#include "obs_ingest_media.h"

#include <algorithm>
#include <cstring>

extern "C" {
#include <libavutil/avutil.h>
}

int aac_sample_rate_index(int sample_rate) {
  switch (sample_rate) {
    case 96000: return 0;
    case 88200: return 1;
    case 64000: return 2;
    case 48000: return 3;
    case 44100: return 4;
    case 32000: return 5;
    case 24000: return 6;
    case 22050: return 7;
    case 16000: return 8;
    case 12000: return 9;
    case 11025: return 10;
    case 8000: return 11;
    case 7350: return 12;
    default: return 3;
  }
}

ParsedAacConfig parse_aac_config(const AVCodecParameters* codecpar) {
  ParsedAacConfig config;
  if (codecpar) {
    if (codecpar->sample_rate > 0) {
      config.sample_rate = codecpar->sample_rate;
      config.sample_rate_index = aac_sample_rate_index(codecpar->sample_rate);
    }
    if (codecpar->ch_layout.nb_channels > 0) {
      config.channel_count = codecpar->ch_layout.nb_channels;
    }

    if (codecpar->extradata && codecpar->extradata_size >= 2) {
      const std::uint8_t byte0 = codecpar->extradata[0];
      const std::uint8_t byte1 = codecpar->extradata[1];
      const int audio_object_type = (byte0 >> 3) & 0x1F;
      const int sampling_index = ((byte0 & 0x07) << 1) | ((byte1 >> 7) & 0x01);
      const int channel_config = (byte1 >> 3) & 0x0F;
      if (audio_object_type > 0) {
        config.audio_object_type = audio_object_type;
      }
      if (sampling_index >= 0 && sampling_index <= 12) {
        config.sample_rate_index = sampling_index;
      }
      if (channel_config > 0) {
        config.channel_count = channel_config;
      }
    }
  }
  return config;
}

std::vector<std::uint8_t> build_adts_framed_aac(
  const std::uint8_t* data,
  std::size_t size,
  const ParsedAacConfig& config) {
  std::vector<std::uint8_t> framed;
  if (!data || size == 0) {
    return framed;
  }

  const bool looks_like_adts =
    size >= 7 &&
    data[0] == 0xFF &&
    (data[1] & 0xF0) == 0xF0;
  if (looks_like_adts) {
    framed.assign(data, data + size);
    return framed;
  }

  const int profile = std::max(1, config.audio_object_type) - 1;
  const int sample_rate_index = std::max(0, std::min(12, config.sample_rate_index));
  const int channel_config = std::max(1, std::min(7, config.channel_count));
  const int full_frame_length = static_cast<int>(size) + 7;

  framed.resize(size + 7);
  framed[0] = 0xFF;
  framed[1] = 0xF1;
  framed[2] = static_cast<std::uint8_t>(((profile & 0x03) << 6) | ((sample_rate_index & 0x0F) << 2) | ((channel_config >> 2) & 0x01));
  framed[3] = static_cast<std::uint8_t>(((channel_config & 0x03) << 6) | ((full_frame_length >> 11) & 0x03));
  framed[4] = static_cast<std::uint8_t>((full_frame_length >> 3) & 0xFF);
  framed[5] = static_cast<std::uint8_t>(((full_frame_length & 0x07) << 5) | 0x1F);
  framed[6] = 0xFC;
  std::memcpy(framed.data() + 7, data, size);
  return framed;
}

std::int64_t packet_timestamp_us(const AVStream* stream, const AVPacket* packet) {
  if (!stream || !packet) {
    return 0;
  }
  const std::int64_t best_ts = packet->pts != AV_NOPTS_VALUE
    ? packet->pts
    : packet->dts;
  if (best_ts == AV_NOPTS_VALUE) {
    return 0;
  }
  return av_rescale_q(best_ts, stream->time_base, AVRational{ 1, 1000000 });
}

std::uint32_t packet_timestamp_at_clock_rate(
  const AVStream* stream,
  const AVPacket* packet,
  int clock_rate) {
  if (!stream || !packet || clock_rate <= 0) {
    return 0;
  }
  const std::int64_t best_ts = packet->pts != AV_NOPTS_VALUE
    ? packet->pts
    : packet->dts;
  if (best_ts == AV_NOPTS_VALUE) {
    return 0;
  }
  const std::int64_t scaled = av_rescale_q(best_ts, stream->time_base, AVRational{ clock_rate, 1 });
  return static_cast<std::uint32_t>(scaled & 0xFFFFFFFFu);
}
