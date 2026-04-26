#include "peer_media_binding_runtime.h"

#include <algorithm>
#include <mutex>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "agent_status_json.h"
#include "host_capture_plan.h"
#include "json_protocol.h"
#include "media_audio.h"
#include "obs_ingest_runtime.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "peer_video_sender.h"
#include "relay_dispatch.h"
#include "string_utils.h"
#include "surface_target.h"
#include "time_utils.h"
#include "video_access_unit.h"

namespace {

using vds::media_agent::extract_string_value;
using vds::media_agent::current_time_millis;
using vds::media_agent::normalize_video_codec;
using vds::media_agent::to_lower_copy;

void emit_peer_media_binding_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

}  // namespace

bool attach_host_video_media_binding(AgentRuntimeState& state, PeerState& peer, std::string* error, bool force_restart);
bool configure_host_audio_sender(AgentRuntimeState& state, PeerState& peer, std::string* error);

void perform_host_video_sender_soft_refresh(AgentRuntimeState& state) {
  if (!state.host_session_running) {
    return;
  }

  bool attempted = false;
  bool all_succeeded = true;
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream" || !peer.transport_session) {
      continue;
    }
    if (!peer.media_binding.runtime || !peer.media_binding.runtime->soft_refresh_requested.load()) {
      continue;
    }

    attempted = true;
    state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
    if (!state.host_capture_plan.ready || !state.host_capture_plan.validated) {
      all_succeeded = false;
      peer.media_binding.reason = "peer-media-soft-refresh-waiting-for-valid-plan";
      peer.media_binding.last_error = state.host_capture_plan.last_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
      continue;
    }
    std::string refresh_error;
    if (!attach_host_video_media_binding(state, peer, &refresh_error, true)) {
      peer.media_binding.attached = false;
      peer.media_binding.sender_configured = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-soft-refresh-failed";
      peer.media_binding.last_error = refresh_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
      all_succeeded = false;
      emit_peer_media_binding_breadcrumb(
        std::string("hostVideoSenderRefresh:failed peer=") + peer.peer_id +
        " error=" + refresh_error);
    } else {
      emit_peer_media_binding_breadcrumb(std::string("hostVideoSenderRefresh:done peer=") + peer.peer_id);
    }
  }

  if (!attempted || all_succeeded) {
    state.host_video_sender_refresh_requested = false;
    state.host_video_sender_refresh_reason.clear();
  }
}

void refresh_peer_transport_runtime(AgentRuntimeState& state) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.receiver_runtime) {
      refresh_peer_video_receiver_runtime(*peer.receiver_runtime);
      {
        std::lock_guard<std::mutex> lock(peer.receiver_runtime->mutex);
        if (!peer.receiver_runtime->running) {
          peer.receiver_runtime->decoder_ready = false;
        }
      }
      update_peer_decoder_state_from_runtime(peer.receiver_runtime, peer.transport_session);
    }
    if (peer.transport_session) {
      peer.transport = get_peer_transport_snapshot(peer.transport_session);
      peer.has_remote_description = peer.transport.remote_description_set;
      peer.remote_candidate_count = peer.transport.remote_candidate_count;
    } else {
      peer.transport.available = state.peer_transport_backend.available;
      peer.transport.transport_ready = state.peer_transport_backend.transport_ready;
      peer.transport.media_plane_ready = state.peer_transport_backend.media_plane_ready;
      if (peer.transport.reason.empty()) {
        peer.transport.reason = state.peer_transport_backend.reason;
      }
    }
    const bool use_encoded_data_channel =
      peer.transport.encoded_media_data_channel_requested ||
      peer.transport.encoded_media_data_channel_supported;
    peer.media_binding.sender_configured = use_encoded_data_channel
      ? true
      : peer.transport.video_track_configured;
    peer.media_binding.active = use_encoded_data_channel
      ? peer.transport.encoded_media_data_channel_open
      : peer.transport.video_track_open;
    if (peer.media_binding.reason == "peer-media-not-attached") {
      if (use_encoded_data_channel) {
        peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
          ? "peer-datachannel-media-attached"
          : "peer-datachannel-media-configured";
      } else if (peer.transport.video_track_configured) {
        peer.media_binding.reason = "peer-media-configured";
      }
    }
    refresh_peer_media_binding(peer);
    peer.media_binding.updated_at_unix_ms = current_time_millis();
  }
}

