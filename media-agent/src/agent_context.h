#pragma once

#include <string>

#include "agent_events.h"

struct AgentRuntimeState;

namespace vds::media_agent {

struct AgentContext {
  explicit AgentContext(AgentRuntimeState& runtime_state)
      : runtime(runtime_state) {}

  AgentRuntimeState& runtime;

  void emit(const std::string& event_name, const std::string& params_json) const {
    emit_event(event_name, params_json);
  }
};

} // namespace vds::media_agent
