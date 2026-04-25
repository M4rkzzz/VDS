#pragma once

#include <string>

#include "agent_runtime.h"

HostCaptureProcessState build_host_capture_process_state();
std::string host_capture_process_json(HostCaptureProcessState& state);
HostCaptureArtifactProbe probe_host_capture_artifact(
  const FfmpegProbeResult& ffmpeg,
  const HostCaptureProcessState& host_capture_process,
  HostCaptureArtifactProbe previous_probe = {});
void persist_host_capture_process_manifest(
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState& state,
  const HostCaptureArtifactProbe& artifact_probe);
void refresh_host_capture_process_state(HostCaptureProcessState& state);
void stop_host_capture_process(
  HostCaptureProcessState& state,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureArtifactProbe& artifact_probe,
  const std::string& reason);
HostCaptureProcessState start_host_capture_process(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState state);