PeerMediaBindingCommandResult attach_peer_media_source_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  const std::string source = extract_string_value(request_json, "source");
  emit_peer_media_binding_breadcrumb(
    std::string("attachPeerMediaSource:begin peer=") + peer_id +
    " source=" + source);

  auto it = state.peers.find(peer_id);
  if (it == state.peers.end()) {
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

  const bool was_attached = it->second.media_binding.attached;
  const bool had_video_track_configured = it->second.transport.video_track_configured;
  const bool had_audio_track_configured = it->second.transport.audio_track_configured;
  const std::string previous_source = it->second.media_binding.source;
  const std::string previous_codec = it->second.media_binding.codec;
  const int previous_width = it->second.media_binding.width;
  const int previous_height = it->second.media_binding.height;
  const int previous_frame_rate = it->second.media_binding.frame_rate;
  const int previous_bitrate_kbps = it->second.media_binding.bitrate_kbps;

  std::string attach_error;
  const bool attach_ok = is_peer_video_media_source(source)
    ? attach_relay_video_media_binding(state, it->second, source, &attach_error)
    : attach_host_video_media_binding(state, it->second, &attach_error);
  if (!attach_ok) {
    it->second.media_binding.attached = false;
    it->second.media_binding.sender_configured = false;
    it->second.media_binding.active = false;
    it->second.media_binding.reason = "peer-media-attach-failed";
    it->second.media_binding.last_error = attach_error;
    it->second.media_binding.updated_at_unix_ms = current_time_millis();
    return {false, {}, "MEDIA_SOURCE_ATTACH_FAILED", attach_error};
  }

  const bool attachment_requires_negotiation =
    !was_attached ||
    previous_source != it->second.media_binding.source ||
    previous_codec != it->second.media_binding.codec ||
    previous_width != it->second.media_binding.width ||
    previous_height != it->second.media_binding.height ||
    previous_frame_rate != it->second.media_binding.frame_rate ||
    previous_bitrate_kbps != it->second.media_binding.bitrate_kbps ||
    had_video_track_configured != it->second.transport.video_track_configured ||
    had_audio_track_configured != it->second.transport.audio_track_configured;

  if (it->second.transport_session &&
      (it->second.initiator || is_peer_video_media_source(source)) &&
      attachment_requires_negotiation) {
    std::string negotiate_error;
    if (!ensure_peer_transport_local_description(it->second.transport_session, &negotiate_error)) {
      it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
      it->second.transport.last_error = negotiate_error;
      it->second.transport.reason = "peer-local-description-failed";
      it->second.media_binding.reason = "peer-local-description-failed";
      it->second.media_binding.last_error = negotiate_error;
      it->second.media_binding.updated_at_unix_ms = current_time_millis();
      return {false, {}, "MEDIA_SOURCE_ATTACH_FAILED", negotiate_error};
    }
  }

  refresh_peer_transport_runtime(state);
  emit_event("peer-state", build_peer_state_json(it->second, "media-source-attached"));
  emit_peer_media_binding_breadcrumb(std::string("attachPeerMediaSource:before-result peer=") + peer_id);
  return {true, build_peer_result_json(it->second), {}, {}};
}

