#include "native_preview_presenter.h"
#ifdef _WIN32
bool NativePreviewPresenter::present(HWND window,
    const std::shared_ptr<const WgcFrameCpuBuffer>& frame, int width, int height,
    const RECT& destination) {
  const auto failed = [this]() { reset(); return false; };
  if (!frame || frame->width <= 0 || frame->height <= 0 || width <= 0 || height <= 0 ||
      !IsWindow(window)) return failed();
  const auto pitch = frame->stride > 0 ? static_cast<std::uint64_t>(frame->stride)
                                      : static_cast<std::uint64_t>(frame->width) * 4;
  if (pitch < static_cast<std::uint64_t>(frame->width) * 4 || pitch > UINT32_MAX ||
      pitch * frame->height > frame->bgra.size()) return failed();
  if (!factory_ && FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, factory_.GetAddressOf())))
    return failed();
  if (target_ && target_->GetHwnd() != window) reset();
  if (!target_) {
    // Pixel coordinates match the existing GDI layout even at non-100% DPI.
    const auto properties = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_HARDWARE,
      D2D1::PixelFormat(DXGI_FORMAT_UNKNOWN, D2D1_ALPHA_MODE_IGNORE), 96, 96);
    if (FAILED(factory_->CreateHwndRenderTarget(properties,
        D2D1::HwndRenderTargetProperties(window, D2D1::SizeU(width, height),
          D2D1_PRESENT_OPTIONS_IMMEDIATELY), target_.GetAddressOf()))) return failed();
  }
  const auto size = target_->GetPixelSize();
  if ((size.width != static_cast<UINT32>(width) || size.height != static_cast<UINT32>(height)) &&
      FAILED(target_->Resize(D2D1::SizeU(width, height)))) return failed();
  if (bitmap_) {
    const auto bitmap_size = bitmap_->GetPixelSize();
    if (bitmap_size.width != static_cast<UINT32>(frame->width) ||
        bitmap_size.height != static_cast<UINT32>(frame->height)) {
      bitmap_.Reset();
      uploaded_frame_.reset();
    }
  }
  if (!bitmap_) {
    const auto properties = D2D1::BitmapProperties(
      D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE), 96, 96);
    if (FAILED(target_->CreateBitmap(D2D1::SizeU(frame->width, frame->height),
        nullptr, 0, properties, bitmap_.GetAddressOf()))) return failed();
  }
  if (uploaded_frame_ != frame) {
    if (FAILED(bitmap_->CopyFromMemory(nullptr, frame->bgra.data(), static_cast<UINT32>(pitch))))
      return failed();
    uploaded_frame_ = frame;
  }
  target_->BeginDraw();
  target_->Clear(D2D1::ColorF(D2D1::ColorF::Black));
  target_->DrawBitmap(bitmap_.Get(), D2D1::RectF(static_cast<float>(destination.left),
    static_cast<float>(destination.top), static_cast<float>(destination.right),
    static_cast<float>(destination.bottom)), 1.0f, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
  if (FAILED(target_->EndDraw())) return failed();
  return true;
}

void NativePreviewPresenter::reset() {
  uploaded_frame_.reset();
  bitmap_.Reset();
  target_.Reset();
}
#endif
