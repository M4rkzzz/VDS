#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "native_surface_layout.h"

struct NativeVideoSurfaceConfig {
  std::string surface_id;
  std::string window_title;
  std::string codec = "h264";
  NativeEmbeddedSurfaceLayout layout;
};

struct NativeVideoSurfaceSnapshot {
  bool attached = false;
  bool launch_attempted = false;
  bool running = false;
  bool decoder_ready = false;
  std::uint64_t decoded_frames_rendered = 0;
  double frame_interval_stddev_ms = 0.0;
  std::int64_t last_decoded_frame_at_unix_ms = -1;
  unsigned long process_id = 0;
  unsigned long thread_id = 0;
  std::string preview_surface_backend = "native-win32-gdi";
  std::string decoder_backend = "none";
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