bool attach_obs_ingest_media_binding(AgentRuntimeState& state, PeerState& peer, std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!state.host_session_running || !state.obs_ingest.prepared) {
    if (error) {
      *error = "obs-ingest-session-not-prepared";
    }
    return false;
  }

  if (!state.obs_ingest.stream_running || !state.obs_ingest.video_ready) {
    if (error) {
      *error = "obs-ingest-not-ready-for-video-binding";
    }
    return false;
  }

  const std::string video_codec = normalize_video_codec(
    state.obs_ingest.video_codec,
    normalize_video_codec(state.host_codec)
  );

  PeerVideoTrackConfig video_config;
  video_config.enabled = true;
  video_config.codec = video_codec;
  video_config.mid = "video";
  video_config.stream_id = "vds-host-stream";
  video_config.track_id = peer.peer_id + "-video";
  video_config.source = std::string("peer-video:") + kObsIngestVirtualUpstreamPeerId;
  video_config.width = state.obs_ingest.width > 0 ? state.obs_ingest.width : std::max(1, state.host_width);
  video_config.height = state.obs_ingest.height > 0 ? state.obs_ingest.height : std::max(1, state.host_height);
  video_config.frame_rate = state.obs_ingest.frame_rate > 0 ? state.obs_ingest.frame_rate : std::max(1, state.host_frame_rate);
  video_config.bitrate_kbps = state.host_bitrate_kbps > 0 ? state.host_bitrate_kbps : 10000;

  const std::string audio_codec = to_lower_copy(state.obs_ingest.audio_codec);
  const bool audio_enabled = state.obs_ingest.audio_ready && audio_codec == "aac";
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;

  if (use_encoded_data_channel) {
    unregister_relay_subscriber(peer.peer_id);
    register_relay_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = true;
    peer.media_binding.sender_configured = true;
    peer.media_binding.active = peer.transport.encoded_media_data_channel_open;
    peer.media_binding.width = video_config.width;
    peer.media_binding.height = video_config.height;
    peer.media_binding.frame_rate = video_config.frame_rate;
    peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
    peer.media_binding.kind = "video";
    peer.media_binding.source = video_config.source;
    peer.media_binding.codec = video_config.codec;
    peer.media_binding.video_encoder_backend = "obs-ingest-relay";
    peer.media_binding.implementation = "obs-ingest-relay-datachannel";
    peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
      ? "obs-ingest-datachannel-media-attached"
      : "obs-ingest-datachannel-waiting-for-ready";
    peer.media_binding.last_error.clear();
    peer.media_binding.command_line.clear();
    peer.media_binding.process_id = 0;
    peer.media_binding.frames_sent = 0;
    peer.media_binding.bytes_sent = 0;
    peer.media_binding.attached_at_unix_ms = current_time_millis();
    peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
    peer.media_binding.detached_at_unix_ms = 0;
    if (error) {
      error->clear();
    }
    return true;
  }

  const bool already_attached =
    peer.media_binding.attached &&
    peer.transport.video_track_configured &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == video_config.source &&
    peer.media_binding.codec == video_config.codec &&
    peer.media_binding.width == video_config.width &&
    peer.media_binding.height == video_config.height &&
    peer.media_binding.frame_rate == video_config.frame_rate &&
    peer.media_binding.bitrate_kbps == video_config.bitrate_kbps &&
    peer.transport.audio_track_configured == audio_enabled;

  if (already_attached) {
    register_relay_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.sender_configured = peer.transport.video_track_configured;
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = "obs-ingest-relay";
    peer.media_binding.implementation = "obs-ingest-relay-track";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "obs-ingest-media-attached"
      : "obs-ingest-waiting-for-video-track-open";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    if (error) {
      error->clear();
    }
    return true;
  }

  if (!configure_peer_transport_video_sender(peer.transport_session, video_config, error)) {
    return false;
  }

  if (audio_enabled) {
    PeerAudioTrackConfig audio_config;
    audio_config.enabled = true;
    audio_config.codec = "aac";
    audio_config.mid = "audio";
    audio_config.stream_id = "vds-host-stream";
    audio_config.track_id = peer.peer_id + "-audio";
    audio_config.source = video_config.source;
    audio_config.sample_rate = state.obs_ingest.audio_sample_rate > 0 ? state.obs_ingest.audio_sample_rate : static_cast<int>(kTransportAudioSampleRate);
    audio_config.channel_count = state.obs_ingest.audio_channel_count > 0 ? state.obs_ingest.audio_channel_count : static_cast<int>(kTransportAudioChannelCount);
    audio_config.payload_type = 97;
    audio_config.bitrate_kbps = static_cast<int>(kTransportAudioBitrateKbps);
    if (!configure_peer_transport_audio_sender(peer.transport_session, audio_config, error)) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
      return false;
    }
  } else {
    clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  }

  unregister_relay_subscriber(peer.peer_id);
  register_relay_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.sender_configured = peer.transport.video_track_configured;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = video_config.width;
  peer.media_binding.height = video_config.height;
  peer.media_binding.frame_rate = video_config.frame_rate;
  peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = video_config.source;
  peer.media_binding.codec = video_config.codec;
  peer.media_binding.video_encoder_backend = "obs-ingest-relay";
  peer.media_binding.implementation = "obs-ingest-relay-track";
  peer.media_binding.reason = "obs-ingest-media-attached";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.frames_sent = 0;
  peer.media_binding.bytes_sent = 0;
  peer.media_binding.attached_at_unix_ms = current_time_millis();
  peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
  peer.media_binding.detached_at_unix_ms = 0;
  if (error) {
    error->clear();
  }
  return true;
}

