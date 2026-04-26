#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct PeerTransportBackendInfo {
  bool available = false;
  bool transport_ready = false;
  bool media_plane_ready = false;
  bool video_track_support = false;
  bool audio_track_support = false;
  std::string backend = "stub";
  std::string implementation = "stub";
  std::string mode = "disabled";
  std::string reason = "libdatachannel-not-compiled";
  std::string last_error;
  std::vector<std::string> ice_servers;
};

struct PeerTransportSnapshot {
  bool available = false;
  bool transport_ready = false;
  bool media_plane_ready = false;
  bool video_track_support = false;
  bool audio_track_support = false;
  bool video_track_configured = false;
  bool audio_track_configured = false;
  bool video_receiver_configured = false;
  bool audio_receiver_configured = false;
  bool video_track_open = false;
  bool audio_track_open = false;
  bool decoder_ready = false;
  bool remote_video_track_attached = false;
  bool remote_audio_track_attached = false;
  bool local_description_created = false;
  bool remote_description_set = false;
  bool data_channel_requested = false;
  bool data_channel_open = false;
  bool encoded_media_data_channel_requested = false;
  bool encoded_media_data_channel_supported = false;
  bool encoded_media_data_channel_open = false;
  bool encoded_media_data_channel_ready = false;
  bool closed = false;
  int local_candidate_count = 0;
  int remote_candidate_count = 0;
  int remote_track_count = 0;
  std::uint64_t bytes_sent = 0;
  std::uint64_t bytes_received = 0;
  std::uint64_t video_frames_sent = 0;
  std::uint64_t video_bytes_sent = 0;
  std::uint64_t audio_frames_sent = 0;
  std::uint64_t audio_bytes_sent = 0;
  std::uint64_t remote_video_frames_received = 0;
  std::uint64_t remote_video_bytes_received = 0;
  std::uint64_t remote_audio_frames_received = 0;
  std::uint64_t remote_audio_bytes_received = 0;
  std::uint64_t encoded_media_data_channel_messages_received = 0;
  std::uint64_t encoded_media_data_channel_frames_sent = 0;
  std::uint64_t encoded_media_data_channel_bytes_sent = 0;
  std::uint64_t encoded_media_data_channel_frames_received = 0;
  std::uint64_t encoded_media_data_channel_bytes_received = 0;
  std::uint64_t encoded_media_data_channel_invalid_frames = 0;
  std::uint64_t decoded_frames_rendered = 0;
  std::uint64_t nack_retransmissions = 0;
  std::uint64_t pli_requests_received = 0;
  std::uint64_t keyframe_requests_sent = 0;
  std::uint64_t decoder_recovery_count = 0;
  std::uint64_t dropped_video_units = 0;
  std::int64_t round_trip_time_ms = -1;
  std::int64_t created_at_unix_ms = 0;
  std::int64_t updated_at_unix_ms = 0;
  std::int64_t last_video_frame_at_unix_ms = -1;
  std::int64_t last_remote_video_frame_at_unix_ms = -1;
  std::int64_t last_decoded_frame_at_unix_ms = -1;
  std::string connection_state = "new";
  std::string ice_state = "new";
  std::string gathering_state = "new";
  std::string signaling_state = "stable";
  std::string local_description_type;
  std::string data_channel_label = "vds-control";
  std::string encoded_media_data_channel_protocol = "vds-media-encoded-v1";
  std::string encoded_media_data_channel_state = "idle";
  std::string media_session_id;
  int media_manifest_version = 0;
  std::string video_mid = "video";
  std::string audio_mid = "audio";
  std::string video_codec = "h264";
  std::string audio_codec = "opus";
  std::string codec_path = "h264";
  std::string video_decoder_backend = "none";
  std::string video_source;
  std::string selected_local_candidate;
  std::string selected_remote_candidate;
  std::string reason = "peer-not-created";
  std::string last_error;
};

