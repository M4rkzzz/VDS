// Real libdatachannel DTLS/SCTP over a finite, endpoint-dependent virtual NAT.
// All addresses and sockets are loopback; this test never contacts a public
// STUN server or modifies a router. STUN reports the mappings created by the
// fixture, and packets are delivered only through mappings which already exist.
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>

#include <rtc/rtc.hpp>

#if !defined(RTC_VDS_ENHANCED_ICE) || RTC_VDS_ENHANCED_ICE != 1
#error This integration test must link the pinned VDS enhanced ICE build.
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
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

sockaddr_in address(const std::string& host, std::uint16_t port) {
  sockaddr_in result{};
  result.sin_family = AF_INET;
  result.sin_port = htons(port);
  require(inet_pton(AF_INET, host.c_str(), &result.sin_addr) == 1, "invalid fixture address");
  return result;
}

std::string addressKey(const sockaddr_in& value) {
  return std::to_string(ntohl(value.sin_addr.s_addr)) + ":" + std::to_string(ntohs(value.sin_port));
}

bool sameAddress(const sockaddr_in& left, const sockaddr_in& right) {
  return left.sin_addr.s_addr == right.sin_addr.s_addr && left.sin_port == right.sin_port;
}

struct UdpSocket {
  SOCKET handle = INVALID_SOCKET;
  sockaddr_in bound{};
  explicit UdpSocket(const sockaddr_in& endpoint) {
    handle = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (handle == INVALID_SOCKET) throw std::runtime_error("socket failed");
    if (bind(handle, reinterpret_cast<const sockaddr*>(&endpoint), sizeof(endpoint)) != 0) {
      closesocket(handle);
      handle = INVALID_SOCKET;
      throw std::runtime_error("fixture UDP bind failed");
    }
    int size = sizeof(bound);
    require(getsockname(handle, reinterpret_cast<sockaddr*>(&bound), &size) == 0,
            "getsockname failed");
    u_long nonblocking = 1;
    require(ioctlsocket(handle, FIONBIO, &nonblocking) == 0, "nonblocking failed");
  }
  ~UdpSocket() { if (handle != INVALID_SOCKET) closesocket(handle); }
  UdpSocket(const UdpSocket&) = delete;
  UdpSocket& operator=(const UdpSocket&) = delete;
  void send(const unsigned char* data, int size, const sockaddr_in& destination) {
    const int sent = sendto(handle, reinterpret_cast<const char*>(data), size, 0,
                            reinterpret_cast<const sockaddr*>(&destination), sizeof(destination));
    require(sent == size, "fixture UDP send failed");
  }
};

std::uint16_t availableInternalPort() {
  UdpSocket reservation(address("127.0.0.1", 0));
  return ntohs(reservation.bound.sin_port);
}

enum class MappingPattern { Sequential, Noisy, NearbyAfterNoisySamples, OutsidePredictionBudget };

struct FixtureSnapshot {
  std::array<std::set<unsigned>, 2> internalPorts;
  std::array<std::set<unsigned>, 2> sampledTargets;
  std::array<std::set<unsigned>, 2> checkedExternalPorts;
  std::array<unsigned, 2> mappingCount{};
  unsigned internalDatagrams = 0;
  unsigned stunRequests = 0;
  unsigned publicDatagrams = 0;
  unsigned forwardedDatagrams = 0;
  unsigned unmappedDrops = 0;
  unsigned filteringDrops = 0;
  unsigned outOfPoolDrops = 0;
};

