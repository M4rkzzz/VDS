#include "peer_control_runtime.h"

#include <memory>
#include <mutex>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "agent_status_json.h"
#include "json_protocol.h"
#include "peer_media_binding_runtime.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "relay_dispatch.h"
#include "surface_attachment_runtime.h"
#include "time_utils.h"
#include "viewer_audio_playback.h"
#include "viewer_video_pipeline.h"

namespace {

using vds::media_agent::extract_bool_value;
using vds::media_agent::extract_string_value;
using vds::media_agent::current_time_millis;
using vds::media_agent::json_escape;

void emit_peer_control_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

PeerControlCommandResult ok_result(std::string result_json) {
  PeerControlCommandResult result;
  result.ok = true;
  result.result_json = std::move(result_json);
  return result;
}

PeerControlCommandResult error_result(const std::string& code, const std::string& message) {
  PeerControlCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

std::string peer_ok_json(const PeerState& peer) {
  return std::string("{\"ok\":true,\"implementation\":\"") +
    json_escape(peer.transport.transport_ready ? "libdatachannel" : "stub") + "\"}";
}

}  // namespace

PeerControlCommandResult create_peer_from_request(AgentRuntimeState& state, const std::string& request_json) {
  PeerState peer;
  peer.peer_id = extract_string_value(request_json, "peerId");
  peer.role = extract_string_value(request_json, "role");
  peer.initiator = extract_bool_value(request_json, "initiator");
  emit_peer_control_breadcrumb(
    std::string("createPeer:begin peer=") + peer.peer_id +
    " role=" + peer.role +
    " initiator=" + (peer.initiator ? "true" : "false"));
  if (peer.peer_id.empty()) {
    return error_result("BAD_REQUEST", "peerId is required");
  }

  peer.transport.available = state.peer_transport_backend.available;
  peer.transport.transport_ready = state.peer_transport_backend.transport_ready;
  peer.transport.reason = state.peer_transport_backend.reason;
  peer.receiver_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime>();
  peer.receiver_runtime->peer_id = peer.peer_id;
  peer.receiver_runtime->local_playback_enabled = peer.role == "viewer-upstream";

  if (state.peer_transport_backend.transport_ready) {
    auto receiver_runtime = peer.receiver_runtime;
    auto transport_session_holder = std::make_shared<std::weak_ptr<PeerTransportSession>>();
    PeerTransportCallbacks callbacks;
    callbacks.on_local_description = [peer_id = peer.peer_id](const std::string& type, const std::string& sdp) {
      emit_event(
        "signal",
        std::string("{\"peerId\":\"") + json_escape(peer_id) +
          "\",\"targetId\":\"" + json_escape(peer_id) +
          "\",\"type\":\"" + json_escape(type) +
          "\",\"sdp\":{\"type\":\"" + json_escape(type) +
          "\",\"sdp\":\"" + json_escape(sdp) +
          "\"},\"transportReady\":true,\"trickleIce\":true}"
      );
    };
    callbacks.on_local_candidate = [peer_id = peer.peer_id](const std::string& candidate, const std::string& sdp_mid) {
      emit_event(
        "signal",
        std::string("{\"peerId\":\"") + json_escape(peer_id) +
          "\",\"targetId\":\"" + json_escape(peer_id) +
          "\",\"type\":\"candidate\",\"candidate\":{\"candidate\":\"" + json_escape(candidate) +
          "\",\"sdpMid\":\"" + json_escape(sdp_mid) +
          "\",\"sdpMLineIndex\":0},\"transportReady\":true,\"trickleIce\":true}"
      );
    };
    callbacks.on_state_change = [
      peer_id = peer.peer_id,
      role = peer.role,
      initiator = peer.initiator
    ](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
      PeerState event_peer;
      event_peer.peer_id = peer_id;
      event_peer.role = role;
      event_peer.initiator = initiator;
      event_peer.transport = snapshot;
      emit_event("peer-state", build_peer_state_json(event_peer, logical_state));
    };
    callbacks.on_warning = [peer_id = peer.peer_id](const std::string& message) {
      emit_event(
        "warning",
        std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer_id) +
          "\",\"message\":\"" + json_escape(message) + "\"}"
      );
    };
    callbacks.on_remote_video_frame = [
      peer_id = peer.peer_id,
      receiver_runtime,
      transport_session_holder
    ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
      consume_remote_peer_video_frame(
        peer_id,
        receiver_runtime,
        transport_session_holder->lock(),
        frame,
        codec,
        rtp_timestamp
      );
    };
    callbacks.on_remote_audio_frame = [
      &state,
      peer_id = peer.peer_id,
      receiver_runtime
    ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
      consume_remote_peer_audio_frame(state.viewer_audio_playback, peer_id, receiver_runtime, frame, codec, rtp_timestamp);
    };

    std::string peer_create_error;
    peer.transport_session = create_peer_transport_session(peer.peer_id, peer.initiator, callbacks, &peer_create_error);
    *transport_session_holder = peer.transport_session;
    if (peer.transport_session) {
      peer.transport = get_peer_transport_snapshot(peer.transport_session);
      emit_peer_control_breadcrumb(std::string("createPeer:after-create-transport peer=") + peer.peer_id);
    } else {
      peer.transport.transport_ready = false;
      peer.transport.reason = "peer-create-failed";
      peer.transport.last_error = peer_create_error;
    }
  }

