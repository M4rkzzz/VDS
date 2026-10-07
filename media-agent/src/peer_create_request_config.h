#pragma once

#include <string>
#include <vector>

#include "peer_control_result.h"
#include "peer_session_state.h"

struct PeerTransportBackendInfo;

namespace vds::media_agent {

struct PeerCreateRequestConfig {
  bool ok = false;
  bool encoded_media_data_channel = true;
  std::string stun_server;
  std::vector<std::string> stun_servers;
  PeerState peer;
  PeerControlCommandResult error;
};

PeerCreateRequestConfig configure_peer_create_request(
  const PeerTransportBackendInfo& peer_transport,
  const std::string& request_json);

}  // namespace vds::media_agent
