#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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
  unsigned long long frame_interval_us = 16666;
  long long next_frame_send_deadline_steady_us = -1;
  long long last_frame_sent_at_steady_us = -1;
  std::string codec_path = "h264";
  std::string reason = "peer-video-sender-idle";
  std::string last_error;
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::vector<std::uint8_t> cached_video_decoder_config_au;
  std::vector<std::uint8_t> cached_video_random_access_au;
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
