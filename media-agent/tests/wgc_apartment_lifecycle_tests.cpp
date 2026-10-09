#define NOMINMAX
#include <windows.h>
#include <objbase.h>

#include <chrono>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>

#include "wgc_capture.h"

void require(bool value, const std::string& message) {
  if (!value) throw std::runtime_error(message);
}

int main() {
  HWND window = nullptr;
  try {
    const auto probe = probe_wgc_capture_backend();
    if (!probe.available) {
      std::cout << "SKIP: " << probe.reason << '\n';
      return 77;
    }
    window = CreateWindowExW(0, L"STATIC", L"VDS owned WGC lifecycle fixture",
      WS_OVERLAPPEDWINDOW, 0, 0, 128, 128, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    require(window != nullptr, "test window creation failed");
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    WgcFrameSourceConfig config;
    config.target_kind = "window";
    config.window_handle = std::to_string(reinterpret_cast<std::uintptr_t>(window));
    config.frame_rate = 30;
    for (int iteration = 0; iteration < 8; ++iteration) {
      std::string error;
      auto missing = config;
      missing.window_handle = "0";
      require(!create_wgc_frame_source(missing, &error), "invalid window unexpectedly created a source");
      auto source = create_wgc_frame_source(config, &error);
      require(source != nullptr, "main source creation: " + error);
      auto worker = std::async(std::launch::async, [source, config]() {
        // Cross-thread close must not uninitialize the RPC thread's apartment.
        source->close();
        std::string worker_error;
        auto next = create_wgc_frame_source(config, &worker_error);
        require(next != nullptr, "worker source creation: " + worker_error);
        WgcFrameCpuBuffer frame;
        require(next->wait_for_frame_bgra(2000, &frame, &worker_error), "owned window readback: " + worker_error);
        require(frame.width > 0 && frame.height > 0 && !frame.bgra.empty(), "empty owned frame");
        next->close();
        next->close();
        require(!next->wait_for_frame_bgra(10, &frame, &worker_error), "closed source returned a frame");
      });
      while (worker.wait_for(std::chrono::milliseconds(10)) != std::future_status::ready) {
        MSG message;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }
      }
      worker.get();
      source.reset();
      require(probe_wgc_capture_backend().available, "support probe after worker shutdown failed");
      APTTYPE apartment;
      APTTYPEQUALIFIER qualifier;
      require(SUCCEEDED(CoGetApartmentType(&apartment, &qualifier)) && apartment == APTTYPE_MTA,
        "main thread lost its MTA after cross-thread close");
    }
    DestroyWindow(window);
    std::cout << "WGC cross-thread close, worker recreation and owned-window frames: 8 cycles passed\n";
    return 0;
  } catch (const std::exception& error) {
    if (window) DestroyWindow(window);
    std::cerr << error.what() << '\n';
    return 1;
  }
}
