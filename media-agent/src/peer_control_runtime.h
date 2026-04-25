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

struct PeerControlCommandResult {
  bool ok = false;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

PeerControlCommandResult create_peer_from_request(AgentRuntimeState& state, const std::string& request_json);
PeerControlCommandResult close_peer_from_request(AgentRuntimeState& state, const std::string& request_json);
PeerControlCommandResult set_peer_remote_description_from_request(AgentRuntimeState& state, const std::string& request_json);
PeerControlCommandResult add_peer_remote_ice_candidate_from_request(AgentRuntimeState& state, const std::string& request_json);
