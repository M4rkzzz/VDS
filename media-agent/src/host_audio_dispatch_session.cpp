#include "host_audio_dispatch_session.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "agent_events.h"
#include "audio_state_json.h"
#include "audio_session_state.h"
#include "audio_transport_config.h"
#include "json_protocol.h"
#include "peer_session_controller.h"
#include "peer_transport.h"
#include "wasapi_backend.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
}

namespace {

using vds::media_agent::extract_int_value;
using vds::media_agent::extract_string_value;
using vds::media_agent::json_escape;

void emit_wasapi_backend_event(const std::string& event_name, const std::string& params_json) {
  emit_event(event_name, params_json);
}

void emit_wasapi_pcm_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) {
  HostAudioDispatchSession host_audio_dispatch;
  host_audio_dispatch.dispatch_capture_packet(status, data, frames, silent);
}

AudioSessionState build_audio_session_state(const WasapiSessionStatus& status) {
  AudioSessionState session;
  session.ready = status.ready;
  session.capture_active = status.capture_active;
  session.pid = status.pid;
  session.process_name = status.process_name;
  session.backend_mode = status.backend_mode;
  session.implementation = status.implementation;
  session.last_error = status.last_error;
  session.reason = status.reason;
  session.sample_rate = status.sample_rate;
  session.channel_count = status.channel_count;
  session.packets_captured = status.packets_captured;
  session.frames_captured = status.frames_captured;
  return session;
}

std::atomic<bool> g_host_audio_capture_active { false };
constexpr std::size_t kMaxQueuedHostAudioCapturePackets = 64;

struct HostAudioDispatchState {
  struct QueuedCapturePacket {
    std::vector<unsigned char> bytes;
    unsigned int frames = 0;
    unsigned int sample_rate = 0;
    unsigned int channel_count = 0;
    unsigned int bits_per_sample = 0;
    unsigned int block_align = 0;
    bool silent = false;
  };

  std::mutex mutex;
  std::condition_variable cv;
  std::vector<std::weak_ptr<PeerTransportSession>> sessions;
  std::deque<QueuedCapturePacket> capture_queue;
  unsigned long long next_timestamp_samples = 0;
  std::deque<std::int16_t> pending_pcm;
  AVCodecContext* encoder_context = nullptr;
  AVPacket* encoder_packet = nullptr;
  int encoder_frame_size = 960;
  bool worker_started = false;
  bool stop_requested = false;
  std::thread worker;
  std::string last_error;
};

HostAudioDispatchState& host_audio_dispatch_state() {
  static HostAudioDispatchState state;
  return state;
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
        encoded_frame.payload_format = "opus-raw";
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

} // namespace

HostAudioDispatchSession::HostAudioDispatchSession(AudioSessionState& session)
    : session_(&session) {}

HostAudioDispatchSession::HostAudioDispatchSession(
  AudioSessionState& session,
  vds::media_agent::PeerSessionController& peer_sessions)
    : session_(&session), peer_sessions_(&peer_sessions) {}

HostAudioDispatchSession::HostAudioDispatchSession(
  AudioSessionState& session,
  vds::media_agent::PeerSessionController& peer_sessions,
  std::function<bool()> transport_ready_provider)
    : session_(&session),
      peer_sessions_(&peer_sessions),
      transport_ready_provider_(std::move(transport_ready_provider)) {}

bool HostAudioDispatchSession::transport_ready() const {
  if (transport_ready_provider_) {
    return transport_ready_provider_();
  }
  return false;
}

void HostAudioDispatchSession::refresh_host_audio_senders() const {
  if (peer_sessions_) {
    peer_sessions_->refresh_host_audio_senders();
    return;
  }
}

bool HostAudioDispatchSession::capture_ready() const {
  return session_ && audio_session_capture_ready(*session_);
}

void HostAudioDispatchSession::refresh_session_status() const {
  if (!session_) {
    return;
  }
  *session_ = build_audio_session_state(get_wasapi_process_loopback_session_status());
}

