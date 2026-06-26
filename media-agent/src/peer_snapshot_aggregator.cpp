#include "peer_snapshot_aggregator.h"

#include <sstream>

#include "peer_session_state.h"
#include "peer_state_json.h"
#include "runtime_registry.h"

namespace vds::media_agent {

std::size_t peer_session_count(const AgentRuntimeState& runtime_state) {
  return peer_count(runtime_state);
}

std::string peer_session_stats_json(const AgentRuntimeState& runtime_state) {
  std::ostringstream payload;
  payload << "[";

  bool first = true;
  for_each_peer(runtime_state, [&](const PeerState& peer) {
    if (!first) {
      payload << ",";
    }
    first = false;

    payload << build_peer_stats_json(peer);
  });

  payload << "]";
  return payload.str();
}

}  // namespace vds::media_agent