class VirtualNat {
 public:
  static constexpr unsigned kPortPool = 128;
  static constexpr unsigned kAllocationStart = 8;
  explicit VirtualNat(MappingPattern pattern, bool firstIndependentFiltering = false)
      : pattern_(pattern), independentFiltering_{firstIndependentFiltering, false} {
    internal_[0] = address("127.0.0.1", availableInternalPort());
    do { internal_[1] = address("127.0.0.1", availableInternalPort()); }
    while (internal_[1].sin_port == internal_[0].sin_port);
    for (unsigned index = 0; index < 4; ++index)
      stun_.push_back(std::make_unique<UdpSocket>(address("127.0.0.1", 0)));
    // Bind the entire finite pool so an unmapped predicted port can receive a
    // packet and be dropped. Receiving never invents a destination mapping.
    for (unsigned attempt = 0; attempt < 100; ++attempt) {
      const unsigned base = 30000 + ((GetCurrentProcessId() * 13 + attempt * 137) % 20000);
      try {
        for (unsigned side = 0; side < 2; ++side) {
          const std::string host = side == 0 ? "127.0.0.2" : "127.0.0.3";
          for (unsigned index = 0; index < kPortPool; ++index)
            external_[side].push_back(std::make_unique<UdpSocket>(
                address(host, static_cast<std::uint16_t>(base + index))));
          mappings_[side].resize(kPortPool);
        }
        basePort_ = static_cast<std::uint16_t>(base);
        break;
      } catch (const std::exception&) {
        for (auto& sockets : external_) sockets.clear();
      }
    }
    require(basePort_ != 0, "could not bind finite virtual NAT port pool");
    worker_ = std::thread([this] { run(); });
  }
  ~VirtualNat() {
    stopping_ = true;
    if (worker_.joinable()) worker_.join();
  }
  std::uint16_t internalPort(unsigned side) const { return ntohs(internal_[side].sin_port); }
  std::uint16_t stunPort(unsigned index) const { return ntohs(stun_[index]->bound.sin_port); }
  std::uint16_t basePort() const { return basePort_ + kAllocationStart; }
  bool listensAtPort(unsigned port) const {
    return port >= basePort_ && port < basePort_ + kPortPool;
  }
  FixtureSnapshot snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!error_.empty()) throw std::runtime_error(error_);
    auto value = stats_;
    for (unsigned side = 0; side < 2; ++side) value.mappingCount[side] = nextMapping_[side];
    return value;
  }
  bool hasMapping(unsigned side, unsigned port) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return port >= basePort_ && port < basePort_ + kPortPool &&
           mappings_[side][port - basePort_].has_value();
  }
  std::string mappingTrace() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ostringstream output;
    for (unsigned side = 0; side < 2; ++side) {
      output << " NAT " << side << " base=" << basePort_;
      for (unsigned slot = 0; slot < kPortPool; ++slot)
        if (mappings_[side][slot])
          output << " [" << slot << "->" << addressKey(mappings_[side][slot]->remote) << "]";
    }
    return output.str();
  }

 private:
  struct Mapping { sockaddr_in remote{}; };
  int internalSide(const sockaddr_in& source) const {
    for (unsigned side = 0; side < 2; ++side) if (sameAddress(source, internal_[side])) return side;
    return -1;
  }
  std::optional<std::pair<unsigned, unsigned>> externalSource(const sockaddr_in& source) const {
    for (unsigned side = 0; side < 2; ++side) {
      if (source.sin_addr.s_addr != external_[side][0]->bound.sin_addr.s_addr) continue;
      const unsigned port = ntohs(source.sin_port);
      if (port < basePort_ || port >= basePort_ + kPortPool) return std::nullopt;
      const unsigned slot = port - basePort_;
      if (!mappings_[side][slot]) return std::nullopt;
      return std::make_pair(side, slot);
    }
    return std::nullopt;
  }
  std::optional<unsigned> createMapping(unsigned side, const sockaddr_in& remote) {
    const auto key = addressKey(remote);
    const auto found = byDestination_[side].find(key);
    if (found != byDestination_[side].end()) return found->second;
    const unsigned sequence = nextMapping_[side]++;
    unsigned slot = kAllocationStart + sequence;
    if (pattern_ == MappingPattern::Noisy || pattern_ == MappingPattern::NearbyAfterNoisySamples) {
      static constexpr unsigned initial[] = {0, 7, 2, 11};
      slot = kAllocationStart + (sequence < 4 ? initial[sequence] :
          (pattern_ == MappingPattern::NearbyAfterNoisySamples ? 8 + sequence : 32 + sequence));
    } else if (pattern_ == MappingPattern::OutsidePredictionBudget && sequence >= 4) {
      slot = kAllocationStart + 64 + sequence;
    }
    if (slot >= kPortPool || mappings_[side][slot]) {
      ++stats_.outOfPoolDrops;
      return std::nullopt;
    }
    mappings_[side][slot] = Mapping{remote};
    byDestination_[side].emplace(key, slot);
    return slot;
  }
  void observeInternal(unsigned side, const sockaddr_in& source) {
    stats_.internalPorts[side].insert(ntohs(source.sin_port));
    ++stats_.internalDatagrams;
  }
  void handleStun(unsigned endpoint, const unsigned char* data, int size, const sockaddr_in& source) {
    const int side = internalSide(source);
    if (side < 0 || size < 20 || data[0] != 0 || data[1] != 1 ||
        data[4] != 0x21 || data[5] != 0x12 || data[6] != 0xa4 || data[7] != 0x42) return;
    observeInternal(static_cast<unsigned>(side), source);
    ++stats_.stunRequests;
    stats_.sampledTargets[side].insert(endpoint);
    const auto slot = createMapping(static_cast<unsigned>(side), stun_[endpoint]->bound);
    if (!slot) return;
    std::array<unsigned char, 32> response{};
    response[0] = 1; response[1] = 1; response[3] = 12;
    std::copy(data + 4, data + 20, response.begin() + 4);
    response[20] = 0; response[21] = 0x20; response[23] = 8;
    response[25] = 1;
    const unsigned port = (basePort_ + *slot) ^ 0x2112;
    response[26] = static_cast<unsigned char>(port >> 8);
    response[27] = static_cast<unsigned char>(port);
    const std::uint32_t host = ntohl(external_[side][*slot]->bound.sin_addr.s_addr) ^ 0x2112a442;
    for (unsigned byte = 0; byte < 4; ++byte)
      response[28 + byte] = static_cast<unsigned char>(host >> (24 - 8 * byte));
    stun_[endpoint]->send(response.data(), static_cast<int>(response.size()), source);
  }
  void handleExternal(unsigned destinationSide, unsigned destinationSlot,
                      const unsigned char* data, int size, const sockaddr_in& source) {
    const int outgoingSide = internalSide(source);
    if (outgoingSide >= 0) {
      observeInternal(static_cast<unsigned>(outgoingSide), source);
      stats_.checkedExternalPorts[outgoingSide].insert(basePort_ + destinationSlot);
      // Outgoing NAT mapping must be allocated even when the destination public
      // port does not exist. This models the port consumption of failed checks.
      const auto slot = createMapping(static_cast<unsigned>(outgoingSide),
                                      external_[destinationSide][destinationSlot]->bound);
      if (slot) external_[outgoingSide][*slot]->send(data, size,
                         external_[destinationSide][destinationSlot]->bound);
      return;
    }
    const auto outgoing = externalSource(source);
    if (!outgoing) return;
    ++stats_.publicDatagrams;
    const auto& destination = mappings_[destinationSide][destinationSlot];
    if (!destination) { ++stats_.unmappedDrops; return; }
    if (!independentFiltering_[destinationSide] && !sameAddress(destination->remote, source)) {
      ++stats_.filteringDrops;
      return;
    }
    // Forward from the original source public socket, preserving the source
    // that the real ICE stack observes. The destination is the real agent UDP
    // socket; DTLS/SCTP and ICE authentication are never decoded or synthesized.
    external_[outgoing->first][outgoing->second]->send(data, size, internal_[destinationSide]);
    ++stats_.forwardedDatagrams;
  }
  void drain(UdpSocket& socket, const std::function<void(const unsigned char*, int, const sockaddr_in&)>& handle) {
    std::array<unsigned char, 65536> data{};
    for (unsigned count = 0; count < 64; ++count) {
      sockaddr_in source{};
      int addressSize = sizeof(source);
      const int size = recvfrom(socket.handle, reinterpret_cast<char*>(data.data()),
          static_cast<int>(data.size()), 0, reinterpret_cast<sockaddr*>(&source), &addressSize);
      if (size == SOCKET_ERROR) {
        const int error = WSAGetLastError();
        if (error == WSAEWOULDBLOCK || error == WSAECONNRESET) return;
        throw std::runtime_error("fixture recvfrom failed: " + std::to_string(error));
      }
      handle(data.data(), size, source);
    }
  }
  void run() {
    try {
      while (!stopping_) {
        {
          std::lock_guard<std::mutex> lock(mutex_);
          for (unsigned index = 0; index < stun_.size(); ++index)
            drain(*stun_[index], [&, index](const unsigned char* data, int size, const sockaddr_in& source) {
              handleStun(index, data, size, source);
            });
          for (unsigned side = 0; side < 2; ++side)
            for (unsigned slot = 0; slot < kPortPool; ++slot)
              drain(*external_[side][slot], [&, side, slot](const unsigned char* data, int size, const sockaddr_in& source) {
                handleExternal(side, slot, data, size, source);
              });
        }
        std::this_thread::sleep_for(1ms);
      }
    } catch (const std::exception& error) {
      std::lock_guard<std::mutex> lock(mutex_);
      error_ = error.what();
    }
  }

  MappingPattern pattern_;
  std::array<bool, 2> independentFiltering_{};
  std::array<sockaddr_in, 2> internal_{};
  std::vector<std::unique_ptr<UdpSocket>> stun_;
  std::array<std::vector<std::unique_ptr<UdpSocket>>, 2> external_;
  std::array<std::vector<std::optional<Mapping>>, 2> mappings_;
  std::array<std::map<std::string, unsigned>, 2> byDestination_;
  std::array<unsigned, 2> nextMapping_{};
  std::uint16_t basePort_ = 0;
  mutable std::mutex mutex_;
  FixtureSnapshot stats_;
  std::string error_;
  std::atomic<bool> stopping_{false};
  std::thread worker_;
};

