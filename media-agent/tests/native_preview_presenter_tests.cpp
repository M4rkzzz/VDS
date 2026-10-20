#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "native_preview_presenter.h"
#include <dwmapi.h>
#include <iostream>
#include <stdexcept>

namespace {
void expect(bool value, const char* reason) {
  if (!value) throw std::runtime_error(reason);
}
LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    BeginPaint(window, &paint);
    EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}
void pump() {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  DwmFlush();
}
std::shared_ptr<const WgcFrameCpuBuffer> solid(int width, int height, COLORREF color) {
  auto frame = std::make_shared<WgcFrameCpuBuffer>();
  frame->width = width;
  frame->height = height;
  frame->stride = width * 4;
  frame->bgra.resize(static_cast<std::size_t>(width) * height * 4);
  for (std::size_t i = 0; i < frame->bgra.size(); i += 4) {
    frame->bgra[i] = GetBValue(color);
    frame->bgra[i + 1] = GetGValue(color);
    frame->bgra[i + 2] = GetRValue(color);
    frame->bgra[i + 3] = 0; // BGRA capture alpha must not make the image transparent.
  }
  return frame;
}
void pixel(HWND window, int x, int y, COLORREF expected) {
  POINT point{x,y};
  ClientToScreen(window, &point);
  HDC screen = GetDC(nullptr);
  const auto actual = GetPixel(screen, point.x, point.y);
  ReleaseDC(nullptr, screen);
  expect(actual == expected, "GPU preview pixel differs after upload/resize/move");
}
}
int main() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW cls{};
  cls.lpfnWndProc = procedure;
  cls.hInstance = GetModuleHandleW(nullptr);
  cls.lpszClassName = L"VDSOwnedPreviewPresenterTest";
  RegisterClassW(&cls);
  HWND window = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
    cls.lpszClassName, L"VDS preview GPU smoke", WS_POPUP | WS_VISIBLE,
    30, 40, 320, 180, nullptr, nullptr, cls.hInstance, nullptr);
  NativePreviewPresenter presenter;
  int result = 0;
  try {
    expect(window != nullptr, "owned test window must exist");
    pump();
    auto red = solid(1920,1080,RGB(255,0,0));
    const RECT rect{20,20,300,160};
    expect(presenter.present(window,red,320,180,rect), "hardware preview must initialize");
    pump();
    pixel(window,160,90,RGB(255,0,0));
    pixel(window,5,5,RGB(0,0,0));
    const auto resources = GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
    for (int i = 0; i < 100; ++i)
      expect(presenter.present(window,red,320,180,rect), "repeated static repaint must succeed");
    expect(GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS) <= resources + 2,
      "repainting must not leak GDI resources");
    for (const POINT position : {POINT{10,40},POINT{70,40},POINT{70,10},POINT{70,80}}) {
      SetWindowPos(window,nullptr,position.x,position.y,400,240,SWP_NOACTIVATE|SWP_NOZORDER);
      pump();
      expect(presenter.present(window,red,400,240,RECT{20,20,380,220}), "resize and move must redraw");
      pump();
      pixel(window,200,120,RGB(255,0,0));
      pixel(window,5,5,RGB(0,0,0));
    }
    presenter.reset();
    auto blue = solid(640,360,RGB(0,0,255));
    expect(presenter.present(window,blue,400,240,RECT{20,20,380,220}), "GPU resources must recreate");
    pump();
    pixel(window,200,120,RGB(0,0,255));
    auto invalid = std::make_shared<WgcFrameCpuBuffer>();
    invalid->width = 640; invalid->height = 360; invalid->stride = 2560;
    invalid->bgra.resize(4);
    expect(!presenter.present(window,invalid,400,240,RECT{0,0,400,240}), "truncated pixels must fail for caller fallback");
    HDC fallback_dc = GetDC(window);
    HBRUSH green = CreateSolidBrush(RGB(0,255,0));
    RECT fallback_rect{0,0,400,240};
    FillRect(fallback_dc,&fallback_rect,green);
    DeleteObject(green);
    ReleaseDC(window,fallback_dc);
    pump();
    pixel(window,200,120,RGB(0,255,0));
    expect(presenter.present(window,red,400,240,RECT{0,0,400,240}), "valid frame must recover after invalid input");
    pump();
    pixel(window,200,120,RGB(255,0,0));
    HWND child = CreateWindowExW(WS_EX_NOPARENTNOTIFY,cls.lpszClassName,L"owned embedded preview",
      WS_CHILD|WS_VISIBLE|WS_CLIPSIBLINGS,20,20,320,180,window,nullptr,cls.hInstance,nullptr);
    expect(child != nullptr, "embedded preview window must exist");
    pump();
    expect(presenter.present(child,blue,320,180,rect), "GPU preview must attach to embedded window");
    pump();
    pixel(child,160,90,RGB(0,0,255));
    presenter.reset();
    DestroyWindow(child);
    std::cout << "Hardware preview: pixels, letterbox, four-way motion, resize, reuse, reset and input bounds passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    result = 1;
  }
  presenter.reset();
  if(window) DestroyWindow(window);
  UnregisterClassW(cls.lpszClassName,cls.hInstance);
  return result;
}