bool attach_host_video_media_binding(AgentRuntimeState& state, PeerState& peer, std::string* error, bool force_restart) {
  emit_peer_media_binding_breadcrumb(
    std::string("attachHostVideoMediaBinding:start peer=") + peer.peer_id +
    " codec=" + normalize_video_codec(state.host_codec) +
    " forceRestart=" + (force_restart ? "true" : "false") +
    " sessionRunning=" + (state.host_session_running ? "true" : "false"));
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (is_obs_ingest_backend(state)) {
    return attach_obs_ingest_media_binding(state, peer, error);
  }

  if (!state.host_session_running || !state.host_capture_plan.ready) {
    if (error) {
      *error = "host-session-not-ready-for-video-binding";
    }
    return false;
  }

  PeerVideoTrackConfig config;
  config.enabled = true;
  config.codec = normalize_video_codec(state.host_codec);
  config.mid = "video";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-video";
  config.source = state.host_capture_plan.capture_backend == "wgc"
    ? "host-session-video"
    : (state.host_capture_artifact.ready ? "host-capture-artifact" : "host-capture-plan");
  config.width = state.host_width;
  config.height = state.host_height;
  config.frame_rate = state.host_frame_rate;
  config.bitrate_kbps = state.host_bitrate_kbps;

  const bool config_matches_current =
    peer.media_binding.attached &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == config.source &&
    peer.media_binding.codec == config.codec &&
    peer.media_binding.width == config.width &&
    peer.media_binding.height == config.height &&
    peer.media_binding.frame_rate == config.frame_rate &&
    peer.media_binding.bitrate_kbps == config.bitrate_kbps;

  const bool already_attached =
    !force_restart &&
    peer.media_binding.attached &&
    peer.media_binding.runtime &&
    config_matches_current;

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;

  if (already_attached) {
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.sender_configured = use_encoded_data_channel ? true : peer.transport.video_track_configured;
    peer.media_binding.active = use_encoded_data_channel
      ? peer.transport.encoded_media_data_channel_open
      : peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = state.host_pipeline.video_encoder_backend;
    peer.media_binding.implementation = use_encoded_data_channel
      ? "wgc-ffmpeg-libdatachannel-datachannel"
      : "wgc-ffmpeg-libdatachannel-video-track";
    peer.media_binding.reason = use_encoded_data_channel
      ? (peer.transport.encoded_media_data_channel_ready
          ? "peer-datachannel-media-attached"
          : "peer-datachannel-waiting-for-ready")
      : (peer.transport.video_track_open
          ? "peer-media-attached"
          : "peer-video-sender-waiting-for-video-track-open");
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    if (error) {
      error->clear();
    }
    return true;
  }

  const bool restart_sender_only =
    force_restart &&
    config_matches_current &&
    (use_encoded_data_channel || peer.transport.video_track_configured);

  if (peer.media_binding.runtime) {
    std::string stop_error;
    if (!stop_peer_video_sender(peer, "peer-media-reconfigure", &stop_error)) {
      if (error) {
        *error = stop_error;
      }
      return false;
    }
  }

  std::string attach_error;
  if (!restart_sender_only && !use_encoded_data_channel) {
    if (!configure_peer_transport_video_sender(peer.transport_session, config, &attach_error)) {
      if (error) {
        *error = attach_error;
      }
      return false;
    }
    emit_peer_media_binding_breadcrumb(std::string("attachHostVideoMediaBinding:after-configure-transport peer=") + peer.peer_id);
  } else {
    emit_peer_media_binding_breadcrumb(std::string("attachHostVideoMediaBinding:restarting-sender-only peer=") + peer.peer_id);
  }

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.sender_configured = use_encoded_data_channel ? true : peer.transport.video_track_configured;
  peer.media_binding.active = use_encoded_data_channel
    ? peer.transport.encoded_media_data_channel_open
    : peer.transport.video_track_open;
  peer.media_binding.width = config.width;
  peer.media_binding.height = config.height;
  peer.media_binding.frame_rate = config.frame_rate;
  peer.media_binding.bitrate_kbps = config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = config.source;
  peer.media_binding.codec = config.codec;
  peer.media_binding.video_encoder_backend = state.host_pipeline.video_encoder_backend;
  peer.media_binding.implementation = use_encoded_data_channel
    ? "wgc-ffmpeg-libdatachannel-datachannel"
    : "wgc-ffmpeg-libdatachannel-video-track";
  peer.media_binding.reason = use_encoded_data_channel
    ? "peer-datachannel-media-configured"
    : "peer-media-configured";
  peer.media_binding.last_error.clear();
  peer.media_binding.attached_at_unix_ms = current_time_millis();
  peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
  peer.media_binding.detached_at_unix_ms = 0;

  if (!start_peer_video_sender(state.ffmpeg, state.host_pipeline, state.host_capture_plan, peer, &attach_error)) {
    peer.media_binding.reason = "peer-video-sender-start-failed";
    peer.media_binding.last_error = attach_error;
    if (!use_encoded_data_channel) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
    }
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = false;
    peer.media_binding.sender_configured = false;
    peer.media_binding.active = false;
    if (error) {
      *error = attach_error;
    }
    return false;
  }
  emit_peer_media_binding_breadcrumb(std::string("attachHostVideoMediaBinding:after-start-sender peer=") + peer.peer_id);

  if ((!force_restart || !peer.transport.audio_track_configured) &&
      state.audio_session.capture_active &&
      state.audio_session.ready) {
    configure_host_audio_sender(state, peer, nullptr);
  }

  peer.media_binding.reason = use_encoded_data_channel
    ? (peer.transport.encoded_media_data_channel_ready
        ? "peer-datachannel-media-attached"
        : "peer-datachannel-waiting-for-ready")
    : "peer-media-attached";
  emit_peer_media_binding_breadcrumb(std::string("attachHostVideoMediaBinding:done peer=") + peer.peer_id);
  return true;
}

