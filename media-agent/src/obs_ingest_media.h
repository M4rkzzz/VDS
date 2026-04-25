#pragma once

#include <cstdint>
#include <vector>

extern "C" {
#include <libavcodec/codec_par.h>
#include <libavcodec/packet.h>
#include <libavformat/avformat.h>
}

struct ParsedAacConfig {
  int audio_object_type = 2;
  int sample_rate = 48000;
  int sample_rate_index = 3;
  int channel_count = 2;
};

int aac_sample_rate_index(int sample_rate);
ParsedAacConfig parse_aac_config(const AVCodecParameters* codecpar);
std::vector<std::uint8_t> build_adts_framed_aac(
  const std::uint8_t* data,
  std::size_t size,
  const ParsedAacConfig& config);
std::int64_t packet_timestamp_us(const AVStream* stream, const AVPacket* packet);
std::uint32_t packet_timestamp_at_clock_rate(
  const AVStream* stream,
  const AVPacket* packet,
  int clock_rate);
