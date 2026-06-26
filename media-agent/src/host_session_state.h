#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

struct HostPipelineState {
  bool ready = false;
  bool hardware = false;
  bool validated = false;
  bool prefer_hardware = true;
  std::string requested_video_codec = "h264";
  std::string requested_video_encoder;
  std::string requested_preset = "balanced";
  std::string requested_tune;
  std::string requested_keyframe_policy = "2s";
  std::string selected_video_encoder;
  std::string video_encoder_backend = "none";
  std::string selected_audio_encoder;
  std::string reason = "pipeline-not-initialized";
  std::string validation_reason = "pipeline-not-validated";
  std::string last_error;
};

struct HostCapturePlan {
  bool ready = false;
  bool validated = false;
  std::string capture_kind = "window";
  std::string capture_state = "normal";
  std::string capture_backend = "gdigrab";
  std::string capture_handle;
  std::string capture_title;
  std::string capture_display_id = "0";
  int width = 1920;
  int height = 1080;
  int frame_rate = 60;
  int bitrate_kbps = 10000;
  int input_width = 0;
  int input_height = 0;
  std::string input_format;
  std::string input_target;
  std::string codec_path = "h264";
  std::string reason = "capture-plan-not-initialized";
  std::string validation_reason = "capture-plan-not-validated";
  std::string last_error;
};

struct HostCaptureProcessState {
  bool enabled = false;
  bool running = false;
  bool preserve_output = false;
  unsigned long process_id = 0;
  unsigned long long output_bytes = 0;
  long long started_at_unix_ms = 0;
  long long updated_at_unix_ms = 0;
  long long stopped_at_unix_ms = 0;
  std::string container = "mpegts";
  std::string session_id;
  std::string output_directory;
  std::string output_path;
  std::string manifest_path;
  std::string reason = "host-capture-process-disabled";
  std::string last_error;
  std::string command_line;
#ifdef _WIN32
  HANDLE process_handle = nullptr;
  HANDLE thread_handle = nullptr;
#endif
};

struct HostCaptureArtifactProbe {
  bool ready = false;
  unsigned long long file_size_bytes = 0;
  int width = 0;
  int height = 0;
  std::string video_codec;
  std::string reason = "artifact-not-probed";
  std::string last_error;
};

struct HostSessionState {
  bool running = false;
  std::string backend = "native";
  std::string capture_target_id;
  std::string requested_codec = "h264";
  std::string codec = "h264";
  bool hardware_acceleration = true;
  std::string video_encoder_preference;
  std::string encoder_preset = "balanced";
  std::string encoder_tune;
  std::string keyframe_policy = "2s";
  std::string capture_kind = "window";
  std::string capture_state = "normal";
  std::string capture_title;
  std::string capture_hwnd;
  std::string capture_display_id;
  bool window_restore_placeholder_active = false;
  int width = 1920;
  int height = 1080;
  int frame_rate = 60;
  int bitrate_kbps = 10000;
  HostPipelineState pipeline;
  HostCapturePlan capture_plan;
  HostCaptureProcessState capture_process;
  HostCaptureArtifactProbe capture_artifact;
};
