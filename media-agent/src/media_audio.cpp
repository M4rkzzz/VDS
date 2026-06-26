#include "media_audio.h"

#include <algorithm>
#include <mutex>

#include "audio_transport_config.h"
#include "string_utils.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/samplefmt.h>
}

namespace {

std::int16_t ulaw_to_linear16_sample(std::uint8_t value) {
  value = static_cast<std::uint8_t>(~value);
  const int sign = value & 0x80;
  const int exponent = (value >> 4) & 0x07;
  const int mantissa = value & 0x0f;

  int sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return static_cast<std::int16_t>(sign ? -sample : sample);
}

bool ensure_peer_audio_decoder_runtime(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::string& codec_name,
  std::string* error) {
  if (!runtime_ptr) {
    if (error) {
      *error = "peer-audio-runtime-missing";
    }
    return false;
  }

  if (!runtime_ptr->audio_decoder_runtime) {
    runtime_ptr->audio_decoder_runtime = std::make_shared<PeerVideoReceiverRuntime::PeerAudioDecoderRuntime>();
  }

  auto& decoder = *runtime_ptr->audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  const std::string normalized_codec = vds::media_agent::to_lower_copy(codec_name);
  if (decoder.context && decoder.packet && decoder.frame && decoder.codec == normalized_codec) {
    return true;
  }

  if (decoder.frame) {
    av_frame_free(&decoder.frame);
  }
  if (decoder.packet) {
    av_packet_free(&decoder.packet);
  }
  if (decoder.context) {
    avcodec_free_context(&decoder.context);
  }
  decoder.codec = "none";

  const AVCodec* codec = nullptr;
  AVCodecID codec_id = AV_CODEC_ID_NONE;
  if (normalized_codec == "aac") {
    codec_id = AV_CODEC_ID_AAC;
    codec = avcodec_find_decoder(codec_id);
  } else {
    codec_id = AV_CODEC_ID_OPUS;
    codec = avcodec_find_decoder_by_name("libopus");
    if (!codec) {
      codec = avcodec_find_decoder(codec_id);
    }
  }
  if (!codec) {
    if (error) {
      *error = normalized_codec == "aac" ? "aac-decoder-unavailable" : "opus-decoder-unavailable";
    }
    return false;
  }

  AVCodecContext* context = avcodec_alloc_context3(codec);
  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  if (!context || !packet || !frame) {
    if (context) {
      avcodec_free_context(&context);
    }
    if (packet) {
      av_packet_free(&packet);
    }
    if (frame) {
      av_frame_free(&frame);
    }
    if (error) {
      *error = normalized_codec == "aac" ? "aac-decoder-allocation-failed" : "opus-decoder-allocation-failed";
    }
    return false;
  }

  context->sample_rate = kTransportAudioSampleRate;
  av_channel_layout_default(&context->ch_layout, kTransportAudioChannelCount);
  if (avcodec_open2(context, codec, nullptr) < 0) {
    avcodec_free_context(&context);
    av_packet_free(&packet);
    av_frame_free(&frame);
    if (error) {
      *error = normalized_codec == "aac" ? "aac-decoder-open-failed" : "opus-decoder-open-failed";
    }
    return false;
  }

  decoder.context = context;
  decoder.packet = packet;
  decoder.frame = frame;
  decoder.codec = normalized_codec;
  decoder.last_error.clear();
  return true;
}

} // namespace

std::vector<std::int16_t> decode_pcmu_to_pcm16(const std::vector<std::uint8_t>& encoded) {
  std::vector<std::int16_t> decoded;
  decoded.reserve(encoded.size());
  for (const std::uint8_t value : encoded) {
    decoded.push_back(ulaw_to_linear16_sample(value));
  }
  return decoded;
}

