#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace vds::media_agent {

constexpr std::size_t kPeerStunServersPerTransport = 4;
struct PeerStunEndpoint {
  std::string host;
  std::uint16_t port = 3478;
  bool tcp = false;
};

bool parse_peer_stun_endpoint(const std::string& server, PeerStunEndpoint* endpoint);
bool is_valid_peer_stun_pool(const std::vector<std::string>& servers);
bool is_valid_peer_stun_server(const std::string& server);
bool parse_peer_stun_server_request(const std::string& request_json, std::string* server);
bool parse_peer_stun_servers_request(const std::string& request_json, std::vector<std::string>* servers);

} // namespace vds::media_agent
