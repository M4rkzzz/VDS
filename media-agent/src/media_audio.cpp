#include "media_audio.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <sstream>
#include <thread>

#include "agent_events.h"
#include "json_protocol.h"
#include "string_utils.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
}

void refresh_host_audio_senders(AgentRuntimeState& state);

namespace {

using vds::media_agent::extract_int_value;
using vds::media_agent::extract_string_value;
using vds::media_agent::json_escape;

std::atomic<bool> g_host_audio_capture_active { false };
constexpr std::size_t kMaxQueuedHostAudioCapturePackets = 64;

HostAudioDispatchState& host_audio_dispatch_state() {
  static HostAudioDispatchState state;
  return state;
}

void emit_wasapi_backend_event(const std::string& event_name, const std::string& params_json) {
  emit_event(event_name, params_json);
}

void emit_wasapi_pcm_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) {
  if (!g_host_audio_capture_active.load(std::memory_order_acquire)) {
    return;
  }

  dispatch_host_audio_capture_packet(status, data, frames, silent);
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

std::vector<std::int16_t> convert_capture_pcm_to_opus_input(
  const unsigned char* data,
  unsigned int frames,
  const WasapiSessionStatus& status) {
  std::vector<std::int16_t> pcm;
  if (!data || frames == 0 || status.bits_per_sample != 16 || status.block_align == 0 || status.sample_rate == 0) {
    return pcm;
  }

  const unsigned int input_channels = std::max(1u, status.channel_count);
  const auto* samples = reinterpret_cast<const std::int16_t*>(data);
  const std::uint64_t output_frames = std::max<std::uint64_t>(
    1,
    (static_cast<std::uint64_t>(frames) * kTransportAudioSampleRate) / status.sample_rate
  );
  pcm.reserve(static_cast<std::size_t>(output_frames) * kTransportAudioChannelCount);

  for (std::uint64_t output_index = 0; output_index < output_frames; ++output_index) {
    const std::uint64_t input_index =
      std::min<std::uint64_t>(frames - 1, (output_index * status.sample_rate) / kTransportAudioSampleRate);

    std::int16_t left = 0;
    std::int16_t right = 0;
    if (input_channels == 1) {
      left = right = samples[input_index];
    } else {
      left = samples[input_index * input_channels];
      right = samples[input_index * input_channels + 1];
    }

    pcm.push_back(left);
    pcm.push_back(right);
  }

  return pcm;
}

bool ensure_host_audio_encoder_locked(HostAudioDispatchState& state, std::string* error) {
  if (state.encoder_context && state.encoder_packet) {
    return true;
  }

  const AVCodec* codec = avcodec_find_encoder_by_name("libopus");
  if (!codec) {
    if (error) {
      *error = "libopus-encoder-unavailable";
    }
    return false;
  }

  AVCodecContext* context = avcodec_alloc_context3(codec);
  AVPacket* packet = av_packet_alloc();
  if (!context || !packet) {
    if (context) {
      avcodec_free_context(&context);
    }
    if (packet) {
      av_packet_free(&packet);
    }
    if (error) {
      *error = "libopus-encoder-allocation-failed";
    }
    return false;
  }

  context->sample_rate = kTransportAudioSampleRate;
  context->bit_rate = kTransportAudioBitrateKbps * 1000;
  context->time_base = AVRational{ 1, static_cast<int>(kTransportAudioSampleRate) };
  av_channel_layout_default(&context->ch_layout, kTransportAudioChannelCount);
  context->sample_fmt = AV_SAMPLE_FMT_S16;

  AVDictionary* options = nullptr;
  av_dict_set(&options, "application", "lowdelay", 0);
  av_dict_set(&options, "vbr", "off", 0);
  const int open_result = avcodec_open2(context, codec, &options);
  av_dict_free(&options);
  if (open_result < 0) {
    avcodec_free_context(&context);
    av_packet_free(&packet);
    if (error) {
      *error = "libopus-encoder-open-failed";
    }
    return false;
  }

  state.encoder_context = context;
  state.encoder_packet = packet;
  state.encoder_frame_size = context->frame_size > 0 ? context->frame_size : 960;
  state.last_error.clear();
  return true;
}

void reset_host_audio_encoder_locked(HostAudioDispatchState& state) {
  state.pending_pcm.clear();
  state.last_error.clear();
  if (state.encoder_packet) {
    av_packet_free(&state.encoder_packet);
  }
  if (state.encoder_context) {
    avcodec_free_context(&state.encoder_context);
  }
  state.encoder_frame_size = 960;
}

bool send_host_audio_opus_frame_locked(
  HostAudioDispatchState& state,
  const std::vector<std::shared_ptr<PeerTransportSession>>& sessions,
  std::string* error) {
  if (!state.encoder_context || !state.encoder_packet) {
    if (error) {
      *error = "host-audio-encoder-not-ready";
    }
    return false;
  }

  const std::size_t required_samples =
    static_cast<std::size_t>(state.encoder_frame_size) * kTransportAudioChannelCount;
  if (state.pending_pcm.size() < required_samples) {
    return true;
  }

  AVFrame* frame = av_frame_alloc();
  if (!frame) {
    if (error) {
      *error = "host-audio-frame-allocation-failed";
    }
    return false;
  }

  frame->nb_samples = state.encoder_frame_size;
  frame->format = state.encoder_context->sample_fmt;
  frame->sample_rate = state.encoder_context->sample_rate;
  if (av_channel_layout_copy(&frame->ch_layout, &state.encoder_context->ch_layout) < 0 ||
      av_frame_get_buffer(frame, 0) < 0) {
    av_frame_free(&frame);
    if (error) {
      *error = "host-audio-frame-buffer-failed";
    }
    return false;
  }

  if (av_frame_make_writable(frame) < 0) {
    av_frame_free(&frame);
    if (error) {
      *error = "host-audio-frame-not-writable";
    }
    return false;
  }

  auto* interleaved = reinterpret_cast<std::int16_t*>(frame->data[0]);
  for (int index = 0; index < state.encoder_frame_size; ++index) {
    interleaved[index * 2] = state.pending_pcm.front();
    state.pending_pcm.pop_front();
    interleaved[index * 2 + 1] = state.pending_pcm.front();
    state.pending_pcm.pop_front();
  }

  const std::uint64_t timestamp_us =
    (state.next_timestamp_samples * 1000000ull) / kTransportAudioSampleRate;
  const int send_result = avcodec_send_frame(state.encoder_context, frame);
  av_frame_free(&frame);
  if (send_result < 0) {
    if (error) {
      *error = "host-audio-encoder-send-failed";
    }
    return false;
  }

  bool emitted_packet = false;
  while (true) {
    const int receive_result = avcodec_receive_packet(state.encoder_context, state.encoder_packet);
    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      break;
    }
    if (receive_result < 0) {
      if (error) {
        *error = "host-audio-encoder-receive-failed";
      }
      return false;
    }

    std::vector<std::uint8_t> encoded(
      state.encoder_packet->data,
      state.encoder_packet->data + state.encoder_packet->size
    );
    std::string send_error;
    for (const auto& session : sessions) {
      const PeerTransportSnapshot snapshot = get_peer_transport_snapshot(session);
      const bool use_encoded_data_channel =
        snapshot.encoded_media_data_channel_requested ||
        snapshot.encoded_media_data_channel_supported;
      if (use_encoded_data_channel) {
        if (!snapshot.encoded_media_data_channel_ready) {
          continue;
        }
        PeerEncodedMediaDataChannelFrame encoded_frame;
        encoded_frame.stream_type = "audio";
        encoded_frame.codec = "opus";
        encoded_frame.timestamp_us = timestamp_us;
        encoded_frame.sequence = state.next_timestamp_samples;
        encoded_frame.payload = encoded;
        send_peer_transport_encoded_media_frame(session, encoded_frame, &send_error);
      } else {
        send_peer_transport_audio_frame(session, encoded, timestamp_us, &send_error);
      }
    }
    av_packet_unref(state.encoder_packet);
    emitted_packet = true;
  }

  if (emitted_packet) {
    state.next_timestamp_samples += static_cast<unsigned long long>(state.encoder_frame_size);
  }

  return true;
}

