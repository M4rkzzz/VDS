#pragma once

#include <string>

struct FfmpegProbeResult;
struct HostCapturePlan;
struct HostPipelineState;
struct PeerState;

bool start_peer_video_sender(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  PeerState& peer,
  std::string* error);
void refresh_peer_media_binding(PeerState& peer);
bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error);