bool configure_host_audio_sender(AgentRuntimeState& state, PeerState& peer, std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!state.audio_session.capture_active || !state.audio_session.ready) {
    if (error) {
      *error = "audio-session-not-ready";
    }
    return false;
  }

  PeerAudioTrackConfig config;
  config.enabled = true;
  config.codec = "opus";
  config.mid = "audio";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-audio";
  config.source = "host-process-loopback";
  config.sample_rate = kTransportAudioSampleRate;
  config.channel_count = kTransportAudioChannelCount;
  config.payload_type = 111;
  config.bitrate_kbps = kTransportAudioBitrateKbps;

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;
  if (use_encoded_data_channel) {
    register_host_audio_transport_session(peer.transport_session);
    return true;
  }

  if (!configure_peer_transport_audio_sender(peer.transport_session, config, error)) {
    return false;
  }

  register_host_audio_transport_session(peer.transport_session);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  return true;
}

bool attach_relay_video_media_binding(
  AgentRuntimeState& state,
  PeerState& peer,
  const std::string& source,
  std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  const std::string upstream_peer_id = extract_peer_id_from_media_source(source);
  if (upstream_peer_id.empty()) {
    if (error) {
      *error = "relay-source-invalid";
    }
    return false;
  }
  if (upstream_peer_id == peer.peer_id) {
    if (error) {
      *error = "relay-source-self-reference";
    }
    return false;
  }

  auto upstream_it = state.peers.find(upstream_peer_id);
  if (upstream_it == state.peers.end()) {
    if (error) {
      *error = "relay-upstream-peer-not-found";
    }
    return false;
  }

  PeerState& upstream_peer = upstream_it->second;
  if (!upstream_peer.transport_session || !upstream_peer.transport.video_receiver_configured) {
    if (error) {
      *error = "relay-upstream-not-ready";
    }
    return false;
  }

  const std::string upstream_video_codec = to_lower_copy(
    upstream_peer.transport.codec_path.empty() ? upstream_peer.transport.video_codec : upstream_peer.transport.codec_path
  );
  if (upstream_video_codec != "h264" && upstream_video_codec != "h265" && upstream_video_codec != "hevc") {
    if (error) {
      *error = "relay-upstream-video-codec-unsupported";
    }
    return false;
  }

  PeerVideoTrackConfig video_config;
  video_config.enabled = true;
  video_config.codec = normalize_video_codec(upstream_video_codec);
  video_config.mid = "video";
  video_config.stream_id = "vds-relay-stream";
  video_config.track_id = peer.peer_id + "-video";
  video_config.source = source;
  video_config.width = upstream_peer.media_binding.width > 0 ? upstream_peer.media_binding.width : 1920;
  video_config.height = upstream_peer.media_binding.height > 0 ? upstream_peer.media_binding.height : 1080;
  video_config.frame_rate = upstream_peer.media_binding.frame_rate > 0 ? upstream_peer.media_binding.frame_rate : 60;
  video_config.bitrate_kbps =
    upstream_peer.media_binding.bitrate_kbps > 0 ? upstream_peer.media_binding.bitrate_kbps : 10000;

  const std::string upstream_audio_codec = to_lower_copy(upstream_peer.transport.audio_codec);
  const bool audio_enabled =
    upstream_peer.transport.audio_receiver_configured &&
    (upstream_audio_codec == "opus" || upstream_audio_codec == "pcmu" || upstream_audio_codec == "aac");

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;
  if (use_encoded_data_channel) {
    unregister_relay_subscriber(peer.peer_id);
    register_relay_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = true;
    peer.media_binding.sender_configured = true;
    peer.media_binding.active = peer.transport.encoded_media_data_channel_open;
    peer.media_binding.width = video_config.width;
    peer.media_binding.height = video_config.height;
    peer.media_binding.frame_rate = video_config.frame_rate;
    peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
    peer.media_binding.kind = "video";
    peer.media_binding.source = source;
    peer.media_binding.codec = video_config.codec;
    peer.media_binding.video_encoder_backend = "relay-copy";
    peer.media_binding.implementation = "peer-transport-relay-datachannel";
    peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
      ? "relay-datachannel-media-attached"
      : "relay-datachannel-waiting-for-ready";
    peer.media_binding.last_error.clear();
    peer.media_binding.command_line.clear();
    peer.media_binding.process_id = 0;
    peer.media_binding.frames_sent = 0;
    peer.media_binding.bytes_sent = 0;
    peer.media_binding.attached_at_unix_ms = current_time_millis();
    peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
    peer.media_binding.detached_at_unix_ms = 0;
    if (error) {
      error->clear();
    }
    return true;
  }

  const bool already_attached =
    peer.media_binding.attached &&
    peer.transport.video_track_configured &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == source &&
    peer.media_binding.codec == video_config.codec &&
    peer.media_binding.width == video_config.width &&
    peer.media_binding.height == video_config.height &&
    peer.media_binding.frame_rate == video_config.frame_rate &&
    peer.media_binding.bitrate_kbps == video_config.bitrate_kbps &&
    peer.transport.audio_track_configured == audio_enabled;

  if (already_attached) {
    register_relay_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.sender_configured = peer.transport.video_track_configured;
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = "relay-copy";
    peer.media_binding.implementation = "peer-transport-relay-track";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "relay-media-attached"
      : "relay-video-sender-waiting-for-video-track-open";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    if (error) {
      error->clear();
    }
    return true;
  }

  if (!configure_peer_transport_video_sender(peer.transport_session, video_config, error)) {
    return false;
  }

  if (audio_enabled) {
    PeerAudioTrackConfig audio_config;
    audio_config.enabled = true;
    audio_config.codec = upstream_audio_codec;
    audio_config.mid = "audio";
    audio_config.stream_id = "vds-relay-stream";
    audio_config.track_id = peer.peer_id + "-audio";
    audio_config.source = source;
    audio_config.sample_rate = upstream_audio_codec == "pcmu" ? 8000 : static_cast<int>(kTransportAudioSampleRate);
    audio_config.channel_count = upstream_audio_codec == "pcmu" ? 1 : static_cast<int>(kTransportAudioChannelCount);
    audio_config.payload_type =
      upstream_audio_codec == "opus" ? 111 :
      (upstream_audio_codec == "aac" ? 97 : 0);
    audio_config.bitrate_kbps =
      upstream_audio_codec == "pcmu" ? 64 : static_cast<int>(kTransportAudioBitrateKbps);
    if (!configure_peer_transport_audio_sender(peer.transport_session, audio_config, error)) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
      return false;
    }
  } else {
    clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  }

  unregister_relay_subscriber(peer.peer_id);
  register_relay_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.sender_configured = peer.transport.video_track_configured;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = video_config.width;
  peer.media_binding.height = video_config.height;
  peer.media_binding.frame_rate = video_config.frame_rate;
  peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = source;
  peer.media_binding.codec = video_config.codec;
  peer.media_binding.video_encoder_backend = "relay-copy";
  peer.media_binding.implementation = "peer-transport-relay-track";
  peer.media_binding.reason = "relay-media-attached";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.frames_sent = 0;
  peer.media_binding.bytes_sent = 0;
  peer.media_binding.attached_at_unix_ms = current_time_millis();
  peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
  peer.media_binding.detached_at_unix_ms = 0;
  return true;
}

