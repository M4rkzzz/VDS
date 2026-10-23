#include "native_d3d11_presenter.h"
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_3.h>
#include <wrl/client.h>
#include <array>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>
extern "C" {
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
}
using Microsoft::WRL::ComPtr;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
struct RefDelete { void operator()(AVBufferRef* p) const { av_buffer_unref(&p); } };
struct FrameDelete { void operator()(AVFrame* p) const { av_frame_free(&p); } };
using Ref = std::unique_ptr<AVBufferRef, RefDelete>;
using Frame = std::unique_ptr<AVFrame, FrameDelete>;
struct Window {
  HWND hwnd = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"VDS owned GPU resource test",
    WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN, 40, 40, 320, 240, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  Window() { require(hwnd != nullptr, "create owned window"); }
  ~Window() { DestroyWindow(hwnd); }
};
Ref make_device() {
  AVBufferRef* device = nullptr;
  require(av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_D3D11VA, nullptr, nullptr, 0) >= 0,
    "create actual D3D11 hardware device");
  return Ref(device);
}
struct Pool {
  Ref frames;
  std::array<Frame, 3> samples;
  explicit Pool(AVBufferRef* device) : frames(av_hwframe_ctx_alloc(device)) {
    require(frames != nullptr, "allocate hardware pool");
    auto* fc = reinterpret_cast<AVHWFramesContext*>(frames->data);
    fc->format = AV_PIX_FMT_D3D11; fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = 160; fc->height = 96; fc->initial_pool_size = 3;
    static_cast<AVD3D11VAFramesContext*>(fc->hwctx)->BindFlags = D3D11_BIND_DECODER;
    require(av_hwframe_ctx_init(frames.get()) >= 0, "initialize hardware pool");
    for (int i = 0; i != 3; ++i) {
      samples[i].reset(av_frame_alloc());
      require(av_hwframe_get_buffer(frames.get(), samples[i].get(), 0) >= 0, "get array slice");
      auto* f = samples[i].get(); f->colorspace = AVCOL_SPC_BT709; f->color_range = AVCOL_RANGE_MPEG;
      Frame software(av_frame_alloc());
      software->format = AV_PIX_FMT_NV12; software->width = 160; software->height = 96;
      require(av_frame_get_buffer(software.get(), 0) >= 0, "allocate software upload frame");
      for (int row = 0; row < 96; ++row)
        std::fill_n(software->data[0] + row * software->linesize[0], 160, static_cast<unsigned char>(16 + i * 90));
      for (int row = 0; row < 48; ++row)
        std::fill_n(software->data[1] + row * software->linesize[1], 160, static_cast<unsigned char>(128));
      require(av_hwframe_transfer_data(f, software.get(), 0) >= 0, "upload NV12 fixture through FFmpeg");
    }
    require(samples[0]->data[0] == samples[1]->data[0], "fixture must exercise decoder texture array");
  }
};
int center_pixel(void* device, void* output) {
  auto* gpu = static_cast<ID3D11Device*>(device);
  ComPtr<ID3D11Texture2D> texture;
  require(SUCCEEDED(static_cast<ID3D11Resource*>(output)->QueryInterface(IID_PPV_ARGS(&texture))), "output texture");
  D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.BindFlags = desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  require(SUCCEEDED(gpu->CreateTexture2D(&desc, nullptr, &staging)), "test-only readback texture");
  ComPtr<ID3D11DeviceContext> context; gpu->GetImmediateContext(&context);
  context->CopyResource(staging.Get(), texture.Get());
  D3D11_MAPPED_SUBRESOURCE pixels{};
  require(SUCCEEDED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &pixels)), "test-only pixel map");
  const auto* center = static_cast<const unsigned char*>(pixels.pData) + (desc.Height / 2) * pixels.RowPitch + (desc.Width / 2) * 4;
  int value = center[0];
  bool gray = abs(int(center[1]) - value) <= 2 && abs(int(center[2]) - value) <= 2;
  context->Unmap(staging.Get(), 0);
  require(gray, "GPU output must have neutral chroma");
  return value;
}
void present(NativeD3D11Presenter& renderer, HWND window, AVFrame* frame, int width = 320, int rate = 30) {
  std::string error;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (std::chrono::steady_clock::now() < deadline) {
    MSG msg{}; for (int dispatched = 0; dispatched < 32 && PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE); ++dispatched) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    auto result = renderer.present(window, frame, width, 240, 0, 0, width, 240, rate, 1, error);
    if (result == NativeD3D11Presenter::Result::Failed) throw std::runtime_error(error);
    if (result == NativeD3D11Presenter::Result::Presented) return;
    Sleep(1);
  }
  throw std::runtime_error("GPU presentation did not progress");
}
int main() {
  try {
    std::cout << std::unitbuf;
    Window window;
    auto device = make_device();
    Pool pool(device.get());
    std::cout << "hardware test frames uploaded\n";
    NativeD3D11Presenter renderer;
    unsigned views = 0;
    renderer.on_input_view_created = [&] { ++views; };
    int expected_pixel = 0; unsigned pixels_checked = 0;
    renderer.inspect_output = [&](void* gpu, void* output) {
      require(abs(center_pixel(gpu, output) - expected_pixel) <= 4, "cached slice must show the current frame pixels");
      ++pixels_checked;
    };
    for (int n = 0; n != 120; ++n) {
      int slice = n % 3; expected_pixel = slice * 90 * 255 / 219;
      present(renderer, window.hwnd, pool.samples[slice].get());
    }
    std::cout << "resource-reuse: presents=120 input-view-creations=" << views << " pixels=" << pixels_checked << '\n';
    require(views == 3 && pixels_checked >= 120, "120 actual presents must create only three input views");
    expected_pixel = 0;
    present(renderer, window.hwnd, pool.samples[0].get(), 300);
    require(views == 4, "resize must invalidate enumerator-dependent views");
    present(renderer, window.hwnd, pool.samples[0].get(), 300, 60);
    require(views == 5, "rate reconfiguration must invalidate views");
    {
      Pool replacement(device.get());
      present(renderer, window.hwnd, replacement.samples[0].get(), 300, 60);
      require(views == 6, "texture replacement must create a compatible view");
    }
    present(renderer, window.hwnd, pool.samples[0].get(), 300, 60);
    require(views == 7, "old texture must not remain in a growing cache");
    renderer.reset();
    present(renderer, window.hwnd, pool.samples[0].get(), 300, 60);
    require(views == 8, "reset must discard GPU views");
    auto another_device = make_device(); Pool another_pool(another_device.get());
    present(renderer, window.hwnd, another_pool.samples[0].get(), 300, 60);
    require(views == 9, "new D3D device must discard old-device resources");
    auto old_slice = another_pool.samples[0]->data[1]; another_pool.samples[0]->data[1] = reinterpret_cast<uint8_t*>(9999);
    std::string error;
    renderer.notify_ready();
    require(renderer.present(window.hwnd, another_pool.samples[0].get(), 300, 240, 0, 0, 300, 240, 60, 1, error) ==
      NativeD3D11Presenter::Result::Failed, "invalid array slice must fail without indexing outside cache");
    another_pool.samples[0]->data[1] = old_slice;
    present(renderer, window.hwnd, another_pool.samples[0].get(), 300, 60);
    require(views == 10, "valid input must recover after failed presentation");
    renderer.reset();
    for (int mode = 0; mode != 4; ++mode) {
      NativeD3D11Presenter fallback;
      unsigned attempts = 0, rejected = 0, accepted_effect = 0, accepted_flags = 0;
      fallback.swapchain_creation_fault = [&](unsigned effect, unsigned flags) -> long {
        ++attempts;
        const bool reject = mode == 0 ? effect == DXGI_SWAP_EFFECT_FLIP_DISCARD :
          mode == 1 ? flags != 0 : mode == 2 ? effect != DXGI_SWAP_EFFECT_DISCARD : true;
        if (reject) { ++rejected; return DXGI_ERROR_UNSUPPORTED; }
        accepted_effect = effect; accepted_flags = flags; return S_OK;
      };
      fallback.inspect_output = renderer.inspect_output;
      if (mode == 3) {
        require(fallback.present(window.hwnd, pool.samples[0].get(), 320, 240, 0, 0, 320, 240, 30, 1, error) ==
          NativeD3D11Presenter::Result::Failed, "total GPU failure must reach existing software fallback");
        fallback.swapchain_creation_fault = {};
      }
      present(fallback, window.hwnd, pool.samples[0].get());
      present(fallback, window.hwnd, pool.samples[0].get(), 300);
      require(rejected > 0, "fixture must exercise creation rejection");
      if (mode == 0) require(accepted_effect == DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, "flip-sequential recovery");
      if (mode == 1) require(accepted_flags == 0 && fallback.wait_handle() == nullptr, "flag-free GPU recovery");
      if (mode == 2) require(accepted_effect == DXGI_SWAP_EFFECT_DISCARD && accepted_flags == 0, "blit GPU recovery");
      std::cout << "swapchain-fallback: mode=" << mode << " rejected=" << rejected << " attempts=" << attempts << " GPU pixels passed\n";
    }
    std::cout << "D3D11 resource, device replacement and compatibility tests passed\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
