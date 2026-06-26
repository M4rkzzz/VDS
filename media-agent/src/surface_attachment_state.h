#pragma once

#include <memory>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "native_surface_layout.h"
#include "peer_video_receiver_state.h"
#include "session_lifecycle.h"

class NativeArtifactPreview;
class NativeLivePreview;
class NativeVideoSurface;

struct SurfaceAttachmentState {
  vds::media_agent::SessionPhase phase = vds::media_agent::SessionPhase::Created;
  std::string phase_reason = "surface-created";
  bool attached = false;
  bool running = false;
  bool waiting_for_artifact = false;
  bool decoder_ready = false;
  unsigned long long decoded_frames_rendered = 0;
  double frame_interval_stddev_ms = 0.0;
  unsigned long process_id = 0;
  std::string surface_id;
  std::string target;
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-native-artifact-preview";
  std::string media_path;
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "surface-not-attached";
  std::string last_error;
  std::string peer_id;
  NativeEmbeddedSurfaceLayout surface_layout;
  std::shared_ptr<PeerVideoReceiverRuntime> peer_runtime;
  std::shared_ptr<NativeArtifactPreview> preview_runtime;
  std::shared_ptr<NativeLivePreview> live_preview_runtime;
#ifdef _WIN32
  HANDLE process_handle = nullptr;
  HANDLE thread_handle = nullptr;
#endif
};
