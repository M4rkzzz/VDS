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
