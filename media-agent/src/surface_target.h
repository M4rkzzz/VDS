#pragma once

#include <string>

bool is_host_capture_surface_target(const std::string& target);
bool is_peer_video_surface_target(const std::string& target);
bool is_peer_video_media_source(const std::string& source);
std::string extract_peer_id_from_surface_target(const std::string& target);
std::string extract_peer_id_from_media_source(const std::string& source);
