#include "peer_lifecycle_pipeline.h"

#include <exception>
#include <stdexcept>

#include "peer_media_detach_binding.h"
#include "peer_session_state.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "runtime_registry.h"

namespace vds::media_agent {

void stop_all_peer_media_bindings(AgentRuntimeState& runtime_state) {
  std::exception_ptr failure;
  for_each_mutable_peer(runtime_state, [&](PeerState& peer) {
    try {
      std::string error;
      if (!prepare_peer_media_binding_for_transport_close(peer, &error)) {
        throw std::runtime_error(error.empty() ? "peer-media-close-prepare-failed" : error);
      }
    } catch (...) {
      if (!failure) failure = std::current_exception();
    }
  });
  if (failure) std::rethrow_exception(failure);
}

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