  if (peer.transport_session && peer.role == "host-downstream" && state.host_session_running) {
    std::string attach_error;
    if (!attach_host_video_media_binding(state, peer, &attach_error)) {
      peer.media_binding.attached = false;
      peer.media_binding.sender_configured = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-attach-failed";
      peer.media_binding.last_error = attach_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
    }
  }

  const bool should_negotiate_immediately =
    peer.transport_session &&
    peer.initiator &&
    (peer.role != "host-downstream" || peer.media_binding.attached);

  if (should_negotiate_immediately) {
    std::string negotiate_error;
    if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
      peer.transport = get_peer_transport_snapshot(peer.transport_session);
      peer.transport.last_error = negotiate_error;
      peer.transport.reason = "peer-local-description-failed";
      if (peer.media_binding.reason == "peer-media-not-attached") {
        peer.media_binding.reason = "peer-local-description-failed";
        peer.media_binding.last_error = negotiate_error;
        peer.media_binding.updated_at_unix_ms = current_time_millis();
      }
    }
  }

  state.peers[peer.peer_id] = peer;
  refresh_peer_transport_runtime(state);
  emit_event("peer-state", build_peer_state_json(peer, "created"));
  if (!peer.transport.transport_ready && !peer.transport.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer.peer_id) +
        "\",\"message\":\"" + json_escape(peer.transport.last_error) + "\"}"
    );
  }
  emit_peer_control_breadcrumb(std::string("createPeer:before-result peer=") + peer.peer_id);
  return ok_result(build_peer_result_json(state.peers[peer.peer_id]));
}

