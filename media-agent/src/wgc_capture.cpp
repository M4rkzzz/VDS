#include "wgc_capture.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <roapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#endif

#include <algorithm>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace {

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

#ifdef _WIN32
bool parse_unsigned_index(const std::string& value, unsigned int* parsed) {
  try {
    std::size_t consumed = 0;
    const unsigned long long numeric = std::stoull(value, &consumed, 10);
    if (consumed != value.size() || numeric > static_cast<unsigned long long>(UINT_MAX)) {
      return false;
    }
    *parsed = static_cast<unsigned int>(numeric);
    return true;
  } catch (...) {
    return false;
  }
}

struct MonitorEnumerationContext {
  unsigned int target_index = 0;
  unsigned int current_index = 0;
  HMONITOR monitor = nullptr;
};

BOOL CALLBACK enum_monitor_proc(HMONITOR monitor, HDC, LPRECT, LPARAM context_value) {
  auto* context = reinterpret_cast<MonitorEnumerationContext*>(context_value);
  if (!context) {
    return FALSE;
  }

  if (context->current_index == context->target_index) {
    context->monitor = monitor;
    return FALSE;
  }

  context->current_index += 1;
  return TRUE;
}

bool resolve_monitor_from_display_id(const std::string& display_id, HMONITOR* monitor, std::string* error) {
  unsigned int target_index = 0;
  if (!parse_unsigned_index(display_id.empty() ? "0" : display_id, &target_index)) {
    if (error) {
      *error = "wgc-display-id-must-be-a-numeric-monitor-index";
    }
    return false;
  }

  MonitorEnumerationContext context;
  context.target_index = target_index;
  EnumDisplayMonitors(nullptr, nullptr, &enum_monitor_proc, reinterpret_cast<LPARAM>(&context));
  if (!context.monitor) {
    if (error) {
      *error = "wgc-display-monitor-not-found";
    }
    return false;
  }

  *monitor = context.monitor;
  if (error) {
    error->clear();
  }
  return true;
}

bool resolve_window_from_handle(const std::string& window_handle, HWND* hwnd, std::string* error) {
  if (window_handle.empty()) {
    if (error) {
      *error = "wgc-window-handle-missing";
    }
    return false;
  }

  try {
    std::size_t consumed = 0;
    const unsigned long long numeric = std::stoull(window_handle, &consumed, 0);
    if (consumed != window_handle.size()) {
      if (error) {
        *error = "wgc-window-handle-invalid";
      }
      return false;
    }
    *hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(numeric));
    if (!IsWindow(*hwnd)) {
      if (error) {
        *error = "wgc-window-handle-not-found";
      }
      return false;
    }
    if (error) {
      error->clear();
    }
    return true;
  } catch (...) {
    if (error) {
      *error = "wgc-window-handle-invalid";
    }
    return false;
  }
}

bool create_d3d11_device(winrt::com_ptr<ID3D11Device>* device, winrt::com_ptr<ID3D11DeviceContext>* context, std::string* error) {
  static const D3D_FEATURE_LEVEL feature_levels[] = {
    D3D_FEATURE_LEVEL_11_1,
    D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_10_0
  };

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_11_0;
  const HRESULT result = D3D11CreateDevice(
    nullptr,
    D3D_DRIVER_TYPE_HARDWARE,
    nullptr,
    flags,
    feature_levels,
    static_cast<UINT>(std::size(feature_levels)),
    D3D11_SDK_VERSION,
    device->put(),
    &feature_level,
    context->put()
  );

  if (FAILED(result)) {
    if (error) {
      *error = "wgc-d3d11-device-create-failed";
    }
    return false;
  }

  if (error) {
    error->clear();
  }
  return true;
}

bool create_winrt_d3d11_device(
  const winrt::com_ptr<ID3D11Device>& d3d_device,
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice* device,
  std::string* error
) {
  winrt::com_ptr<IDXGIDevice> dxgi_device;
  const HRESULT qi_result = d3d_device->QueryInterface(__uuidof(IDXGIDevice), dxgi_device.put_void());
  if (FAILED(qi_result)) {
    if (error) {
      *error = "wgc-dxgi-device-query-failed";
    }
    return false;
  }

  winrt::com_ptr<::IInspectable> inspectable;
  const HRESULT wrap_result = CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.get(), inspectable.put());
  if (FAILED(wrap_result)) {
    if (error) {
      *error = "wgc-winrt-device-wrap-failed";
    }
    return false;
  }

  *device = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
  if (error) {
    error->clear();
  }
  return true;
}