WasapiSessionStatus status_from_queued_packet(const HostAudioDispatchState::QueuedCapturePacket& packet) {
  WasapiSessionStatus status;
  status.sample_rate = packet.sample_rate;
  status.channel_count = packet.channel_count;
  status.bits_per_sample = packet.bits_per_sample;
  status.block_align = packet.block_align;
  return status;
}

void process_host_audio_capture_packet(
  HostAudioDispatchState& state,
  const HostAudioDispatchState::QueuedCapturePacket& packet) {
  std::vector<std::shared_ptr<PeerTransportSession>> sessions;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    for (auto it = state.sessions.begin(); it != state.sessions.end();) {
      const auto session = it->lock();
      if (!session) {
        it = state.sessions.erase(it);
        continue;
      }
      sessions.push_back(session);
      ++it;
    }
  }

  if (sessions.empty()) {
    return;
  }

  std::string encoder_error;
  if (!ensure_host_audio_encoder_locked(state, &encoder_error)) {
    state.last_error = encoder_error;
    return;
  }

  const WasapiSessionStatus status = status_from_queued_packet(packet);
  std::vector<std::int16_t> pcm = packet.silent
    ? std::vector<std::int16_t>(static_cast<std::size_t>(std::max(1u, static_cast<unsigned int>((static_cast<std::uint64_t>(packet.frames) * kTransportAudioSampleRate) / std::max(1u, status.sample_rate)))) * kTransportAudioChannelCount, 0)
    : convert_capture_pcm_to_opus_input(packet.bytes.data(), packet.frames, status);
  if (pcm.empty()) {
    return;
  }

  for (const std::int16_t sample : pcm) {
    state.pending_pcm.push_back(sample);
  }

  while (state.pending_pcm.size() >= static_cast<std::size_t>(state.encoder_frame_size) * kTransportAudioChannelCount) {
    std::string send_error;
    if (!send_host_audio_opus_frame_locked(state, sessions, &send_error)) {
      state.last_error = send_error;
      break;
    }
  }
}

