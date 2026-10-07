// Exercise the patched libjuice UDP transport itself. Every request destination
// is loopback; documentation-only mapped addresses never receive any traffic.
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>

#include <juice/juice.h>

#if !defined(JUICE_VDS_ENHANCED_ICE) || JUICE_VDS_ENHANCED_ICE != 1
#error This test requires the pinned VDS enhanced libjuice build.
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace std::chrono_literals;

namespace {

void require(bool value, const std::string& message) {
  if (!value) throw std::runtime_error(message);
}

struct Winsock {
  Winsock() {
    WSADATA data{};
    require(WSAStartup(MAKEWORD(2, 2), &data) == 0, "WSAStartup failed");
  }
  ~Winsock() { WSACleanup(); }
};

struct Endpoint {
  sockaddr_storage address{};
  int length = 0;
};

unsigned portOf(const Endpoint& endpoint) {
  if (endpoint.address.ss_family == AF_INET)
    return ntohs(reinterpret_cast<const sockaddr_in*>(&endpoint.address)->sin_port);
  return ntohs(reinterpret_cast<const sockaddr_in6*>(&endpoint.address)->sin6_port);
}

bool isLoopback(const Endpoint& endpoint) {
  if (endpoint.address.ss_family == AF_INET) {
    const auto* address = reinterpret_cast<const sockaddr_in*>(&endpoint.address);
    return ntohl(address->sin_addr.s_addr) == 0x7f000001u;
  }
  if (endpoint.address.ss_family == AF_INET6) {
    const auto* address = reinterpret_cast<const sockaddr_in6*>(&endpoint.address);
    return IN6_IS_ADDR_LOOPBACK(&address->sin6_addr);
  }
  return false;
}

class UdpSocket {
 public:
  explicit UdpSocket(bool ipv6 = false) : ipv6_(ipv6) {
    const int family = ipv6 ? AF_INET6 : AF_INET;
    handle = socket(family, SOCK_DGRAM, IPPROTO_UDP);
    require(handle != INVALID_SOCKET, "fixture socket failed");
    Endpoint endpoint;
    if (ipv6) {
      auto* address = reinterpret_cast<sockaddr_in6*>(&endpoint.address);
      address->sin6_family = AF_INET6;
      address->sin6_addr = in6addr_loopback;
      endpoint.length = sizeof(*address);
    } else {
      auto* address = reinterpret_cast<sockaddr_in*>(&endpoint.address);
      address->sin_family = AF_INET;
      address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      endpoint.length = sizeof(*address);
    }
    if (bind(handle, reinterpret_cast<const sockaddr*>(&endpoint.address), endpoint.length) != 0) {
      closesocket(handle);
      handle = INVALID_SOCKET;
      throw std::runtime_error("fixture bind failed");
    }
    bound_.length = sizeof(bound_.address);
    if (getsockname(handle, reinterpret_cast<sockaddr*>(&bound_.address), &bound_.length) != 0) {
      closesocket(handle);
      handle = INVALID_SOCKET;
      throw std::runtime_error("fixture getsockname failed");
    }
  }
  ~UdpSocket() { if (handle != INVALID_SOCKET) closesocket(handle); }
  UdpSocket(const UdpSocket&) = delete;
  UdpSocket& operator=(const UdpSocket&) = delete;
  unsigned port() const { return portOf(bound_); }
  bool ipv6() const { return ipv6_; }
  void send(const std::vector<unsigned char>& packet, const Endpoint& destination) {
    require(isLoopback(destination), "fixture refused non-loopback destination");
    const int count = sendto(handle, reinterpret_cast<const char*>(packet.data()),
      static_cast<int>(packet.size()), 0,
      reinterpret_cast<const sockaddr*>(&destination.address), destination.length);
    require(count == static_cast<int>(packet.size()), "fixture send failed");
  }
  SOCKET handle = INVALID_SOCKET;