bool create_capture_item_from_monitor(
  HMONITOR monitor,
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem* item,
  std::string* error
) {
  const auto interop = winrt::get_activation_factory<
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
    IGraphicsCaptureItemInterop
  >();
  const HRESULT result = interop->CreateForMonitor(
    monitor,
    winrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(),
    winrt::put_abi(*item)
  );
  if (FAILED(result)) {
    if (error) {
      *error = "wgc-create-monitor-item-failed";
    }
    return false;
  }
  if (error) {
    error->clear();
  }
  return true;
}

bool create_capture_item_from_window(
  HWND hwnd,
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem* item,
  std::string* error
) {
  const auto interop = winrt::get_activation_factory<
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
    IGraphicsCaptureItemInterop
  >();
  const HRESULT result = interop->CreateForWindow(
    hwnd,
    winrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(),
    winrt::put_abi(*item)
  );
  if (FAILED(result)) {
    if (error) {
      *error = "wgc-create-window-item-failed";
    }
    return false;
  }
  if (error) {
    error->clear();
  }
  return true;
}

bool create_staging_texture(
  const winrt::com_ptr<ID3D11Device>& device,
  const D3D11_TEXTURE2D_DESC& source_desc,
  winrt::com_ptr<ID3D11Texture2D>* staging_texture,
  std::string* error
) {
  D3D11_TEXTURE2D_DESC desc = source_desc;
  desc.BindFlags = 0;
  desc.MiscFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.ArraySize = 1;
  desc.MipLevels = 1;
  desc.SampleDesc.Count = 1;
  desc.SampleDesc.Quality = 0;

  const HRESULT result = device->CreateTexture2D(&desc, nullptr, staging_texture->put());
  if (FAILED(result)) {
    if (error) {
      *error = "wgc-staging-texture-create-failed";
    }
    return false;
  }

  if (error) {
    error->clear();
  }
  return true;
}

#endif

}  // namespace

class WgcFrameSource::Impl {
 public:
  explicit Impl(WgcFrameSourceConfig config)
      : config_(std::move(config)) {}

  bool initialize(std::string* error) {
#ifdef _WIN32
    if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) {
      if (error) {
        *error = "wgc-not-supported-on-this-windows-build";
      }
      return false;
    }

    winrt::init_apartment(winrt::apartment_type::single_threaded);
    apartment_initialized_ = true;

    if (!create_d3d11_device(&device_, &context_, error)) {
      return false;
    }
    if (!create_winrt_d3d11_device(device_, &winrt_device_, error)) {
      return false;
    }

    const std::string target_kind = to_lower_ascii(config_.target_kind.empty() ? "display" : config_.target_kind);
    if (target_kind == "display") {
      HMONITOR monitor = nullptr;
      if (!resolve_monitor_from_display_id(config_.display_id, &monitor, error)) {
        return false;
      }
      if (!create_capture_item_from_monitor(monitor, &item_, error)) {
        return false;
      }
    } else if (target_kind == "window") {
      HWND hwnd = nullptr;
      if (!resolve_window_from_handle(config_.window_handle, &hwnd, error)) {
        return false;
      }
      if (!create_capture_item_from_window(hwnd, &item_, error)) {
        return false;
      }
    } else {
      if (error) {
        *error = "wgc-target-kind-must-be-display-or-window";
      }
      return false;
    }

    pool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      winrt_device_,
      winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      2,
      item_.Size()
    );
    frame_arrived_token_ = pool_.FrameArrived([this](
      const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool&,
      const winrt::Windows::Foundation::IInspectable&) {
      {
        std::lock_guard<std::mutex> lock(frame_event_mutex_);
        frame_arrived_ = true;
      }
      frame_event_cv_.notify_one();
    });
    session_ = pool_.CreateCaptureSession(item_);
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
          winrt::name_of<winrt::Windows::Graphics::Capture::GraphicsCaptureSession>(),
          L"IsCursorCaptureEnabled")) {
      try {
        session_.IsCursorCaptureEnabled(config_.with_cursor);
      } catch (...) {
      }
    }
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
          winrt::name_of<winrt::Windows::Graphics::Capture::GraphicsCaptureSession>(),
          L"IsBorderRequired")) {
      try {
        session_.IsBorderRequired(config_.with_border);
      } catch (...) {
      }
    }
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
          winrt::name_of<winrt::Windows::Graphics::Capture::GraphicsCaptureSession>(),
          L"MinUpdateInterval")) {
      try {
        session_.MinUpdateInterval(std::chrono::milliseconds(1));
      } catch (...) {
      }
    }
    session_.StartCapture();
    return true;
