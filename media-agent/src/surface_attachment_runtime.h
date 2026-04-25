#pragma once

#include <memory>
#include <string>

#include "agent_runtime.h"

void refresh_surface_attachment_state(SurfaceAttachmentState& state);
SurfaceAttachmentState start_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  const HostCapturePlan& host_capture_plan,
  const HostCaptureProcessState& host_capture_process,
  const HostCaptureArtifactProbe& host_capture_artifact,
  SurfaceAttachmentState state
);
void stop_surface_attachment(SurfaceAttachmentState& state, const std::string& reason);
bool update_surface_attachment_layout(
  SurfaceAttachmentState& state,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error
);
bool start_peer_video_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  PeerState::PeerVideoReceiverRuntime& runtime,
  std::string* error
);
bool restart_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, std::string* error);
void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason);
bool update_peer_video_surface_layout(
  PeerState::PeerVideoReceiverRuntime& runtime,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error
);
bool is_peer_video_surface_shutdown_reason(const std::string& reason);
void sync_surface_attachment_from_peer_runtime(
  SurfaceAttachmentState& state,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime
);
std::string surface_attachment_json(SurfaceAttachmentState& state);
std::string build_surface_result_json(SurfaceAttachmentState& state);
std::string build_surface_attachments_json(AgentRuntimeState& state);
