#include "peer_session_controller.h"

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "audio_session_state.h"
#include "host_audio_dispatch_session.h"
#include "host_capture_plan.h"
#include "host_session_runtime.h"
#include "host_session_state.h"
#include "json_protocol.h"
#include "obs_ingest_session.h"
#include "peer_create_pipeline.h"
#include "peer_create_request_config.h"
#include "peer_host_source_binding.h"
#include "peer_lifecycle_pipeline.h"
#include "peer_media_manifest.h"
#include "peer_media_detach_binding.h"
#include "peer_media_source_pipeline.h"
#include "peer_receiver_runtime.h"
#include "peer_refresh_pipeline.h"
#include "peer_session_state.h"
#include "peer_state_json.h"
#include "peer_transport.h"
#include "peer_transport_session_factory.h"
#include "relay_hub.h"
#include "runtime_registry.h"
#include "surface_session_controller.h"
#include "viewer_audio_session.h"

namespace vds::media_agent {
namespace {

void emit_peer_close_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

void emit_peer_create_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

PeerControlCommandResult ok_peer_control_result(std::string result_json) {
  PeerControlCommandResult result;
  result.ok = true;
  result.result_json = result_json;
  return result;
}

PeerControlCommandResult error_peer_control_result(const std::string& code, const std::string& message) {
  PeerControlCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

PeerControlCommandResult finalize_created_peer(AgentRuntimeState& state, const PeerState& peer) {
  PeerState& stored_peer = ensure_peer(state, peer.peer_id);
  stored_peer = peer;
  refresh_all_peer_transport_runtime(state);
  emit_event("peer-state", build_peer_state_json(peer, "created"));
  if (!peer.transport.transport_ready && !peer.transport.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer.peer_id) +
        "\",\"message\":\"" + json_escape(peer.transport.last_error) + "\"}"
    );
  }
  emit_peer_create_breadcrumb(std::string("createPeer:before-result peer=") + peer.peer_id);
  return ok_peer_control_result(build_peer_result_json(stored_peer));
}

void refresh_all_host_video_senders_for_controller(AgentRuntimeState& runtime_state) {
  if (!host_session_snapshot(runtime_state).running) {
    return;
  }

  HostSessionState& host_session = active_host_session(runtime_state);

  for_each_mutable_peer_with_role(runtime_state, "host-downstream", [&](PeerState& peer) {
    if (!peer.transport_session) {
      return;
    }
    if (!peer.media_binding.runtime || !peer.media_binding.runtime->soft_refresh_requested.load()) {
      return;
    }

    const HostCapturePlan& capture_plan = revalidate_host_capture_plan(runtime_state, host_session);
    if (!capture_plan.ready || !capture_plan.validated) {
      peer.media_binding.reason = "peer-media-soft-refresh-waiting-for-valid-plan";
      peer.media_binding.last_error = capture_plan.last_error;
      return;
    }
    const ObsIngestSessionSnapshot obs_ingest =
      make_obs_ingest_session_snapshot(obs_ingest_session_snapshot(runtime_state));
    const HostVideoBindingContext binding_context{
      host_session_snapshot(runtime_state),
      ffmpeg_probe_result(runtime_state),
      audio_session_snapshot(runtime_state),
      obs_ingest
    };
    std::string refresh_error;
    if (!attach_host_video_media_binding(binding_context, peer, &refresh_error, true)) {
      peer.media_binding.attached = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-soft-refresh-failed";
      peer.media_binding.last_error = refresh_error;
      emit_agent_breadcrumb(
        std::string("hostVideoSenderRefresh:failed peer=") + peer.peer_id +
        " error=" + refresh_error);
    } else {
      emit_agent_breadcrumb(std::string("hostVideoSenderRefresh:done peer=") + peer.peer_id);
    }
  });
}

void refresh_all_host_audio_senders_for_controller(AgentRuntimeState& runtime_state) {
  const AudioSessionState& audio_session = audio_session_snapshot(runtime_state);
  for_each_mutable_peer_with_role(runtime_state, "host-downstream", [&](PeerState& peer) {
    if (!peer.transport_session) {
      return;
    }

    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    const bool use_encoded_data_channel =
      peer.transport.encoded_media_data_channel_requested ||
      peer.transport.encoded_media_data_channel_supported;
    const bool had_audio_track = peer.transport.audio_track_configured;
    if (audio_session_capture_ready(audio_session)) {
      configure_host_audio_sender(audio_session, peer, nullptr);
    } else {
      clear_host_audio_sender(peer);
    }
    if (use_encoded_data_channel) {
      return;
    }

    const bool has_audio_track = peer.transport.audio_track_configured;
    if (peer.initiator && had_audio_track != has_audio_track) {
      std::string negotiate_error;
      if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
        peer.transport = get_peer_transport_snapshot(peer.transport_session);
        peer.transport.last_error = negotiate_error;
        peer.transport.reason = "peer-audio-renegotiation-failed";
      }
    }
  });
}

}  // namespace