#else
    if (error) {
      *error = "wgc-only-available-on-windows";
    }
    return false;
#endif
  }

  bool wait_for_frame_bgra(int timeout_ms, WgcFrameCpuBuffer* frame, std::string* error) {
#ifdef _WIN32
    if (!frame) {
      if (error) {
        *error = "wgc-frame-output-missing";
      }
      return false;
    }

    if (auto next_frame = pool_.TryGetNextFrame()) {
      return copy_frame_to_cpu(next_frame, frame, error);
    }

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(std::max(1, timeout_ms));
    while (std::chrono::steady_clock::now() < deadline) {
      {
        std::unique_lock<std::mutex> lock(frame_event_mutex_);
        const bool signaled = frame_event_cv_.wait_until(lock, deadline, [this]() {
          return frame_arrived_ || closed_;
        });
        if (!signaled) {
          break;
        }
        if (closed_) {
          if (error) {
            *error = "wgc-source-closed";
          }
          return false;
        }
        frame_arrived_ = false;
      }

      auto next_frame = pool_.TryGetNextFrame();
      if (next_frame) {
        return copy_frame_to_cpu(next_frame, frame, error);
      }
    }

    if (error) {
      *error = "wgc-frame-timeout";
    }
    return false;
#else
    (void)timeout_ms;
    (void)frame;
    if (error) {
      *error = "wgc-only-available-on-windows";
    }
    return false;
#endif
  }

  void close() {
#ifdef _WIN32
    {
      std::lock_guard<std::mutex> lock(frame_event_mutex_);
      closed_ = true;
      frame_arrived_ = false;
    }
    frame_event_cv_.notify_all();
    if (session_) {
      session_.Close();
      session_ = nullptr;
    }
    if (pool_) {
      if (frame_arrived_token_.value != 0) {
        try {
          pool_.FrameArrived(frame_arrived_token_);
        } catch (...) {
        }
        frame_arrived_token_ = {};
      }
      pool_.Close();
      pool_ = nullptr;
    }
    item_ = nullptr;
    winrt_device_ = nullptr;
    staging_texture_ = nullptr;
    context_ = nullptr;
    device_ = nullptr;
    if (apartment_initialized_) {
      winrt::uninit_apartment();
      apartment_initialized_ = false;
    }
#endif
  }

 private:
