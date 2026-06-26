#pragma once

#include <cstddef>
#include <string>

struct AgentRuntimeState;

namespace vds::media_agent {

std::size_t surface_session_count(const AgentRuntimeState& runtime_state);
std::string surface_session_stats_json(const AgentRuntimeState& runtime_state);

}  // namespace vds::media_agent