void host_audio_dispatch_worker_main() {
  auto& state = host_audio_dispatch_state();
  while (true) {
    HostAudioDispatchState::QueuedCapturePacket packet;
    {
      std::unique_lock<std::mutex> lock(state.mutex);
      state.cv.wait(lock, [&state]() {
        return state.stop_requested || !state.capture_queue.empty();
      });
      if (state.stop_requested && state.capture_queue.empty()) {
        break;
      }
      packet = std::move(state.capture_queue.front());
      state.capture_queue.pop_front();
    }

    process_host_audio_capture_packet(state, packet);
  }

  reset_host_audio_encoder_locked(state);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.worker_started = false;
    state.stop_requested = false;
  }
}

void ensure_host_audio_dispatch_worker_running_locked(HostAudioDispatchState& state) {
  if (state.worker_started) {
    return;
  }
  state.stop_requested = false;
  state.worker_started = true;
  state.worker = std::thread(host_audio_dispatch_worker_main);
}

void stop_host_audio_dispatch_worker(HostAudioDispatchState& state) {
  std::thread worker;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.stop_requested = true;
    state.capture_queue.clear();
    worker = std::move(state.worker);
  }
  state.cv.notify_all();
  if (worker.joinable()) {
    worker.join();
  }
}

bool ensure_peer_audio_decoder_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::string& codec_name,
  std::string* error) {
  if (!runtime_ptr) {
    if (error) {
      *error = "peer-audio-runtime-missing";
    }
    return false;
  }

  if (!runtime_ptr->audio_decoder_runtime) {
    runtime_ptr->audio_decoder_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime::PeerAudioDecoderRuntime>();
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

void attach_wasapi_audio_callbacks(AgentRuntimeState& state) {
  (void)state;
  set_wasapi_event_callback(emit_wasapi_backend_event);
  set_wasapi_pcm_packet_callback(emit_wasapi_pcm_packet);
}

AudioSessionCommandResult start_audio_session_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const int pid = extract_int_value(request_json, "pid", 0);
  const std::string process_name = extract_string_value(request_json, "processName");
  state.audio_session = build_audio_session_state(start_wasapi_process_loopback_session(pid, process_name));
  g_host_audio_capture_active.store(state.audio_session.capture_active, std::memory_order_release);
  refresh_host_audio_senders(state);

  emit_event(
    "media-state",
    std::string("{\"state\":\"audio-session-started\",\"pid\":") +
      std::to_string(state.audio_session.pid) +
      ",\"processName\":\"" + json_escape(state.audio_session.process_name) +
      "\",\"backendMode\":\"" + json_escape(state.audio_session.backend_mode) +
      "\",\"implementation\":\"" + json_escape(state.audio_session.implementation) +
      "\",\"reason\":\"" + json_escape(state.audio_session.reason) +
      "\",\"ready\":" + (state.audio_session.ready ? "true" : "false") +
      ",\"captureActive\":" + (state.audio_session.capture_active ? "true" : "false") +
      ",\"sampleRate\":" + std::to_string(state.audio_session.sample_rate) +
      ",\"channelCount\":" + std::to_string(state.audio_session.channel_count) +
      ",\"packetsCaptured\":" + std::to_string(state.audio_session.packets_captured) +
      ",\"transportReady\":" + std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  if (state.audio_session.capture_active && !state.audio_session.ready) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"audio\",\"message\":\"WASAPI process-loopback capture started, but the native audio session is not ready for transport. The stream will fall back to video-only sharing.\",\"backendMode\":\"") +
        json_escape(state.audio_session.backend_mode) + "\"}"
    );
  } else if (!state.audio_session.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"audio\",\"message\":\"") +
        json_escape(state.audio_session.last_error) +
        "\",\"backendMode\":\"" + json_escape(state.audio_session.backend_mode) + "\"}"
    );
  }
  return {true, audio_session_json(state.audio_session), {}, {}};
}

