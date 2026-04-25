#pragma once

#include <string>
#include <vector>

#include "agent_runtime.h"

namespace vds::media_agent {

FfmpegProbeResult probe_ffmpeg(const std::string& agent_binary_path);
std::string ffmpeg_probe_json(const FfmpegProbeResult& probe);

std::string select_preferred_audio_encoder(const std::vector<std::string>& audio_encoders);
bool encoder_exists_for_runtime(const FfmpegProbeResult& ffmpeg, const std::string& target);
std::string normalize_video_encoder_preference(const std::string& encoder);
bool video_encoder_matches_codec(const std::string& encoder, const std::string& requested_codec);
bool is_hardware_video_encoder(const std::string& encoder);
CommandResult run_ffmpeg_encoder_self_test(
  const FfmpegProbeResult& ffmpeg,
  const std::string& video_encoder,
  const std::string& audio_encoder);

}  // namespace vds::media_agent