AudioSessionCommandResult HostAudioDispatchSession::start_from_request(const std::string& request_json) const {
  if (!session_) {
    return {false, {}, "AUDIO_SESSION_UNAVAILABLE", "Audio session state is unavailable"};
  }

  const int pid = extract_int_value(request_json, "pid", 0);
  const std::string process_name = extract_string_value(request_json, "processName");
  *session_ = build_audio_session_state(start_wasapi_process_loopback_session(pid, process_name));
  set_capture_active(session_->capture_active);
  refresh_host_audio_senders();

  emit_event(
    "media-state",
    std::string("{\"state\":\"audio-session-started\",\"pid\":") +
      std::to_string(session_->pid) +
      ",\"processName\":\"" + json_escape(session_->process_name) +
      "\",\"backendMode\":\"" + json_escape(session_->backend_mode) +
      "\",\"implementation\":\"" + json_escape(session_->implementation) +
      "\",\"reason\":\"" + json_escape(session_->reason) +
      "\",\"ready\":" + (session_->ready ? "true" : "false") +
      ",\"captureActive\":" + (session_->capture_active ? "true" : "false") +
      ",\"sampleRate\":" + std::to_string(session_->sample_rate) +
      ",\"channelCount\":" + std::to_string(session_->channel_count) +
      ",\"packetsCaptured\":" + std::to_string(session_->packets_captured) +
      ",\"transportReady\":" + std::string(transport_ready() ? "true" : "false") + "}"
  );
  if (session_->capture_active && !session_->ready) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"audio\",\"message\":\"WASAPI process-loopback capture started, but the native audio session is not ready for transport. The stream will fall back to video-only sharing.\",\"backendMode\":\"") +
        json_escape(session_->backend_mode) + "\"}"
    );
  } else if (!session_->last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"audio\",\"message\":\"") +
        json_escape(session_->last_error) +
        "\",\"backendMode\":\"" + json_escape(session_->backend_mode) + "\"}"
    );
  }
  return {true, audio_session_json(*session_), {}, {}};
}

AudioSessionCommandResult HostAudioDispatchSession::stop_from_request() const {
  if (!session_) {
    return {false, {}, "AUDIO_SESSION_UNAVAILABLE", "Audio session state is unavailable"};
  }

  set_capture_active(false);
  *session_ = build_audio_session_state(stop_wasapi_process_loopback_session());
  reset_transport_sessions();
  refresh_host_audio_senders();
  emit_event(
    "media-state",
    std::string("{\"state\":\"audio-session-stopped\",\"backendMode\":\"") +
      json_escape(session_->backend_mode) +
      "\",\"implementation\":\"" + json_escape(session_->implementation) +
      "\",\"reason\":\"" + json_escape(session_->reason) +
      "\",\"ready\":" + (session_->ready ? "true" : "false") +
      ",\"captureActive\":" + (session_->capture_active ? "true" : "false") +
      ",\"transportReady\":" + std::string(transport_ready() ? "true" : "false") + "}"
  );
  return {true, audio_session_json(*session_), {}, {}};
}

void HostAudioDispatchSession::attach_wasapi_callbacks() const {
  set_wasapi_event_callback(emit_wasapi_backend_event);
  set_wasapi_pcm_packet_callback(emit_wasapi_pcm_packet);
}

void HostAudioDispatchSession::set_capture_active(bool active) const {
  g_host_audio_capture_active.store(active, std::memory_order_release);
}

void HostAudioDispatchSession::register_transport_session(
  const std::shared_ptr<PeerTransportSession>& session) const {
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

void HostAudioDispatchSession::unregister_transport_session(
  const std::shared_ptr<PeerTransportSession>& session) const {
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

void HostAudioDispatchSession::reset_transport_sessions() const {
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

void HostAudioDispatchSession::dispatch_capture_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) const {
  if (!g_host_audio_capture_active.load(std::memory_order_acquire)) {
    return;
  }

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
    }
    state.capture_queue.push_back(std::move(packet));
  }
  state.cv.notify_one();
}

std::string HostAudioDispatchSession::stats_json() const {
  if (!session_) {
    return audio_session_json(AudioSessionState{});
  }
  return audio_session_json(*session_);
}
