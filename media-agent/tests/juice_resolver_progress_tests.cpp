#include <winsock2.h>
#include <ws2tcpip.h>
#include <juice/juice.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono_literals;
namespace {
std::atomic<bool> releaseDns{false};
std::atomic<unsigned> waitingDns{0};
std::atomic<bool> failDns{false};
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
struct Context {
  std::mutex mutex;
  std::vector<std::string> candidates;
  std::atomic<bool> gathered{false}, earlyGathering{false};
  std::atomic<unsigned> received{0};
};
void candidate(juice_agent_t*, const char* text, void* data) {
  if (!std::strstr(text, " typ srflx") || std::strstr(text, " vds-predicted 1")) return;
  auto& ctx = *static_cast<Context*>(data);
  std::lock_guard<std::mutex> lock(ctx.mutex);
  ctx.candidates.emplace_back(text);
}
void gathered(juice_agent_t*, void* data) {
  auto& ctx = *static_cast<Context*>(data);
  if (!releaseDns) ctx.earlyGathering = true;
  ctx.gathered = true;
}
void received(juice_agent_t*, const char* bytes, size_t size, void* data) {
  if (size == 4096 && bytes[0] == 'V' && bytes[size - 1] == 'S') ++static_cast<Context*>(data)->received;
}
using Agent = std::unique_ptr<juice_agent_t, decltype(&juice_destroy)>;
using Server = std::unique_ptr<juice_server_t, decltype(&juice_server_destroy)>;
// Must outlive agents so failure/close cannot hang on the deliberately held resolver.
struct ReleaseOnExit { ~ReleaseOnExit() { releaseDns = true; } };
std::string credentials(juice_agent_t* agent) {
  char text[JUICE_MAX_SDP_STRING_LEN];
  require(juice_get_local_description(agent, text, sizeof(text)) == 0, "get description failed");
  std::string result;
  for (const char* key : {"a=ice-ufrag:", "a=ice-pwd:"}) {
    const std::string all(text); const auto pos = all.find(key);
    require(pos != std::string::npos, "missing credentials");
    result += all.substr(pos, all.find_first_of("\r\n", pos) - pos) + "\r\n";
  }
  return result; // no host candidate or relay can rescue this case
}
void run(bool dnsFailure, bool slowFirst) {
  releaseDns = false; failDns = dnsFailure;
  require(waitingDns == 0, "previous resolver still pending");
  juice_server_config_t serverConfig{}; serverConfig.bind_address = "127.0.0.1";
  Server server(juice_server_create(&serverConfig), juice_server_destroy);
  require(bool(server), "loopback STUN server failed");
  const auto port = juice_server_get_port(server.get());
  require(port != 0, "missing server port");
  std::array<Context, 2> ctx;
  std::array<Agent, 2> agents{Agent(nullptr, juice_destroy), Agent(nullptr, juice_destroy)};
  ReleaseOnExit cleanup; // destroyed before agents, also on assertion failure
  std::array<juice_stun_server_t, 2> servers{{{"127.0.0.1", port}, {"delayed.vds.test", port}}};
  if (slowFirst) std::swap(servers[0], servers[1]);
  for (unsigned side = 0; side < 2; ++side) {
    juice_config_t config{};
    config.bind_address = "127.0.0.1";
    config.stun_servers[0] = servers[0]; config.stun_servers[1] = servers[1]; config.stun_servers_count = 2;
    config.enable_port_prediction = true; config.enable_multi_socket_punch = true;
    config.cb_candidate = candidate; config.cb_gathering_done = gathered; config.cb_recv = received;
    config.user_ptr = &ctx[side];
    agents[side].reset(juice_create(&config));
    require(bool(agents[side]), "agent create failed");
  }
  const auto local0 = credentials(agents[0].get()), local1 = credentials(agents[1].get());
  require(juice_set_remote_description(agents[0].get(), local1.c_str()) == 0 &&
    juice_set_remote_description(agents[1].get(), local0.c_str()) == 0, "credential exchange failed");
  const auto start = std::chrono::steady_clock::now();
  for (auto& agent : agents) require(juice_gather_candidates(agent.get()) == 0, "gather failed");
  std::array<size_t, 2> delivered{};
  std::string payload(4096, 'x'); payload.front() = 'V'; payload.back() = 'S';
  const auto pump = [&] {
    for (unsigned side = 0; side < 2; ++side) {
      std::vector<std::string> fresh;
      {
        std::lock_guard<std::mutex> lock(ctx[side].mutex);
        while (delivered[side] < ctx[side].candidates.size()) fresh.push_back(ctx[side].candidates[delivered[side]++]);
      }
      for (const auto& text : fresh)
        require(juice_add_remote_candidate(agents[1 - side].get(), text.c_str()) == 0, "candidate rejected");
      const auto state = juice_get_state(agents[side].get());
      if (state == JUICE_STATE_CONNECTED || state == JUICE_STATE_COMPLETED)
        require(juice_send(agents[side].get(), payload.data(), payload.size()) == 0, "application datagram send failed");
    }
    std::this_thread::sleep_for(10ms);
  };
  while (std::chrono::steady_clock::now() - start < 3500ms) pump();
  std::cout << "slow-first=" << slowFirst << " dns-failure=" << dnsFailure << " before-dns-release waiting=" << waitingDns << " gathered=" << ctx[0].gathered << ',' << ctx[1].gathered
    << " candidates=" << delivered[0] << ',' << delivered[1] << " received=" << ctx[0].received << ',' << ctx[1].received << std::endl;
  require(waitingDns == 2, "both agents must encounter held DNS lookup");
  require(!ctx[0].earlyGathering && !ctx[1].earlyGathering, "gathering completed while configured DNS lookup was pending");
  require(delivered[0] && delivered[1], "numeric STUN candidates stalled by pending DNS");
  require(ctx[0].received >= 20 && ctx[1].received >= 20, "resolved path did not carry bidirectional data during DNS wait");
  releaseDns = true;
  const auto finish = std::chrono::steady_clock::now() + 2s;
  while ((!ctx[0].gathered || !ctx[1].gathered) && std::chrono::steady_clock::now() < finish) pump();
  require(ctx[0].gathered && ctx[1].gathered, "gathering did not finish after DNS and duplicate STUN resolution");
  require(waitingDns == 0, "resolver worker still held");
  for (const auto& agent : agents) require(juice_get_state(agent.get()) == JUICE_STATE_COMPLETED, "ICE nomination incomplete");
  const auto before0 = ctx[0].received.load(), before1 = ctx[1].received.load();
  const auto until = std::chrono::steady_clock::now() + 1s;
  while (std::chrono::steady_clock::now() < until) pump();
  require(ctx[0].received > before0 + 20 && ctx[1].received > before1 + 20, "late DNS disturbed active transport");
  std::cout << "PASS held DNS: candidate progress, no premature completion, authenticated ICE, 4KiB bidirectional UDP and nomination\n";
}
} // namespace

extern "C" int WSAAPI vds_test_getaddrinfo(const char* node, const char* service, const addrinfo* hints, addrinfo** result) {
  if (node && std::strcmp(node, "delayed.vds.test") == 0) {
    ++waitingDns;
    const auto limit = std::chrono::steady_clock::now() + 10s;
    while (!releaseDns && std::chrono::steady_clock::now() < limit) std::this_thread::sleep_for(1ms);
    --waitingDns;
    if (!releaseDns) return EAI_AGAIN;
    if (failDns) return EAI_NONAME;
    return getaddrinfo("127.0.0.1", service, hints, result);
  }
  // Only numeric loopback inputs are expected. No test name goes to real DNS.
  return getaddrinfo(node, service, hints, result);
}
int main(int argc, char** argv) {
  try {
    juice_set_log_level(JUICE_LOG_LEVEL_WARN);
    require(argc == 1 || (argc == 2 && std::string(argv[1]) == "--slow-first"), "usage: [--slow-first]");
    if (argc == 1) { run(false, false); run(true, false); }
    run(false, true); run(true, true); return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL held DNS: " << error.what() << '\n'; return 1;
  }
}
