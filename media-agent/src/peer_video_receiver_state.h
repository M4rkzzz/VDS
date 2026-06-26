#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "native_surface_layout.h"

struct AVCodecContext;
struct AVFrame;
struct AVPacket;

class NativeVideoSurface;

struct PeerVideoReceiverRuntime {
  struct PeerAudioDecoderRuntime {
    std::mutex mutex;
    AVCodecContext* context = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* frame = nullptr;
    std::string codec = "none";
    std::string last_error;
  };

  bool surface_attached = false;
  bool running = false;
  bool decoder_ready = false;
  bool closing = false;
  bool local_playback_enabled = false;
  unsigned long process_id = 0;
  unsigned long long decoded_frames_rendered = 0;
  unsigned long long submitted_video_units = 0;
  unsigned long long dispatched_audio_blocks = 0;
  unsigned long long dropped_video_units = 0;
  unsigned long long dropped_audio_blocks = 0;
  double frame_interval_stddev_ms = 0.0;
  std::string peer_id;
  std::string surface_id;
  std::string target;
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-native-video-surface";
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "peer-video-surface-idle";
  std::string last_error;
  std::shared_ptr<NativeVideoSurface> surface;
  std::shared_ptr<PeerAudioDecoderRuntime> audio_decoder_runtime;
  NativeEmbeddedSurfaceLayout surface_layout;
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::vector<std::uint8_t> startup_video_decoder_config_au;
  bool startup_waiting_for_random_access = true;
  std::mutex mutex;
};
