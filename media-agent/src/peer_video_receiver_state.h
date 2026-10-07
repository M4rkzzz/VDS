#pragma once

#include <cstdint>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "native_surface_layout.h"
#include "media_timestamp_helpers.h"
#include "media_source_epoch.h"

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct AVChannelLayout;
struct SwrContext;

class NativeVideoSurface;

inline std::string next_peer_media_source_generation() {
  static std::atomic<std::uint64_t> generation{0};
  return std::to_string(generation.fetch_add(1, std::memory_order_relaxed) + 1);
}

struct PeerVideoReceiverRuntime {
  struct PeerAudioDecoderRuntime {
    std::mutex mutex;
    AVCodecContext* context = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* frame = nullptr;
    SwrContext* resampler = nullptr;
    AVChannelLayout* resampler_input_layout = nullptr;
    int resampler_input_rate = 0;
    int resampler_input_format = -1;
    std::string codec = "none";
    std::string timing_source_id;
    bool submitted_timing_valid = false;
    std::uint64_t submitted_timestamp_us = 0;
    bool submitted_sequence_valid = false;
    std::uint64_t submitted_sequence = 0;
    std::string last_error;
  };

  bool surface_attached = false;
  bool running = false;
  bool decoder_ready = false;
  bool closing = false;
  bool local_playback_enabled = false;
  unsigned long process_id = 0;
  unsigned long long decoded_frames_rendered = 0;
  std::uint64_t decoded_frames = 0;
  std::uint64_t painted_frames = 0;
  std::uint64_t dropped_decoded_frames = 0;
  std::uint64_t dropped_encoded_frames = 0;
  std::uint64_t reference_chain_resets = 0;
  std::uint64_t decode_late_frames = 0;
  std::uint64_t presentation_late_frames = 0;
  double max_decode_lateness_ms = 0.0;
  double max_presentation_lateness_ms = 0.0;
  unsigned int pending_decoded_frames = 0;
  unsigned int pending_encoded_frames = 0;
  unsigned int expected_video_frame_rate = 0;
  unsigned int buffer_delay_ms = 20;
  bool needs_keyframe = false;
  unsigned long long submitted_video_units = 0;
  unsigned long long dispatched_audio_blocks = 0;
  unsigned long long dropped_video_units = 0;
  unsigned long long dropped_audio_blocks = 0;
  double frame_interval_stddev_ms = 0.0;
  std::string peer_id;
  const std::string source_generation = next_peer_media_source_generation();
  vds::media_agent::MediaSourceEpochGate source_epochs;
  std::uint64_t retired_epoch_frames_dropped = 0;
  std::function<void(const std::string&)> on_keyframe_needed;
  vds::media_agent::RtpTimestampUnwrapper video_rtp_timestamps;
  std::string video_rtp_codec;
  std::string active_video_source_id;
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
  bool surface_keyframe_wait_observed = false;
  std::uint64_t surface_reference_chain_resets_observed = 0;
  // Source transitions and decoder submission must be ordered across the
  // independent audio/video callbacks of the same transport.
  std::mutex media_dispatch_mutex;
  std::mutex mutex;
};
