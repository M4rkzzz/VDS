#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct ObsIngestState {
  bool prepared = false;
  bool waiting = false;
  bool ingest_connected = false;
  bool stream_running = false;
  int port = 0;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
  int audio_sample_rate = 48000;
  int audio_channel_count = 2;
  unsigned long long video_packets_received = 0;
  std::string url;
  std::string listen_url;
  std::string video_codec = "h264";
  std::string audio_codec = "aac";
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::atomic<bool> stop_requested { false };
  mutable std::mutex mutex;
  std::thread worker;
};
