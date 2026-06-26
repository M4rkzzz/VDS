#pragma once

#include <string>

struct AudioSessionState;
struct FfmpegProbeResult;
struct HostSessionState;
struct ObsIngestSessionSnapshot;
struct PeerState;

struct HostVideoBindingContext {
  const HostSessionState& host_session;
  const FfmpegProbeResult& ffmpeg;
  const AudioSessionState& audio_session;
  const ObsIngestSessionSnapshot& obs_ingest;
};

bool attach_host_video_media_binding(
  const HostVideoBindingContext& context,
  PeerState& peer,
  std::string* error,
  bool force_restart = false);
bool configure_host_audio_sender(const AudioSessionState& audio_session, PeerState& peer, std::string* error);
void clear_host_audio_sender(PeerState& peer);