#ifdef _WIN32
  bool copy_frame_to_cpu(
    const winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame& frame,
    WgcFrameCpuBuffer* output,
    std::string* error
  ) {
    const auto total_start = std::chrono::steady_clock::now();
    const auto surface = frame.Surface();
    winrt::com_ptr<IInspectable> inspectable;
    inspectable.copy_from(reinterpret_cast<IInspectable*>(winrt::get_abi(surface)));
    winrt::com_ptr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
    const HRESULT access_result = inspectable->QueryInterface(__uuidof(::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess), access.put_void());
    if (FAILED(access_result)) {
      if (error) {
        *error = "wgc-surface-access-query-failed";
      }
      return false;
    }

    winrt::com_ptr<ID3D11Texture2D> texture;
    const HRESULT texture_result = access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void());
    if (FAILED(texture_result)) {
      if (error) {
        *error = "wgc-texture-query-failed";
      }
      return false;
    }

    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    if (!staging_texture_ ||
        desc.Width != staging_desc_.Width ||
        desc.Height != staging_desc_.Height ||
        desc.Format != staging_desc_.Format) {
      if (!create_staging_texture(device_, desc, &staging_texture_, error)) {
        return false;
      }
      staging_desc_ = desc;
    }

    const auto copy_start = std::chrono::steady_clock::now();
    context_->CopyResource(staging_texture_.get(), texture.get());
    const auto copy_end = std::chrono::steady_clock::now();

    D3D11_MAPPED_SUBRESOURCE mapped{};
    const auto map_start = std::chrono::steady_clock::now();
    const HRESULT map_result = context_->Map(staging_texture_.get(), 0, D3D11_MAP_READ, 0, &mapped);
    const auto map_end = std::chrono::steady_clock::now();
    if (FAILED(map_result)) {
      if (error) {
        *error = "wgc-staging-map-failed";
      }
      return false;
    }

    output->width = static_cast<int>(desc.Width);
    output->height = static_cast<int>(desc.Height);
    output->stride = static_cast<int>(desc.Width * 4);
    output->timestamp_100ns = static_cast<std::uint64_t>(frame.SystemRelativeTime().count());
    output->bgra.resize(static_cast<std::size_t>(output->stride * output->height));

    const auto* source_bytes = static_cast<const std::uint8_t*>(mapped.pData);
    const auto memcpy_start = std::chrono::steady_clock::now();
    for (int row = 0; row < output->height; ++row) {
      std::memcpy(
        output->bgra.data() + static_cast<std::size_t>(row * output->stride),
        source_bytes + static_cast<std::size_t>(row * mapped.RowPitch),
        static_cast<std::size_t>(output->stride)
      );
    }
    const auto memcpy_end = std::chrono::steady_clock::now();

    context_->Unmap(staging_texture_.get(), 0);
    output->copy_resource_us = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(copy_end - copy_start).count());
    output->map_us = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(map_end - map_start).count());
    output->memcpy_us = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(memcpy_end - memcpy_start).count());
    output->total_readback_us = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(memcpy_end - total_start).count());
    if (error) {
      error->clear();
    }
    return true;
  }

  WgcFrameSourceConfig config_;
  bool apartment_initialized_ = false;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrt_device_ { nullptr };
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_ { nullptr };
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_ { nullptr };
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_ { nullptr };
  winrt::event_token frame_arrived_token_ {};
  winrt::com_ptr<ID3D11Texture2D> staging_texture_;
  D3D11_TEXTURE2D_DESC staging_desc_ {};
  std::mutex frame_event_mutex_;
  std::condition_variable frame_event_cv_;
  bool frame_arrived_ = false;
  bool closed_ = false;
#else
  WgcFrameSourceConfig config_;
#endif
};

WgcFrameSource::WgcFrameSource(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl)) {}

WgcFrameSource::~WgcFrameSource() {
  if (impl_) {
    impl_->close();
  }
}

bool WgcFrameSource::wait_for_frame_bgra(int timeout_ms, WgcFrameCpuBuffer* frame, std::string* error) {
  return impl_->wait_for_frame_bgra(timeout_ms, frame, error);
}

void WgcFrameSource::close() {
  if (impl_) {
    impl_->close();
  }
}

WgcCaptureProbe probe_wgc_capture_backend() {
  WgcCaptureProbe probe;
#ifdef _WIN32
  probe.platform_supported = true;
  probe.display_capture_supported = false;
  probe.window_capture_supported = false;

  if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) {
    probe.available = false;
    probe.implemented = true;
    probe.reason = "wgc-not-supported-on-this-windows-build";
    probe.last_error =
      "Windows.Graphics.Capture requires Windows 10 version 1903 or newer with desktop capture support enabled.";
    return probe;
  }

  winrt::com_ptr<ID3D11Device> d3d_device;
  winrt::com_ptr<ID3D11DeviceContext> d3d_context;
  std::string create_error;
  if (!create_d3d11_device(&d3d_device, &d3d_context, &create_error)) {
    probe.available = false;
    probe.implemented = true;
    probe.reason = "wgc-d3d11-device-create-failed";
    probe.last_error = create_error;
    return probe;
  }

  probe.available = true;
  probe.implemented = true;
  probe.display_capture_supported = true;
  probe.window_capture_supported = true;
  probe.reason = "wgc-capture-source-ready";
  probe.last_error.clear();
#else
  probe.platform_supported = false;
  probe.available = false;
  probe.implemented = false;
  probe.reason = "wgc-only-available-on-windows";
  probe.last_error = "Windows.Graphics.Capture is only available on Windows 10/11.";
#endif
  return probe;
}

std::shared_ptr<WgcFrameSource> create_wgc_frame_source(
  const WgcFrameSourceConfig& config,
  std::string* error
) {
  auto impl = std::make_unique<WgcFrameSource::Impl>(config);
  if (!impl->initialize(error)) {
    return nullptr;
  }
  return std::shared_ptr<WgcFrameSource>(new WgcFrameSource(std::move(impl)));
}
