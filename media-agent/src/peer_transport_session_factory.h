#pragma once

#include <string>

struct PeerState;

namespace vds::media_agent {

void create_transport_for_peer_session(
  bool transport_ready,
  PeerState& peer,
  const std::string& request_json,
  bool encoded_media_data_channel);

}  // namespace vds::media_agent
