#include "peer_host_source_binding.h"

#include <algorithm>

#include "agent_diagnostics.h"
#include "audio_session_state.h"
#include "audio_transport_config.h"
#include "host_audio_dispatch_session.h"
#include "host_capture_plan.h"
#include "host_session_state.h"
#include "obs_ingest_constants.h"
#include "obs_ingest_session.h"
#include "peer_transport.h"
#include "peer_session_state.h"
#include "peer_video_sender.h"
#include "relay_hub.h"
#include "string_utils.h"
#include "video_access_unit.h"

namespace {

using vds::media_agent::normalize_video_codec;
using vds::media_agent::to_lower_copy;

bool is_obs_ingest_backend_state(const HostSessionState& session) {
  return to_lower_copy(session.backend) == "obs-ingest";
}

void emit_peer_host_source_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

bool attach_obs_ingest_media_binding(
  const HostSessionState& host_session,
  const ObsIngestSessionSnapshot& obs_ingest,
  PeerState& peer,
  std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!host_session.running || !obs_ingest.prepared) {
    if (error) {
      *error = "obs-ingest-session-not-prepared";
    }
    return false;
  }

  if (!obs_ingest.stream_running) {
    if (error) {
      *error = "obs-ingest-not-ready-for-video-binding";
    }
    return false;
  }

  const std::string video_codec = normalize_video_codec(
    obs_ingest.video_codec,
    normalize_video_codec(host_session.codec)
  );

  PeerVideoTrackConfig video_config;
  video_config.codec = video_codec;
  video_config.mid = "video";
  video_config.stream_id = "vds-host-stream";
  video_config.track_id = peer.peer_id + "-video";
  video_config.bitrate_kbps = host_session.bitrate_kbps > 0 ? host_session.bitrate_kbps : 10000;
  const std::string video_source = std::string("peer-video:") + kObsIngestVirtualUpstreamPeerId;
  const int video_width = obs_ingest.width > 0 ? obs_ingest.width : std::max(1, host_session.width);
  const int video_height = obs_ingest.height > 0 ? obs_ingest.height : std::max(1, host_session.height);
  const int video_frame_rate = obs_ingest.frame_rate > 0 ? obs_ingest.frame_rate : std::max(1, host_session.frame_rate);

  const std::string audio_codec = to_lower_copy(obs_ingest.audio_codec);
  const bool audio_enabled = audio_codec == "aac";
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;

  if (use_encoded_data_channel) {
    relay_hub().unregister_subscriber(peer.peer_id);
    relay_hub().register_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = true;
    peer.media_binding.active = peer.transport.encoded_media_data_channel_open;
    peer.media_binding.width = video_width;
    peer.media_binding.height = video_height;
    peer.media_binding.frame_rate = video_frame_rate;
    peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
    peer.media_binding.kind = "video";
    peer.media_binding.source = video_source;
    peer.media_binding.codec = video_config.codec;
    peer.media_binding.video_encoder_backend = "obs-ingest-relay";
    peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
      ? "obs-ingest-datachannel-media-attached"
      : "obs-ingest-datachannel-waiting-for-ready";
    peer.media_binding.last_error.clear();
    peer.media_binding.frames_sent = 0;
    if (error) {
      error->clear();
    }
    return true;
  }

  const bool already_attached =
    peer.media_binding.attached &&
    peer.transport.video_track_configured &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == video_source &&
    peer.media_binding.codec == video_config.codec &&
    peer.media_binding.width == video_width &&
    peer.media_binding.height == video_height &&
    peer.media_binding.frame_rate == video_frame_rate &&
    peer.media_binding.bitrate_kbps == video_config.bitrate_kbps &&
    peer.transport.audio_track_configured == audio_enabled;

  if (already_attached) {
    relay_hub().register_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = "obs-ingest-relay";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "obs-ingest-media-attached"
      : "obs-ingest-waiting-for-video-track-open";
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
    audio_config.codec = "aac";
    audio_config.mid = "audio";
    audio_config.stream_id = "vds-host-stream";
    audio_config.track_id = peer.peer_id + "-audio";
    audio_config.sample_rate = obs_ingest.audio_sample_rate > 0 ? obs_ingest.audio_sample_rate : static_cast<int>(kTransportAudioSampleRate);
    audio_config.payload_type = 97;
    audio_config.bitrate_kbps = static_cast<int>(kTransportAudioBitrateKbps);
    if (!configure_peer_transport_audio_sender(peer.transport_session, audio_config, error)) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
      return false;
    }
  } else {
    clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  }

  relay_hub().unregister_subscriber(peer.peer_id);
  relay_hub().register_subscriber(kObsIngestVirtualUpstreamPeerId, peer.peer_id, peer.transport_session, audio_enabled);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = video_width;
  peer.media_binding.height = video_height;
  peer.media_binding.frame_rate = video_frame_rate;
  peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = video_source;
  peer.media_binding.codec = video_config.codec;
  peer.media_binding.video_encoder_backend = "obs-ingest-relay";
  peer.media_binding.reason = "obs-ingest-media-attached";
  peer.media_binding.last_error.clear();
  peer.media_binding.frames_sent = 0;
  if (error) {
    error->clear();
  }
  return true;
}