PeerControlCommandResult close_peer_from_request(AgentRuntimeState& state, const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  emit_peer_control_breadcrumb(std::string("closePeer:begin peer=") + peer_id);
  auto it = state.peers.find(peer_id);
  if (it != state.peers.end()) {
    for (auto surface_it = state.attached_surfaces.begin(); surface_it != state.attached_surfaces.end();) {
      if (surface_it->second.peer_id == peer_id) {
        if (surface_it->second.peer_runtime) {
          stop_peer_video_surface_attachment(*surface_it->second.peer_runtime, "peer-closed");
        } else {
          stop_surface_attachment(surface_it->second, "peer-closed");
        }
        surface_it = state.attached_surfaces.erase(surface_it);
        continue;
      }
      ++surface_it;
    }
    emit_peer_control_breadcrumb(std::string("closePeer:after-stop-surfaces peer=") + peer_id);

    std::string detach_error;
    if (!prepare_peer_media_binding_for_transport_close(it->second, &detach_error)) {
      it->second.media_binding.reason = "peer-media-close-prepare-failed";
      it->second.media_binding.last_error = detach_error;
    }
    emit_peer_control_breadcrumb(std::string("closePeer:after-prepare-media-binding peer=") + peer_id);
    if (it->second.receiver_runtime) {
      begin_close_peer_video_receiver_runtime(*it->second.receiver_runtime);
    }
    emit_peer_control_breadcrumb(std::string("closePeer:after-begin-close-receiver-runtime peer=") + peer_id);
    close_peer_transport_session(it->second.transport_session);
    emit_peer_control_breadcrumb(std::string("closePeer:after-close-transport-session peer=") + peer_id);
    if (it->second.receiver_runtime) {
      close_peer_video_receiver_handles(*it->second.receiver_runtime);
    }
    emit_peer_control_breadcrumb(std::string("closePeer:after-close-receiver-handles peer=") + peer_id);
    if (it->second.role == "viewer-upstream") {
      clear_relay_upstream_bootstrap_state(peer_id);
    }
    if (it->second.role == "viewer-upstream") {
      stop_viewer_audio_playback_runtime(state.viewer_audio_playback);
    }
    emit_peer_control_breadcrumb(std::string("closePeer:after-stop-viewer-audio peer=") + peer_id);
    it->second.transport.closed = true;
    it->second.transport.data_channel_open = false;
    it->second.transport.connection_state = "closed";
    it->second.transport.ice_state = "closed";
    it->second.transport.signaling_state = "closed";
    it->second.transport.reason = "peer-closed";
    it->second.transport.updated_at_unix_ms = current_time_millis();
    emit_event("peer-state", build_peer_state_json(it->second, "closed"));
    state.peers.erase(it);
    emit_peer_control_breadcrumb(std::string("closePeer:after-erase peer=") + peer_id);
  }

  return ok_result(
    std::string("{\"closed\":true,\"implementation\":\"") +
    json_escape(state.peer_transport_backend.transport_ready ? "libdatachannel" : "stub") +
    "\"}"
  );
}

PeerControlCommandResult set_peer_remote_description_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string description_type = extract_string_value(request_json, "type");
  const std::string sdp = extract_string_value(request_json, "sdp");
  auto it = state.peers.find(peer_id);
  if (it == state.peers.end()) {
    return error_result("PEER_NOT_FOUND", "Peer has not been created");
  }

  if (it->second.transport_session) {
    std::string set_description_error;
    if (!set_peer_transport_remote_description(
          it->second.transport_session,
          description_type.empty() ? "offer" : description_type,
          sdp,
          &set_description_error)) {
      return error_result("NATIVE_TRANSPORT_ERROR", set_description_error);
    }
    it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
  }

  it->second.has_remote_description = true;
  if (!it->second.transport_session) {
    emit_event("peer-state", build_peer_state_json(it->second, "remote-description-set"));
  }
  return ok_result(peer_ok_json(it->second));
}

PeerControlCommandResult add_peer_remote_ice_candidate_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string candidate = extract_string_value(request_json, "candidate");
  const std::string sdp_mid = extract_string_value(request_json, "sdpMid");
  auto it = state.peers.find(peer_id);
  if (it == state.peers.end()) {
    return error_result("PEER_NOT_FOUND", "Peer has not been created");
  }

  if (it->second.transport_session) {
    std::string add_candidate_error;
    if (!add_peer_transport_remote_candidate(
          it->second.transport_session,
          candidate,
          sdp_mid,
          &add_candidate_error)) {
      return error_result("NATIVE_TRANSPORT_ERROR", add_candidate_error);
    }
    it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
  }

  it->second.remote_candidate_count += 1;
  if (!it->second.transport_session) {
    emit_event("peer-state", build_peer_state_json(it->second, "remote-candidate-added"));
  }
  return ok_result(peer_ok_json(it->second));
}