 private:
  bool ipv6_;
  Endpoint bound_;
};

using Transaction = std::array<unsigned char, 12>;
constexpr std::array<unsigned char, 4> kMagic{0x21, 0x12, 0xa4, 0x42};

void append16(std::vector<unsigned char>& output, unsigned value) {
  output.push_back(static_cast<unsigned char>(value >> 8));
  output.push_back(static_cast<unsigned char>(value));
}

std::vector<unsigned char> message(unsigned type, const Transaction& transaction,
                                  const std::vector<unsigned char>& attributes) {
  std::vector<unsigned char> output;
  append16(output, type);
  append16(output, static_cast<unsigned>(attributes.size()));
  output.insert(output.end(), kMagic.begin(), kMagic.end());
  output.insert(output.end(), transaction.begin(), transaction.end());
  output.insert(output.end(), attributes.begin(), attributes.end());
  return output;
}

std::vector<unsigned char> success(const Transaction& transaction, unsigned port,
                                   const char* mappedAddress = "203.0.113.9", bool ipv6 = false) {
  std::array<unsigned char, 16> packed{};
  require(inet_pton(ipv6 ? AF_INET6 : AF_INET, mappedAddress, packed.data()) == 1,
          "invalid mapped fixture address");
  std::vector<unsigned char> attribute;
  append16(attribute, 0x20); // XOR-MAPPED-ADDRESS
  append16(attribute, ipv6 ? 20 : 8);
  attribute.push_back(0);
  attribute.push_back(ipv6 ? 2 : 1);
  append16(attribute, port ^ 0x2112);
  for (unsigned index = 0; index < (ipv6 ? 16u : 4u); ++index) {
    const unsigned char mask = index < 4 ? kMagic[index] : transaction[index - 4];
    attribute.push_back(static_cast<unsigned char>(packed[index] ^ mask));
  }
  return message(0x101, transaction, attribute);
}

std::vector<unsigned char> error(const Transaction& transaction) {
  return message(0x111, transaction, {0, 9, 0, 4, 0, 0, 5, 0}); // ERROR-CODE 500
}

struct Event {
  bool complete = false;
  std::string candidate;
};

class Events {
 public:
  static void candidateCallback(juice_agent_t*, const char* candidate, void* user) {
    auto& self = *static_cast<Events*>(user);
    try {
      std::lock_guard<std::mutex> lock(self.mutex_);
      self.events_.push_back({false, candidate});
    } catch (...) { self.failed = true; }
  }
  static void completeCallback(juice_agent_t*, void* user) {
    auto& self = *static_cast<Events*>(user);
    try {
      std::lock_guard<std::mutex> lock(self.mutex_);
      self.events_.push_back({true, {}});
    } catch (...) { self.failed = true; }
    self.complete = true;
  }
  std::vector<Event> snapshot() {
    require(!failed, "native callback failed");
    std::lock_guard<std::mutex> lock(mutex_);
    return events_;
  }
  std::atomic<bool> complete{false};
  std::atomic<bool> failed{false};