rtc::Description withoutCandidates(const rtc::Description& value) {
  std::stringstream input(static_cast<std::string>(value));
  std::string output, line;
  while (std::getline(input, line)) {
    if (line.rfind("a=candidate:", 0) == 0 || line.rfind("a=end-of-candidates", 0) == 0) continue;
    output += line + "\n";
  }
  return rtc::Description(output, value.type());
}

struct Signaling {
  std::mutex mutex;
  std::array<std::vector<rtc::Description>, 2> descriptions;
  std::array<std::vector<rtc::Candidate>, 2> candidates;
  std::array<std::atomic<bool>, 2> gathered{};
  std::atomic<bool> echoed{false};
  std::atomic<bool> received{false};
  std::shared_ptr<rtc::DataChannel> remoteChannel;
};

struct ScenarioResult {
  std::string name;
  bool connected = false;
  unsigned predictions = 0;
  unsigned linearPredictions = 0;
  std::array<unsigned, 2> checkedPredictions{};
  unsigned candidates = 0;
  std::array<std::string, 2> selectedLocal;
  std::array<std::string, 2> selectedRemote;
  FixtureSnapshot fixture;
};

struct Cleanup {
  std::function<void()> action;
  ~Cleanup() {
    try { action(); } catch (...) { /* preserve the original test failure */ }
  }
};

