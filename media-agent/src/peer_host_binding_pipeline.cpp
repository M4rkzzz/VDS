#include "peer_host_binding_pipeline.h"

#include <string>

#include "agent_events.h"
#include "host_session_command.h"
#include "peer_session_state.h"
#include "peer_state_json.h"
#include "peer_transport.h"
#include "runtime_registry.h"

namespace vds::media_agent {
namespace {

void apply_local_description_after_binding(PeerState& peer) {
  if (!peer.initiator || !peer.transport_session) {
    return;
  }

  std::string negotiate_error;
  if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.transport.last_error = negotiate_error;
    peer.transport.reason = "peer-local-description-failed";
    peer.media_binding.reason = "peer-local-description-failed";
    peer.media_binding.last_error = negotiate_error;
  }
}

}  // namespace

void attach_host_downstream_media_bindings(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks) {
  for_each_mutable_peer_with_role(state, "host-downstream", [&](PeerState& peer) {
    std::string attach_error;
    if (!callbacks.attach_host_video_media_binding ||
        !callbacks.attach_host_video_media_binding(peer, &attach_error)) {
      peer.media_binding.attached = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-attach-failed";
      peer.media_binding.last_error = attach_error;
    } else if (peer.initiator && peer.transport_session) {
      apply_local_description_after_binding(peer);
    } else {
      emit_event("peer-state", build_peer_state_json(peer, "media-source-attached"));
    }
  });
}

void detach_host_downstream_media_bindings(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks) {
  for_each_mutable_peer_with_role(state, "host-downstream", [&](PeerState& peer) {
    std::string detach_error;
    if (!callbacks.detach_peer_media_binding ||
        !callbacks.detach_peer_media_binding(peer, &detach_error)) {
      peer.media_binding.reason = "peer-media-detach-failed";
      peer.media_binding.last_error = detach_error;
    } else if (peer.initiator && peer.transport_session) {
      apply_local_description_after_binding(peer);
    }
  });
}

}  // namespace vds::media_agent
