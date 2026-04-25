#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "agent_runtime.h"

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
bool attach_relay_video_media_binding(
  AgentRuntimeState& state,
  PeerState& peer,
  const std::string& source,
  std::string* error);
bool detach_peer_media_binding(PeerState& peer, std::string* error);
bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error);
void clear_host_audio_sender(PeerState& peer);
void refresh_host_audio_senders(AgentRuntimeState& state);