ScenarioResult runScenario(const std::string& name, MappingPattern pattern, unsigned stunCount,
                           bool expectConnected, bool independentFiltering = false,
                           bool exchangePredictions = true, bool delayedPrediction = false) {
  VirtualNat fixture(pattern, independentFiltering);
  Signaling signaling;
  std::array<std::shared_ptr<rtc::PeerConnection>, 2> peers;
  rtc::binary payload(4096);
  for (std::size_t index = 0; index < payload.size(); ++index)
    payload[index] = static_cast<std::byte>((index * 37 + 11) & 255);
  for (unsigned side = 0; side < 2; ++side) {
    rtc::Configuration config;
    config.bindAddress = "127.0.0.1";
    config.enableIceTcp = false;
    config.portRangeBegin = fixture.internalPort(side);
    config.portRangeEnd = fixture.internalPort(side);
    for (unsigned index = 0; index < stunCount; ++index)
      config.iceServers.emplace_back("127.0.0.1", fixture.stunPort(index));
    peers[side] = std::make_shared<rtc::PeerConnection>(config);
    peers[side]->onLocalDescription([&, side](rtc::Description description) {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      signaling.descriptions[side].push_back(withoutCandidates(description));
    });
    peers[side]->onLocalCandidate([&, side](rtc::Candidate candidate) {
      // No host, relay, or TCP route can rescue this fixture.
      if (candidate.type() != rtc::Candidate::Type::ServerReflexive ||
          candidate.transportType() != rtc::Candidate::TransportType::Udp) return;
      // The baseline exposes exactly the standard single-STUN candidate set of
      // the previous engine. The patched library also supports a one-STUN
      // neighbor fallback, which is intentionally not signaled in that baseline.
      if (!exchangePredictions && candidate.candidate().find("vds-predicted 1") != std::string::npos) return;
      std::lock_guard<std::mutex> lock(signaling.mutex);
      signaling.candidates[side].push_back(candidate);
    });
    peers[side]->onGatheringStateChange([&, side](rtc::PeerConnection::GatheringState state) {
      if (state == rtc::PeerConnection::GatheringState::Complete) signaling.gathered[side] = true;
    });
  }
  peers[1]->onDataChannel([&](std::shared_ptr<rtc::DataChannel> channel) {
    {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      signaling.remoteChannel = channel;
    }
    const std::weak_ptr<rtc::DataChannel> weak = channel;
    channel->onMessage([&, weak](rtc::message_variant message) {
      const auto bytes = std::get_if<rtc::binary>(&message);
      if (!bytes || *bytes != payload) return;
      signaling.received = true;
      if (const auto active = weak.lock()) active->send(payload);
    });
  });
  const auto channel = peers[0]->createDataChannel("finite-nat-real-dtls-sctp");
  channel->onMessage([&](rtc::message_variant message) {
    if (const auto bytes = std::get_if<rtc::binary>(&message); bytes && *bytes == payload)
      signaling.echoed = true;
  });
  Cleanup cleanup{[&] {
    channel->resetCallbacks();
    for (auto& peer : peers) peer->resetCallbacks();
    {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      if (signaling.remoteChannel) signaling.remoteChannel->resetCallbacks();
    }
    for (auto& peer : peers) peer->close();
    std::this_thread::sleep_for(100ms);
  }};

  bool candidatesExchanged = false;
  bool predictionsPending = false;
  bool sent = false;
  std::array<std::set<unsigned>, 2> predictedCandidatePorts;
  std::array<std::vector<rtc::Candidate>, 2> deferredPredictions;
  std::chrono::steady_clock::time_point sendPredictionsAt;
  ScenarioResult result;
  result.name = name;
  const auto deadline = std::chrono::steady_clock::now() + (expectConnected ? 12s : 4s);
  while (std::chrono::steady_clock::now() < deadline && !signaling.echoed) {
    std::array<std::vector<rtc::Description>, 2> descriptions;
    {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      for (unsigned side = 0; side < 2; ++side) descriptions[side].swap(signaling.descriptions[side]);
    }
    for (unsigned side = 0; side < 2; ++side)
      for (auto& description : descriptions[side]) peers[1 - side]->setRemoteDescription(description);
    if (!candidatesExchanged && signaling.gathered[0] && signaling.gathered[1]) {
      std::array<std::vector<rtc::Candidate>, 2> candidates;
      {
        std::lock_guard<std::mutex> lock(signaling.mutex);
        candidates = signaling.candidates;
      }
      for (unsigned side = 0; side < 2; ++side) {
        const auto& set = candidates[side];
        require(!set.empty(), name + ": no real STUN candidates");
        unsigned realSamples = 0;
        for (auto candidate : set) {
          ++result.candidates;
          candidate.resolve();
          require(candidate.port() && fixture.listensAtPort(*candidate.port()),
                  name + ": an emitted remote candidate port bypasses the virtual NAT listener pool");
          if (candidate.candidate().find("vds-predicted 1") != std::string::npos) {
            ++result.predictions;
            const auto text = candidate.candidate();
            const auto marker = text.find("vds-nat-step ");
            if (marker != std::string::npos && std::stoi(text.substr(marker + 13)) != 0)
              ++result.linearPredictions;
            candidate.resolve();
            require(candidate.port().has_value(), name + ": predicted port missing");
            predictedCandidatePorts[side].insert(*candidate.port());
          } else { ++realSamples; }
        }
        require(realSamples == stunCount,
                name + ": gathering completed before the confirmed STUN candidates were emitted");
      }
      // Interleave both endpoints' candidates to let both real ICE agents punch
      // concurrently. This does not open or forward any virtual NAT mapping.
      for (std::size_t index = 0; index < std::max(candidates[0].size(), candidates[1].size()); ++index)
        for (unsigned side = 0; side < 2; ++side)
          if (index < candidates[side].size()) {
            const auto& candidate = candidates[side][index];
            if (delayedPrediction && candidate.candidate().find("vds-predicted 1") != std::string::npos)
              deferredPredictions[side].push_back(candidate);
            else peers[1 - side]->addRemoteCandidate(candidate);
          }
      if (delayedPrediction) {
        predictionsPending = true;
        sendPredictionsAt = std::chrono::steady_clock::now() + 100ms;
      }
      candidatesExchanged = true;
    }
    if (predictionsPending && std::chrono::steady_clock::now() >= sendPredictionsAt) {
      const auto beforePredictions = fixture.snapshot();
      for (unsigned side = 0; side < 2; ++side)
        require(beforePredictions.checkedExternalPorts[side].empty(),
                name + ": ordinary checks consumed NAT ports during the trickle grace period");
      for (std::size_t index = 0; index < std::max(deferredPredictions[0].size(), deferredPredictions[1].size()); ++index)
        for (unsigned side = 0; side < 2; ++side)
          if (index < deferredPredictions[side].size())
            peers[1 - side]->addRemoteCandidate(deferredPredictions[side][index]);
      predictionsPending = false;
    }
    if (!sent && channel->isOpen()) { channel->send(payload); sent = true; }
    fixture.snapshot(); // surface worker failures promptly
    std::this_thread::sleep_for(5ms);
  }
  result.connected = signaling.received && signaling.echoed;
  require(candidatesExchanged, name + ": gathering/signaling never completed");
  if (result.connected != expectConnected) {
    std::cerr << "TRACE " << name << fixture.mappingTrace() << std::endl;
    std::lock_guard<std::mutex> lock(signaling.mutex);
    for (unsigned side = 0; side < 2; ++side)
      for (const auto& candidate : signaling.candidates[side])
        std::cerr << "candidate " << side << " " << candidate.candidate() << std::endl;
  }
  require(result.connected == expectConnected, name + ": unexpected real DataChannel result");
  if (result.connected) {
    for (unsigned side = 0; side < 2; ++side) {
      rtc::Candidate local, remote;
      require(peers[side]->getSelectedCandidatePair(&local, &remote), name + ": missing selected pair");
      require(local.type() != rtc::Candidate::Type::Relayed && remote.type() != rtc::Candidate::Type::Relayed,
              name + ": selected relay candidate");
      remote.resolve();
      require(remote.address() && *remote.address() == (side == 0 ? "127.0.0.3" : "127.0.0.2") &&
              remote.port() && fixture.hasMapping(1 - side, *remote.port()),
              name + ": selected pair did not use an actual external NAT mapping");
      result.selectedLocal[side] = local.candidate();
      result.selectedRemote[side] = remote.candidate();
    }
    require(result.predictions > 0, name + ": connected without predicted candidates");
  }
  if (pattern == MappingPattern::OutsidePredictionBudget) {
    const auto exhausted = fixture.snapshot();
    std::this_thread::sleep_for(600ms);
    const auto later = fixture.snapshot();
    require(exhausted.mappingCount == later.mappingCount &&
            exhausted.checkedExternalPorts == later.checkedExternalPorts,
            name + ": exhausted prediction policy kept opening new endpoints");
    // Normal ICE may still retransmit authenticated checks until its timeout;
    // it may not expand the finite candidate/port search after exhaustion.
  }
  channel->resetCallbacks();
  peers[0]->close();
  peers[1]->close();
  std::this_thread::sleep_for(700ms); // drain packets issued before close
  const auto afterClose = fixture.snapshot();
  std::this_thread::sleep_for(350ms);
  result.fixture = fixture.snapshot();
  require(afterClose.internalDatagrams == result.fixture.internalDatagrams &&
          afterClose.stunRequests == result.fixture.stunRequests,
          name + ": closed ICE agent kept sending enhanced probes/checks");
  for (unsigned side = 0; side < 2; ++side) {
    for (const unsigned target : result.fixture.checkedExternalPorts[side])
      if (predictedCandidatePorts[1 - side].count(target)) ++result.checkedPredictions[side];
    require(result.fixture.internalPorts[side].size() == 1 &&
            *result.fixture.internalPorts[side].begin() == fixture.internalPort(side),
            name + ": STUN and ICE did not share the real agent UDP source port");
    require(result.fixture.sampledTargets[side].size() == stunCount,
            name + ": did not sample every configured STUN target");
    require(result.fixture.mappingCount[side] <= VirtualNat::kPortPool,
            name + ": exceeded finite mapping budget");
  }
  require(result.predictions <= 32, name + ": exceeded 16 predictions per endpoint");
  require(result.fixture.internalDatagrams < 4000, name + ": unbounded ICE packet budget");
  peers[0]->resetCallbacks();
  peers[1]->resetCallbacks();
  {
    std::lock_guard<std::mutex> lock(signaling.mutex);
    if (signaling.remoteChannel) signaling.remoteChannel->resetCallbacks();
  }
  return result;
}