PeerSessionController::PeerSessionController(AgentRuntimeState& runtime_state)
    : runtime_state_(runtime_state) {}

PeerControlCommandResult PeerSessionController::create_from_request(const std::string& request_json) {
  PeerCreateRequestConfig config = configure_peer_create_request(peer_transport_backend(runtime_state_), request_json);
  if (!config.ok) {
    return config.error;
  }
  PeerState& peer = config.peer;

  const bool transport_ready = peer_transport_ready(runtime_state_);
  if (transport_ready) {
    create_transport_for_peer_session(
      transport_ready,
      peer,
      request_json,
      config.encoded_media_data_channel);
  }

  const ObsIngestSessionSnapshot obs_ingest =
    make_obs_ingest_session_snapshot(obs_ingest_session_snapshot(runtime_state_));
  const HostVideoBindingContext host_binding_context{
    host_session_snapshot(runtime_state_),
    ffmpeg_probe_result(runtime_state_),
    audio_session_snapshot(runtime_state_),
    obs_ingest
  };
  attach_host_downstream_media_if_running(host_binding_context, peer);
  ensure_initial_peer_negotiation(peer);
  return finalize_created_peer(runtime_state_, peer);
}

PeerControlCommandResult PeerSessionController::close_from_request(const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  emit_peer_close_breadcrumb(std::string("closePeer:begin peer=") + peer_id);
  PeerState* peer = find_peer(runtime_state_, peer_id);
  if (peer) {
    SurfaceSessionController surface_sessions(runtime_state_);
    surface_sessions.detach_peer_surfaces(peer_id, "peer-closed");
    emit_peer_close_breadcrumb(std::string("closePeer:after-stop-surfaces peer=") + peer_id);

    std::string detach_error;
    if (!prepare_peer_media_binding_for_transport_close(*peer, &detach_error)) {
      peer->media_binding.reason = "peer-media-close-prepare-failed";
      peer->media_binding.last_error = detach_error;
    }
    peer->phase = SessionPhase::Draining;
    peer->phase_reason = "peer-closing";
    emit_peer_close_breadcrumb(std::string("closePeer:after-prepare-media-binding peer=") + peer_id);
    if (peer->receiver_runtime) {
      begin_close_peer_video_receiver_runtime(*peer->receiver_runtime);
    }
    emit_peer_close_breadcrumb(std::string("closePeer:after-begin-close-receiver-runtime peer=") + peer_id);
    close_peer_transport_session(peer->transport_session);
    emit_peer_close_breadcrumb(std::string("closePeer:after-close-transport-session peer=") + peer_id);
    if (peer->receiver_runtime) {
      close_peer_video_receiver_handles(*peer->receiver_runtime);
    }
    emit_peer_close_breadcrumb(std::string("closePeer:after-close-receiver-handles peer=") + peer_id);
    if (peer->role == "viewer-upstream") {
      relay_hub().clear_upstream_bootstrap_state(peer_id);
    }
    if (peer->role == "viewer-upstream") {
      ViewerAudioSession viewer_audio;
      viewer_audio.stop();
    }
    emit_peer_close_breadcrumb(std::string("closePeer:after-stop-viewer-audio peer=") + peer_id);
    peer->transport.connection_state = "closed";
    peer->transport.ice_state = "closed";
    peer->transport.signaling_state = "closed";
    peer->transport.reason = "peer-closed";
    peer->phase = SessionPhase::Stopped;
    peer->phase_reason = "peer-closed";
    emit_event("peer-state", build_peer_state_json(*peer, "closed"));
    erase_peer(runtime_state_, peer_id);
    emit_peer_close_breadcrumb(std::string("closePeer:after-erase peer=") + peer_id);
  }

  return ok_peer_control_result(build_peer_closed_result_json(peer_transport_ready(runtime_state_)));
}

