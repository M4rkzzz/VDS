// Real Opus encoding and dispatch, with only transport and WASAPI boundaries
// replaced. No capture thread, peer connection, or audio device is started.
#include "peer_transport.h"

class PeerTransportSession {
 public:
  PeerTransportMediaReadiness readiness;
  int readiness_queries = 0;
  std::vector<PeerEncodedMediaDataChannelFrame> encoded_frames;
  std::vector<std::vector<std::uint8_t>> rtp_frames;
  std::vector<std::uint64_t> rtp_timestamps;
};

#include "../src/host_audio_dispatch_session.cpp"

#include <iostream>

namespace {
int checks = 0;
int failures = 0;
int snapshot_queries = 0;
WasapiEventCallback registered_event_callback = nullptr;
WasapiPcmPacketCallback registered_pcm_callback = nullptr;
std::vector<std::string> event_payloads;

void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

WasapiSessionStatus fake_capture_status() {
  WasapiSessionStatus status;
  status.ready = true;
  status.capture_active = true;
  status.running = true;
  status.pid = 123;
  status.sample_rate = 48000;
  status.channel_count = 2;
  status.bits_per_sample = 16;
  status.block_align = 4;
  status.packets_captured = 77;
  status.frames_captured = 96000;
  return status;
}
}  // namespace

PeerTransportMediaReadiness get_peer_transport_media_readiness(
    const std::shared_ptr<PeerTransportSession>& session) {
  if (!session) return {};
  ++session->readiness_queries;
  return session->readiness;
}

PeerTransportSnapshot get_peer_transport_snapshot(const std::shared_ptr<PeerTransportSession>&) {
  ++snapshot_queries;
  return {};
}

bool send_peer_transport_encoded_media_frame(const std::shared_ptr<PeerTransportSession>& session,
    const PeerEncodedMediaDataChannelFrame& frame, std::string*) {
  session->encoded_frames.push_back(frame);
  return true;
}

bool send_peer_transport_audio_frame(const std::shared_ptr<PeerTransportSession>& session,
    const std::vector<std::uint8_t>& frame, std::uint64_t timestamp_us, std::string*) {
  session->rtp_frames.push_back(frame);
  session->rtp_timestamps.push_back(timestamp_us);
  return true;
}

void vds::media_agent::PeerSessionController::refresh_host_audio_senders() {}

void emit_event(const std::string& event_name, const std::string& params_json) {
  event_payloads.push_back(event_name + ":" + params_json);
}

WasapiSessionStatus get_wasapi_process_loopback_session_status() {
  return fake_capture_status();
}

WasapiSessionStatus start_wasapi_process_loopback_session(int, const std::string&) {
  return fake_capture_status();
}

WasapiSessionStatus stop_wasapi_process_loopback_session() {
  auto status = fake_capture_status();
  status.capture_active = false;
  status.running = false;
  return status;
}

void set_wasapi_event_callback(WasapiEventCallback callback) {
  registered_event_callback = callback;
}

void set_wasapi_pcm_packet_callback(WasapiPcmPacketCallback callback) {
  registered_pcm_callback = callback;
}

