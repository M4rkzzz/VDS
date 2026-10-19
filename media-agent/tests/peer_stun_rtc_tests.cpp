#include "peer_stun_rtc.h"
#include <iostream>
#include <cstring>
#include <new>

using namespace vds::media_agent;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  try {
#ifdef RTC_VDS_TCP_STUN
    // Host constructors predate STUN/TCP and used to leave relayType undefined.
    // Poison storage so a coincidentally zeroed stack cannot hide regression.
    alignas(rtc::IceServer) unsigned char storage[sizeof(rtc::IceServer)];
    for (bool numeric : {false, true}) {
      std::memset(storage, 0xa5, sizeof(storage));
      auto* raw = numeric ? new (storage) rtc::IceServer("example.org", std::uint16_t(3478)) :
        new (storage) rtc::IceServer("example.org", std::string("3478"));
      const bool defaultsToUdp = raw->type == rtc::IceServer::Type::Stun &&
        raw->relayType == rtc::IceServer::RelayType::TurnUdp;
      raw->~IceServer();
      require(defaultsToUdp, "host STUN constructor has an uninitialized transport");
    }
#endif
    for (const auto& url : {"stun:example.org", "stun:[::1]:3478?transport=udp"}) {
      auto server = make_peer_stun_ice_server(url);
      require(server.type == rtc::IceServer::Type::Stun && server.port == 3478 &&
        server.relayType == rtc::IceServer::RelayType::TurnUdp, "UDP changed");
    }
    PeerStunEndpoint endpoint;
    require(parse_peer_stun_endpoint("stun:[2001:db8::1]:65535?transport=tcp", &endpoint) &&
      endpoint.host == "2001:db8::1" && endpoint.port == 65535 && endpoint.tcp, "IPv6 TCP parsing");
    const char* tcp = "stun:[::1]:443?transport=tcp";
#ifdef RTC_VDS_TCP_STUN
    auto server = make_peer_stun_ice_server(tcp);
    require(server.hostname == "::1" && server.port == 443 && server.type == rtc::IceServer::Type::Stun &&
      server.relayType == rtc::IceServer::RelayType::TurnTcp && server.username.empty() && server.password.empty(),
      "TCP STUN changed into UDP or TURN");
#else
    bool rejected = false;
    try { make_peer_stun_ice_server(tcp); }
    catch (const std::invalid_argument& e) { rejected = std::string(e.what()) == "native-tcp-stun-runtime-required"; }
    require(rejected, "older runtime silently downgraded TCP");
#endif
    for (const auto& url : {"stun:?transport=tcp", "stun:example:3478abc?transport=tcp",
        "stun:example?transport=tcp&x=1", "stun:example?transport=tls", "turn:example?transport=tcp",
        "stuns:example", "stun:example?transport=tcp#x", "stun:[::1]:65536?transport=tcp"}) {
      require(!parse_peer_stun_endpoint(url, &endpoint), "invalid URI accepted");
    }
    const std::string udp = "stun:udp.example:3478";
    const std::string stream = "stun:tcp.example:3478?transport=tcp";
    std::vector<std::string> pool(4, udp);
    pool.insert(pool.end(), 4, stream);
    require(is_valid_peer_stun_pool(pool), "TCP displaces existing UDP pool");
    pool.push_back(stream);
    require(!is_valid_peer_stun_pool(pool), "TCP pool exceeds native capacity");
    require(!is_valid_peer_stun_pool(std::vector<std::string>(5, udp)), "UDP validation regressed");
    std::vector<std::string> parsed;
    require(parse_peer_stun_servers_request(
      R"({"params":{"stunServers":["stun:u1","stun:u2","stun:u3","stun:u4","stun:[::1]?transport=tcp"]}})", &parsed) &&
      parsed.size() == 5, "JSON-RPC mixed pool lost transport");
    std::cout << "PASS native STUN URI, JSON-RPC pool, RTC transport and pure-P2P guards\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
