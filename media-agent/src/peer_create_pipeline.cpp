#include "peer_create_pipeline.h"

#include <string>

#include "host_session_state.h"
#include "peer_host_source_binding.h"
#include "peer_session_state.h"
#include "peer_transport.h"

namespace vds::media_agent {
void attach_host_downstream_media_if_running(const HostVideoBindingContext& binding_context, PeerState& peer) {
  if (!peer.transport_session || peer.role != "host-downstream" || !binding_context.host_session.running) {
    return;
  }

  std::string attach_error;
  if (!attach_host_video_media_binding(binding_context, peer, &attach_error)) {
    peer.media_binding.attached = false;
    peer.media_binding.active = false;
    peer.media_binding.reason = "peer-media-attach-failed";
    peer.media_binding.last_error = attach_error;
  }
}

void ensure_initial_peer_negotiation(PeerState& peer) {
  const bool should_negotiate_immediately =
    peer.transport_session &&
    peer.initiator &&
    (peer.role != "host-downstream" || peer.media_binding.attached);

  if (!should_negotiate_immediately) {
    return;
  }

  std::string negotiate_error;
  if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.transport.last_error = negotiate_error;
    peer.transport.reason = "peer-local-description-failed";
    if (peer.media_binding.reason == "peer-media-not-attached") {
      peer.media_binding.reason = "peer-local-description-failed";
      peer.media_binding.last_error = negotiate_error;
    }
  }
}

}  // namespace vds::media_agent
