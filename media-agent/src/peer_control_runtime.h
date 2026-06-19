#pragma once

#include <string>

struct AgentRuntimeState;

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