void printResult(const ScenarioResult& result) {
  std::cout << "{\"scenario\":\"" << result.name << "\",\"connected\":"
            << (result.connected ? "true" : "false") << ",\"predictions\":" << result.predictions
            << ",\"linearPredictions\":" << result.linearPredictions
            << ",\"checkedPredictedPorts\":[" << result.checkedPredictions[0]
            << "," << result.checkedPredictions[1] << "]"
            << ",\"candidates\":" << result.candidates
            << ",\"stunRequests\":" << result.fixture.stunRequests
            << ",\"internalDatagrams\":" << result.fixture.internalDatagrams
            << ",\"forwardedDatagrams\":" << result.fixture.forwardedDatagrams
            << ",\"unmappedDrops\":" << result.fixture.unmappedDrops
            << ",\"filteringDrops\":" << result.fixture.filteringDrops << "}" << std::endl;
  if (result.connected)
    for (unsigned side = 0; side < 2; ++side)
      std::cout << "selected " << side << " local=" << result.selectedLocal[side]
                << " remote=" << result.selectedRemote[side] << std::endl;
}

void testBackendPredictionLimit() {
  rtc::Configuration config;
  config.bindAddress = "127.0.0.1";
  config.disableAutoGathering = true;
  config.disableAutoNegotiation = true;
  auto sender = std::make_shared<rtc::PeerConnection>(config);
  auto receiver = std::make_shared<rtc::PeerConnection>(config);
  const auto channel = sender->createDataChannel("backend-limit-no-public-network");
  Cleanup cleanup{[&] {
    channel->resetCallbacks();
    sender->resetCallbacks();
    receiver->resetCallbacks();
    sender->close();
    receiver->close();
    std::this_thread::sleep_for(100ms);
  }};
  sender->setLocalDescription(rtc::Description::Type::Offer);
  const auto offer = sender->localDescription();
  require(offer.has_value(), "backend limit: no local offer");
  const auto description = withoutCandidates(*offer);
  const auto sdp = static_cast<std::string>(description);
  const auto start = sdp.find("a=ice-ufrag:");
  require(start != std::string::npos, "backend limit: no ICE ufrag");
  const auto end = sdp.find_first_of("\r\n", start + 12);
  const auto ufrag = sdp.substr(start + 12, end - start - 12);
  receiver->setRemoteDescription(description);
  receiver->setLocalDescription(rtc::Description::Type::Answer);
  for (unsigned index = 0; index < 16; ++index) {
    const std::string candidate = "candidate:vds" + std::to_string(index) +
        " 1 UDP 1358954495 127.0.0.3 " + std::to_string(42000 + index) +
        " typ srflx raddr 0.0.0.0 rport 0 vds-predicted 1 vds-nat-step 1 "
        "vds-probe-index 4 vds-probe-count 4 ufrag " + ufrag;
    receiver->addRemoteCandidate(rtc::Candidate(candidate, "0"));
  }
  const auto acceptedDescription = receiver->remoteDescription();
  require(acceptedDescription && static_cast<std::string>(*acceptedDescription).find("candidate:vds15 ") != std::string::npos,
          "backend limit: valid candidate was not recorded");
  const std::string rejected = "candidate:vds16 1 UDP 1358954495 127.0.0.3 42016 "
      "typ srflx raddr 0.0.0.0 rport 0 vds-predicted 1 vds-nat-step 1 "
      "vds-probe-index 4 vds-probe-count 4 ufrag " + ufrag;
  for (unsigned retry = 0; retry < 2; ++retry) {
    bool threw = false;
    try { receiver->addRemoteCandidate(rtc::Candidate(rejected, "0")); }
    catch (const std::exception&) { threw = true; }
    require(threw, "backend limit: excess prediction was accepted or cached as a success");
    const auto current = receiver->remoteDescription();
    require(current && static_cast<std::string>(*current).find("candidate:vds16 ") == std::string::npos,
            "backend limit: rejected candidate polluted remote description");
  }
  std::cout << "PASS backend rejects prediction 17, retry still fails, remote SDP stays unchanged" << std::endl;
}

} // namespace

