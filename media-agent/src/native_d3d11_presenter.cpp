#include "native_d3d11_presenter.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_5.h>
#include <wrl/client.h>
#include <mutex>
#include <sstream>
#include <cstdint>
#include <vector>

extern "C" {
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
}

using Microsoft::WRL::ComPtr;

namespace {
LRESULT CALLBACK video_window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    BeginPaint(hwnd, &paint);
    EndPaint(hwnd, &paint);
    InvalidateRect(GetParent(hwnd), nullptr, FALSE);
    return 0;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

struct DeviceLock {
  AVD3D11VADeviceContext* context;
  explicit DeviceLock(AVD3D11VADeviceContext* value) : context(value) { context->lock(context->lock_ctx); }
  ~DeviceLock() { context->unlock(context->lock_ctx); }
};

std::string describe_failure(const char* stage, HRESULT result) {
  std::ostringstream out;
  out << stage << ":0x" << std::hex << static_cast<unsigned long>(result);
  return out.str();
}
}

class NativeD3D11Presenter::Impl {
 public:
  ~Impl() { reset(); }
  void reset() {
    if (latency_event) CloseHandle(latency_event);
    latency_event = nullptr;
    latency_ready = false;
    clear_input_views();
    output.Reset();
    processor.Reset();
    enumerator.Reset();
    swapchain.Reset();
    video_context.Reset();
    video_device.Reset();
    device.Reset();
    if (window) DestroyWindow(window);
    window = nullptr;
    width = height = input_width = input_height = 0;
  }

