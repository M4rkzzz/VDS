#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "agent_runtime.h"
#include "peer_transport.h"

void register_relay_subscriber(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::shared_ptr<PeerTransportSession>& session,
  bool audio_enabled);

void unregister_relay_subscriber(const std::string& peer_id);
void clear_relay_upstream_bootstrap_state(const std::string& upstream_peer_id);

bool query_relay_subscriber_state(
  const std::string& peer_id,
  RelaySubscriberState* out_state);
std::string relay_subscriber_runtime_json(const std::string& peer_id);

void fanout_relay_video_units(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp);

void fanout_relay_audio_frame(
  const std::string& upstream_peer_id,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp);
