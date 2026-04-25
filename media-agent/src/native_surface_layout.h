#pragma once

#include <string>

struct NativeEmbeddedSurfaceLayout {
  bool embedded = false;
  bool visible = true;
  std::string parent_window_handle;
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

NativeEmbeddedSurfaceLayout build_surface_layout_from_json(const std::string& json);
std::string surface_layout_json(const NativeEmbeddedSurfaceLayout& layout);
