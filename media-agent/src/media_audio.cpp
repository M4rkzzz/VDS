#include "media_audio.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <mutex>

#include "audio_transport_config.h"
#include "string_utils.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/mathematics.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

namespace {

void reset_audio_resampler(PeerVideoReceiverRuntime::PeerAudioDecoderRuntime& decoder) {
  if (decoder.resampler) { swr_free(&decoder.resampler); }
  if (decoder.resampler_input_layout) {
    av_channel_layout_uninit(decoder.resampler_input_layout);
    delete decoder.resampler_input_layout;
    decoder.resampler_input_layout = nullptr;
  }
  decoder.resampler_input_rate = 0;
  decoder.resampler_input_format = -1;
}

bool ensure_audio_resampler(PeerVideoReceiverRuntime::PeerAudioDecoderRuntime& decoder,
                            int sample_rate, AVSampleFormat sample_format) {
  AVChannelLayout input_layout{};
  if (decoder.frame->ch_layout.nb_channels > 0) {
    if (av_channel_layout_copy(&input_layout, &decoder.frame->ch_layout) < 0) { return false; }
  } else { av_channel_layout_default(&input_layout, kTransportAudioChannelCount); }
  if (decoder.resampler && decoder.resampler_input_layout &&
      decoder.resampler_input_rate == sample_rate && decoder.resampler_input_format == sample_format &&
      av_channel_layout_compare(decoder.resampler_input_layout, &input_layout) == 0) {
    av_channel_layout_uninit(&input_layout);
    return true;
  }
  reset_audio_resampler(decoder);
  AVChannelLayout output_layout{};
  av_channel_layout_default(&output_layout, kTransportAudioChannelCount);
  const auto allocation_result = swr_alloc_set_opts2(&decoder.resampler, &output_layout,
    AV_SAMPLE_FMT_S16, kTransportAudioSampleRate, &input_layout, sample_format, sample_rate, 0, nullptr);
  av_channel_layout_uninit(&output_layout);
  if (allocation_result < 0 || !decoder.resampler || swr_init(decoder.resampler) < 0) {
    av_channel_layout_uninit(&input_layout);
    reset_audio_resampler(decoder);
    return false;
  }
  decoder.resampler_input_layout = new AVChannelLayout{};
  if (av_channel_layout_copy(decoder.resampler_input_layout, &input_layout) < 0) {
    av_channel_layout_uninit(&input_layout);
    reset_audio_resampler(decoder);
    return false;
  }
  av_channel_layout_uninit(&input_layout);
  decoder.resampler_input_rate = sample_rate;
  decoder.resampler_input_format = sample_format;
  return true;
}

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
  reset_audio_resampler(decoder);

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
  context->pkt_timebase = {1, 1000000};
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
  decoder.timing_source_id.clear();
  decoder.submitted_timing_valid = false;
  decoder.submitted_sequence_valid = false;
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
  reset_audio_resampler(decoder);
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
  decoder.timing_source_id.clear();
  decoder.submitted_timing_valid = false;
  decoder.submitted_sequence_valid = false;
}