  HRESULT initialize(HWND parent, ID3D11Device* source_device, int w, int h) {
    reset();
    static std::once_flag registered;
    std::call_once(registered, [] {
      WNDCLASSW wc{};
      wc.lpfnWndProc = video_window_proc;
      wc.hInstance = GetModuleHandleW(nullptr);
      wc.lpszClassName = L"VDSD3D11VideoWindow";
      RegisterClassW(&wc);
    });
    // A dedicated child avoids unsupported flip-model/GDI interleaving on the
    // parent HWND. Destroying it exposes the compatible GDI fallback surface.
    window = CreateWindowExW(0, L"VDSD3D11VideoWindow", L"", WS_CHILD | WS_VISIBLE | WS_DISABLED,
      0, 0, w, h, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!window) return HRESULT_FROM_WIN32(GetLastError());
    device = source_device;
    HRESULT hr = device.As(&video_device);
    if (FAILED(hr)) return hr;
    ComPtr<ID3D11DeviceContext> immediate;
    device->GetImmediateContext(&immediate);
    hr = immediate.As(&video_context);
    if (FAILED(hr)) return hr;
    ComPtr<IDXGIDevice> dxgi_device;
    ComPtr<IDXGIAdapter> adapter;
    ComPtr<IDXGIFactory2> factory;
    if (FAILED(hr = device.As(&dxgi_device)) || FAILED(hr = dxgi_device->GetAdapter(&adapter)) ||
        FAILED(hr = adapter->GetParent(IID_PPV_ARGS(&factory)))) return hr;
    BOOL tearing = FALSE;
    ComPtr<IDXGIFactory5> factory5;
    if (SUCCEEDED(factory.As(&factory5))) {
      factory5->CheckFeatureSupport(DXGI_FEATURE_PRESENT_ALLOW_TEARING, &tearing, sizeof(tearing));
    }
    const UINT preferred_flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT |
      (tearing ? DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING : 0);
    DXGI_SWAP_CHAIN_DESC1 desc{};
    desc.Width = w;
    desc.Height = h;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    const auto create_chain = [&](DXGI_SWAP_EFFECT effect, UINT options) {
      desc.SwapEffect = effect;
      desc.Flags = options;
      swapchain.Reset();
#ifdef VDS_NATIVE_SURFACE_TESTING
      if (swapchain_creation_fault) {
        const HRESULT injected = swapchain_creation_fault(effect, options);
        if (FAILED(injected)) return injected;
      }
#endif
      return factory->CreateSwapChainForHwnd(device.Get(), window, &desc, nullptr, nullptr,
        swapchain.GetAddressOf());
    };
    // A rejected optional flag must not force decoded pixels through the CPU.
    // Try simpler GPU paths only during creation; the media clock still paces
    // presentation and Present remains nonblocking on every path.
    UINT previous_options = ~0u;
    hr = E_FAIL;
    for (const UINT options : {preferred_flags,
        static_cast<UINT>(DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT), 0u}) {
      if (options == previous_options) continue;
      previous_options = options;
      for (const auto effect : {DXGI_SWAP_EFFECT_FLIP_DISCARD, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL}) {
        hr = create_chain(effect, options);
        if (SUCCEEDED(hr)) break;
        if (FAILED(device->GetDeviceRemovedReason())) return hr;
      }
      if (SUCCEEDED(hr)) break;
    }
    if (FAILED(hr)) hr = create_chain(DXGI_SWAP_EFFECT_DISCARD, 0);
    if (FAILED(hr)) return hr;
    flags = desc.Flags;
    factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER);
    ComPtr<IDXGISwapChain2> chain2;
    if ((flags & DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT) &&
        SUCCEEDED(swapchain.As(&chain2))) {
      chain2->SetMaximumFrameLatency(1);
      latency_event = chain2->GetFrameLatencyWaitableObject();
    }
    width = w;
    height = h;
    return S_OK;
  }

  HRESULT configure(AVFrame* frame, int w, int h, int rate_num, int rate_den) {
    HRESULT hr = S_OK;
    if (width != w || height != h) {
      output.Reset();
      hr = swapchain->ResizeBuffers(2, w, h, DXGI_FORMAT_UNKNOWN, flags);
      if (FAILED(hr)) return hr;
      width = w;
      height = h;
      clear_input_views();
      enumerator.Reset();
    }
    if (!enumerator || input_width != frame->width || input_height != frame->height ||
        rate_num != frame_rate_num || rate_den != frame_rate_den) {
      output.Reset();
      processor.Reset();
      clear_input_views();
      enumerator.Reset();
      D3D11_VIDEO_PROCESSOR_CONTENT_DESC desc{};
      desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
      desc.InputFrameRate = {static_cast<UINT>(rate_num), static_cast<UINT>(rate_den)};
      // No frame-rate conversion: presentation deadlines remain owned by the
      // media scheduler. These equal rates only describe the content to D3D.
      desc.OutputFrameRate = desc.InputFrameRate;
      desc.InputWidth = frame->width;
      desc.InputHeight = frame->height;
      desc.OutputWidth = w;
      desc.OutputHeight = h;
      desc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
      if (FAILED(hr = video_device->CreateVideoProcessorEnumerator(&desc, &enumerator))) return hr;
      UINT input_support = 0, output_support = 0;
      if (FAILED(hr = enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &input_support)) ||
          FAILED(hr = enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &output_support))) return hr;
      if (!(input_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) ||
          !(output_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) return E_NOTIMPL;
      if (FAILED(hr = video_device->CreateVideoProcessor(enumerator.Get(), 0, &processor))) return hr;
      input_width = frame->width;
      input_height = frame->height;
      frame_rate_num = rate_num;
      frame_rate_den = rate_den;
    }
    if (!output) {
      ComPtr<ID3D11Texture2D> back_buffer;
      if (FAILED(hr = swapchain->GetBuffer(0, IID_PPV_ARGS(&back_buffer)))) return hr;
      D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view{};
      view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
      if (FAILED(hr = video_device->CreateVideoProcessorOutputView(back_buffer.Get(), enumerator.Get(), &view, &output))) return hr;
    }
    return S_OK;
  }

  void clear_input_views() {
    input_views.clear();
    input_texture.Reset();
  }

  HRESULT input_view(AVFrame* frame, ID3D11VideoProcessorInputView** result) {
    auto* texture = reinterpret_cast<ID3D11Texture2D*>(frame->data[0]);
    const auto slice = reinterpret_cast<std::uintptr_t>(frame->data[1]);
    if (texture != input_texture.Get()) {
      D3D11_TEXTURE2D_DESC desc{};
      texture->GetDesc(&desc);
      if (slice >= desc.ArraySize) return E_INVALIDARG;
      // FFmpeg's D3D11 decoder pool is a texture array. Retain only the current
      // array, so stream/texture replacement cannot accumulate old GPU pools.
      clear_input_views();
      input_views.resize(desc.ArraySize);
      input_texture = texture;
    }
    if (slice >= input_views.size()) return E_INVALIDARG;
    auto& view = input_views[slice];
    if (!view) {
      D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC desc{};
      desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
      desc.Texture2D.ArraySlice = static_cast<UINT>(slice);
      const HRESULT hr = video_device->CreateVideoProcessorInputView(texture,
        enumerator.Get(), &desc, view.GetAddressOf());
      if (FAILED(hr)) return hr;
#ifdef VDS_NATIVE_SURFACE_TESTING
      if (on_input_view_created) on_input_view_created();
#endif
    }
    *result = view.Get();
    return S_OK;
  }

