#pragma once

#include <chrono>
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

// Moves the sender's existing sampling decision ahead of GPU readback. Preview
// callers omit it, and changed geometry always reaches the source refresh path.
class WgcFrameReadbackSampler {
 public:
  using Clock = std::chrono::steady_clock;

  WgcFrameReadbackSampler(std::uint64_t frame_interval_us, int width, int height)
      : frame_interval_us_(frame_interval_us > 0 ? frame_interval_us : 1),
        expected_width_(width), expected_height_(height) {}

  bool accept(int width, int height, int stride, std::uint64_t timestamp_100ns,
      Clock::time_point observed_at) {
    if (width != expected_width_ || height != expected_height_ || stride != expected_width_ * 4) {
      return true;
    }
    if (timestamp_100ns > 0) {
      const auto interval_100ns = frame_interval_us_ * 10;
      if (next_timestamp_100ns_ == 0) next_timestamp_100ns_ = timestamp_100ns;
      if (timestamp_100ns < next_timestamp_100ns_) return false;
      // Advance in one operation after a capture stall rather than iterating
      // once for every missed frame. This preserves the original sampling grid.
      next_timestamp_100ns_ +=
        ((timestamp_100ns - next_timestamp_100ns_) / interval_100ns + 1) * interval_100ns;
    } else {
      const auto interval = std::chrono::microseconds(frame_interval_us_);
      if (next_observed_at_ == Clock::time_point{}) next_observed_at_ = observed_at;
      if (observed_at < next_observed_at_) return false;
      next_observed_at_ += ((observed_at - next_observed_at_) / interval + 1) * interval;
    }
    return true;
  }

  void reset() {
    next_timestamp_100ns_ = 0;
    next_observed_at_ = Clock::time_point{};
  }

 private:
  std::uint64_t frame_interval_us_;
  int expected_width_;
  int expected_height_;
  std::uint64_t next_timestamp_100ns_ = 0;
  Clock::time_point next_observed_at_{};
};

class WgcFrameSource {
 public:
  ~WgcFrameSource();

  WgcFrameSource(const WgcFrameSource&) = delete;
  WgcFrameSource& operator=(const WgcFrameSource&) = delete;

  bool wait_for_frame_bgra(int timeout_ms, WgcFrameCpuBuffer* frame, std::string* error,
    WgcFrameReadbackSampler* sampler = nullptr);
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
