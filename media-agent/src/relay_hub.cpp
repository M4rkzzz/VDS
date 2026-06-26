#include "relay_hub.h"

#include "relay_backend_runtime.h"

namespace relay_backend = vds::media_agent::relay_backend;

struct RelayHub::Backend {
  Backend() : runtime(relay_backend::create_runtime()) {}

  std::unique_ptr<relay_backend::Runtime> runtime;
};

RelayHub::RelayHub() : backend_(std::make_unique<Backend>()) {
  frame_bus_.set_video_handler([this](const EncodedFrameBatch& batch) {
    if (!backend_ || !backend_->runtime) {
      return;
    }
    backend_->runtime->fanout_video_units(
      batch.upstream_peer_id,
      batch.codec,
      batch.payloads,
      batch.rtp_timestamp
    );
  });
  frame_bus_.set_audio_handler([this](const EncodedFrame& frame) {
    if (!backend_ || !backend_->runtime) {
      return;
    }
    backend_->runtime->fanout_audio_frame(
      frame.upstream_peer_id,
      frame.payload,
      frame.codec,
      frame.rtp_timestamp
    );
  });
}

RelayHub::~RelayHub() {
  shutdown_runtime();
}

EncodedFrameBus& RelayHub::frame_bus() {
  return frame_bus_;
}

const EncodedFrameBus& RelayHub::frame_bus() const {
  return frame_bus_;
}

void RelayHub::register_subscriber(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::shared_ptr<PeerTransportSession>& session,
  bool audio_enabled) const {
  if (!backend_ || !backend_->runtime) {
    return;
  }
  backend_->runtime->register_subscriber(upstream_peer_id, peer_id, session, audio_enabled);
}

void RelayHub::unregister_subscriber(const std::string& peer_id) const {
  if (!backend_ || !backend_->runtime) {
    return;
  }
  backend_->runtime->unregister_subscriber(peer_id);
}

void RelayHub::clear_upstream_bootstrap_state(const std::string& upstream_peer_id) const {
  if (!backend_ || !backend_->runtime) {
    return;
  }
  backend_->runtime->clear_upstream_bootstrap_state(upstream_peer_id);
}

bool RelayHub::query_subscriber_state(
  const std::string& peer_id,
  RelaySubscriberState* out_state) const {
  if (!backend_ || !backend_->runtime) {
    return false;
  }
  return backend_->runtime->query_subscriber_state(peer_id, out_state);
}

std::string RelayHub::subscriber_runtime_json(const std::string& peer_id) const {
  if (!backend_ || !backend_->runtime) {
    return "null";
  }
  return backend_->runtime->subscriber_runtime_json(peer_id);
}

void RelayHub::shutdown_runtime() const {
  if (!backend_ || !backend_->runtime) {
    return;
  }
  backend_->runtime->shutdown_dispatch();
}

void RelayHub::publish_video_units(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp) const {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  EncodedFrameBatch batch;
  batch.upstream_peer_id = upstream_peer_id;
  batch.stream_type = "video";
  batch.codec = codec;
  batch.rtp_timestamp = rtp_timestamp;
  batch.payloads = access_units;
  frame_bus_.publish_video(batch);
}

void RelayHub::publish_audio_frame(
  const std::string& upstream_peer_id,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) const {
  if (upstream_peer_id.empty() || frame.empty()) {
    return;
  }

  EncodedFrame encoded_frame;
  encoded_frame.upstream_peer_id = upstream_peer_id;
  encoded_frame.stream_type = "audio";
  encoded_frame.codec = codec;
  encoded_frame.rtp_timestamp = rtp_timestamp;
  encoded_frame.payload = frame;
  frame_bus_.publish_audio(encoded_frame);
}

RelayHub& relay_hub() {
  static RelayHub hub;
  return hub;
}
