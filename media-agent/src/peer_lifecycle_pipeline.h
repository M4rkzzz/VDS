#pragma once

struct AgentRuntimeState;

namespace vds::media_agent {

void close_all_peer_receiver_handles(AgentRuntimeState& runtime_state);
void close_all_peer_transport_sessions(AgentRuntimeState& runtime_state);

}  // namespace vds::media_agent
