#pragma once

#include <string>

struct AgentRuntimeState;
struct PeerState;

struct PeerMediaBindingCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

void perform_host_video_sender_soft_refresh(AgentRuntimeState& state);
void refresh_peer_transport_runtime(AgentRuntimeState& state);
PeerMediaBindingCommandResult attach_peer_media_source_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
PeerMediaBindingCommandResult detach_peer_media_source_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
bool attach_host_video_media_binding(
  AgentRuntimeState& state,
  PeerState& peer,
  std::string* error,
  bool force_restart = false);
bool detach_peer_media_binding(PeerState& peer, std::string* error);
bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error);
void refresh_host_audio_senders(AgentRuntimeState& state);
