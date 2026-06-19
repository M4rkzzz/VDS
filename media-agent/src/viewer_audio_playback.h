#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "agent_runtime.h"

inline constexpr unsigned int kViewerAudioSampleRate = 48000;
inline constexpr unsigned int kViewerAudioChannelCount = 2;

struct ViewerAudioCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

ViewerAudioCommandResult set_viewer_volume_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
ViewerAudioCommandResult get_viewer_volume_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
ViewerAudioCommandResult set_viewer_audio_delay_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
void stop_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime);
void consume_remote_peer_audio_frame(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime,
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp
);
