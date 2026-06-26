#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "relay_subscriber_state.h"

class PeerTransportSession;

namespace vds::media_agent::relay_backend {

class Runtime {
 public:
  struct State;

  Runtime();
  ~Runtime();

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  void register_subscriber(
    const std::string& upstream_peer_id,
    const std::string& peer_id,
    const std::shared_ptr<PeerTransportSession>& session,
    bool audio_enabled);

  void unregister_subscriber(const std::string& peer_id);
  void clear_upstream_bootstrap_state(const std::string& upstream_peer_id);
  void shutdown_dispatch();

  bool query_subscriber_state(
    const std::string& peer_id,
    RelaySubscriberState* out_state);
  std::string subscriber_runtime_json(const std::string& peer_id);

  void fanout_video_units(
    const std::string& upstream_peer_id,
    const std::string& codec,
    const std::vector<std::vector<std::uint8_t>>& access_units,
    std::uint32_t rtp_timestamp);

  void fanout_audio_frame(
    const std::string& upstream_peer_id,
    const std::vector<std::uint8_t>& frame,
    const std::string& codec,
    std::uint32_t rtp_timestamp);

 private:
  friend State& relay_backend_state(Runtime& runtime);
  std::unique_ptr<State> state_;
};

std::unique_ptr<Runtime> create_runtime();

} // namespace vds::media_agent::relay_backend
