#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct EncodedFrame {
  std::string upstream_peer_id;
  std::string stream_type;
  std::string codec;
  std::uint32_t rtp_timestamp = 0;
  std::uint64_t timestamp_us = 0;
  bool keyframe = false;
  bool config = false;
  std::vector<std::uint8_t> payload;
};

struct EncodedFrameBatch {
  std::string upstream_peer_id;
  std::string stream_type;
  std::string codec;
  std::uint32_t rtp_timestamp = 0;
  std::uint64_t timestamp_us = 0;
  std::vector<std::vector<std::uint8_t>> payloads;
};

class EncodedFrameBus {
 public:
  using VideoBatchHandler = std::function<void(const EncodedFrameBatch&)>;
  using AudioFrameHandler = std::function<void(const EncodedFrame&)>;

  void set_video_handler(VideoBatchHandler handler);
  void set_audio_handler(AudioFrameHandler handler);

  void publish_video(const EncodedFrameBatch& batch) const;
  void publish_audio(const EncodedFrame& frame) const;

 private:
  VideoBatchHandler video_handler_;
  AudioFrameHandler audio_handler_;
};