#ifdef VDS_NATIVE_SURFACE_TESTING
  std::function<long(unsigned int, unsigned int)> swapchain_creation_fault;
  std::function<void()> on_input_view_created;
#endif
  ComPtr<ID3D11Texture2D> input_texture;
  std::vector<ComPtr<ID3D11VideoProcessorInputView>> input_views;
  HWND window = nullptr;
  HANDLE latency_event = nullptr;
  bool latency_ready = false;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11VideoDevice> video_device;
  ComPtr<ID3D11VideoContext> video_context;
  ComPtr<IDXGISwapChain1> swapchain;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  ComPtr<ID3D11VideoProcessor> processor;
  ComPtr<ID3D11VideoProcessorOutputView> output;
  int width = 0, height = 0, input_width = 0, input_height = 0;
  int frame_rate_num = 0, frame_rate_den = 0;
  UINT flags = 0;
};

NativeD3D11Presenter::NativeD3D11Presenter() : impl_(std::make_unique<Impl>()) {}
NativeD3D11Presenter::~NativeD3D11Presenter() = default;
void NativeD3D11Presenter::reset() { impl_->reset(); }
void* NativeD3D11Presenter::wait_handle() const {
  return impl_->latency_ready ? nullptr : impl_->latency_event;
}
void NativeD3D11Presenter::notify_ready() { impl_->latency_ready = true; }

bool NativeD3D11Presenter::supports(const AVFrame* frame) {
  if (!frame || frame->format != AV_PIX_FMT_D3D11 || !frame->hw_frames_ctx || !frame->data[0]) return false;
  const auto* frames = reinterpret_cast<const AVHWFramesContext*>(frame->hw_frames_ctx->data);
  // HDR/10-bit/interlaced paths keep the existing conversion until their
  // color-management and deinterlace requirements have separate coverage.
  return frames->sw_format == AV_PIX_FMT_NV12 && !(frame->flags & AV_FRAME_FLAG_INTERLACED) &&
    (frame->colorspace == AVCOL_SPC_UNSPECIFIED || frame->colorspace == AVCOL_SPC_BT709 ||
     frame->colorspace == AVCOL_SPC_BT470BG || frame->colorspace == AVCOL_SPC_SMPTE170M) &&
    frame->color_trc != AVCOL_TRC_SMPTE2084 && frame->color_trc != AVCOL_TRC_ARIB_STD_B67;
}

