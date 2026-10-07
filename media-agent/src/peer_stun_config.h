#pragma once

#include <string>
#include <vector>

namespace vds::media_agent {

bool is_valid_peer_stun_server(const std::string& server);
bool parse_peer_stun_server_request(const std::string& request_json, std::string* server);
bool parse_peer_stun_servers_request(const std::string& request_json, std::vector<std::string>* servers);

} // namespace vds::media_agent
