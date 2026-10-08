#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "peer_transport_state.h"

struct PeerTransportSnapshot {
  bool transport_ready = false;
  bool media_plane_ready = false;
  bool video_track_configured = false;
  bool audio_track_configured = false;
  bool video_receiver_configured = false;
  bool audio_receiver_configured = false;
  bool video_track_open = false;
  bool audio_track_open = false;
  bool decoder_ready = false;
  bool remote_description_set = false;
  bool encoded_media_data_channel_requested = false;
  bool encoded_media_data_channel_supported = false;
  bool encoded_media_data_channel_open = false;
  bool encoded_media_data_channel_ready = false;
  int remote_candidate_count = 0;
  int nat_probe_observations = 0;
  int nat_port_step = 0;
  int predicted_local_candidates = 0;
  int predicted_remote_candidates = 0;
  bool nat_traversal_enabled = false;
  std::uint64_t video_frames_sent = 0;
  std::uint64_t audio_frames_sent = 0;
  std::uint64_t remote_video_frames_received = 0;
  std::uint64_t remote_audio_frames_received = 0;
  std::uint64_t encoded_media_data_channel_frames_sent = 0;
  std::uint64_t encoded_media_data_channel_frames_received = 0;
  std::uint64_t encoded_media_data_channel_invalid_frames = 0;
  std::uint64_t encoded_media_data_channel_chunks_received = 0;
  std::uint64_t encoded_media_data_channel_incomplete_frames_dropped = 0;
  std::uint64_t encoded_media_data_channel_backpressure_drops = 0;
  std::uint64_t encoded_media_data_channel_pending_frames = 0;
  std::uint64_t encoded_media_data_channel_pending_bytes = 0;
  std::uint64_t encoded_media_data_channel_buffered_bytes = 0;
  std::uint64_t decoded_frames_rendered = 0;
  std::uint64_t nack_retransmissions = 0;
  std::uint64_t pli_requests_received = 0;
  std::uint64_t keyframe_requests_sent = 0;
  std::uint64_t keyframe_requests_received = 0;
  std::uint64_t keyframe_requests_throttled = 0;
  std::string keyframe_request_action = "keyframe-producer-unavailable";
  std::uint64_t decoder_recovery_count = 0;
  std::uint64_t dropped_video_units = 0;
  std::int64_t round_trip_time_ms = -1;
  std::string connection_state = "new";
  std::string ice_state = "new";
  std::string signaling_state = "stable";
  std::string data_channel_label = "vds-control";
  std::string encoded_media_data_channel_state = "idle";
  std::string media_session_id;
  int media_manifest_version = 0;
  std::string video_codec = "h264";
  std::string audio_codec = "opus";
  std::string codec_path = "h264";
  std::string selected_local_candidate;
  std::string selected_remote_candidate;
  std::string selected_stun_server;
  std::vector<std::string> stun_servers;
  std::string transport_generation;
  std::string reason = "peer-not-created";
  std::string last_error;
};

// A readiness hint for media producers. This carries no diagnostic strings,
// does not query RTT/candidates, and never replaces actual send admission.
struct PeerTransportMediaReadiness {
  bool connected = false;
  bool use_encoded_data_channel = false;
  bool video_ready = false;
  bool audio_ready = false;
};

struct PeerVideoTrackConfig {
  std::string codec = "h264";
  std::string mid = "video";
  std::string stream_id = "vds-stream";
  std::string track_id = "vds-video";
  int payload_type = 96;
  int bitrate_kbps = 10000;
};

struct PeerAudioTrackConfig {
  std::string codec = "opus";
  std::string mid = "audio";
  std::string stream_id = "vds-stream";
  std::string track_id = "vds-audio";
  int payload_type = 111;
  int sample_rate = 48000;
  int bitrate_kbps = 128;
};

struct PeerEncodedMediaDataChannelFrame {
  std::string message_type = "frame";
  std::string stream_type;
  std::string codec;
  std::string payload_format;
  std::string source_epoch;
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

using PeerKeyframeRequestHandler = std::function<std::string(const std::string&)>;

struct PeerTransportCallbacks {
  // Downstream media bindings still accept hello/keyframe control, but cannot
  // feed media back into a host or relay receiver.
  bool allow_remote_media = true;
  PeerKeyframeRequestHandler on_keyframe_requested;
  std::function<void(const std::string& type, const std::string& sdp, const std::string& generation)> on_local_description;
  std::function<void(const std::string& candidate, const std::string& sdp_mid, const std::string& generation)> on_local_candidate;
  std::function<void(const PeerTransportSnapshot& snapshot, const std::string& logical_state)> on_state_change;
  std::function<void(const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp)> on_remote_video_frame;
  std::function<void(const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp)> on_remote_audio_frame;
  std::function<void(const PeerEncodedMediaDataChannelFrame& frame)> on_encoded_media_data_channel_frame;
  std::function<void(const std::string& message)> on_warning;
};

class PeerTransportSession;

void set_peer_transport_keyframe_request_handler(
  const std::shared_ptr<PeerTransportSession>& session,
  PeerKeyframeRequestHandler handler);

PeerTransportBackendInfo get_peer_transport_backend_info();

std::shared_ptr<PeerTransportSession> create_peer_transport_session(
  const std::string& peer_id,
  bool initiator,
  const PeerTransportCallbacks& callbacks,
  bool encoded_media_data_channel,
  const std::string& stun_server,
  const std::vector<std::string>& stun_servers,
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

PeerTransportMediaReadiness get_peer_transport_media_readiness(
  const std::shared_ptr<PeerTransportSession>& session);

std::string peer_transport_snapshot_json(const PeerTransportSnapshot& snapshot);