bool attach_native_host_video_media_binding(
  const HostSessionState& host_session,
  const FfmpegProbeResult& ffmpeg,
  const AudioSessionState& audio_session,
  PeerState& peer,
  std::string* error,
  bool force_restart) {
  const HostCapturePlan& capture_plan = host_session.capture_plan;
  if (!host_session.running || !capture_plan.ready) {
    if (error) {
      *error = "host-session-not-ready-for-video-binding";
    }
    return false;
  }

  PeerVideoTrackConfig config;
  config.codec = normalize_video_codec(host_session.codec);
  config.mid = "video";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-video";
  const std::string video_source = capture_plan.capture_backend == "wgc"
    ? "host-session-video"
    : (host_session.capture_artifact.ready ? "host-capture-artifact" : "host-capture-plan");
  config.bitrate_kbps = host_session.bitrate_kbps;
  const int video_width = host_session.width;
  const int video_height = host_session.height;
  const int video_frame_rate = host_session.frame_rate;

  const bool config_matches_current =
    peer.media_binding.attached &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == video_source &&
    peer.media_binding.codec == config.codec &&
    peer.media_binding.width == video_width &&
    peer.media_binding.height == video_height &&
    peer.media_binding.frame_rate == video_frame_rate &&
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
    peer.media_binding.active = use_encoded_data_channel
      ? peer.transport.encoded_media_data_channel_open
      : peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = host_session.pipeline.video_encoder_backend;
    peer.media_binding.reason = use_encoded_data_channel
      ? (peer.transport.encoded_media_data_channel_ready
          ? "peer-datachannel-media-attached"
          : "peer-datachannel-waiting-for-ready")
      : (peer.transport.video_track_open
          ? "peer-media-attached"
          : "peer-video-sender-waiting-for-video-track-open");
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
    emit_peer_host_source_breadcrumb(std::string("attachHostVideoMediaBinding:after-configure-transport peer=") + peer.peer_id);
  } else {
    emit_peer_host_source_breadcrumb(std::string("attachHostVideoMediaBinding:restarting-sender-only peer=") + peer.peer_id);
  }

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.active = use_encoded_data_channel
    ? peer.transport.encoded_media_data_channel_open
    : peer.transport.video_track_open;
  peer.media_binding.width = video_width;
  peer.media_binding.height = video_height;
  peer.media_binding.frame_rate = video_frame_rate;
  peer.media_binding.bitrate_kbps = config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = video_source;
  peer.media_binding.codec = config.codec;
  peer.media_binding.video_encoder_backend = host_session.pipeline.video_encoder_backend;
  peer.media_binding.reason = use_encoded_data_channel
    ? "peer-datachannel-media-configured"
    : "peer-media-configured";
  peer.media_binding.last_error.clear();

  if (!start_peer_video_sender(ffmpeg, host_session.pipeline, capture_plan, peer, &attach_error)) {
    peer.media_binding.reason = "peer-video-sender-start-failed";
    peer.media_binding.last_error = attach_error;
    if (!use_encoded_data_channel) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
    }
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = false;
    peer.media_binding.active = false;
    if (error) {
      *error = attach_error;
    }
    return false;
  }
  emit_peer_host_source_breadcrumb(std::string("attachHostVideoMediaBinding:after-start-sender peer=") + peer.peer_id);

  if ((!force_restart || !peer.transport.audio_track_configured) &&
      audio_session_capture_ready(audio_session)) {
    configure_host_audio_sender(audio_session, peer, nullptr);
  }

  peer.media_binding.reason = use_encoded_data_channel
    ? (peer.transport.encoded_media_data_channel_ready
        ? "peer-datachannel-media-attached"
        : "peer-datachannel-waiting-for-ready")
    : "peer-media-attached";
  emit_peer_host_source_breadcrumb(std::string("attachHostVideoMediaBinding:done peer=") + peer.peer_id);
  return true;
}

}  // namespace

bool attach_host_video_media_binding(
  const HostVideoBindingContext& context,
  PeerState& peer,
  std::string* error,
  bool force_restart) {
  const HostSessionState& host_session = context.host_session;
  emit_peer_host_source_breadcrumb(
    std::string("attachHostVideoMediaBinding:start peer=") + peer.peer_id +
    " codec=" + normalize_video_codec(host_session.codec) +
    " forceRestart=" + (force_restart ? "true" : "false") +
    " sessionRunning=" + (host_session.running ? "true" : "false"));
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (is_obs_ingest_backend_state(host_session)) {
    return attach_obs_ingest_media_binding(host_session, context.obs_ingest, peer, error);
  }

  return attach_native_host_video_media_binding(
    host_session,
    context.ffmpeg,
    context.audio_session,
    peer,
    error,
    force_restart);
}

bool configure_host_audio_sender(const AudioSessionState& audio_session, PeerState& peer, std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!audio_session_capture_ready(audio_session)) {
    if (error) {
      *error = "audio-session-not-ready";
    }
    return false;
  }

  PeerAudioTrackConfig config;
  config.codec = "opus";
  config.mid = "audio";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-audio";
  config.payload_type = 111;
  config.bitrate_kbps = kTransportAudioBitrateKbps;

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;
  if (use_encoded_data_channel) {
    HostAudioDispatchSession host_audio_dispatch;
    host_audio_dispatch.register_transport_session(peer.transport_session);
    return true;
  }

  if (!configure_peer_transport_audio_sender(peer.transport_session, config, error)) {
    return false;
  }

  HostAudioDispatchSession host_audio_dispatch;
  host_audio_dispatch.register_transport_session(peer.transport_session);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  return true;
}

void clear_host_audio_sender(PeerState& peer) {
  if (!peer.transport_session) {
    return;
  }

  HostAudioDispatchSession host_audio_dispatch;
  host_audio_dispatch.unregister_transport_session(peer.transport_session);
  clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
}
