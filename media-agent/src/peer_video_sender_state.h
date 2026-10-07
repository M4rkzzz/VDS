#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "host_media_clock.h"
#include "media_frame_timing.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

struct PeerVideoSenderRuntime {
  bool running = false;
  unsigned long long source_frames_captured = 0;
  unsigned long long source_copy_resource_us_total = 0;
  unsigned long long source_map_us_total = 0;
  unsigned long long source_memcpy_us_total = 0;
  unsigned long long source_total_readback_us_total = 0;
  unsigned long long frames_sent = 0;
  unsigned long long next_frame_timestamp_us = 0;
  bool source_timestamp_valid = false;
  bool uses_wgc_source = false;
  vds::media_agent::HostMediaClockSnapshot source_clock;
  std::deque<std::uint64_t> pending_source_timestamps_us;
  std::uint64_t source_timestamps_discarded = 0;
  std::uint64_t next_video_sequence = 0;
  unsigned long long frame_interval_us = 16666;
  long long last_frame_sent_at_steady_us = -1;
  std::string codec_path = "h264";
  std::string reason = "peer-video-sender-idle";
  std::string last_error;
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::vector<std::uint8_t> cached_video_decoder_config_au;
  bool pending_video_bootstrap = true;
  std::atomic<bool> soft_refresh_requested { false };
  std::atomic<bool> stop_requested { false };
#ifdef _WIN32
  HANDLE process_handle = nullptr;
  HANDLE thread_handle = nullptr;
  HANDLE stdin_write_handle = nullptr;
  HANDLE stdout_read_handle = nullptr;
#endif
  std::thread source_thread;
  std::thread pump_thread;
  std::mutex mutex;
};

namespace vds::media_agent {

inline std::function<std::string(const std::string&)> make_peer_video_sender_keyframe_request_handler(
  std::weak_ptr<PeerVideoSenderRuntime> weak_runtime) {
  return [weak_runtime](const std::string&) -> std::string {
    const auto runtime = weak_runtime.lock();
    if (!runtime || runtime->stop_requested.load(std::memory_order_acquire) ||
        runtime->source_clock.source_epoch != host_media_clock_snapshot().source_epoch) {
      return "host-encoder-unavailable";
    }
    std::lock_guard<std::mutex> lock(runtime->mutex);
    // The encoder is already waiting to deliver a complete fresh bootstrap.
    // Let it finish instead of repeatedly restarting before its first IDR.
    if (runtime->pending_video_bootstrap) return "host-encoder-awaiting-bootstrap";
    runtime->soft_refresh_requested.store(true, std::memory_order_release);
    return "host-encoder-refresh-requested";
  };
}

}  // namespace vds::media_agent
