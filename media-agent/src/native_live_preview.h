#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "native_surface_layout.h"

struct NativeLivePreviewConfig {
  std::string surface_id;
  std::string window_title;
  std::string target_kind = "display";
  std::string display_id = "0";
  std::string window_handle;
  NativeEmbeddedSurfaceLayout layout;
};

struct NativeLivePreviewSnapshot {
  bool attached = false;
  bool launch_attempted = false;
  bool running = false;
  bool waiting_for_artifact = false;
  bool decoder_ready = false;
  std::uint64_t decoded_frames_rendered = 0;
  std::int64_t last_decoded_frame_at_unix_ms = -1;
  unsigned long process_id = 0;
  std::string preview_surface_backend = "native-win32-gdi";
  std::string decoder_backend = "wgc-bgra";
  std::string codec_path = "bgra";
  std::string implementation = "wgc-live-preview";
  std::string media_path;
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "surface-not-started";
  std::string last_error;
};

class NativeLivePreview {
 public:
  ~NativeLivePreview();

  NativeLivePreview(const NativeLivePreview&) = delete;
  NativeLivePreview& operator=(const NativeLivePreview&) = delete;

  NativeLivePreviewSnapshot snapshot() const;
  bool update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error);
  void close(const std::string& reason);

 private:
  explicit NativeLivePreview(NativeLivePreviewConfig config);

  friend std::shared_ptr<NativeLivePreview> create_native_live_preview(
    const NativeLivePreviewConfig& config,
    std::string* error
  );

  class Impl;
  std::unique_ptr<Impl> impl_;
};

std::shared_ptr<NativeLivePreview> create_native_live_preview(
  const NativeLivePreviewConfig& config,
  std::string* error
);
