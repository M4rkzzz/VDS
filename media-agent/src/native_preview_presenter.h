#pragma once
#ifdef _WIN32
#include "wgc_capture.h"
#include <d2d1.h>
#include <wrl/client.h>

// Window-thread owned, hardware-only scaling of the existing shared BGRA frame.
// Failure leaves the caller free to paint with GDI on the same window.
class NativePreviewPresenter {
 public:
  bool present(HWND window, const std::shared_ptr<const WgcFrameCpuBuffer>& frame,
               int width, int height, const RECT& destination);
  void reset();
 private:
  Microsoft::WRL::ComPtr<ID2D1Factory> factory_;
  Microsoft::WRL::ComPtr<ID2D1HwndRenderTarget> target_;
  Microsoft::WRL::ComPtr<ID2D1Bitmap> bitmap_;
  std::shared_ptr<const WgcFrameCpuBuffer> uploaded_frame_;
};
#endif