void reset_peer_audio_decoder_runtime(PeerVideoReceiverRuntime& runtime) {
  if (!runtime.audio_decoder_runtime) {
    return;
  }

  auto& decoder = *runtime.audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  if (decoder.frame) {
    av_frame_free(&decoder.frame);
  }
  if (decoder.packet) {
    av_packet_free(&decoder.packet);
  }
  if (decoder.context) {
    avcodec_free_context(&decoder.context);
  }
  decoder.codec = "none";
  decoder.last_error.clear();
}

std::vector<std::int16_t> decode_audio_to_pcm16(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  const std::string& codec_name,
  std::string* error) {
  std::vector<std::int16_t> pcm;
  const std::string normalized_codec = vds::media_agent::to_lower_copy(codec_name);
  if (!ensure_peer_audio_decoder_runtime(runtime_ptr, normalized_codec, error)) {
    return pcm;
  }

  auto& decoder = *runtime_ptr->audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  decoder.packet->data = const_cast<std::uint8_t*>(encoded.data());
  decoder.packet->size = static_cast<int>(encoded.size());

  const int send_result = avcodec_send_packet(decoder.context, decoder.packet);
  if (send_result < 0) {
    if (error) {
      *error = normalized_codec == "aac" ? "aac-decoder-send-failed" : "opus-decoder-send-failed";
    }
    av_packet_unref(decoder.packet);
    return pcm;
  }
  av_packet_unref(decoder.packet);

  while (true) {
    const int receive_result = avcodec_receive_frame(decoder.context, decoder.frame);
    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      break;
    }
    if (receive_result < 0) {
      if (error) {
        *error = normalized_codec == "aac" ? "aac-decoder-receive-failed" : "opus-decoder-receive-failed";
      }
      break;
    }

    const int channel_count = decoder.frame->ch_layout.nb_channels > 0
      ? decoder.frame->ch_layout.nb_channels
      : kTransportAudioChannelCount;
    const int sample_count = decoder.frame->nb_samples;
    const AVSampleFormat sample_format = static_cast<AVSampleFormat>(decoder.frame->format);

    const auto append_interleaved_s16 = [&](auto read_sample) {
      const std::size_t start = pcm.size();
      pcm.resize(start + static_cast<std::size_t>(sample_count) * channel_count);
      for (int sample_index = 0; sample_index < sample_count; ++sample_index) {
        for (int channel_index = 0; channel_index < channel_count; ++channel_index) {
          pcm[start + static_cast<std::size_t>(sample_index) * channel_count + channel_index] =
            read_sample(sample_index, channel_index);
        }
      }
    };

    if (sample_format == AV_SAMPLE_FMT_S16) {
      const auto* interleaved = reinterpret_cast<const std::int16_t*>(decoder.frame->data[0]);
      append_interleaved_s16([&](int sample_index, int channel_index) {
        return interleaved[sample_index * channel_count + channel_index];
      });
    } else if (sample_format == AV_SAMPLE_FMT_S16P) {
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const auto* plane = reinterpret_cast<const std::int16_t*>(decoder.frame->data[channel_index]);
        return plane[sample_index];
      });
    } else if (sample_format == AV_SAMPLE_FMT_FLT) {
      const auto* interleaved = reinterpret_cast<const float*>(decoder.frame->data[0]);
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const float value = interleaved[sample_index * channel_count + channel_index] * 32767.0f;
        return static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, value)));
      });
    } else if (sample_format == AV_SAMPLE_FMT_FLTP) {
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const auto* plane = reinterpret_cast<const float*>(decoder.frame->data[channel_index]);
        const float value = plane[sample_index] * 32767.0f;
        return static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, value)));
      });
    } else {
      if (error) {
        *error = normalized_codec == "aac"
          ? "aac-decoder-unsupported-sample-format"
          : "opus-decoder-unsupported-sample-format";
      }
      av_frame_unref(decoder.frame);
      pcm.clear();
      return pcm;
    }

    av_frame_unref(decoder.frame);
  }

  return pcm;
}