PeerControlCommandResult PeerSessionController::set_remote_description_from_request(const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string description_type = extract_string_value(request_json, "type");
  const std::string sdp = extract_string_value(request_json, "sdp");
  PeerState* peer = find_peer(runtime_state_, peer_id);
  if (!peer) {
    return error_peer_control_result("PEER_NOT_FOUND", "Peer has not been created");
  }
  apply_media_manifest_to_peer(*peer, request_json);

  if (peer->transport_session) {
    std::string set_description_error;
    if (!set_peer_transport_remote_description(
          peer->transport_session,
          description_type.empty() ? "offer" : description_type,
          sdp,
          &set_description_error)) {
      return error_peer_control_result("NATIVE_TRANSPORT_ERROR", set_description_error);
    }
    peer->transport = get_peer_transport_snapshot(peer->transport_session);
  }

  if (!peer->transport_session) {
    emit_event("peer-state", build_peer_state_json(*peer, "remote-description-set"));
  }
  return ok_peer_control_result(build_peer_ok_json(*peer));
}

PeerControlCommandResult PeerSessionController::add_remote_ice_candidate_from_request(const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string candidate = extract_string_value(request_json, "candidate");
  const std::string sdp_mid = extract_string_value(request_json, "sdpMid");
  PeerState* peer = find_peer(runtime_state_, peer_id);
  if (!peer) {
    return error_peer_control_result("PEER_NOT_FOUND", "Peer has not been created");
  }

  if (peer->transport_session) {
    std::string add_candidate_error;
    if (!add_peer_transport_remote_candidate(
          peer->transport_session,
          candidate,
          sdp_mid,
          &add_candidate_error)) {
      return error_peer_control_result("NATIVE_TRANSPORT_ERROR", add_candidate_error);
    }
    peer->transport = get_peer_transport_snapshot(peer->transport_session);
  }

  if (!peer->transport_session) {
    emit_event("peer-state", build_peer_state_json(*peer, "remote-candidate-added"));
  }
  return ok_peer_control_result(build_peer_ok_json(*peer));
}

PeerMediaBindingCommandResult PeerSessionController::attach_media_source_from_request(const std::string& request_json) {
  return attach_peer_media_source_command(runtime_state_, request_json);
}

PeerMediaBindingCommandResult PeerSessionController::detach_media_source_from_request(const std::string& request_json) {
  return detach_peer_media_source_command(runtime_state_, request_json);
}

void PeerSessionController::refresh_transport_runtime() {
  refresh_all_peer_transport_runtime(runtime_state_);
}

void PeerSessionController::perform_host_video_sender_soft_refresh() {
  refresh_all_host_video_senders_for_controller(runtime_state_);
}

void PeerSessionController::refresh_host_audio_senders() {
  refresh_all_host_audio_senders_for_controller(runtime_state_);
}

void PeerSessionController::close_all_receiver_handles() {
  close_all_peer_receiver_handles(runtime_state_);
}

void PeerSessionController::close_all_transport_sessions() {
  close_all_peer_transport_sessions(runtime_state_);
}

} // namespace vds::media_agent