std::vector<DecodedAudioPcmBlock> decode_audio_to_pcm_blocks(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  const std::string& codec_name,
  const MediaFrameTiming& timing,
  std::string* error) {
  std::vector<DecodedAudioPcmBlock> blocks;
  if (error) {
    error->clear();
  }
  if (timing.timestamp_valid && timing.timestamp_us > static_cast<std::uint64_t>(INT64_MAX)) {
    if (error) { *error = "audio-decoder-invalid-source-timestamp"; }
    return blocks;
  }
  // A zero-length FFmpeg packet drains the decoder. Empty transport payloads
  // are not an end-of-stream signal and must leave it ready for the next frame.
  if (encoded.empty()) {
    return blocks;
  }
  if (vds::media_agent::to_lower_copy(codec_name) == "pcmu") {
    DecodedAudioPcmBlock block;
    if (encoded.size() > block.pcm.max_size() / 12) {
      if (error) { *error = "audio-decoder-pcmu-allocation-overflow"; }
      return blocks;
    }
    block.timing = timing;
    // G.711 is 8 kHz mono; the output device is 48 kHz stereo. Retain the
    // original decoder helper for callers needing unconverted 8 kHz PCM.
    block.pcm.reserve(encoded.size() * 12);
    for (const auto byte : encoded) {
      const auto sample = ulaw_to_linear16_sample(byte);
      for (int repeated = 0; repeated < 6; ++repeated) {
        block.pcm.push_back(sample);
        block.pcm.push_back(sample);
      }
    }
    block.duration_us = static_cast<std::uint64_t>(encoded.size()) * 1000000 / 8000;
    blocks.push_back(std::move(block));
    return blocks;
  }
  if (encoded.size() > static_cast<std::size_t>(std::numeric_limits<int>::max() - AV_INPUT_BUFFER_PADDING_SIZE)) {
    if (error) {
      *error = "audio-decoder-packet-too-large";
    }
    return blocks;
  }
  const std::string normalized_codec = vds::media_agent::to_lower_copy(codec_name);
  if (!ensure_peer_audio_decoder_runtime(runtime_ptr, normalized_codec, error)) {
    return blocks;
  }

  auto& decoder = *runtime_ptr->audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  if (!decoder.context || !decoder.packet || !decoder.frame) {
    if (error) { *error = "audio-decoder-runtime-reset"; }
    return blocks;
  }
  if (decoder.timing_source_id != timing.source_id) {
    avcodec_flush_buffers(decoder.context);
    reset_audio_resampler(decoder);
    decoder.timing_source_id = timing.source_id;
    decoder.submitted_timing_valid = false;
    decoder.submitted_sequence_valid = false;
  }
  if (!timing.config &&
      ((timing.timestamp_valid && decoder.submitted_timing_valid &&
        timing.timestamp_us <= decoder.submitted_timestamp_us) ||
       (timing.sequence_valid && decoder.submitted_sequence_valid &&
        timing.sequence <= decoder.submitted_sequence))) {
    if (error) { *error = "audio-decoder-stale-packet"; }
    return blocks;
  }
  av_packet_unref(decoder.packet);
  // av_new_packet owns the buffer and supplies FFmpeg's required zero padding.
  if (av_new_packet(decoder.packet, static_cast<int>(encoded.size())) < 0) {
    if (error) {
      *error = "audio-decoder-packet-allocation-failed";
    }
    return blocks;
  }
  std::memcpy(decoder.packet->data, encoded.data(), encoded.size());
  if (timing.timestamp_valid && timing.timestamp_us <= static_cast<std::uint64_t>(INT64_MAX)) {
    decoder.packet->pts = static_cast<std::int64_t>(timing.timestamp_us);
    decoder.packet->dts = decoder.packet->pts;
  }

  const int send_result = avcodec_send_packet(decoder.context, decoder.packet);
  if (send_result < 0) {
    if (error) {
      *error = normalized_codec == "aac" ? "aac-decoder-send-failed" : "opus-decoder-send-failed";
    }
    av_packet_unref(decoder.packet);
    return blocks;
  }
  av_packet_unref(decoder.packet);

  if (!timing.config) {
    if (timing.timestamp_valid) {
      decoder.submitted_timestamp_us = timing.timestamp_us;
      decoder.submitted_timing_valid = true;
    }
    if (timing.sequence_valid) {
      decoder.submitted_sequence = timing.sequence;
      decoder.submitted_sequence_valid = true;
    }
  }

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

    const auto sample_rate = decoder.frame->sample_rate;
    if (sample_rate <= 0 || sample_rate > 384000 || channel_count <= 0 ||
        sample_count <= 0 || !decoder.frame->data[0]) {
      if (error) { *error = "audio-decoder-unsupported-output-format"; }
      av_frame_unref(decoder.frame);
      continue;
    }
    DecodedAudioPcmBlock block;
    block.timing = timing;
    const auto frame_pts = decoder.frame->pts != AV_NOPTS_VALUE
      ? decoder.frame->pts : decoder.frame->best_effort_timestamp;
    block.timing.timestamp_valid = timing.timestamp_valid && frame_pts != AV_NOPTS_VALUE && frame_pts >= 0 &&
      !timing.source_id.empty();
    if (block.timing.timestamp_valid) {
      block.timing.timestamp_us = static_cast<std::uint64_t>(frame_pts);
    }
    block.duration_us = static_cast<std::uint64_t>(sample_count) * 1000000 / kTransportAudioSampleRate;
    auto& pcm = block.pcm;

    const bool simple_format = sample_format == AV_SAMPLE_FMT_S16 || sample_format == AV_SAMPLE_FMT_S16P ||
      sample_format == AV_SAMPLE_FMT_FLT || sample_format == AV_SAMPLE_FMT_FLTP;
    if (sample_rate != kTransportAudioSampleRate || channel_count != kTransportAudioChannelCount || !simple_format) {
      if (!ensure_audio_resampler(decoder, sample_rate, sample_format)) {
        if (error) { *error = "audio-decoder-resampler-initialization-failed"; }
        av_frame_unref(decoder.frame);
        continue;
      }
      const auto delay_samples = swr_get_delay(decoder.resampler, sample_rate);
      const auto capacity = av_rescale_rnd(delay_samples + sample_count,
        kTransportAudioSampleRate, sample_rate, AV_ROUND_UP);
      if (capacity <= 0 || capacity > std::numeric_limits<int>::max() ||
          static_cast<std::uint64_t>(capacity) > pcm.max_size() / kTransportAudioChannelCount) {
        if (error) { *error = "audio-decoder-resampler-output-too-large"; }
        av_frame_unref(decoder.frame);
        reset_audio_resampler(decoder);
        continue;
      }
      pcm.resize(static_cast<std::size_t>(capacity) * kTransportAudioChannelCount);
      auto* output = reinterpret_cast<std::uint8_t*>(pcm.data());
      const auto output_frames = swr_convert(decoder.resampler, &output, static_cast<int>(capacity),
        const_cast<const std::uint8_t**>(decoder.frame->extended_data), sample_count);
      if (output_frames < 0) {
        if (error) { *error = "audio-decoder-resampler-conversion-failed"; }
        av_frame_unref(decoder.frame);
        reset_audio_resampler(decoder);
        continue;
      }
      pcm.resize(static_cast<std::size_t>(output_frames) * kTransportAudioChannelCount);
      block.duration_us = static_cast<std::uint64_t>(output_frames) * 1000000 / kTransportAudioSampleRate;
      const auto delay_us = av_rescale_rnd(delay_samples, 1000000, sample_rate, AV_ROUND_NEAR_INF);
      if (block.timing.timestamp_valid) {
        if (delay_us >= 0 && static_cast<std::uint64_t>(delay_us) <= block.timing.timestamp_us) {
          block.timing.timestamp_us -= static_cast<std::uint64_t>(delay_us);
        } else { block.timing.timestamp_valid = false; }
      }
      if (!pcm.empty()) { blocks.push_back(std::move(block)); }
      av_frame_unref(decoder.frame);
      continue;
    }
    // Normal 48 kHz stereo takes the existing conversion path; a resampler is
    // allocated only when the source format actually needs one.
    reset_audio_resampler(decoder);

    const auto append_interleaved_s16 = [&](auto read_sample) {
      pcm.resize(static_cast<std::size_t>(sample_count) * kTransportAudioChannelCount);
      for (int sample_index = 0; sample_index < sample_count; ++sample_index) {
        for (int channel_index = 0; channel_index < kTransportAudioChannelCount; ++channel_index) {
          pcm[static_cast<std::size_t>(sample_index) * kTransportAudioChannelCount + channel_index] =
            read_sample(sample_index, std::min(channel_index, channel_count - 1));
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
      return {};
    }

    blocks.push_back(std::move(block));
    av_frame_unref(decoder.frame);
  }

  return blocks;
}

std::vector<std::int16_t> decode_audio_to_pcm16(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  const std::string& codec_name,
  std::string* error) {
  auto blocks = decode_audio_to_pcm_blocks(runtime_ptr, encoded, codec_name, {}, error);
  if (blocks.size() == 1) { return std::move(blocks.front().pcm); }
  std::vector<std::int16_t> pcm;
  for (auto& block : blocks) {
    pcm.insert(pcm.end(), block.pcm.begin(), block.pcm.end());
  }
  return pcm;
}
