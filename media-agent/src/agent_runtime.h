#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "audio_session_state.h"
#include "ffmpeg_probe_state.h"
#include "host_session_state.h"
#include "obs_ingest_session_state.h"
#include "peer_transport_state.h"
#include "peer_session_state.h"
#include "session_registries.h"
#include "surface_attachment_state.h"
#include "wgc_capture_state.h"

struct AgentRuntimeState {
  HostSessionRegistry host_sessions;
  PeerSessionRegistry peer_sessions;
  SurfaceSessionRegistry surface_sessions;
  PeerTransportBackendInfo peer_transport_backend;
  WgcCaptureProbe wgc_capture_backend;
  FfmpegProbeResult ffmpeg;
  AudioSessionRegistry audio_sessions;
  ObsIngestSessionRegistry obs_ingest_sessions;
};
