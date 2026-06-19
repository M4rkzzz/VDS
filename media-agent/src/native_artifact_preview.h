#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "native_surface_layout.h"

struct NativeArtifactPreviewConfig {
  std::string surface_id;
  std::string window_title;
  std::string media_path;
  std::string codec = "h264";
  NativeEmbeddedSurfaceLayout layout;
};

struct NativeArtifactPreviewSnapshot {
  bool attached = false;
  bool running = false;
  bool waiting_for_artifact = false;
  bool decoder_ready = false;
  std::uint64_t decoded_frames_rendered = 0;
  unsigned long process_id = 0;
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-native-artifact-preview";
  std::string window_title;
  std::string reason = "surface-not-started";
  std::string last_error;
};

class NativeArtifactPreview {
 public:
  ~NativeArtifactPreview();

  NativeArtifactPreview(const NativeArtifactPreview&) = delete;
  NativeArtifactPreview& operator=(const NativeArtifactPreview&) = delete;

  NativeArtifactPreviewSnapshot snapshot() const;
  bool update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error);
  void close(const std::string& reason);

 private:
  explicit NativeArtifactPreview(NativeArtifactPreviewConfig config);

  friend std::shared_ptr<NativeArtifactPreview> create_native_artifact_preview(
    const NativeArtifactPreviewConfig& config,
    std::string* error
  );

  class Impl;
  std::unique_ptr<Impl> impl_;
};

std::shared_ptr<NativeArtifactPreview> create_native_artifact_preview(
  const NativeArtifactPreviewConfig& config,
  std::string* error
);