int main() {
  HostAudioDispatchState state;
  std::string error;
  expect(ensure_host_audio_encoder_locked(state, &error), "real libopus encoder opens");
  if (!state.encoder_context) return 1;
  state.source_epoch = "dispatch-test-source";
  state.next_timestamp_samples = 12ull * 3600 * kTransportAudioSampleRate;

  const auto dc = std::make_shared<PeerTransportSession>();
  const auto rtp = std::make_shared<PeerTransportSession>();
  const auto pending_dc = std::make_shared<PeerTransportSession>();
  const auto pending_rtp = std::make_shared<PeerTransportSession>();
  dc->readiness = { true, true, true, true };
  rtp->readiness = { true, false, true, true };
  pending_dc->readiness = { true, true, true, false };
  pending_rtp->readiness = { true, false, true, false };
  std::vector<std::shared_ptr<PeerTransportSession>> sessions { dc, rtp, pending_dc, pending_rtp, nullptr };
  const auto frame_samples = state.encoder_frame_size;
  for (int packet = 0; packet < 4; ++packet) {
    for (int sample = 0; sample < frame_samples * static_cast<int>(kTransportAudioChannelCount); ++sample) {
      state.pending_pcm.push_back(static_cast<std::int16_t>((sample % 101) - 50));
    }
    expect(send_host_audio_opus_frame_locked(state, sessions, &error), "real PCM frame is encoded and dispatched");
    expect(dc->encoded_frames.size() == static_cast<std::size_t>(packet + 1),
      "ready DataChannel receives every encoded packet");
    expect(rtp->rtp_frames.size() == static_cast<std::size_t>(packet + 1),
      "ready RTP track receives every encoded packet");
  }
  expect(pending_dc->encoded_frames.empty() && pending_dc->rtp_frames.empty() &&
      pending_rtp->encoded_frames.empty() && pending_rtp->rtp_frames.empty(),
    "audio readiness skips both unopened DataChannel and RTP tracks");
  expect(dc->rtp_frames.empty() && rtp->encoded_frames.empty(), "transport selection preserves DC versus RTP");
  expect(snapshot_queries == 0, "per-packet dispatch never constructs the full diagnostic snapshot");
  expect(dc->readiness_queries == 4 && rtp->readiness_queries == 4 &&
      pending_dc->readiness_queries == 4 && pending_rtp->readiness_queries == 4,
    "writability is checked afresh for each peer and packet");
  for (std::size_t index = 0; index < dc->encoded_frames.size(); ++index) {
    const auto& frame = dc->encoded_frames[index];
    expect(!frame.payload.empty() && frame.payload == rtp->rtp_frames[index],
      "both transports get the same real Opus bytes");
    expect(frame.stream_type == "audio" && frame.codec == "opus" && frame.payload_format == "opus-raw",
      "DataChannel audio packet keeps its codec metadata");
    expect(frame.sequence == index && frame.source_epoch == state.source_epoch,
      "source epoch and packet sequence survive the hot-path change");
    const auto expected_timestamp = 43200000000ull + vds::media_agent::host_media_samples_to_us(
      index * static_cast<std::uint64_t>(frame_samples), kTransportAudioSampleRate);
    expect(frame.timestamp_us == expected_timestamp && rtp->rtp_timestamps[index] == expected_timestamp,
      "both transports retain 64-bit source-clock timestamps");
  }
  dc->readiness.audio_ready = false;
  pending_dc->readiness.audio_ready = true;
  state.pending_pcm.insert(state.pending_pcm.end(), static_cast<std::size_t>(frame_samples) * 2, 0);
  expect(send_host_audio_opus_frame_locked(state, sessions, &error), "a silent PCM frame still encodes");
  expect(dc->encoded_frames.size() == 4 && pending_dc->encoded_frames.size() == 1,
    "live readiness transitions take effect on the next audio packet");
  expect(rtp->rtp_frames.size() == 5 && !rtp->rtp_frames.back().empty(),
    "silence preserves timing and reaches the ready audio transport");
  reset_host_audio_encoder_locked(state);

  AudioSessionState audio_state;
  HostAudioDispatchSession host(audio_state);
  host.attach_wasapi_callbacks();
  expect(registered_event_callback && registered_pcm_callback,
    "WASAPI state events and real PCM callbacks remain installed");
  expect(host.start_from_request("{\"pid\":123}").ok, "audio session start still succeeds");
  expect(audio_state.capture_active && host.capture_ready() && audio_state.packets_captured == 77 &&
      audio_state.frames_captured == 96000,
    "audio session state retains readiness and capture counters");
  expect(!event_payloads.empty() && event_payloads.back().find("audio-session-started") != std::string::npos,
    "necessary audio start state is still emitted");
  expect(host.stop_from_request().ok && !audio_state.capture_active,
    "audio session stop still clears capture activity");
  expect(!event_payloads.empty() && event_payloads.back().find("audio-session-stopped") != std::string::npos,
    "necessary audio stop state is still emitted");
  std::cout << "host audio dispatch: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