struct PeerVideoTrackConfig {
  bool enabled = false;
  std::string codec = "h264";
  std::string mid = "video";
  std::string stream_id = "vds-stream";
  std::string track_id = "vds-video";
  std::string source = "unbound";
  int payload_type = 96;
  std::uint32_t ssrc = 0;
  int width = 1920;
  int height = 1080;
  int frame_rate = 60;
  int bitrate_kbps = 10000;
};

struct PeerAudioTrackConfig {
  bool enabled = false;
  std::string codec = "opus";
  std::string mid = "audio";
  std::string stream_id = "vds-stream";
  std::string track_id = "vds-audio";
  std::string source = "unbound";
  int payload_type = 111;
  std::uint32_t ssrc = 0;
  int sample_rate = 48000;
  int channel_count = 2;
  int bitrate_kbps = 128;
};

struct PeerEncodedMediaDataChannelFrame {
  std::string message_type = "frame";
  std::string stream_type;
  std::string codec;
  std::uint64_t timestamp_us = 0;
  std::uint64_t sequence = 0;
  bool keyframe = false;
  bool config = false;
  std::string frame_id;
  std::uint64_t chunk_index = 0;
  std::uint64_t chunk_count = 0;
  std::uint64_t frame_payload_bytes = 0;
  std::vector<std::uint8_t> payload;
};

struct PeerTransportCallbacks {
  std::function<void(const std::string& type, const std::string& sdp)> on_local_description;
  std::function<void(const std::string& candidate, const std::string& sdp_mid)> on_local_candidate;
  std::function<void(const PeerTransportSnapshot& snapshot, const std::string& logical_state)> on_state_change;
  std::function<void(const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp)> on_remote_video_frame;
  std::function<void(const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp)> on_remote_audio_frame;
  std::function<void(const PeerEncodedMediaDataChannelFrame& frame)> on_encoded_media_data_channel_frame;
  std::function<void(const std::string& message)> on_warning;
};

class PeerTransportSession;

PeerTransportBackendInfo get_peer_transport_backend_info();

std::shared_ptr<PeerTransportSession> create_peer_transport_session(
  const std::string& peer_id,
  bool initiator,
  const PeerTransportCallbacks& callbacks,
  bool encoded_media_data_channel,
  std::string* error
);

bool set_peer_transport_remote_description(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& type,
  const std::string& sdp,
  std::string* error
);

bool add_peer_transport_remote_candidate(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& candidate,
  const std::string& sdp_mid,
  std::string* error
);

bool ensure_peer_transport_local_description(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
);

bool configure_peer_transport_video_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerVideoTrackConfig& config,
  std::string* error
);

bool configure_peer_transport_audio_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerAudioTrackConfig& config,
  std::string* error
);

bool clear_peer_transport_video_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
);

bool clear_peer_transport_audio_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
);

bool send_peer_transport_video_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint64_t timestamp_us,
  std::string* error
);

bool send_peer_transport_audio_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::vector<std::uint8_t>& frame,
  std::uint64_t timestamp_us,
  std::string* error
);

bool send_peer_transport_encoded_media_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerEncodedMediaDataChannelFrame& frame,
  std::string* error
);

bool set_peer_transport_decoder_state(
  const std::shared_ptr<PeerTransportSession>& session,
  bool decoder_ready,
  std::uint64_t decoded_frames_rendered,
  std::int64_t last_decoded_frame_at_unix_ms,
  const std::string& video_decoder_backend,
  std::string* error
);

bool request_peer_transport_keyframe(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& reason,
  std::string* error
);

void set_peer_transport_media_manifest(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& media_session_id,
  int manifest_version
);

void add_peer_transport_dropped_video_units(
  const std::shared_ptr<PeerTransportSession>& session,
  std::uint64_t count
);

void close_peer_transport_session(const std::shared_ptr<PeerTransportSession>& session);

PeerTransportSnapshot get_peer_transport_snapshot(const std::shared_ptr<PeerTransportSession>& session);

std::string peer_transport_backend_json(const PeerTransportBackendInfo& backend);
std::string peer_transport_snapshot_json(const PeerTransportSnapshot& snapshot);