int main() {
  try {
    Winsock winsock;
    rtc::InitLogger(rtc::LogLevel::Warning);
    // Both endpoints have destination-dependent mapping. Endpoint A permits
    // incoming traffic from any source on existing mappings, B filters by the
    // exact endpoint to which its mapping was opened. Host candidates are never
    // exchanged. Standard single-STUN candidates do not expose the next peer
    // mapping; enhanced one-STUN neighbors may guess it within their budget.
    printResult(runScenario("single-stun-standard-ice-baseline", MappingPattern::Sequential, 1, false, true, false));
    printResult(runScenario("single-stun-neighbor-finite-miss", MappingPattern::Sequential, 1, false, true));
    printResult(runScenario("sequential-prediction-real-datachannel", MappingPattern::Sequential, 4, true, true));
    printResult(runScenario("sequential-trickle-delayed-prediction", MappingPattern::Sequential, 4, true, true, true, true));
    printResult(runScenario("sequential-both-exact-endpoint-filtering", MappingPattern::Sequential, 4, true, false));
    const auto nearby = runScenario("nonlinear-neighbor-finite-miss", MappingPattern::NearbyAfterNoisySamples, 4, false, true);
    require(nearby.linearPredictions == 0, "neighbor miss falsely used a linear NAT step");
    printResult(nearby);
    const auto noisy = runScenario("nonlinear-port-no-false-linear-prediction", MappingPattern::Noisy, 4, false, true);
    require(noisy.linearPredictions == 0, "noisy NAT was falsely classified as sequential");
    printResult(noisy);
    const auto exhausted = runScenario("outside-finite-prediction-budget", MappingPattern::OutsidePredictionBudget, 4, false, true);
    require(exhausted.checkedPredictions[0] >= 2 && exhausted.checkedPredictions[1] >= 2,
            "finite multi-port policy did not send real checks to multiple predicted ports");
    printResult(exhausted);
    testBackendPredictionLimit();
    std::cout << "PASS finite NAT real ICE/DTLS/SCTP, strict source socket, bounded probes, close cancellation" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL nat traversal E2E: " << error.what() << std::endl;
    return 1;
  }
}