AudioSessionCommandResult stop_audio_session_from_request(AgentRuntimeState& state) {
  g_host_audio_capture_active.store(false, std::memory_order_release);
  state.audio_session = build_audio_session_state(stop_wasapi_process_loopback_session());
  reset_host_audio_transport_sessions();
  refresh_host_audio_senders(state);
  emit_event(
    "media-state",
    std::string("{\"state\":\"audio-session-stopped\",\"backendMode\":\"") +
      json_escape(state.audio_session.backend_mode) +
      "\",\"implementation\":\"" + json_escape(state.audio_session.implementation) +
      "\",\"reason\":\"" + json_escape(state.audio_session.reason) +
      "\",\"ready\":" + (state.audio_session.ready ? "true" : "false") +
      ",\"captureActive\":" + (state.audio_session.capture_active ? "true" : "false") +
      ",\"transportReady\":" + std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  return {true, audio_session_json(state.audio_session), {}, {}};
}

std::vector<std::int16_t> decode_pcmu_to_pcm16(const std::vector<std::uint8_t>& encoded) {
  std::vector<std::int16_t> decoded;
  decoded.reserve(encoded.size());
  for (const std::uint8_t value : encoded) {
    decoded.push_back(ulaw_to_linear16_sample(value));
  }
  return decoded;
}

void reset_peer_audio_decoder_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
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
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
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

void register_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session) {
  if (!session) {
    return;
  }

  auto& state = host_audio_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto it = state.sessions.begin(); it != state.sessions.end();) {
    const auto existing = it->lock();
    if (!existing) {
      it = state.sessions.erase(it);
      continue;
    }
    if (existing == session) {
      return;
    }
    ++it;
  }
  state.sessions.push_back(session);
}

void unregister_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session) {
  auto& state = host_audio_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto it = state.sessions.begin(); it != state.sessions.end();) {
    const auto existing = it->lock();
    if (!existing || existing == session) {
      it = state.sessions.erase(it);
      continue;
    }
    ++it;
  }
}

void reset_host_audio_transport_sessions() {
  auto& state = host_audio_dispatch_state();
  stop_host_audio_dispatch_worker(state);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.sessions.clear();
    state.capture_queue.clear();
    state.next_timestamp_samples = 0;
  }
  reset_host_audio_encoder_locked(state);
}

