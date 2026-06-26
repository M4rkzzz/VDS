#pragma once

#include <string>

struct WgcCaptureProbe {
  bool available = false;
  bool implemented = false;
  bool platform_supported = false;
  bool display_capture_supported = false;
  bool window_capture_supported = false;
  std::string implementation = "windows-graphics-capture";
  std::string reason = "wgc-backend-not-implemented-yet";
  std::string last_error;
};
