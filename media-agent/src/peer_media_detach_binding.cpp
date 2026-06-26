#include "peer_media_detach_binding.h"

#include "agent_diagnostics.h"
#include "host_audio_dispatch_session.h"
#include "peer_host_source_binding.h"
#include "peer_session_state.h"
#include "peer_transport.h"
#include "peer_video_sender.h"
#include "relay_hub.h"

namespace {

void emit_peer_media_detach_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

}  // namespace

bool detach_peer_media_binding(PeerState& peer, std::string* error) {
  relay_hub().unregister_subscriber(peer.peer_id);
  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-media-detached", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  if (!peer.transport_session) {
    peer.media_binding.attached = false;
    peer.media_binding.active = false;
    peer.media_binding.reason = "peer-media-detached";
    return true;
  }

  std::string detach_error;
  if (!clear_peer_transport_video_sender(peer.transport_session, &detach_error)) {
    if (error) {
      *error = detach_error;
    }
    return false;
  }
  clear_host_audio_sender(peer);

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-media-detached";
  peer.media_binding.last_error.clear();
  return true;
}

bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error) {
  emit_peer_media_detach_breadcrumb(
    std::string("preparePeerMediaBinding:start peer=") +
    peer.peer_id +
    " role=" + peer.role +
    " attached=" + (peer.media_binding.attached ? "true" : "false")
  );
  relay_hub().unregister_subscriber(peer.peer_id);
  HostAudioDispatchSession host_audio_dispatch;
  host_audio_dispatch.unregister_transport_session(peer.transport_session);

  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-closing", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  peer.media_binding.attached = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-closing";
  peer.media_binding.last_error.clear();
  emit_peer_media_detach_breadcrumb(std::string("preparePeerMediaBinding:done peer=") + peer.peer_id);
  if (error) {
    error->clear();
  }
  return true;
}
