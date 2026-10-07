#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "native_surface_layout.h"
#include "media_frame_timing.h"

struct NativeVideoSurfaceConfig {
  std::string surface_id;
  std::string window_title;
  std::string codec = "h264";
  // Source cadence sizes the compressed jitter backlog; this is not an FPS cap.
  unsigned int frame_rate = 0;
  NativeEmbeddedSurfaceLayout layout;
  std::function<void(const std::string&)> on_keyframe_needed;
};

struct NativeVideoSurfaceSnapshot {
  bool attached = false;
  bool running = false;
  bool decoder_ready = false;
  std::uint64_t decoded_frames_rendered = 0;
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
  unsigned int buffer_delay_ms = 20;
  bool needs_keyframe = false;
  double frame_interval_stddev_ms = 0.0;
  unsigned long process_id = 0;
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-win32-gdi-surface";
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "surface-not-started";
  std::string last_error;
};

class NativeVideoSurface {
 public:
  ~NativeVideoSurface();

  NativeVideoSurface(const NativeVideoSurface&) = delete;
  NativeVideoSurface& operator=(const NativeVideoSurface&) = delete;

  bool submit_encoded_frame(const std::vector<std::uint8_t>& frame, const std::string& codec, std::string* error);
  bool submit_encoded_frame(const std::vector<std::uint8_t>& frame, const std::string& codec,
    const MediaFrameTiming& timing, std::string* error);
  NativeVideoSurfaceSnapshot snapshot() const;
  bool update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error);
  void close(const std::string& reason);

 private:
  explicit NativeVideoSurface(NativeVideoSurfaceConfig config);

  friend std::shared_ptr<NativeVideoSurface> create_native_video_surface(
    const NativeVideoSurfaceConfig& config,
    std::string* error
  );

  class Impl;

  std::unique_ptr<Impl> impl_;
};

std::shared_ptr<NativeVideoSurface> create_native_video_surface(
  const NativeVideoSurfaceConfig& config,
  std::string* error
);
