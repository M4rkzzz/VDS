#include "peer_transport_session_factory.h"

#include <memory>

#include "agent_diagnostics.h"
#include "peer_media_manifest.h"
#include "peer_session_state.h"
#include "peer_transport.h"
#include "peer_transport_callback_factory.h"

namespace vds::media_agent {
namespace {

void emit_peer_transport_factory_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

}  // namespace

void create_transport_for_peer_session(
  bool transport_ready,
  PeerState& peer,
  const std::string& request_json,
  bool encoded_media_data_channel) {
  if (!transport_ready) {
    return;
  }

  peer.phase = SessionPhase::Starting;
  peer.phase_reason = "peer-transport-starting";
  auto receiver_runtime = peer.receiver_runtime;
  auto transport_session_holder = std::make_shared<std::weak_ptr<PeerTransportSession>>();
  const PeerTransportCallbacks callbacks = create_peer_transport_callbacks({
    peer.peer_id,
    peer.role,
    peer.initiator,
    peer.expected_video_codec,
    peer.expected_audio_codec,
    receiver_runtime,
    transport_session_holder
  });

  std::string peer_create_error;
  peer.transport_session = create_peer_transport_session(
    peer.peer_id,
    peer.initiator,
    callbacks,
    encoded_media_data_channel,
    &peer_create_error
  );
  *transport_session_holder = peer.transport_session;
  if (peer.transport_session) {
    apply_media_manifest_to_peer(peer, request_json);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.phase = SessionPhase::Running;
    peer.phase_reason = "peer-transport-running";
    emit_peer_transport_factory_breadcrumb(
      std::string("createPeer:after-create-transport peer=") + peer.peer_id);
  } else {
    peer.transport.transport_ready = false;
    peer.transport.reason = "peer-create-failed";
    peer.transport.last_error = peer_create_error;
    peer.phase = SessionPhase::Failed;
    peer.phase_reason = "peer-create-failed";
  }
}

}  // namespace vds::media_agent
