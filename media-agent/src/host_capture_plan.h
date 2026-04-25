#pragma once

#include <string>

#include "agent_runtime.h"
#include "ffmpeg_probe.h"
#include "wgc_capture.h"

bool resolve_wgc_display_dimensions(const std::string& display_id, int* width, int* height, std::string* error);
bool resolve_wgc_window_dimensions(const std::string& capture_handle, int* width, int* height, std::string* error);
WgcFrameSourceConfig build_wgc_frame_source_config(const HostCapturePlan& plan);
HostCapturePlan build_host_capture_plan(
  const FfmpegProbeResult& ffmpeg,
  const WgcCaptureProbe& wgc_capture,
  const HostPipelineState& pipeline,
  const HostCaptureProcessState& process_state,
  const std::string& capture_kind,
  const std::string& capture_state,
  const std::string& capture_title,
  const std::string& capture_hwnd,
  const std::string& capture_display_id,
  int width,
  int height,
  int frame_rate,
  int bitrate_kbps);
HostCapturePlan validate_host_capture_plan(const FfmpegProbeResult& ffmpeg, HostCapturePlan plan);
