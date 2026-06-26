#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "encoded_frame_bus.h"
#include "relay_subscriber_state.h"

class PeerTransportSession;

class RelayHub {
 public:
  RelayHub();
  ~RelayHub();

  EncodedFrameBus& frame_bus();
  const EncodedFrameBus& frame_bus() const;

  void register_subscriber(
    const std::string& upstream_peer_id,
    const std::string& peer_id,
    const std::shared_ptr<PeerTransportSession>& session,
    bool audio_enabled) const;

  void unregister_subscriber(const std::string& peer_id) const;
  void clear_upstream_bootstrap_state(const std::string& upstream_peer_id) const;
  bool query_subscriber_state(const std::string& peer_id, RelaySubscriberState* out_state) const;
  std::string subscriber_runtime_json(const std::string& peer_id) const;
  void shutdown_runtime() const;

  void publish_video_units(
    const std::string& upstream_peer_id,
    const std::string& codec,
    const std::vector<std::vector<std::uint8_t>>& access_units,
    std::uint32_t rtp_timestamp) const;

  void publish_audio_frame(
    const std::string& upstream_peer_id,
    const std::vector<std::uint8_t>& frame,
    const std::string& codec,
    std::uint32_t rtp_timestamp) const;

 private:
  struct Backend;
  mutable std::unique_ptr<Backend> backend_;
  EncodedFrameBus frame_bus_;
};

RelayHub& relay_hub();
