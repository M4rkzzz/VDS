#pragma once

#include <string>
#include <vector>

struct PeerState;

namespace vds::media_agent {

void create_transport_for_peer_session(
  bool transport_ready,
  PeerState& peer,
  const std::string& request_json,
  bool encoded_media_data_channel,
  const std::string& stun_server,
  const std::vector<std::string>& stun_servers);

}  // namespace vds::media_agent
