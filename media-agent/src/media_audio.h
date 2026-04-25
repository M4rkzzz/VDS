#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "agent_runtime.h"
#include "peer_transport.h"
#include "wasapi_backend.h"

inline constexpr unsigned int kTransportAudioSampleRate = 48000;
inline constexpr unsigned int kTransportAudioChannelCount = 2;
inline constexpr unsigned int kTransportAudioBitrateKbps = 128;

struct AudioSessionCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

AudioSessionCommandResult start_audio_session_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
AudioSessionCommandResult stop_audio_session_from_request(AgentRuntimeState& state);
void attach_wasapi_audio_callbacks(AgentRuntimeState& state);

std::vector<std::int16_t> decode_pcmu_to_pcm16(const std::vector<std::uint8_t>& encoded);
std::vector<std::int16_t> decode_audio_to_pcm16(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  const std::string& codec_name,
  std::string* error);
void reset_peer_audio_decoder_runtime(PeerState::PeerVideoReceiverRuntime& runtime);

void register_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session);
void unregister_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session);
void reset_host_audio_transport_sessions();
void dispatch_host_audio_capture_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent);

std::string audio_session_json(const AudioSessionState& session);
AudioSessionState build_audio_session_state(const AudioBackendProbe& probe);
AudioSessionState build_audio_session_state(const WasapiSessionStatus& status);
AudioBackendProbe build_audio_backend_probe(const WasapiProbeResult& probe);
