#pragma once

#include <string>

struct AgentRuntimeState;

std::string capabilities_json(const AgentRuntimeState& state);
std::string build_status_json(const AgentRuntimeState& state);
std::string build_agent_ready_json(const AgentRuntimeState& state);
std::string build_stats_json(const AgentRuntimeState& state);
