#include "surface_target.h"

#include "json_protocol.h"
#include "string_utils.h"

bool is_host_capture_surface_target(const std::string& target) {
  const std::string normalized = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(target));
  return normalized == "host-capture-artifact" ||
    normalized == "host-capture-preview" ||
    normalized == "host-session-artifact";
}

bool is_peer_video_surface_target(const std::string& target) {
  const std::string normalized = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(target));
  return normalized.rfind("peer-video:", 0) == 0;
}

bool is_peer_video_media_source(const std::string& source) {
  return is_peer_video_surface_target(source);
}

std::string extract_peer_id_from_surface_target(const std::string& target) {
  const std::string trimmed = vds::media_agent::trim_copy(target);
  const std::string lowered = vds::media_agent::to_lower_copy(trimmed);
  const std::string prefix = "peer-video:";
  if (lowered.rfind(prefix, 0) != 0 || trimmed.size() <= prefix.size()) {
    return {};
  }
  return trimmed.substr(prefix.size());
}

std::string extract_peer_id_from_media_source(const std::string& source) {
  return extract_peer_id_from_surface_target(source);
}
