// Real ICE/DTLS/SCTP, exclusively over Windows loopback. No public STUN/TURN.
// The fallback case synthesizes loopback aliases of the real dual-stack socket;
// it tests transport scheduling, not OS interface enumeration or public routing.
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <rtc/rtc.hpp>
#include <array>
#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono_literals;
namespace {
void require(bool ok, const std::string& why) {
  if (!ok) throw std::runtime_error(why);
}

struct SilentEndpoint {
  SOCKET socket = INVALID_SOCKET;
  unsigned port = 0;
  unsigned packets = 0;
  explicit SilentEndpoint(unsigned requested = 0) {
    socket = ::socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
    require(socket != INVALID_SOCKET, "IPv6 socket unavailable");
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_addr = in6addr_loopback;
    address.sin6_port = htons(static_cast<unsigned short>(requested));
    if (bind(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address))) {
      const int error = WSAGetLastError();
      closesocket(socket); socket = INVALID_SOCKET;
      throw std::runtime_error("IPv6 bind failed: " + std::to_string(error));
    }
    int size = sizeof(address);
    require(getsockname(socket, reinterpret_cast<sockaddr*>(&address), &size) == 0, "getsockname failed");
    port = ntohs(address.sin6_port);
    u_long mode = 1;
    require(ioctlsocket(socket, FIONBIO, &mode) == 0, "nonblocking failed");
  }
  ~SilentEndpoint() { if (socket != INVALID_SOCKET) closesocket(socket); }
  SilentEndpoint(const SilentEndpoint&) = delete;
  SilentEndpoint& operator=(const SilentEndpoint&) = delete;
  void drain() {
    char data[65536];
    while (recv(socket, data, sizeof(data), 0) >= 0) ++packets;
    require(WSAGetLastError() == WSAEWOULDBLOCK, "silent endpoint receive failed");
  }
};

struct Pair {
  std::mutex mutex;
  std::array<std::vector<rtc::Candidate>, 2> candidates;
  std::array<std::shared_ptr<rtc::PeerConnection>, 2> peers;
  std::shared_ptr<rtc::DataChannel> outgoing, incoming;
  std::atomic<unsigned> echoed{0};
  std::atomic<bool> corrupt{false};
  ~Pair() {
    if (outgoing) outgoing->resetCallbacks();
    for (const auto& peer : peers) if (peer) peer->resetCallbacks();
    // close() schedules teardown; keep callback state alive until workers stop.
    for (const auto& peer : peers) if (peer) peer->close();
    peers = {};
    outgoing.reset();
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (incoming) incoming->resetCallbacks();
      incoming.reset();
    }
    rtc::Cleanup().wait();
  }
};

template<class Predicate, class Pump>
void until(Predicate predicate, Pump pump, std::chrono::milliseconds timeout, const char* why) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    pump();
    if (predicate()) return;
    std::this_thread::sleep_for(5ms);
  }
  throw std::runtime_error(why);
}

