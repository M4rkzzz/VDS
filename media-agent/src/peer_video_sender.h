#pragma once

#include <string>

#include "agent_runtime.h"

#ifdef _WIN32
void close_peer_video_sender_handles(PeerState::PeerVideoSenderRuntime& runtime);
#endif
bool start_peer_video_sender(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  PeerState& peer,
  std::string* error);
void refresh_peer_media_binding(PeerState& peer);
bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error);
