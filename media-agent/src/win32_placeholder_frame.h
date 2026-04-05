#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

inline std::vector<std::uint8_t> build_placeholder_frame_bgra(
  int width,
  int height,
  const std::wstring& message
) {
  if (width <= 0 || height <= 0) {
    return {};
  }

  const std::size_t total_bytes =
    static_cast<std::size_t>(width) *
    static_cast<std::size_t>(height) *
    static_cast<std::size_t>(4);
  std::vector<std::uint8_t> output(total_bytes, 0);

#ifdef _WIN32
  BITMAPINFO bitmap_info{};
  bitmap_info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap_info.bmiHeader.biWidth = width;
  bitmap_info.bmiHeader.biHeight = -height;
  bitmap_info.bmiHeader.biPlanes = 1;
  bitmap_info.bmiHeader.biBitCount = 32;
  bitmap_info.bmiHeader.biCompression = BI_RGB;

  void* dib_pixels = nullptr;
  HDC screen_dc = GetDC(nullptr);
  HDC memory_dc = CreateCompatibleDC(screen_dc);
  HBITMAP bitmap = CreateDIBSection(memory_dc, &bitmap_info, DIB_RGB_COLORS, &dib_pixels, nullptr, 0);
  HGDIOBJ previous_bitmap = bitmap ? SelectObject(memory_dc, bitmap) : nullptr;

  if (memory_dc && bitmap && dib_pixels) {
    RECT rect{0, 0, width, height};
    FillRect(memory_dc, &rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

    const int font_height = std::max(18, std::min(height / 10, width / 18));
    HFONT font = CreateFontW(
      -font_height,
      0,
      0,
      0,
      FW_SEMIBOLD,
      FALSE,
      FALSE,
      FALSE,
      DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS,
      CLIP_DEFAULT_PRECIS,
      CLEARTYPE_QUALITY,
      DEFAULT_PITCH | FF_DONTCARE,
      L"Microsoft YaHei UI"
    );
    HGDIOBJ previous_font = font ? SelectObject(memory_dc, font) : nullptr;

    SetBkMode(memory_dc, TRANSPARENT);
    SetTextColor(memory_dc, RGB(155, 155, 155));
    RECT text_rect = rect;
    DrawTextW(
      memory_dc,
      message.c_str(),
      -1,
      &text_rect,
      DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
    );

    std::memcpy(output.data(), dib_pixels, total_bytes);

    if (previous_font) {
      SelectObject(memory_dc, previous_font);
    }
    if (font) {
      DeleteObject(font);
    }
  }

  if (previous_bitmap) {
    SelectObject(memory_dc, previous_bitmap);
  }
  if (bitmap) {
    DeleteObject(bitmap);
  }
  if (memory_dc) {
    DeleteDC(memory_dc);
  }
  if (screen_dc) {
    ReleaseDC(nullptr, screen_dc);
  }
#endif

  return output;
}