 private:
  std::mutex mutex_;
  std::vector<Event> events_;
};

struct Request {
  Transaction transaction{};
  Endpoint source;
  unsigned receiveOrder = 0;
};

class Fixture {
 public:
  explicit Fixture(bool dualStack) {
    for (unsigned index = 0; index < servers.size(); ++index)
      servers[index] = std::make_unique<UdpSocket>(dualStack && index == 1);
  }
  void drain(std::chrono::milliseconds duration) {
    const auto finish = std::chrono::steady_clock::now() + duration;
    while (std::chrono::steady_clock::now() < finish) {
      fd_set readable;
      FD_ZERO(&readable);
      for (const auto& server : servers) FD_SET(server->handle, &readable);
      const auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(
        finish - std::chrono::steady_clock::now());
      const auto wait = std::min<std::int64_t>(20000, std::max<std::int64_t>(0, remaining.count()));
      timeval timeout{static_cast<long>(wait / 1000000), static_cast<long>(wait % 1000000)};
      const int count = select(0, &readable, nullptr, nullptr, &timeout);
      require(count != SOCKET_ERROR, "fixture select failed");
      for (unsigned index = 0; index < servers.size(); ++index) {
        if (!FD_ISSET(servers[index]->handle, &readable)) continue;
        std::array<unsigned char, 4096> packet{};
        Endpoint source;
        source.length = sizeof(source.address);
        const int size = recvfrom(servers[index]->handle, reinterpret_cast<char*>(packet.data()),
          static_cast<int>(packet.size()), 0,
          reinterpret_cast<sockaddr*>(&source.address), &source.length);
        require(size >= 20 && packet[0] == 0 && packet[1] == 1 &&
          std::equal(kMagic.begin(), kMagic.end(), packet.begin() + 4),
          "fixture received an invalid Binding request");
        require(isLoopback(source), "fixture received non-loopback source");
        ++packetCount;
        if (!requests[index]) {
          Request request;
          std::copy(packet.begin() + 8, packet.begin() + 20, request.transaction.begin());
          request.source = source;
          request.receiveOrder = firstRequestCount++;
          requests[index] = request;
        }
      }
    }
  }
  std::array<std::unique_ptr<UdpSocket>, 4> servers;
  std::array<std::optional<Request>, 4> requests;
  unsigned firstRequestCount = 0;
  unsigned packetCount = 0;
};

std::vector<std::string> fields(const std::string& candidate) {
  std::istringstream input(candidate);
  std::vector<std::string> result;
  for (std::string field; input >> field;) result.push_back(field);
  return result;
}

bool serverReflexive(const Event& event) {
  return !event.complete && event.candidate.find(" typ srflx") != std::string::npos;
}

void runScenario(bool dualStack) {
  const std::string name = dualStack ? "interleaved-ipv6-first-transmission" : "reverse-ipv4-replies-final-error";
  Fixture fixture(dualStack);
  UdpSocket forgedSource;
  Events events;
  juice_config_t config{};
  config.concurrency_mode = JUICE_CONCURRENCY_MODE_POLL;
  config.bind_address = dualStack ? nullptr : "127.0.0.1";
  config.cb_candidate = &Events::candidateCallback;
  config.cb_gathering_done = &Events::completeCallback;
  config.user_ptr = &events;
  config.stun_servers_count = 4;
  config.enable_port_prediction = true;
  for (unsigned index = 0; index < fixture.servers.size(); ++index) {
    config.stun_servers[index].host = fixture.servers[index]->ipv6() ? "::1" : "127.0.0.1";
    config.stun_servers[index].port = static_cast<std::uint16_t>(fixture.servers[index]->port());
  }
  std::unique_ptr<juice_agent_t, decltype(&juice_destroy)> agent(juice_create(&config), &juice_destroy);
  require(agent != nullptr, name + ": juice_create failed");
  require(juice_gather_candidates(agent.get()) == JUICE_ERR_SUCCESS, name + ": gather failed");
  auto deadline = std::chrono::steady_clock::now() + 1300ms;
  while (fixture.firstRequestCount < 4 && std::chrono::steady_clock::now() < deadline) fixture.drain(20ms);
  require(fixture.firstRequestCount == 4, name + ": did not sample all targets");
  std::set<unsigned> sourcePorts;
  for (const auto& request : fixture.requests) sourcePorts.insert(portOf(request->source));
  require(sourcePorts.size() == 1, name + ": STUN targets used different UDP source ports");

  const auto& first = *fixture.requests[0];
  forgedSource.send(success(first.transaction, 65000), first.source);
  Transaction wrongTransaction = first.transaction;
  wrongTransaction[0] ^= 0x80;
  fixture.servers[0]->send(success(wrongTransaction, 65001), first.source);
  fixture.servers[0]->send(success(first.transaction, 0), first.source);
  fixture.servers[0]->send(success(first.transaction, 65002, "0.0.0.0"), first.source);
  fixture.drain(120ms);
  const auto afterInvalid = events.snapshot();
  require(std::none_of(afterInvalid.begin(), afterInvalid.end(), serverReflexive),
          name + ": invalid response emitted a candidate");

  std::vector<unsigned> validIndices;
  for (unsigned index = 0; index < fixture.servers.size() && validIndices.size() < 3; ++index)
    if (!fixture.servers[index]->ipv6()) validIndices.push_back(index);
  std::sort(validIndices.begin(), validIndices.end(), [&](unsigned left, unsigned right) {
    return fixture.requests[left]->receiveOrder < fixture.requests[right]->receiveOrder;
  });
  // Send success replies in reverse first-send order, then complete the final target.
  for (int index = 2; index >= 0; --index) {
    const unsigned target = validIndices[static_cast<std::size_t>(index)];
    const auto& request = *fixture.requests[target];
    fixture.servers[target]->send(success(request.transaction, 42000u + index), request.source);
  }
  if (dualStack) {
    const auto& request = *fixture.requests[1];
    fixture.servers[1]->send(success(request.transaction, 43000, "2001:db8::9", true), request.source);
  } else {
    const auto& request = *fixture.requests[3];
    fixture.servers[3]->send(error(request.transaction), request.source);
  }
  deadline = std::chrono::steady_clock::now() + 1000ms;
  while (!events.complete && std::chrono::steady_clock::now() < deadline) fixture.drain(20ms);
  require(events.complete, name + ": final response did not finish gathering");
  fixture.drain(100ms);
  const auto completed = events.snapshot();
  unsigned genuine = 0;
  unsigned predicted = 0;
  bool sawComplete = false;
  bool sawPredicted = false;
  std::vector<unsigned> replyPorts;
  std::vector<unsigned> predictedPorts;
  for (const auto& event : completed) {
    if (event.complete) {
      require(!sawComplete, name + ": duplicate complete callback");
      sawComplete = true;
      continue;
    }
    require(!sawComplete, name + ": candidate emitted after complete");
    require(event.candidate.find(" ufrag ") != std::string::npos, name + ": candidate lost ICE credentials");
    if (!serverReflexive(event)) continue;
    const auto parts = fields(event.candidate);
    require(parts.size() >= 8, name + ": invalid candidate fields");
    if (event.candidate.find("vds-predicted 1") != std::string::npos) {
      sawPredicted = true;
      ++predicted;
      require(event.candidate.find("vds-nat-step 1") != std::string::npos &&
              event.candidate.find("vds-probe-index 3") != std::string::npos,
              name + ": reply order or IPv6 polluted linear prediction");
      predictedPorts.push_back(static_cast<unsigned>(std::stoul(parts[5])));
    } else {
      require(!sawPredicted, name + ": genuine address confirmation followed prediction");
      ++genuine;
      if (parts[4] == "203.0.113.9") replyPorts.push_back(static_cast<unsigned>(std::stoul(parts[5])));
    }
  }
  require(genuine == (dualStack ? 4u : 3u), name + ": invalid response was adopted or real mapping missing");
  require(replyPorts == std::vector<unsigned>{42002, 42001, 42000}, name + ": reverse reply order not exercised");
  require(predicted > 0 && predicted <= 16, name + ": speculative candidate budget incorrect");
  require(predictedPorts == std::vector<unsigned>{42003, 42004, 42005, 42006, 42007},
          name + ": incorrect sequential prediction ports");
  require(sawComplete, name + ": missing complete callback");
  if (!dualStack) {
    const auto& request = *fixture.requests[3];
    fixture.servers[3]->send(success(request.transaction, 55000), request.source);
    fixture.drain(200ms);
    const auto late = events.snapshot();
    require(late.size() == completed.size(), name + ": failed transaction adopted a late response");
  }

  agent.reset();
  fixture.drain(50ms);
  const unsigned packetsAtClose = fixture.packetCount;
  fixture.drain(400ms);
  require(fixture.packetCount == packetsAtClose, name + ": closed transport kept sending probes");
  std::cout << "PASS " << name << ": same UDP source, four invalid responses rejected, reverse order "
            << "step=1, genuine=" << genuine << ", predicted=" << predicted
            << ", candidates before complete, close stopped packets" << std::endl;
}

} // namespace

int main() {
  try {
    Winsock winsock;
    juice_set_log_level(JUICE_LOG_LEVEL_NONE);
    runScenario(false);
    runScenario(true);
    std::cout << "PASS native STUN packet validation, final failure/late response, IPv6 sampling separation" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL libjuice STUN probe regression: " << error.what() << std::endl;
    return 1;
  }
}