void run(const char* name, bool embedded, bool fallback, bool unreachable = false) {
  std::cout << "CASE-BEGIN " << name << std::endl;
  SilentEndpoint dead0, dead1, deadStun;
  const std::array<unsigned, 2> deadPorts{dead0.port, dead1.port};
  std::array<unsigned, 2> localPorts{};
  long long connectedMs = 0;
  unsigned echoes = 0;
  {
    Pair pair;
    for (unsigned side = 0; side < 2; ++side) {
      rtc::Configuration config;
      config.bindAddress = fallback ? "::" : "::1";
      config.disableAutoGathering = true;
      config.disableAutoNegotiation = true;
      config.enableIceTcp = false;
      config.iceServers.emplace_back("::1", static_cast<uint16_t>(deadStun.port));
      pair.peers[side] = std::make_shared<rtc::PeerConnection>(config);
      pair.peers[side]->onLocalCandidate([&, side](rtc::Candidate candidate) {
        if (candidate.type() != rtc::Candidate::Type::Host ||
            candidate.transportType() != rtc::Candidate::TransportType::Udp) return;
        std::lock_guard<std::mutex> lock(pair.mutex);
        pair.candidates[side].push_back(candidate);
      });
    }
    pair.peers[1]->onDataChannel([&](std::shared_ptr<rtc::DataChannel> channel) {
      const std::weak_ptr<rtc::DataChannel> weak = channel;
      channel->onMessage([weak](rtc::message_variant message) {
        if (const auto active = weak.lock()) active->send(message);
      });
      std::lock_guard<std::mutex> lock(pair.mutex);
      pair.incoming = channel;
    });
    pair.outgoing = pair.peers[0]->createDataChannel("dual-stack-real-dtls-sctp");
    pair.outgoing->onMessage([&](rtc::message_variant message) {
      const auto* value = std::get_if<std::string>(&message);
      const auto expected = std::string(4096, 'v') + std::to_string(pair.echoed.load());
      if (!value || *value != expected) pair.corrupt = true;
      else ++pair.echoed;
    });
    pair.peers[0]->setLocalDescription(rtc::Description::Type::Offer);
    pair.peers[1]->setRemoteDescription(*pair.peers[0]->localDescription());
    pair.peers[1]->setLocalDescription(rtc::Description::Type::Answer);
    pair.peers[0]->setRemoteDescription(*pair.peers[1]->localDescription());
    for (const auto& peer : pair.peers) peer->gatherLocalCandidates();
    const auto pump = [&] { dead0.drain(); dead1.drain(); deadStun.drain(); };
    until([&] {
      std::lock_guard<std::mutex> lock(pair.mutex);
      return !pair.candidates[0].empty() && !pair.candidates[1].empty();
    }, pump, 3s, "host candidate gathering failed");
    std::array<std::vector<rtc::Candidate>, 2> signaled;
    {
      std::lock_guard<std::mutex> lock(pair.mutex);
      signaled = pair.candidates;
    }
    for (unsigned side = 0; side < 2; ++side) {
      auto candidate = signaled[side].front();
      require(candidate.resolve() && candidate.port(), "host candidate does not resolve");
      localPorts[side] = *candidate.port();
      if (fallback) {
        // High-priority IPv6 is a real bound socket that deliberately never
        // answers; lower-priority IPv4 reaches the genuine ICE socket.
        signaled[side] = {rtc::Candidate("candidate:dead6 1 UDP 2130706431 ::1 " +
          std::to_string(deadPorts[side]) + " typ host", candidate.mid())};
        if (!unreachable) signaled[side].emplace_back("candidate:live4 1 UDP 2120000000 127.0.0.1 " +
          std::to_string(localPorts[side]) + " typ host", candidate.mid());
      } else {
        require(candidate.family() == rtc::Candidate::Family::Ipv6 && candidate.address() == "::1",
          "IPv6 test must use genuine loopback host candidate");
        require(signaled[side].size() == 1, "unexpected route could rescue IPv6 test");
      }
    }
    const auto began = std::chrono::steady_clock::now();
    if (embedded) {
      pair.peers[0]->setLocalDescription(rtc::Description::Type::Offer);
      auto offer = pair.peers[0]->createOffer();
      require(offer.candidates().size() == 1, "exported IPv6 offer lacks candidate");
      pair.peers[1]->setRemoteDescription(offer);
      pair.peers[1]->setLocalDescription(rtc::Description::Type::Answer);
      auto answer = pair.peers[1]->createAnswer();
      require(answer.candidates().size() == 1, "exported IPv6 answer lacks candidate");
      pair.peers[0]->setRemoteDescription(answer);
    } else {
      for (unsigned side = 0; side < 2; ++side)
        for (const auto& candidate : signaled[side]) pair.peers[1 - side]->addRemoteCandidate(candidate);
    }
    if (unreachable) {
      const auto deadline = began + 3s;
      while (std::chrono::steady_clock::now() < deadline) {
        pump();
        require(!pair.outgoing->isOpen(), "negative fixture unexpectedly connected");
        std::this_thread::sleep_for(5ms);
      }
    } else {
      until([&] { return pair.outgoing->isOpen(); }, pump, 5s, "DataChannel handshake failed");
      connectedMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - began).count();
      const auto deadline = std::chrono::steady_clock::now() + 3s;
      do {
        const unsigned sequence = pair.echoed.load();
        pair.outgoing->send(std::string(4096, 'v') + std::to_string(sequence));
        until([&] { return pair.echoed > sequence || pair.corrupt; }, pump, 1s, "sustained echo stalled");
        require(!pair.corrupt, "echo corruption, duplicate, or reordering");
        std::this_thread::sleep_for(50ms);
      } while (std::chrono::steady_clock::now() < deadline);
      echoes = pair.echoed;
      require(echoes >= 20, "insufficient sustained echoes");
      for (unsigned side = 0; side < 2; ++side) {
        rtc::Candidate local, remote;
        require(pair.peers[side]->getSelectedCandidatePair(&local, &remote) && remote.resolve(), "selected pair missing");
        require(remote.family() == (fallback ? rtc::Candidate::Family::Ipv4 : rtc::Candidate::Family::Ipv6),
          "wrong family won; fixture bypassed intended path");
        require(remote.address() == (fallback ? "127.0.0.1" : "::1") && remote.port() == localPorts[1 - side],
          "selected endpoint differs from the real peer socket");
        require(remote.type() != rtc::Candidate::Type::Relayed, "relay route forbidden");
      }
    }
    pump();
    require(deadStun.packets > 0, "dead STUN was not exercised");
    if (fallback) require(dead0.packets + dead1.packets > 0, "preferred IPv6 route was not tried");
  }
  // After native teardown both original ICE ports must be released.
  SilentEndpoint rebound0(localPorts[0]), rebound1(localPorts[1]);
  std::cout << "RESULT {\"scenario\":\"" << name << "\",\"connectedMs\":" << connectedMs
    << ",\"echoes\":" << echoes << ",\"silentIpv6Packets\":" << dead0.packets + dead1.packets
    << ",\"deadStunPackets\":" << deadStun.packets << ",\"portsReleased\":true}" << std::endl;
}
} // namespace

int main() {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data)) return 1;
  int result = 0;
  try {
    rtc::InitLogger(rtc::LogLevel::Warning);
    run("ipv6-trickle-dead-stun", false, false);
    run("ipv6-embedded-sdp-dead-stun", true, false);
    run("ipv6-blackhole-ipv4-fallback", false, true);
    run("no-reachable-candidate-negative", false, true, true);
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    result = 1;
  }
  WSACleanup();
  return result;
}
