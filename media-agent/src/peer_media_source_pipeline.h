#pragma once

#include <string>

#include "peer_media_binding_result.h"

struct AgentRuntimeState;

namespace vds::media_agent {

PeerMediaBindingCommandResult attach_peer_media_source_command(
  AgentRuntimeState& runtime_state,
  const std::string& request_json);
PeerMediaBindingCommandResult detach_peer_media_source_command(
  AgentRuntimeState& runtime_state,
  const std::string& request_json);

}  // namespace vds::media_agent
