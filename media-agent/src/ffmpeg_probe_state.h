#pragma once

#include <string>
#include <vector>

struct VideoEncoderProbeResult {
  std::string name;
  bool exists = false;
  bool hardware = false;
  bool validated = false;
  int priority = 0;
  std::string reason;
  std::string error;
};

struct FfmpegProbeResult {
  bool available = false;
  std::string path;
  std::string version;
  std::vector<std::string> video_encoders;
  std::vector<std::string> validated_video_encoders;
  std::vector<VideoEncoderProbeResult> video_encoder_probes;
  std::vector<std::string> audio_encoders;
  std::string error;
};
