#pragma once

#include <string>

struct PeerState;

struct RelayVideoBindingContext {
  const std::string& upstream_peer_id;
  const PeerState& upstream_peer;
};

bool attach_relay_video_media_binding(
  const RelayVideoBindingContext& context,
  PeerState& peer,
  const std::string& source,
  std::string* error);
