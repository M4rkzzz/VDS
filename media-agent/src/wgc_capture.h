#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "wgc_capture_state.h"

struct WgcFrameSourceConfig {
  std::string target_kind = "display";
  std::string display_id = "0";
  std::string window_handle;
  int frame_rate = 30;
  bool with_cursor = true;
  bool with_border = false;
};

struct WgcFrameCpuBuffer {
  int width = 0;
  int height = 0;
  int stride = 0;
  std::uint64_t timestamp_100ns = 0;
  std::uint64_t copy_resource_us = 0;
  std::uint64_t map_us = 0;
  std::uint64_t memcpy_us = 0;
  std::uint64_t total_readback_us = 0;
  std::vector<std::uint8_t> bgra;
};

class WgcFrameSource {
 public:
  ~WgcFrameSource();

  WgcFrameSource(const WgcFrameSource&) = delete;
  WgcFrameSource& operator=(const WgcFrameSource&) = delete;

  bool wait_for_frame_bgra(int timeout_ms, WgcFrameCpuBuffer* frame, std::string* error);
  void close();

 private:
  class Impl;
  friend std::shared_ptr<WgcFrameSource> create_wgc_frame_source(
    const WgcFrameSourceConfig& config,
    std::string* error
  );

  explicit WgcFrameSource(std::unique_ptr<Impl> impl);

  std::unique_ptr<Impl> impl_;
};

WgcCaptureProbe probe_wgc_capture_backend();

std::shared_ptr<WgcFrameSource> create_wgc_frame_source(
  const WgcFrameSourceConfig& config,
  std::string* error
);
