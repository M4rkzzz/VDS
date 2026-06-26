#pragma once

#include <memory>
#include <string>

struct PeerVideoSenderRuntime;

struct PeerMediaBindingState {
  bool attached = false;
  bool active = false;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
  int bitrate_kbps = 0;
  std::string kind = "video";
  std::string source = "unbound";
  std::string codec = "h264";
  std::string video_encoder_backend = "none";
  std::string reason = "peer-media-not-attached";
  std::string last_error;
  unsigned long long source_frames_captured = 0;
  unsigned long long avg_source_copy_resource_us = 0;
  unsigned long long avg_source_map_us = 0;
  unsigned long long avg_source_memcpy_us = 0;
  unsigned long long avg_source_total_readback_us = 0;
  unsigned long long frames_sent = 0;
  std::shared_ptr<PeerVideoSenderRuntime> runtime;
};
