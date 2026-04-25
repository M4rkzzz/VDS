#include "native_surface_layout.h"

#include <sstream>

#include "json_protocol.h"

NativeEmbeddedSurfaceLayout build_surface_layout_from_json(const std::string& json) {
  NativeEmbeddedSurfaceLayout layout;
  layout.embedded = vds::media_agent::extract_bool_value(json, "embedded", false);
  layout.visible = vds::media_agent::extract_bool_value(json, "visible", true);
  layout.parent_window_handle = vds::media_agent::extract_string_value(json, "parentWindowHandle");
  layout.x = vds::media_agent::extract_int_value(json, "x", 0);
  layout.y = vds::media_agent::extract_int_value(json, "y", 0);
  layout.width = vds::media_agent::extract_int_value(json, "width", 0);
  layout.height = vds::media_agent::extract_int_value(json, "height", 0);
  return layout;
}

std::string surface_layout_json(const NativeEmbeddedSurfaceLayout& layout) {
  std::ostringstream payload;
  payload
    << "{\"embedded\":" << (layout.embedded ? "true" : "false")
    << ",\"visible\":" << (layout.visible ? "true" : "false")
    << ",\"parentWindowHandle\":\"" << vds::media_agent::json_escape(layout.parent_window_handle) << "\""
    << ",\"x\":" << layout.x
    << ",\"y\":" << layout.y
    << ",\"width\":" << layout.width
    << ",\"height\":" << layout.height
    << "}";
  return payload.str();
}
