#include "peer_media_source_pipeline.h"

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "json_protocol.h"
#include "obs_ingest_session.h"
#include "peer_host_source_binding.h"
#include "peer_media_detach_binding.h"
#include "peer_refresh_pipeline.h"
#include "peer_relay_source_binding.h"
#include "peer_session_state.h"
#include "peer_state_json.h"
#include "peer_transport.h"
#include "runtime_registry.h"
#include "surface_target.h"

namespace vds::media_agent {
namespace {

void emit_peer_media_source_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

}  // namespace

PeerMediaBindingCommandResult attach_peer_media_source_command(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string source = extract_string_value(request_json, "source");
  emit_peer_media_source_breadcrumb(
    std::string("attachPeerMediaSource:begin peer=") + peer_id +
    " source=" + source);

  PeerState* peer = find_peer(runtime_state, peer_id);
  if (!peer) {
    return {false, {}, "PEER_NOT_FOUND", "Peer has not been created"};
  }

  if (!source.empty() &&
      source != "host-session-video" &&
      source != "host-capture-artifact" &&
      !is_peer_video_media_source(source)) {
    return {
      false,
      {},
      "BAD_REQUEST",
      "Only host-session-video, host-capture-artifact, and peer-video:<peerId> are currently supported"
    };
  }

  const bool was_attached = peer->media_binding.attached;
  const bool had_video_track_configured = peer->transport.video_track_configured;
  const bool had_audio_track_configured = peer->transport.audio_track_configured;
  const std::string previous_source = peer->media_binding.source;
  const std::string previous_codec = peer->media_binding.codec;
  const int previous_width = peer->media_binding.width;
  const int previous_height = peer->media_binding.height;
  const int previous_frame_rate = peer->media_binding.frame_rate;
  const int previous_bitrate_kbps = peer->media_binding.bitrate_kbps;

  std::string attach_error;
  bool attach_ok = false;
  if (is_peer_video_media_source(source)) {
    const std::string upstream_peer_id = extract_peer_id_from_media_source(source);
    if (upstream_peer_id.empty()) {
      attach_error = "relay-source-invalid";
    } else if (upstream_peer_id == peer->peer_id) {
      attach_error = "relay-source-self-reference";
    } else if (PeerState* upstream_peer = find_peer(runtime_state, upstream_peer_id)) {
      const RelayVideoBindingContext relay_context{upstream_peer_id, *upstream_peer};
      attach_ok = attach_relay_video_media_binding(relay_context, *peer, source, &attach_error);
    } else {
      attach_error = "relay-upstream-peer-not-found";
    }
  } else {
    const ObsIngestSessionSnapshot obs_ingest =
      make_obs_ingest_session_snapshot(obs_ingest_session_snapshot(runtime_state));
    const HostVideoBindingContext binding_context{
      host_session_snapshot(runtime_state),
      ffmpeg_probe_result(runtime_state),
      audio_session_snapshot(runtime_state),
      obs_ingest
    };
    attach_ok = attach_host_video_media_binding(binding_context, *peer, &attach_error);
  }
  if (!attach_ok) {
    peer->media_binding.attached = false;
    peer->media_binding.active = false;
    peer->media_binding.reason = "peer-media-attach-failed";
    peer->media_binding.last_error = attach_error;
    return {false, {}, "MEDIA_SOURCE_ATTACH_FAILED", attach_error};
  }

  const bool attachment_requires_negotiation =
    !was_attached ||
    previous_source != peer->media_binding.source ||
    previous_codec != peer->media_binding.codec ||
    previous_width != peer->media_binding.width ||
    previous_height != peer->media_binding.height ||
    previous_frame_rate != peer->media_binding.frame_rate ||
    previous_bitrate_kbps != peer->media_binding.bitrate_kbps ||
    had_video_track_configured != peer->transport.video_track_configured ||
    had_audio_track_configured != peer->transport.audio_track_configured;

  if (peer->transport_session &&
      (peer->initiator || is_peer_video_media_source(source)) &&
      attachment_requires_negotiation) {
    std::string negotiate_error;
    if (!ensure_peer_transport_local_description(peer->transport_session, &negotiate_error)) {
      peer->transport = get_peer_transport_snapshot(peer->transport_session);
      peer->transport.last_error = negotiate_error;
      peer->transport.reason = "peer-local-description-failed";
      peer->media_binding.reason = "peer-local-description-failed";
      peer->media_binding.last_error = negotiate_error;
      return {false, {}, "MEDIA_SOURCE_ATTACH_FAILED", negotiate_error};
    }
  }

  refresh_all_peer_transport_runtime(runtime_state);
  emit_event("peer-state", build_peer_state_json(*peer, "media-source-attached"));
  emit_peer_media_source_breadcrumb(std::string("attachPeerMediaSource:before-result peer=") + peer_id);
  return {true, build_peer_result_json(*peer), {}, {}};
}

PeerMediaBindingCommandResult detach_peer_media_source_command(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  PeerState* peer = find_peer(runtime_state, peer_id);
  if (!peer) {
    return {false, {}, "PEER_NOT_FOUND", "Peer has not been created"};
  }

  std::string detach_error;
  if (!detach_peer_media_binding(*peer, &detach_error)) {
    peer->media_binding.reason = "peer-media-detach-failed";
    peer->media_binding.last_error = detach_error;
    return {false, {}, "MEDIA_SOURCE_DETACH_FAILED", detach_error};
  }

  if (peer->initiator && peer->transport_session) {
    std::string negotiate_error;
    if (!ensure_peer_transport_local_description(peer->transport_session, &negotiate_error)) {
      peer->transport = get_peer_transport_snapshot(peer->transport_session);
      peer->transport.last_error = negotiate_error;
      peer->transport.reason = "peer-local-description-failed";
      peer->media_binding.reason = "peer-local-description-failed";
      peer->media_binding.last_error = negotiate_error;
    }
  }

  refresh_all_peer_transport_runtime(runtime_state);
  emit_event("peer-state", build_peer_state_json(*peer, "media-source-detached"));
  return {true, build_peer_result_json(*peer), {}, {}};
}

}  // namespace vds::media_agent