void clear_host_audio_sender(PeerState& peer) {
  if (!peer.transport_session) {
    return;
  }

  unregister_host_audio_transport_session(peer.transport_session);
  clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
}

void refresh_host_audio_senders(AgentRuntimeState& state) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream" || !peer.transport_session) {
      continue;
    }

    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    const bool use_encoded_data_channel =
      peer.transport.encoded_media_data_channel_requested ||
      peer.transport.encoded_media_data_channel_supported;
    const bool had_audio_track = peer.transport.audio_track_configured;
    if (state.audio_session.capture_active && state.audio_session.ready) {
      configure_host_audio_sender(state, peer, nullptr);
    } else {
      clear_host_audio_sender(peer);
    }
    if (use_encoded_data_channel) {
      continue;
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
  }
}

bool detach_peer_media_binding(PeerState& peer, std::string* error) {
  unregister_relay_subscriber(peer.peer_id);
  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-media-detached", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  if (!peer.transport_session) {
    peer.media_binding.attached = false;
    peer.media_binding.sender_configured = false;
    peer.media_binding.active = false;
    peer.media_binding.reason = "peer-media-detached";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
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
  peer.media_binding.sender_configured = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-media-detached";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  return true;
}

PeerMediaBindingCommandResult detach_peer_media_source_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string peer_id = extract_string_value(request_json, "peerId");
  auto it = state.peers.find(peer_id);
  if (it == state.peers.end()) {
    return {false, {}, "PEER_NOT_FOUND", "Peer has not been created"};
  }

  std::string detach_error;
  if (!detach_peer_media_binding(it->second, &detach_error)) {
    it->second.media_binding.reason = "peer-media-detach-failed";
    it->second.media_binding.last_error = detach_error;
    it->second.media_binding.updated_at_unix_ms = current_time_millis();
    return {false, {}, "MEDIA_SOURCE_DETACH_FAILED", detach_error};
  }

  if (it->second.initiator && it->second.transport_session) {
    std::string negotiate_error;
    if (!ensure_peer_transport_local_description(it->second.transport_session, &negotiate_error)) {
      it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
      it->second.transport.last_error = negotiate_error;
      it->second.transport.reason = "peer-local-description-failed";
      it->second.media_binding.reason = "peer-local-description-failed";
      it->second.media_binding.last_error = negotiate_error;
      it->second.media_binding.updated_at_unix_ms = current_time_millis();
    }
  }

  refresh_peer_transport_runtime(state);
  emit_event("peer-state", build_peer_state_json(it->second, "media-source-detached"));
  return {true, build_peer_result_json(it->second), {}, {}};
}

bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error) {
  emit_peer_media_binding_breadcrumb(
    std::string("preparePeerMediaBinding:start peer=") +
    peer.peer_id +
    " role=" + peer.role +
    " attached=" + (peer.media_binding.attached ? "true" : "false")
  );
  unregister_relay_subscriber(peer.peer_id);
  unregister_host_audio_transport_session(peer.transport_session);

  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-closing", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  peer.media_binding.attached = false;
  peer.media_binding.sender_configured = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-closing";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  emit_peer_media_binding_breadcrumb(std::string("preparePeerMediaBinding:done peer=") + peer.peer_id);
  if (error) {
    error->clear();
  }
  return true;
}
