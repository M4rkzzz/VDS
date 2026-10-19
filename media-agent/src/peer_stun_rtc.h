#pragma once

#include "peer_stun_config.h"
#include <rtc/configuration.hpp>
#include <stdexcept>

namespace vds::media_agent {

inline rtc::IceServer make_peer_stun_ice_server(const std::string& url) {
  PeerStunEndpoint endpoint;
  if (!parse_peer_stun_endpoint(url, &endpoint)) {
    throw std::invalid_argument("invalid-stun-server");
  }
#ifndef RTC_VDS_TCP_STUN
  // Older libraries silently interpret STUN/TCP as UDP. Never misreport that
  // configuration as TCP discovery when building against an older runtime.
  if (endpoint.tcp) throw std::invalid_argument("native-tcp-stun-runtime-required");
#endif
  // Keep the host/port constructor: the upstream URL parser mishandles IPv6.
  rtc::IceServer server(endpoint.host, endpoint.port);
  server.relayType = endpoint.tcp ? rtc::IceServer::RelayType::TurnTcp : rtc::IceServer::RelayType::TurnUdp;
  // relayType names are upstream API names; this remains Type::Stun and has no
  // TURN credentials or allocation. It only discovers a direct TCP endpoint.
  return server;
}

} // namespace vds::media_agent