void dispatch_host_audio_capture_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) {
  auto& state = host_audio_dispatch_state();

  if (!silent && (!data || frames == 0 || status.block_align == 0)) {
    return;
  }

  HostAudioDispatchState::QueuedCapturePacket packet;
  packet.frames = frames;
  packet.sample_rate = status.sample_rate;
  packet.channel_count = status.channel_count;
  packet.bits_per_sample = status.bits_per_sample;
  packet.block_align = status.block_align;
  packet.silent = silent;
  if (!silent) {
    const std::size_t byte_count = static_cast<std::size_t>(frames) * status.block_align;
    packet.bytes.assign(data, data + byte_count);
  }

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.sessions.empty()) {
      return;
    }
    ensure_host_audio_dispatch_worker_running_locked(state);
    if (state.capture_queue.size() >= kMaxQueuedHostAudioCapturePackets) {
      state.capture_queue.pop_front();
      state.dropped_capture_packets += 1;
    }
    state.capture_queue.push_back(std::move(packet));
  }
  state.cv.notify_one();
}

std::string audio_session_json(const AudioSessionState& session) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (session.ready ? "true" : "false")
    << ",\"running\":" << (session.running ? "true" : "false")
    << ",\"captureActive\":" << (session.capture_active ? "true" : "false")
    << ",\"platformSupported\":" << (session.platform_supported ? "true" : "false")
    << ",\"deviceEnumeratorAvailable\":" << (session.device_enumerator_available ? "true" : "false")
    << ",\"renderDeviceCount\":" << session.render_device_count
    << ",\"pid\":" << session.pid
    << ",\"processName\":\"" << vds::media_agent::json_escape(session.process_name) << "\""
    << ",\"backendMode\":\"" << vds::media_agent::json_escape(session.backend_mode) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(session.implementation) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(session.last_error) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(session.reason) << "\""
    << ",\"sampleRate\":" << session.sample_rate
    << ",\"channelCount\":" << session.channel_count
    << ",\"bitsPerSample\":" << session.bits_per_sample
    << ",\"blockAlign\":" << session.block_align
    << ",\"bufferFrameCount\":" << session.buffer_frame_count
    << ",\"lastBufferFrames\":" << session.last_buffer_frames
    << ",\"packetsCaptured\":" << session.packets_captured
    << ",\"framesCaptured\":" << session.frames_captured
    << ",\"silentPackets\":" << session.silent_packets
    << ",\"activationAttempts\":" << session.activation_attempts
    << ",\"activationSuccesses\":" << session.activation_successes
    << "}";
  return payload.str();
}

AudioSessionState build_audio_session_state(const AudioBackendProbe& probe) {
  AudioSessionState session;
  session.ready = probe.ready;
  session.running = false;
  session.capture_active = false;
  session.platform_supported = probe.platform_supported;
  session.device_enumerator_available = probe.device_enumerator_available;
  session.render_device_count = probe.render_device_count;
  session.backend_mode = probe.backend_mode;
  session.implementation = probe.implementation;
  session.reason = probe.reason;
  session.last_error = probe.last_error;
  return session;
}

AudioSessionState build_audio_session_state(const WasapiSessionStatus& status) {
  AudioSessionState session;
  session.ready = status.ready;
  session.running = status.running;
  session.capture_active = status.capture_active;
  session.platform_supported = status.platform_supported;
  session.device_enumerator_available = status.device_enumerator_available;
  session.render_device_count = status.render_device_count;
  session.pid = status.pid;
  session.process_name = status.process_name;
  session.backend_mode = status.backend_mode;
  session.implementation = status.implementation;
  session.last_error = status.last_error;
  session.reason = status.reason;
  session.sample_rate = status.sample_rate;
  session.channel_count = status.channel_count;
  session.bits_per_sample = status.bits_per_sample;
  session.block_align = status.block_align;
  session.buffer_frame_count = status.buffer_frame_count;
  session.last_buffer_frames = status.last_buffer_frames;
  session.packets_captured = status.packets_captured;
  session.frames_captured = status.frames_captured;
  session.silent_packets = status.silent_packets;
  session.activation_attempts = status.activation_attempts;
  session.activation_successes = status.activation_successes;
  return session;
}

AudioBackendProbe build_audio_backend_probe(const WasapiProbeResult& probe) {
  AudioBackendProbe result;
  result.ready = probe.platform_supported && probe.device_enumerator_available;
  result.backend_mode = probe.backend_mode;
  result.implementation = probe.implementation;
  result.reason = probe.reason;
  result.last_error = probe.last_error;
  result.platform_supported = probe.platform_supported;
  result.device_enumerator_available = probe.device_enumerator_available;
  result.render_device_count = probe.render_device_count;
  return result;
}