NativeD3D11Presenter::Result NativeD3D11Presenter::present(void* parent, AVFrame* frame, int width, int height,
    int left, int top, int right, int bottom, int rate_num, int rate_den, std::string& error) {
  if (width <= 0 || height <= 0) return Result::Skipped;
  if (!supports(frame)) { error = "d3d11-present-format-unsupported"; return Result::Failed; }
  auto* frames = reinterpret_cast<AVHWFramesContext*>(frame->hw_frames_ctx->data);
  auto* hardware = static_cast<AVD3D11VADeviceContext*>(frames->device_ctx->hwctx);
#ifdef VDS_NATIVE_SURFACE_TESTING
  impl_->swapchain_creation_fault = swapchain_creation_fault;
  impl_->on_input_view_created = on_input_view_created;
#endif
  HRESULT hr = S_OK;
  if (impl_->device.Get() != hardware->device) {
    hr = impl_->initialize(static_cast<HWND>(parent), hardware->device, width, height);
    if (FAILED(hr)) { error = describe_failure("swapchain-create", hr); reset(); return Result::Failed; }
  }
  if (impl_->latency_event && !impl_->latency_ready) {
    const DWORD result = WaitForSingleObject(impl_->latency_event, 0);
    if (result == WAIT_TIMEOUT) return Result::Skipped;
    if (result != WAIT_OBJECT_0) {
      error = "swapchain-wait-failed"; reset(); return Result::Failed;
    }
    impl_->latency_ready = true;
  }
  {
    // FFmpeg decoding and video processing share the immediate context. Use
    // FFmpeg's own lock, and release it before DXGI Present/window operations.
    DeviceLock lock(hardware);
    hr = impl_->configure(frame, width, height, rate_num > 0 ? rate_num : 1, rate_den > 0 ? rate_den : 1);
    if (SUCCEEDED(hr)) {
      ID3D11VideoProcessorInputView* input = nullptr;
      hr = impl_->input_view(frame, &input);
      if (SUCCEEDED(hr)) {
        RECT source{0, 0, frame->width, frame->height}, destination{left, top, right, bottom};
        RECT output_rect{0, 0, width, height};
        auto* context = impl_->video_context.Get();
        auto* processor = impl_->processor.Get();
        context->VideoProcessorSetStreamFrameFormat(processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        context->VideoProcessorSetStreamAutoProcessingMode(processor, 0, FALSE);
        context->VideoProcessorSetStreamSourceRect(processor, 0, TRUE, &source);
        context->VideoProcessorSetStreamDestRect(processor, 0, TRUE, &destination);
        context->VideoProcessorSetOutputTargetRect(processor, TRUE, &output_rect);
        D3D11_VIDEO_COLOR black{};
        black.RGBA.A = 1.0f;
        context->VideoProcessorSetOutputBackgroundColor(processor, FALSE, &black);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_color{};
        input_color.YCbCr_Matrix = frame->colorspace == AVCOL_SPC_BT709 ? 1 : 0;
        input_color.Nominal_Range = frame->color_range == AVCOL_RANGE_JPEG
          ? D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255 : D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_color{};
        output_color.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
        context->VideoProcessorSetStreamColorSpace(processor, 0, &input_color);
        context->VideoProcessorSetOutputColorSpace(processor, &output_color);
        D3D11_VIDEO_PROCESSOR_STREAM stream{};
        stream.Enable = TRUE;
        stream.pInputSurface = input;
        hr = context->VideoProcessorBlt(processor, impl_->output.Get(), 0, 1, &stream);
#ifdef VDS_NATIVE_SURFACE_TESTING
        if (SUCCEEDED(hr) && inspect_output) {
          ComPtr<ID3D11Resource> resource;
          impl_->output->GetResource(&resource);
          inspect_output(hardware->device, resource.Get());
        }
#endif
      }
    }
  }
  if (FAILED(hr)) { error = describe_failure("video-processor", hr); reset(); return Result::Failed; }
  RECT child_rect{};
  GetClientRect(impl_->window, &child_rect);
  if (child_rect.right != width || child_rect.bottom != height) {
    SetWindowPos(impl_->window, nullptr, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
  }
  const UINT present_flags = DXGI_PRESENT_DO_NOT_WAIT |
    ((impl_->flags & DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING) ? DXGI_PRESENT_ALLOW_TEARING : 0);
  hr = impl_->swapchain->Present(0, present_flags);
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING || hr == DXGI_STATUS_OCCLUDED) return Result::Skipped;
  if (FAILED(hr)) { error = describe_failure("swapchain-present", hr); reset(); return Result::Failed; }
  impl_->latency_ready = false;
  return Result::Presented;
}
