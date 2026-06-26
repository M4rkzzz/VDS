#include "peer_relay_source_binding.h"

#include "audio_transport_config.h"
#include "peer_session_state.h"
#include "peer_transport.h"
#include "relay_hub.h"
#include "string_utils.h"
#include "video_access_unit.h"

namespace {

using vds::media_agent::normalize_video_codec;
using vds::media_agent::to_lower_copy;

}  // namespace

bool attach_relay_video_media_binding(
  const RelayVideoBindingContext& context,
  PeerState& peer,
  const std::string& source,
  std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  const std::string& upstream_peer_id = context.upstream_peer_id;
  const PeerState& upstream_peer = context.upstream_peer;

  const bool upstream_uses_encoded_data_channel =
    upstream_peer.transport.encoded_media_data_channel_requested ||
    upstream_peer.transport.encoded_media_data_channel_supported;
  const bool upstream_encoded_data_channel_ready =
    upstream_uses_encoded_data_channel &&
    (upstream_peer.transport.encoded_media_data_channel_ready ||
     upstream_peer.transport.encoded_media_data_channel_frames_received > 0 ||
     upstream_peer.transport.remote_video_frames_received > 0 ||
     upstream_peer.transport.decoded_frames_rendered > 0);
  if (!upstream_peer.transport_session ||
      (!upstream_peer.transport.video_receiver_configured && !upstream_encoded_data_channel_ready)) {
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
  video_config.codec = normalize_video_codec(upstream_video_codec);
  video_config.mid = "video";
  video_config.stream_id = "vds-relay-stream";
  video_config.track_id = peer.peer_id + "-video";
  video_config.bitrate_kbps =
    upstream_peer.media_binding.bitrate_kbps > 0 ? upstream_peer.media_binding.bitrate_kbps : 10000;
  const int video_width = upstream_peer.media_binding.width > 0 ? upstream_peer.media_binding.width : 1920;
  const int video_height = upstream_peer.media_binding.height > 0 ? upstream_peer.media_binding.height : 1080;
  const int video_frame_rate = upstream_peer.media_binding.frame_rate > 0 ? upstream_peer.media_binding.frame_rate : 60;

  const std::string upstream_audio_codec = to_lower_copy(upstream_peer.transport.audio_codec);
  const bool audio_enabled =
    (upstream_peer.transport.audio_receiver_configured || upstream_encoded_data_channel_ready) &&
    (upstream_audio_codec == "opus" || upstream_audio_codec == "pcmu" || upstream_audio_codec == "aac");

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  const bool use_encoded_data_channel =
    peer.transport.encoded_media_data_channel_requested ||
    peer.transport.encoded_media_data_channel_supported;
  if (use_encoded_data_channel) {
    relay_hub().unregister_subscriber(peer.peer_id);
    relay_hub().register_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = true;
    peer.media_binding.active = peer.transport.encoded_media_data_channel_open;
    peer.media_binding.width = video_width;
    peer.media_binding.height = video_height;
    peer.media_binding.frame_rate = video_frame_rate;
    peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
    peer.media_binding.kind = "video";
    peer.media_binding.source = source;
    peer.media_binding.codec = video_config.codec;
    peer.media_binding.video_encoder_backend = "relay-copy";
    peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
      ? "relay-datachannel-media-attached"
      : "relay-datachannel-waiting-for-ready";
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
    peer.media_binding.source == source &&
    peer.media_binding.codec == video_config.codec &&
    peer.media_binding.width == video_width &&
    peer.media_binding.height == video_height &&
    peer.media_binding.frame_rate == video_frame_rate &&
    peer.media_binding.bitrate_kbps == video_config.bitrate_kbps &&
    peer.transport.audio_track_configured == audio_enabled;

  if (already_attached) {
    relay_hub().register_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = "relay-copy";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "relay-media-attached"
      : "relay-video-sender-waiting-for-video-track-open";
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
    audio_config.codec = upstream_audio_codec;
    audio_config.mid = "audio";
    audio_config.stream_id = "vds-relay-stream";
    audio_config.track_id = peer.peer_id + "-audio";
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

  relay_hub().unregister_subscriber(peer.peer_id);
  relay_hub().register_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = video_width;
  peer.media_binding.height = video_height;
  peer.media_binding.frame_rate = video_frame_rate;
  peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = source;
  peer.media_binding.codec = video_config.codec;
  peer.media_binding.video_encoder_backend = "relay-copy";
  peer.media_binding.reason = "relay-media-attached";
  peer.media_binding.last_error.clear();
  peer.media_binding.frames_sent = 0;
  return true;
}
