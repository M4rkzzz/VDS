#include "peer_lifecycle_pipeline.h"

#include "peer_session_state.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "runtime_registry.h"

namespace vds::media_agent {

void close_all_peer_receiver_handles(AgentRuntimeState& runtime_state) {
  for_each_mutable_peer(runtime_state, [](PeerState& peer) {
    if (peer.receiver_runtime) {
      close_peer_video_receiver_handles(*peer.receiver_runtime);
    }
  });
}

void close_all_peer_transport_sessions(AgentRuntimeState& runtime_state) {
  for_each_mutable_peer(runtime_state, [](PeerState& peer) {
    close_peer_transport_session(peer.transport_session);
  });
}

}  // namespace vds::media_agent
