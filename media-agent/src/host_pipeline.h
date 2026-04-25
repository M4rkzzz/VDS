#pragma once

#include <string>

#include "agent_runtime.h"

std::string build_ffmpeg_host_capture_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureProcessState& process_state);
bool is_h264_video_encoder(const std::string& encoder);
bool is_h265_video_encoder(const std::string& encoder);
int normalize_host_output_dimension(int value, int fallback);
std::string infer_video_encoder_backend(const std::string& encoder);
std::string normalize_host_encoder_preset(const std::string& preset);
std::string normalize_host_encoder_tune(const std::string& tune);
std::string normalize_host_keyframe_policy(const std::string& policy);
std::string build_ffmpeg_peer_video_sender_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan);
HostPipelineState select_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune);
HostPipelineState select_and_validate_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune);
