#pragma once

#include <string>

#include "agent_runtime.h"

std::string capabilities_json(AgentRuntimeState& state);
std::string build_status_json(AgentRuntimeState& state);
std::string build_agent_ready_json(AgentRuntimeState& state);
std::string build_peer_state_json(const PeerState& peer, const std::string& state);
std::string build_host_session_json(AgentRuntimeState& state);
std::string build_peer_result_json(const PeerState& peer);
std::string build_stats_json(AgentRuntimeState& state);
