// Real libdatachannel DTLS/SCTP over a finite, endpoint-dependent virtual NAT.
// All addresses and sockets are loopback; this test never contacts a public
// STUN server or modifies a router. STUN reports the mappings created by the
// fixture, and packets are delivered only through mappings which already exist.
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>

#include <rtc/rtc.hpp>

#ifdef VDS_TEST_FULL_EGRESS
extern "C" __declspec(dllimport) void vds_test_egress_configure(unsigned short port);
extern "C" __declspec(dllimport) unsigned long long vds_test_egress_sent(void);
extern "C" __declspec(dllimport) int vds_test_egress_send(SOCKET socket, unsigned long ip, unsigned short port);
#endif

#ifdef VDS_TEST_SEEDED_PLANNER
extern "C" __declspec(dllimport) void vds_test_plan_seed_configure(unsigned seed);
extern "C" __declspec(dllimport) unsigned vds_test_plan_seed_calls(void);
#endif

#if !defined(RTC_VDS_ENHANCED_ICE) || RTC_VDS_ENHANCED_ICE != 1
#error This integration test must link the pinned VDS enhanced ICE build.
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
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

// Preserve the STUN framing/fingerprint so this fault reaches short-term
// MESSAGE-INTEGRITY verification, rather than only testing CRC rejection.
void damageStunIntegrity(std::vector<unsigned char>& packet) {
  bool damaged = false;
  for (size_t at = 20; at + 4 <= packet.size();) {
    const unsigned type = (packet[at] << 8) | packet[at + 1];
    const unsigned length = (packet[at + 2] << 8) | packet[at + 3];
    require(at + 4 + length <= packet.size(), "fixture received truncated STUN attribute");
    if ((type == 0x0008 && length == 20) || (type == 0x001c && length == 32)) {
      packet[at + 4] ^= 1;
      damaged = true;
    }
    if (type == 0x8028) {
      require(damaged && length == 4 && at + 8 == packet.size(), "fixture needs integrity then fingerprint");
      uint32_t crc = 0xffffffffu;
      for (size_t index = 0; index < at; ++index) {
        crc ^= packet[index];
        for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0);
      }
      const uint32_t fingerprint = (crc ^ 0xffffffffu) ^ 0x5354554eu;
      for (unsigned byte = 0; byte < 4; ++byte)
        packet[at + 4 + byte] = static_cast<unsigned char>(fingerprint >> (24 - 8 * byte));
      return;
    }
    at += 4 + ((length + 3u) & ~3u);
  }
  throw std::runtime_error("fixture STUN message lacks fingerprint");
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

// Failure-only evidence: a rebind error alone cannot distinguish a leaked
// socket from another process taking the port or an OS port reservation.
// Do not weaken the release assertion or extend its deadline on these errors.
struct UdpPortOwners {
  bool queried = false, own = false, foreign = false;
  std::string details;
};
UdpPortOwners udpPortOwners(unsigned side, unsigned port) {
  const auto module = LoadLibraryExW(L"iphlpapi.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!module) return {false, false, false, " owner-query-load-error=" + std::to_string(GetLastError())};
  const auto query = reinterpret_cast<decltype(&GetExtendedUdpTable)>(GetProcAddress(module, "GetExtendedUdpTable"));
  if (!query) { FreeLibrary(module); return {false, false, false, " owner-query-function-unavailable"}; }
  ULONG size = 0;
  DWORD status = query(nullptr, &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0);
  std::vector<unsigned char> buffer(size);
  if (status == ERROR_INSUFFICIENT_BUFFER)
    status = query(buffer.data(), &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0);
  FreeLibrary(module);
  if (status != NO_ERROR || buffer.size() < sizeof(DWORD))
    return {false, false, false, " owner-query-error=" + std::to_string(status)};
  const auto table = reinterpret_cast<const MIB_UDPTABLE_OWNER_PID*>(buffer.data());
  if (table->dwNumEntries > (buffer.size() - offsetof(MIB_UDPTABLE_OWNER_PID, table)) / sizeof(MIB_UDPROW_OWNER_PID))
    return {false, false, false, " owner-query-truncated"};
  const auto local = address(side ? "127.0.0.11" : "127.0.0.10", static_cast<uint16_t>(port));
  UdpPortOwners owners{true, false, false, {}};
  std::ostringstream output;
  output << " currentPid=" << GetCurrentProcessId() << " owners=[";
  for (DWORD i = 0; i < table->dwNumEntries; ++i) {
    const auto& row = table->table[i];
    if (ntohs(static_cast<u_short>(row.dwLocalPort)) == port &&
        (row.dwLocalAddr == INADDR_ANY || row.dwLocalAddr == local.sin_addr.s_addr)) {
      output << "{pid=" << row.dwOwningPid << ",address=" << ntohl(row.dwLocalAddr) << "}";
      if (row.dwOwningPid == GetCurrentProcessId()) owners.own = true;
      else if (row.dwOwningPid) owners.foreign = true;
    }
  }
  output << ']';
  owners.details = output.str();
  return owners;
}

struct UdpSocket {
  SOCKET handle = INVALID_SOCKET;
  sockaddr_in bound{};
  explicit UdpSocket(const sockaddr_in& endpoint) {
    handle = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (handle == INVALID_SOCKET) throw std::runtime_error("socket failed");
    if (bind(handle, reinterpret_cast<const sockaddr*>(&endpoint), sizeof(endpoint)) != 0) {
      const int error = WSAGetLastError();
      closesocket(handle);
      handle = INVALID_SOCKET;
      throw std::runtime_error("fixture UDP bind failed: endpoint=" + addressKey(endpoint) + " error=" + std::to_string(error));
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

enum class MappingPattern { Sequential, Noisy, NearbyAfterNoisySamples, OutsidePredictionBudget, Random };

struct FixtureSnapshot {
  std::array<std::set<unsigned>, 2> internalPorts;
  std::array<std::set<unsigned>, 2> sampledTargets;
  std::array<std::set<unsigned>, 2> checkedExternalPorts;
  std::array<unsigned, 2> mappingCount{};
  unsigned internalDatagrams = 0;
  bool fullEgress = false;
  unsigned egressPackets = 0;
  std::array<unsigned, 2> outsidePackets{}, outsideAllocations{};
  std::array<unsigned, 2> primaryInternalPorts{};
  unsigned stunRequests = 0;
  unsigned publicDatagrams = 0;
  unsigned forwardedDatagrams = 0;
  unsigned heldIceResponses = 0;
  unsigned clientHellos = 0;
  int64_t firstClientHelloAtMs = 0;
  std::array<int64_t, 2> firstPeerPacketAtMs{};
  std::array<unsigned, 2> dtlsPackets{};
  unsigned unmappedDrops = 0;
  unsigned filteringDrops = 0;
  unsigned corruptedPackets = 0;
  unsigned corruptedIntegrityPackets = 0;
  unsigned outOfPoolDrops = 0;
  std::array<std::set<unsigned>, 2> deadExitSources;
  std::array<unsigned, 2> mappedDestinations{};
  unsigned reciprocalMappings = 0;
  std::array<std::set<std::string>, 2> checkedExternalEndpoints;
  unsigned outageDrops = 0;
  unsigned primaryPathDrops = 0;
  unsigned droppedStunResponses = 0;
  unsigned heldStunResponses = 0;
  unsigned heldNominationRequests = 0;
  std::array<int64_t, 2> firstAuxiliaryAtMs{};
  std::array<int64_t, 2> firstNovelTargetAtMs{};
  std::array<std::set<unsigned>, 2> firstPlanHypotheses, secondPlanHypotheses, repeatedPlanHypotheses;
  std::array<std::set<std::string>, 2> firstPlanSourceTargets, repeatedSameSourceTargets, repeatedNewSourceTargets;
};

class VirtualNat {
 public:
  static constexpr unsigned kPortPool = 256;
  static constexpr unsigned kAllocationStart = 8;
  explicit VirtualNat(MappingPattern pattern, bool firstIndependentFiltering = false, unsigned seed = 1, bool corrupt = false, bool stableFirst = false, bool blackhole = false, bool pacedRecovery = false, bool earlyHandshake = false, bool latePath = false, unsigned respondingStun = 4, bool lateStun = false, bool exportSdp = false, bool delayedNomination = false, unsigned allocationOffset = 0, bool addressDependent = false, bool historyCheck = false, bool standardPeer = false)
      : standard_peer_(standardPeer), history_check_(historyCheck), address_dependent_(addressDependent), delayed_nomination_(delayedNomination), responding_stun_(respondingStun), late_stun_(lateStun), export_sdp_(exportSdp), late_path_(latePath), early_handshake_(earlyHandshake), paced_recovery_(pacedRecovery), stable_first_(stableFirst), corrupt_(corrupt), blackhole_(blackhole), pattern_(pattern), independentFiltering_{firstIndependentFiltering, false} {
    dead_exit_ = std::make_unique<UdpSocket>(address("127.0.0.4", 0));
    for (unsigned side = 0; side < 2; ++side) {
      for (unsigned i = 0; i < kPortPool; ++i) randomSlots_[side][i] = i;
      std::mt19937 random(seed * 31 + side);
      std::shuffle(randomSlots_[side].begin(), randomSlots_[side].end(), random);
    }
    internal_[0] = address("127.0.0.1", availableInternalPort());
    do { internal_[1] = address("127.0.0.1", availableInternalPort()); }
    while (internal_[1].sin_port == internal_[0].sin_port);
    for (unsigned index = 0; index < 4; ++index)
      stun_.push_back(std::make_unique<UdpSocket>(address(stunHost(index), 0)));
    // Bind the entire finite pool so an unmapped predicted port can receive a
    // packet and be dropped. Receiving never invents a destination mapping.
    for (unsigned attempt = 0; attempt <
#ifdef VDS_TEST_SEEDED_PLANNER
         1; ++attempt) {
      // A different public-port pool changes global guesses. Fail on a busy
      // fixture pool instead of silently comparing a different network.
      const unsigned rawBase = 32768;
#else
         100; ++attempt) {
      const unsigned rawBase = 30000 + ((GetCurrentProcessId() * 13 + attempt * 137) % 20000);
#endif
      const unsigned base = pattern_ == MappingPattern::Random ? rawBase / 256 * 256 + allocationOffset : rawBase;
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
#ifdef VDS_TEST_SEEDED_PLANNER
    std::cout << "FIXED-NAT-POOL base=" << basePort_ << " width=" << kPortPool << std::endl;
#endif
    if (pattern_ == MappingPattern::Random) {
      internal_[0].sin_addr = address("127.0.0.10", 0).sin_addr;
      internal_[1].sin_addr = address("127.0.0.11", 0).sin_addr;
    }
#ifdef VDS_TEST_FULL_EGRESS
    egress_ = std::make_unique<UdpSocket>(address("127.0.0.1", 0));
    stats_.fullEgress = true;
    vds_test_egress_configure(ntohs(egress_->bound.sin_port));
#endif
    worker_ = std::thread([this] { run(); });
  }
  ~VirtualNat() {
    stopping_ = true;
    if (worker_.joinable()) worker_.join();
#ifdef VDS_TEST_FULL_EGRESS
    vds_test_egress_configure(0);
#endif
  }
  std::uint16_t internalPort(unsigned side) const { return ntohs(internal_[side].sin_port); }
  std::string stunHost(unsigned index) const {
    // The nomination test needs a genuinely supported stable classification
    // to exercise competing auxiliary sockets; keep its retention assertions.
    return delayed_nomination_ ? "127.0.0." + std::to_string(20 + index) : "127.0.0.1";
  }
  std::uint16_t stunPort(unsigned index) const { return ntohs(stun_[index]->bound.sin_port); }
  std::uint16_t deadExitPort() const { return ntohs(dead_exit_->bound.sin_port); }
  std::uint16_t basePort() const { return basePort_ + kAllocationStart; }
  bool listensAtPort(unsigned port) const {
    return port >= basePort_ && port < basePort_ + kPortPool;
  }
  void registerSignaledPort(unsigned outgoingSide, unsigned port) {
    std::lock_guard<std::mutex> lock(mutex_);
    signaledPorts_[outgoingSide].insert(port);
  }
  FixtureSnapshot snapshot(bool topology = false) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!error_.empty()) throw std::runtime_error(error_);
    auto value = stats_;
    for (unsigned side = 0; side < 2; ++side) value.mappingCount[side] = nextMapping_[side];
    if (!topology) return value; // graph inspection stays out of the packet hot path
    for (unsigned side = 0; side < 2; ++side) {
      value.mappingCount[side] = nextMapping_[side];
      std::set<std::string> destinations;
      for (const auto& mapping : mappings_[side]) if (mapping)
        destinations.insert(mapping->allowed.begin(), mapping->allowed.end());
      value.mappedDestinations[side] = static_cast<unsigned>(destinations.size());
    }
    for (unsigned a = 0; a < kPortPool; ++a) {
      if (!mappings_[0][a]) continue;
      const auto source = addressKey(external_[0][a]->bound);
      for (unsigned b = 0; b < kPortPool; ++b) {
        if (mappings_[1][b] && mappings_[0][a]->allowed.count(addressKey(external_[1][b]->bound)) &&
            mappings_[1][b]->allowed.count(source)) ++value.reciprocalMappings;
      }
    }
    return value;
  }
  // Opt-in wire diagnostics: preserve only protocol headers, never ICE keys or
  // media payload. Rendering happens after observation, outside the packet path.
  void printControlTrace(const std::string& scenario, int64_t beganEpochMs) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (std::getenv("VDS_NAT_ALLOCATION_TRACE")) {
      // Bounded by the fixture's mapping table. Never print ICE credentials or
      // packet contents; emit after observation, not on the packet hot path.
      for (unsigned side = 0; side < 2; ++side) for (unsigned slot = 0; slot < kPortPool; ++slot) {
        if (!mappings_[side][slot]) continue;
        const auto& mapping = *mappings_[side][slot];
        std::cout << "ALLOCATION {\"scenario\":\"" << scenario << "\",\"side\":" << side
          << ",\"sequence\":" << mapping.sequence << ",\"atMs\":" << mapping.createdAtMs - beganEpochMs
          << ",\"source\":" << ntohs(mapping.internal.sin_port)
          << ",\"publicPort\":" << basePort_ + slot
          << ",\"remote\":\"" << addressKey(mapping.remote) << "\"}" << '\n';
      }
    }
    for (const auto& event : control_trace_) {
      std::ostringstream transaction;
      if (event.stun) for (unsigned i = 8; i < 20; ++i)
        transaction << std::hex << std::setfill('0') << std::setw(2) << unsigned(event.header[i]);
      std::cout << "WIRE {\"scenario\":\"" << scenario << "\",\"atMs\":" << event.atMs - beganEpochMs
        << ",\"fromSide\":" << event.side << ",\"fromInternal\":" << event.sourceInternal
        << ",\"fromPublic\":" << event.sourcePublic << ",\"toInternal\":" << event.destinationInternal
        << ",\"toPublic\":" << event.destinationPublic << ",\"size\":" << event.size
        << ",\"stun\":" << (event.stun ? "true" : "false")
        << ",\"type\":" << (event.stun ? (event.header[0] << 8) | event.header[1] : event.header[0])
        << ",\"transaction\":\"" << transaction.str() << "\",\"handshakeType\":"
        << (!event.stun && event.size >= 25 && event.header[0] == 22 ? int(event.header[13]) : -1)
        << "}" << std::endl;
    }
    if (trace_enabled_) std::cout << "WIRE-END " << scenario << " recorded=" << control_trace_.size()
      << " omitted=" << omitted_control_packets_ << std::endl;
  }
  bool hasMapping(unsigned side, unsigned port) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return port >= basePort_ && port < basePort_ + kPortPool &&
           mappings_[side][port - basePort_].has_value();
  }
  unsigned mappingOwner(unsigned side, unsigned port) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (port < basePort_ || port >= basePort_ + kPortPool) return 0;
    const auto& entry = mappings_[side][port - basePort_];
    return entry ? ntohs(entry->internal.sin_port) : 0;
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
  bool standard_peer_ = false;
  bool history_check_ = false;
  std::array<std::set<std::string>, 2> seen_transactions_;
  bool address_dependent_ = false;
  unsigned responding_stun_;
  std::array<std::set<unsigned>, 2> signaledPorts_;
  struct Mapping {
    sockaddr_in remote{}; sockaddr_in internal{}; std::set<std::string> allowed;
    unsigned sequence = 0; int64_t createdAtMs = 0;
  };
  int internalSide(const sockaddr_in& source) const {
    for (unsigned side = 0; side < 2; ++side) if (pattern_ == MappingPattern::Random
        ? source.sin_addr.s_addr == internal_[side].sin_addr.s_addr
        : sameAddress(source, internal_[side])) return side;
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
  std::optional<unsigned> createMapping(unsigned side, const sockaddr_in& remote, const sockaddr_in& internal) {
    const auto key = addressKey(internal) + (stable_first_ && side == 0 ? "" : "/" + (address_dependent_ ? std::to_string(remote.sin_addr.s_addr) : addressKey(remote)));
    const auto found = byDestination_[side].find(key);
    if (found != byDestination_[side].end()) { mappings_[side][found->second]->allowed.insert(addressKey(remote)); return found->second; }
    const unsigned sequence = nextMapping_[side];
    unsigned slot = kAllocationStart + sequence;
    if (pattern_ == MappingPattern::Random) {
      if (sequence >= kPortPool) { ++stats_.outOfPoolDrops; return std::nullopt; }
      slot = randomSlots_[side][sequence];
    }
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
    mappings_[side][slot] = Mapping{remote, internal, {addressKey(remote)}, sequence,
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()};
    ++nextMapping_[side];
    byDestination_[side].emplace(key, slot);
    return slot;
  }
  void observeInternal(unsigned side, const sockaddr_in& source) {
    if (stats_.primaryInternalPorts[side] && ntohs(source.sin_port) != stats_.primaryInternalPorts[side] &&
        !stats_.firstAuxiliaryAtMs[side]) stats_.firstAuxiliaryAtMs[side] =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    stats_.internalPorts[side].insert(ntohs(source.sin_port));
    ++stats_.internalDatagrams;
  }
  void handleStun(unsigned endpoint, const unsigned char* data, int size, const sockaddr_in& source) {
    const int side = internalSide(source);
    if (side < 0 || size < 20 || data[0] != 0 || data[1] != 1 ||
        data[4] != 0x21 || data[5] != 0x12 || data[6] != 0xa4 || data[7] != 0x42) return;
    observeInternal(static_cast<unsigned>(side), source);
    ++stats_.stunRequests;
    if (!stats_.primaryInternalPorts[side]) stats_.primaryInternalPorts[side] = ntohs(source.sin_port);
    stats_.sampledTargets[side].insert(endpoint);
    const auto slot = createMapping(static_cast<unsigned>(side), stun_[endpoint]->bound, source);
    if (!slot) return;
    if (side == 1 && endpoint >= responding_stun_) { ++stats_.droppedStunResponses; return; }
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
    // Force sparse responses to arrive in separate callback batches: observing
    // one candidate must not be mistaken for receiving all responsive samples.
    if ((late_stun_ && side == 0) || (responding_stun_ == 2 && side == 1 && endpoint == 1)) {
      if (!release_stun_at_) release_stun_at_ = std::chrono::steady_clock::now() + 2500ms;
      if (std::chrono::steady_clock::now() < *release_stun_at_) {
        held_stun_.push_back({endpoint, source, std::vector<unsigned char>(response.begin(), response.end())});
        ++stats_.heldStunResponses;
        return;
      }
    }
    stun_[endpoint]->send(response.data(), static_cast<int>(response.size()), source);
  }
#ifdef VDS_TEST_FULL_EGRESS
  void handleEgress(const unsigned char* data, int size, const sockaddr_in& source) {
    require(size >= 10 && std::memcmp(data, "VDSE", 4) == 0, "invalid full-egress envelope");
    const int side = internalSide(source);
    require(side >= 0, "full-egress envelope did not retain an agent source socket");
    sockaddr_in target{}; target.sin_family = AF_INET;
    std::memcpy(&target.sin_addr.s_addr, data + 4, 4);
    std::memcpy(&target.sin_port, data + 8, 2);
    const unsigned ip = ntohl(target.sin_addr.s_addr), port = ntohs(target.sin_port);
    require(ip >= 0x7f000001 && ip <= 0x7f000007 && port, "invalid full-egress target");
    ++stats_.egressPackets;
    if (ip == 0x7f000001) {
      for (unsigned i = 0; i < stun_.size(); ++i) if (stunPort(i) == port) {
        handleStun(i, data + 10, size - 10, source);
        return;
      }
    }
    if (ip >= 0x7f000002 && ip <= 0x7f000003 && listensAtPort(port)) {
      handleExternal(ip - 0x7f000002, port - basePort_, data + 10, size - 10, source);
      return;
    }
    // A failed destination still consumes an outbound mapping. Never forward
    // outside-pool packets to the OS or invent a receiver mapping/response.
    observeInternal(static_cast<unsigned>(side), source);
    stats_.checkedExternalPorts[side].insert(port);
    stats_.checkedExternalEndpoints[side].insert(addressKey(target));
    ++stats_.outsidePackets[side];
    const auto before = nextMapping_[side];
    createMapping(static_cast<unsigned>(side), target, source);
    stats_.outsideAllocations[side] += nextMapping_[side] - before;
  }
#endif
  void handleExternal(unsigned destinationSide, unsigned destinationSlot,
                      const unsigned char* data, int size, const sockaddr_in& source) {
    const int outgoingSide = internalSide(source);
    if (outgoingSide >= 0) {
      observeInternal(static_cast<unsigned>(outgoingSide), source);
      stats_.checkedExternalPorts[outgoingSide].insert(basePort_ + destinationSlot);
      stats_.checkedExternalEndpoints[outgoingSide].insert(addressKey(external_[destinationSide][destinationSlot]->bound));
      if (history_check_ && size >= 20 && data[0] == 0 && data[1] == 1 &&
          stats_.firstAuxiliaryAtMs[outgoingSide] && !signaledPorts_[outgoingSide].count(basePort_ + destinationSlot)) {
        const std::string transaction(reinterpret_cast<const char*>(data + 8), 12);
        if (seen_transactions_[outgoingSide].insert(transaction).second) {
          const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count() - stats_.firstAuxiliaryAtMs[outgoingSide];
          const unsigned port = basePort_ + destinationSlot;
          const std::string sourceTarget = addressKey(source) + "/" + std::to_string(port);
          if (elapsed < 4500) {
            stats_.firstPlanHypotheses[outgoingSide].insert(port);
            stats_.firstPlanSourceTargets[outgoingSide].insert(sourceTarget);
          }
          if (elapsed >= 5000 && elapsed < 9000) {
            stats_.secondPlanHypotheses[outgoingSide].insert(port);
            if (stats_.firstPlanHypotheses[outgoingSide].count(port)) {
              stats_.repeatedPlanHypotheses[outgoingSide].insert(port);
              if (stats_.firstPlanSourceTargets[outgoingSide].count(sourceTarget))
                stats_.repeatedSameSourceTargets[outgoingSide].insert(sourceTarget);
              else stats_.repeatedNewSourceTargets[outgoingSide].insert(sourceTarget);
            }
          }
        }
      }

      if (!signaledPorts_[outgoingSide].count(basePort_ + destinationSlot) &&
          !stats_.firstNovelTargetAtMs[outgoingSide]) stats_.firstNovelTargetAtMs[outgoingSide] =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
      // Outgoing NAT mapping must be allocated even when the destination public
      // port does not exist. This models the port consumption of failed checks.
      const auto slot = createMapping(static_cast<unsigned>(outgoingSide),
                                      external_[destinationSide][destinationSlot]->bound, source);
      if (slot) external_[outgoingSide][*slot]->send(data, size,
                         external_[destinationSide][destinationSlot]->bound);
      return;
    }
    const auto outgoing = externalSource(source);
    if (!outgoing) return;
    ++stats_.publicDatagrams;
    if (late_path_) {
      // Drop, never queue, public peer packets for eighteen seconds. STUN
      // discovery and real NAT allocations/filtering continue normally.
      if (!outage_until_) outage_until_ = std::chrono::steady_clock::now() + 18s;
      if (std::chrono::steady_clock::now() < *outage_until_) {
        ++stats_.outageDrops; return;
      }
    }
    if ((responding_stun_ < 4 || late_stun_ || export_sdp_ || delayed_nomination_ || address_dependent_ || standard_peer_) && outgoing->first == 1 &&
        ntohs(mappings_[1][outgoing->second]->internal.sin_port) == stats_.primaryInternalPorts[1]) {
      ++stats_.primaryPathDrops; return;
    }
    if (paced_recovery_) {
      // Fault injection: random peer's primary path is unavailable, so this
      // test must recover on a real auxiliary socket, not ordinary ICE retries.
      const auto& origin = mappings_[outgoing->first][outgoing->second];
      if (outgoing->first == 1 && ntohs(origin->internal.sin_port) == stats_.primaryInternalPorts[1]) {
        ++stats_.primaryPathDrops; return;
      }
      // First enhanced packet starts a two-second bidirectional network outage.
      // NAT allocation/filtering is unchanged; dropped packets are never queued.
      if (outgoing->first == 1 && !outage_until_) outage_until_ = std::chrono::steady_clock::now() + 2s;
      if (!outage_until_ || std::chrono::steady_clock::now() < *outage_until_) {
        ++stats_.outageDrops; return;
      }
    }
    if (blackhole_) return; // planner regressions must not win ordinary ICE early
    const auto& destination = mappings_[destinationSide][destinationSlot];
    if (!destination) { ++stats_.unmappedDrops; return; }
    if (!independentFiltering_[destinationSide] && !destination->allowed.count(addressKey(source))) {
      ++stats_.filteringDrops;
      return;
    }
    if (delayed_nomination_ && size >= 20 && data[0] == 0 && data[1] == 1) {
      bool nominated = false;
      for (size_t at = 20; at + 4 <= static_cast<size_t>(size);) {
        const unsigned type = (data[at] << 8) | data[at + 1];
        const unsigned length = (data[at + 2] << 8) | data[at + 3];
        require(at + 4 + length <= static_cast<size_t>(size), "truncated nomination fixture packet");
        if (type == 0x0025 && length == 0) nominated = true;
        at += 4 + ((length + 3u) & ~3u);
      }
      const auto now = std::chrono::steady_clock::now();
      const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
      if (nominated && stats_.firstAuxiliaryAtMs[1] && elapsed < stats_.firstAuxiliaryAtMs[1] + 6000) {
        held_nomination_.push_back({outgoing->first, outgoing->second, destination->internal,
          std::vector<unsigned char>(data, data + size)});
        ++stats_.heldNominationRequests;
        return;
      }
    }
    // Reorder real ICE responses behind the first DTLS flight. No packet is
    // forged and NAT allocation/filtering above remains unchanged.
    if (early_handshake_ && destinationSide == 0 && size >= 20 && data[0] == 1 && data[1] == 1 &&
        (!release_ice_at_ || std::chrono::steady_clock::now() < *release_ice_at_)) {
      held_ice_.push_back({outgoing->first, outgoing->second, destination->internal,
        std::vector<unsigned char>(data, data + size)});
      ++stats_.heldIceResponses;
      if (!release_ice_at_ && stats_.firstClientHelloAtMs) release_ice_at_ = std::chrono::steady_clock::now() + 200ms;
      return;
    }
    if (destinationSide == 0 && size >= 25 && data[0] == 22 && data[3] == 0 && data[4] == 0 && data[13] == 1) {
      ++stats_.clientHellos;
      if (!stats_.firstClientHelloAtMs) {
        const auto now = std::chrono::steady_clock::now();
        stats_.firstClientHelloAtMs = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
        if (early_handshake_ && !held_ice_.empty()) release_ice_at_ = now + 200ms;
      }
    }
    if (trace_enabled_ && size >= 20) {
      const bool stun = (data[0] & 0xc0) == 0 && data[4] == 0x21 && data[5] == 0x12 && data[6] == 0xa4 && data[7] == 0x42;
      if (stun || data[0] == 22 || data[0] == 21) {
        if (control_trace_.size() < 256) {
          ControlPacket event{};
          event.atMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
          event.side = outgoing->first;
          event.sourceInternal = ntohs(mappings_[outgoing->first][outgoing->second]->internal.sin_port);
          event.sourcePublic = ntohs(source.sin_port);
          event.destinationInternal = ntohs(destination->internal.sin_port);
          event.destinationPublic = basePort_ + destinationSlot;
          event.size = size; event.stun = stun;
          std::copy_n(data, std::min(size, 25), event.header.begin());
          control_trace_.push_back(event);
        } else ++omitted_control_packets_;
      }
    }
    // Forward from the original source public socket, preserving the source
    // that the real ICE stack observes. The destination is the real agent UDP
    // socket; DTLS/SCTP and ICE authentication are never decoded or synthesized.
    if (corrupt_ && size > 20 && (data[0] & 0xc0) == 0 && data[4] == 0x21) {
      std::vector<unsigned char> invalid(data, data + size);
      if (responding_stun_ < 4 || standard_peer_) {
        damageStunIntegrity(invalid);
        ++stats_.corruptedIntegrityPackets;
      } else invalid.back() ^= 1;
      external_[outgoing->first][outgoing->second]->send(invalid.data(), size, destination->internal);
      ++stats_.corruptedPackets;
    } else external_[outgoing->first][outgoing->second]->send(data, size, destination->internal);
    ++stats_.forwardedDatagrams;
    if (!stats_.firstPeerPacketAtMs[destinationSide]) stats_.firstPeerPacketAtMs[destinationSide] =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    if (size && data[0] >= 20 && data[0] <= 63) ++stats_.dtlsPackets[destinationSide];
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
          if (release_stun_at_ && std::chrono::steady_clock::now() >= *release_stun_at_) {
            for (const auto& packet : held_stun_)
              stun_[packet.endpoint]->send(packet.bytes.data(), static_cast<int>(packet.bytes.size()), packet.destination);
            held_stun_.clear();
          }
          if (release_ice_at_ && std::chrono::steady_clock::now() >= *release_ice_at_) {
            for (const auto& packet : held_ice_) {
              external_[packet.side][packet.slot]->send(packet.bytes.data(), static_cast<int>(packet.bytes.size()), packet.destination);
              ++stats_.forwardedDatagrams;
            }
            held_ice_.clear();
          }
          const auto epochMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
          if (stats_.firstAuxiliaryAtMs[1] && epochMs >= stats_.firstAuxiliaryAtMs[1] + 6000) {
            for (const auto& packet : held_nomination_) {
              external_[packet.side][packet.slot]->send(packet.bytes.data(), static_cast<int>(packet.bytes.size()), packet.destination);
              ++stats_.forwardedDatagrams;
            }
            held_nomination_.clear();
          }
          drain(*dead_exit_, [&](const unsigned char*, int, const sockaddr_in& source) {
            const int side = internalSide(source);
            if (side >= 0) {
              observeInternal(static_cast<unsigned>(side), source);
              stats_.deadExitSources[side].insert(ntohs(source.sin_port));
            }
          });
          for (unsigned index = 0; index < stun_.size(); ++index)
            drain(*stun_[index], [&, index](const unsigned char* data, int size, const sockaddr_in& source) {
              handleStun(index, data, size, source);
            });
#ifdef VDS_TEST_FULL_EGRESS
          drain(*egress_, [&](const unsigned char* data, int size, const sockaddr_in& source) {
            handleEgress(data, size, source);
          });
#endif
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

  std::array<std::array<unsigned, kPortPool>, 2> randomSlots_{};
  struct ControlPacket {
    int64_t atMs;
    unsigned side, sourceInternal, sourcePublic, destinationInternal, destinationPublic;
    int size;
    bool stun;
    std::array<unsigned char, 25> header{};
  };
  const bool trace_enabled_ = std::getenv("VDS_NAT_PACKET_TRACE") != nullptr;
  std::vector<ControlPacket> control_trace_;
  unsigned omitted_control_packets_ = 0;
  struct HeldIcePacket { unsigned side, slot; sockaddr_in destination; std::vector<unsigned char> bytes; };
  bool delayed_nomination_ = false;
  std::vector<HeldIcePacket> held_nomination_;
  struct HeldStunPacket { unsigned endpoint; sockaddr_in destination; std::vector<unsigned char> bytes; };
  bool late_stun_ = false;
  bool export_sdp_ = false;
  std::vector<HeldStunPacket> held_stun_;
  std::optional<std::chrono::steady_clock::time_point> release_stun_at_;
  bool late_path_ = false;
  bool early_handshake_ = false;
  std::vector<HeldIcePacket> held_ice_;
  std::optional<std::chrono::steady_clock::time_point> release_ice_at_;
  bool paced_recovery_ = false;
  std::optional<std::chrono::steady_clock::time_point> outage_until_;
  bool stable_first_ = false;
  bool corrupt_ = false;
  bool blackhole_ = false;
  std::unique_ptr<UdpSocket> dead_exit_;
  MappingPattern pattern_;
  std::array<bool, 2> independentFiltering_{};
  std::array<sockaddr_in, 2> internal_{};
  std::vector<std::unique_ptr<UdpSocket>> stun_;
#ifdef VDS_TEST_FULL_EGRESS
  std::unique_ptr<UdpSocket> egress_;
#endif
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
  std::atomic<bool> embeddedExchange{false};
  std::atomic<bool> echoed{false};
  std::atomic<bool> received{false};
  std::shared_ptr<rtc::DataChannel> remoteChannel;
};

struct ScenarioResult {
  std::int64_t connectedAtMs = 0;
  std::int64_t beganEpochMs = 0;
  std::array<int64_t, 2> iceReadyAtMs{};
  std::array<std::string, 2> iceStates, peerStates;
  bool payloadReceived = false;
  bool channelOpen = false;
  std::string name;
  bool connected = false;
  unsigned predictions = 0;
  unsigned linearPredictions = 0;
  std::array<unsigned, 2> checkedPredictions{};
  std::array<unsigned, 2> selectedInternalPorts{};
  unsigned selectedAuxiliarySockets = 0;
  unsigned candidates = 0;
  unsigned embeddedSdpExchanges = 0;
  unsigned selectedPairChanges = 0;
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
                           bool exchangePredictions = true, bool delayedPrediction = false,
                           bool multiSocket = false, unsigned seed = 1, bool observeResult = false, bool corrupt = false, bool stableFirst = false,
                           int explorationCheck = 0, unsigned connectTimeoutSeconds = 12, bool pacedRecovery = false, bool earlyHandshake = false, bool latePath = false, unsigned respondingStun = 4, bool lateStun = false, bool exportSdp = false, bool delayedNomination = false, unsigned allocationOffset = 0, bool addressDependent = false, unsigned standardPeer = 0) {
  std::cout << "CASE-BEGIN " << name << std::endl;
#ifdef VDS_TEST_SEEDED_PLANNER
  vds_test_plan_seed_configure(seed);
#endif
  VirtualNat fixture(pattern, independentFiltering, seed, corrupt, stableFirst, explorationCheck != 0, pacedRecovery, earlyHandshake, latePath, respondingStun, lateStun, exportSdp, delayedNomination, allocationOffset, addressDependent, explorationCheck == 5, standardPeer != 0);
  Signaling signaling;
  std::array<std::shared_ptr<rtc::PeerConnection>, 2> peers;
  rtc::binary payload(4096);
  for (std::size_t index = 0; index < payload.size(); ++index)
    payload[index] = static_cast<std::byte>((index * 37 + 11) & 255);
  for (unsigned side = 0; side < 2; ++side) {
    rtc::Configuration config;
    config.bindAddress = pattern == MappingPattern::Random
      ? (side == 0 ? "127.0.0.10" : "127.0.0.11") : "127.0.0.1";
#if defined(RTC_VDS_MULTISOCKET_ICE)
    config.enableIceMultiSocket = multiSocket && !(standardPeer && side == 0);
#else
    require(!multiSocket, "multi socket backend not compiled");
#endif
    config.enableIceTcp = false;
    config.portRangeBegin = fixture.internalPort(side);
    config.portRangeEnd = fixture.internalPort(side);
    if (pattern == MappingPattern::Random && explorationCheck != 3) config.portRangeBegin = config.portRangeEnd = 0;
    for (unsigned index = 0; index < stunCount; ++index)
      config.iceServers.emplace_back(fixture.stunHost(index), fixture.stunPort(index));
    peers[side] = std::make_shared<rtc::PeerConnection>(config);
    peers[side]->onLocalDescription([&, side](rtc::Description description) {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      if (!signaling.embeddedExchange) signaling.descriptions[side].push_back(withoutCandidates(description));
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
  bool lateMetadataComplete = true;
  bool predictionsPending = false;
  bool sent = false;
  std::array<std::set<unsigned>, 2> predictedCandidatePorts;
  std::array<std::set<unsigned>, 2> genuineCandidatePorts;
  std::array<unsigned, 2> anchorBlock{}, anchorPriority{};
  std::array<std::vector<rtc::Candidate>, 2> deferredPredictions;
  std::chrono::steady_clock::time_point sendPredictionsAt;
  ScenarioResult result;
  result.name = name;
  const auto began = std::chrono::steady_clock::now();
  result.beganEpochMs = std::chrono::duration_cast<std::chrono::milliseconds>(began.time_since_epoch()).count();
  const auto observeIce = [&] {
    for (unsigned side = 0; side < 2; ++side) {
      const auto state = peers[side]->iceState();
      if (!result.iceReadyAtMs[side] && (state == rtc::PeerConnection::IceState::Connected ||
          state == rtc::PeerConnection::IceState::Completed)) result.iceReadyAtMs[side] =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - began).count();
    }
  };
  const auto deadline = began + ((expectConnected || explorationCheck)
    ? std::chrono::seconds(connectTimeoutSeconds) : 4s);
  std::optional<FixtureSnapshot> firstPlan;
  std::array<bool, 2> discoveryChecked{};
  while (std::chrono::steady_clock::now() < deadline && !signaling.echoed) {
    observeIce();
    if (explorationCheck == 1 || explorationCheck == 3) {
      const auto state = fixture.snapshot();
      const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
      for (unsigned side = 0; side < 2; ++side) if (!discoveryChecked[side] &&
          state.firstNovelTargetAtMs[side] && nowMs >= state.firstNovelTargetAtMs[side] + 300) {
        require(fixture.snapshot(true).mappedDestinations[side] >= 60,
          "first discovery must cover destinations promptly, not postpone them with retransmissions");
        discoveryChecked[side] = true;
      }
    }
    if (explorationCheck && !firstPlan && std::chrono::steady_clock::now() > began + 4s) firstPlan = fixture.snapshot(true);
    std::array<std::vector<rtc::Description>, 2> descriptions;
    {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      for (unsigned side = 0; side < 2; ++side) descriptions[side].swap(signaling.descriptions[side]);
    }
    for (unsigned side = 0; side < 2; ++side)
      for (auto& description : descriptions[side]) peers[1 - side]->setRemoteDescription(description);
    bool sparseReady = respondingStun < stunCount;
    if (sparseReady) {
      std::lock_guard<std::mutex> lock(signaling.mutex);
      for (unsigned side = 0; side < 2; ++side) {
        const auto realSamples = std::count_if(signaling.candidates[side].begin(), signaling.candidates[side].end(),
          [](const rtc::Candidate& candidate) { return candidate.candidate().find("vds-predicted 1") == std::string::npos; });
        const unsigned expected = (addressDependent || (stableFirst && side == 0)) ? 1u :
          std::min(stunCount, side == 1 ? respondingStun : stunCount);
        // This fixture exchanges one batch. Wait for its responsive samples,
        // not for the first callback or dead servers' GatheringComplete.
        sparseReady = sparseReady && realSamples >= expected;
      }
    }
    // Trickle-confirmed endpoints must be usable while dead STUN servers are
    // still retrying; production signaling does not wait for GatheringComplete.
    if (!candidatesExchanged && (sparseReady || (signaling.gathered[0] && signaling.gathered[1]))) {
      std::array<std::vector<rtc::Candidate>, 2> candidates;
      {
        std::lock_guard<std::mutex> lock(signaling.mutex);
        candidates = signaling.candidates;
      }
      if (exportSdp) for (unsigned side = 0; side < 2; ++side) {
        // Exercise the transport's SDP serializer rather than reusing strings
        // cached from trickle callbacks. Do not let exported LAN routes win.
        const auto description = side == 0 ? peers[side]->createOffer() : peers[side]->createAnswer();
        candidates[side].clear();
        for (const auto& candidate : description.candidates())
          if (candidate.type() == rtc::Candidate::Type::ServerReflexive &&
              candidate.transportType() == rtc::Candidate::TransportType::Udp)
            candidates[side].push_back(candidate);
      }
      for (unsigned side = 0; side < 2; ++side) {
        const auto& set = candidates[side];
        require(!set.empty(), name + ": no real STUN candidates");
        unsigned realSamples = 0;
        for (auto candidate : set) {
          ++result.candidates;
          candidate.resolve();
          require(candidate.port() && (pattern == MappingPattern::Random || fixture.listensAtPort(*candidate.port())),
                  name + ": an emitted remote candidate port bypasses the virtual NAT listener pool");
          fixture.registerSignaledPort(1 - side, *candidate.port());
          if (candidate.candidate().find("vds-predicted 1") != std::string::npos) {
            ++result.predictions;
            const auto text = candidate.candidate();
            const auto marker = text.find("vds-nat-step ");
            if (marker != std::string::npos && std::stoi(text.substr(marker + 13)) != 0)
              ++result.linearPredictions;
            candidate.resolve();
            require(candidate.port().has_value(), name + ": predicted port missing");
            predictedCandidatePorts[side].insert(*candidate.port());
          } else {
            ++realSamples;
            genuineCandidatePorts[side].insert(*candidate.port());
            if (candidate.priority() > anchorPriority[side]) {
              anchorPriority[side] = candidate.priority();
              anchorBlock[side] = *candidate.port() & 0xff00u;
            }
            if (lateStun && side == 0) lateMetadataComplete = lateMetadataComplete &&
              candidate.candidate().find("vds-punch 1") != std::string::npos &&
              candidate.candidate().find("vds-nat-mode 0") != std::string::npos &&
              candidate.candidate().find("vds-probe-count 1") != std::string::npos;
            if (side == 1 && respondingStun < 3) require(candidate.candidate().find("vds-nat-mode 0") != std::string::npos,
              "sparse samples must remain unknown, never claim stable or linear mapping");
          }
        }
        require((addressDependent || (stableFirst && side == 0)) ? realSamples == 1 : realSamples == std::min(stunCount, side == 1 ? respondingStun : stunCount),
                name + ": gathering completed before the confirmed STUN candidates were emitted");
      }
      // Interleave both endpoints' candidates to let both real ICE agents punch
      // concurrently. This does not open or forward any virtual NAT mapping.
      if (standardPeer) {
        // Standard ICE peer: no VDS extensions, no auxiliary socket support.
        // Candidate-level ufrag is optional; the SDP still carries credentials.
        for (auto& candidate : candidates[0]) {
          std::istringstream input(candidate.candidate());
          std::vector<std::string> fields; std::string field;
          while (input >> field) fields.push_back(field);
          std::ostringstream text;
          for (size_t i = 0; i < fields.size();) {
            if (i >= 8 && (fields[i].rfind("vds-", 0) == 0 ||
                (standardPeer >= 2 && fields[i] == "ufrag"))) { i += 2; continue; }
            text << fields[i++] << ' ';
          }
          if (standardPeer == 3 || standardPeer == 6) text << "ufrag stale-generation ";
          candidate = rtc::Candidate(text.str(), candidate.mid());
          require(candidate.candidate().find("vds-") == std::string::npos, "standard candidate retained VDS metadata");
        }
        if (standardPeer >= 4) {
          require(candidates[0].size() == 1, "multi-exit control requires one actual stable mapping");
          // Four unreachable advertised public addresses, all on the same
          // remote port. They allocate outgoing mappings but never forward.
          // Mode 5 keeps the live exit first as a positive ordering control.
          std::istringstream input(candidates[0].front().candidate());
          const auto standardMid = candidates[0].front().mid();
          std::vector<std::string> fields; std::string field;
          while (input >> field) fields.push_back(field);
          for (unsigned dead = 0; dead < 4; ++dead) {
            auto changed = fields;
            // Only the live address is stale in mode 6. The valid dead groups
            // must not allow the aggregate planner to admit it accidentally.
            if (standardPeer == 6) {
              require(changed[changed.size() - 2] == "ufrag", "missing stale ufrag control");
              changed.resize(changed.size() - 2);
            }
            changed[0] = "candidate:dead-standard-" + std::to_string(dead);
            changed[3] = std::to_string(standardPeer == 5 ? 1000000u + dead : 2000000000u + dead);
            changed[4] = "127.0.0." + std::to_string(4 + dead);
            std::ostringstream text;
            for (const auto& token : changed) text << token << ' ';
            candidates[0].emplace_back(text.str(), standardMid);
          }
        }
      }
      if (explorationCheck == 2) {
        for (unsigned side = 0; side < 2; ++side) {
          std::istringstream input(candidates[side].front().candidate());
          std::vector<std::string> fields; std::string field;
          while (input >> field) fields.push_back(field);
          require(fields.size() > 8, "candidate fixture has standard SDP fields");
          fields[0] = "candidate:dead-exit";
          fields[3] = "2130706431"; fields[4] = "127.0.0.4";
          fields[5] = std::to_string(fixture.deadExitPort());
          for (std::size_t i = 8; i + 1 < fields.size(); ++i)
            if (fields[i] == "vds-nat-mode") fields[i + 1] = "1";
          std::ostringstream candidate;
          for (const auto& part : fields) candidate << part << ' ';
          peers[1 - side]->addRemoteCandidate(rtc::Candidate(candidate.str(), candidates[side].front().mid()));
        }
      }
      if (exportSdp) {
        signaling.embeddedExchange = true;
        peers[0]->setLocalDescription(rtc::Description::Type::Offer);
        auto offer = peers[0]->createOffer();
        offer.extractCandidates();
        offer.addCandidates(candidates[0]);
        peers[1]->setRemoteDescription(offer);
        auto answer = peers[1]->createAnswer();
        answer.extractCandidates();
        answer.addCandidates(candidates[1]);
        peers[0]->setRemoteDescription(answer);
        result.embeddedSdpExchanges = 2;
        require(peers[0]->signalingState() == rtc::PeerConnection::SignalingState::Stable &&
                peers[1]->signalingState() == rtc::PeerConnection::SignalingState::Stable,
                "embedded offer/answer did not finish negotiation");
      } else
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
  observeIce();
  for (unsigned side = 0; side < 2; ++side) {
    std::ostringstream ice, peer;
    ice << peers[side]->iceState(); peer << peers[side]->state();
    result.iceStates[side] = ice.str(); result.peerStates[side] = peer.str();
  }
  result.payloadReceived = signaling.received;
  result.channelOpen = channel->isOpen();
  result.connected = signaling.received && signaling.echoed;
  if (std::getenv("VDS_NAT_PACKET_TRACE") || std::getenv("VDS_NAT_ALLOCATION_TRACE")) {
    const auto observed = fixture.snapshot(true);
    std::cout << "OBSERVATION {\"scenario\":\"" << name << "\",\"endedAtMs\":"
      << std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - began).count()
      << ",\"connected\":" << (result.connected ? "true" : "false")
      << ",\"reciprocalMappings\":" << observed.reciprocalMappings
      << ",\"forwardedDatagrams\":" << observed.forwardedDatagrams << "}" << std::endl;
    fixture.printControlTrace(name, result.beganEpochMs);
  }
  if (result.connected) result.connectedAtMs =
    std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - began).count();
  if (explorationCheck) {
    require(firstPlan.has_value(), "captured the first exploration plan");
    if (explorationCheck == 1 || explorationCheck == 3) require(discoveryChecked[0] && discoveryChecked[1], "both initial discovery phases were checked");
    const auto later = fixture.snapshot(true);
    for (unsigned side = 0; side < 2; ++side) {
      unsigned newPorts = 0;
      for (const auto port : later.checkedExternalPorts[side])
        newPorts += !firstPlan->checkedExternalPorts[side].count(port);
      require(newPorts > 8, "next plan must explore new targets, not just retransmit the first set");
      if (explorationCheck == 1) require(firstPlan->mappedDestinations[side] >= 60,
        "small NAT mapping table must cover many destinations before it fills, not sixteen sockets per target");
      if (explorationCheck == 1) {
        require(firstPlan->mappingCount[side] < 140,
          "double random must leave mapping capacity for later hypotheses, not exhaust it in the first plan");
        require(firstPlan->internalPorts[side].size() == 2 &&
            firstPlan->mappingCount[side] == firstPlan->mappedDestinations[side],
          "first random plan must reuse primary ICE mappings, without duplicate per-destination allocations");
        require(later.mappingCount[side] > firstPlan->mappingCount[side] &&
            later.internalPorts[side].size() > firstPlan->internalPorts[side].size(),
          "later random plans must create new mappings and expand source diversity after a sparse first pass");
      }
      if (explorationCheck == 3) require(firstPlan->mappedDestinations[side] >= 60 &&
          later.internalPorts[side].size() == 1 && later.mappingCount[side] > firstPlan->mappingCount[side],
        "auxiliary bind failure must preserve exploration and later fresh targets on the primary socket");
      if (explorationCheck == 2) require(firstPlan->deadExitSources[side].size() > 1 &&
          later.mappedDestinations[side] > firstPlan->mappedDestinations[side] + 8,
        "planner must visit the ranked dead exit, then establish new target mappings at the next exit");
      if (explorationCheck == 5) {
        std::cout << "plan-targets side=" << side << " first=" << later.firstPlanHypotheses[side].size()
          << " second=" << later.secondPlanHypotheses[side].size()
          << " repeated=" << later.repeatedPlanHypotheses[side].size()
          << " same-source-reuse=" << later.repeatedSameSourceTargets[side].size()
          << " new-source-choices=" << later.repeatedNewSourceTargets[side].size() << std::endl;
        require(later.firstPlanHypotheses[side].size() >= 30 && later.secondPlanHypotheses[side].size() >= 10,
          "overlap diagnostic must observe two actual hypothesis plans");

      }
      if (explorationCheck == 4) {
        std::set<unsigned> blocks;
        for (unsigned port : genuineCandidatePorts[1 - side]) blocks.insert(port & 0xff00u);
        require(blocks.size() > 1, "shifted fixture must supply real observations across an aligned boundary");
        unsigned novelOffAnchor = 0;
        for (unsigned port : firstPlan->checkedExternalPorts[side])
          if ((port & 0xff00u) != anchorBlock[1 - side] &&
              !genuineCandidatePorts[1 - side].count(port) && !predictedCandidatePorts[1 - side].count(port))
            ++novelOffAnchor;
        std::cout << "sampled-range side=" << side << " novel-off-anchor=" << novelOffAnchor << std::endl;
        require(novelOffAnchor >= 10, "native exploration ignored confirmed observations outside the anchor block");
      }
      std::cout << name << " side=" << side << " first-targets=" << firstPlan->checkedExternalPorts[side].size()
        << " first-mapped-destinations=" << firstPlan->mappedDestinations[side]
        << " first-mappings=" << firstPlan->mappingCount[side] << " later-mappings=" << later.mappingCount[side]
        << " added-targets=" << newPorts << " dead-exit-sockets=" << later.deadExitSources[side].size() << '\n';
    }
  }
  require(candidatesExchanged, name + ": gathering/signaling never completed");
  if (!observeResult && result.connected != expectConnected) {
    const auto failureSnapshot = fixture.snapshot(true);
    std::cerr << "FAILURE-STATS forwarded=" << failureSnapshot.forwardedDatagrams
      << " outage=" << failureSnapshot.outageDrops << " primary=" << failureSnapshot.primaryPathDrops
      << " reciprocal=" << failureSnapshot.reciprocalMappings << std::endl;
    std::cerr << "TRACE " << name << fixture.mappingTrace() << std::endl;
    std::lock_guard<std::mutex> lock(signaling.mutex);
    for (unsigned side = 0; side < 2; ++side)
      for (const auto& candidate : signaling.candidates[side])
        std::cerr << "candidate " << side << " " << candidate.candidate() << std::endl;
  }
  require(observeResult || result.connected == expectConnected, name + ": unexpected real DataChannel result");
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
      local.resolve();
      if (pattern == MappingPattern::Random && local.port()) {
        auto owner = fixture.mappingOwner(side, *local.port());
        require(owner != 0, name + ": selected local socket has no real NAT mapping");
        result.selectedInternalPorts[side] = owner;
        result.selectedAuxiliarySockets += owner != fixture.snapshot().primaryInternalPorts[side];
      }
      result.selectedLocal[side] = local.candidate();
      result.selectedRemote[side] = remote.candidate();
    }
    require(pattern == MappingPattern::Random || result.predictions > 0, name + ": connected without predicted candidates");
  }
  if (multiSocket && result.connected) {
    // The ordinary path may legitimately win, especially for stable/random peers.
    // Matrix acceptance below still requires a verified auxiliary winner.
    const auto until = std::chrono::steady_clock::now() + 7s;
    bool retainedBeforeNomination = false;
    while (std::chrono::steady_clock::now() < until) {
      const auto running = fixture.snapshot();
      const auto epochMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
      if (delayedNomination && !retainedBeforeNomination && running.firstAuxiliaryAtMs[1] &&
          epochMs >= running.firstAuxiliaryAtMs[1] + 5500) {
        require(running.heldNominationRequests > 0 && peers[1]->iceState() == rtc::PeerConnection::IceState::Connected,
          "fault injection must keep a usable path awaiting nomination");
        require(running.internalPorts[1].size() > 2, "delayed nomination needs competing auxiliary paths");
        unsigned retained = 0;
        for (unsigned port : running.internalPorts[1]) {
          SOCKET socket = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
          require(socket != INVALID_SOCKET, "spare retention check socket failed");
          const auto endpoint = address("127.0.0.11", static_cast<std::uint16_t>(port));
          const int bound = bind(socket, reinterpret_cast<const sockaddr*>(&endpoint), sizeof(endpoint));
          const int error = bound == 0 ? 0 : WSAGetLastError();
          closesocket(socket);
          require(bound != 0 && error == WSAEADDRINUSE,
            "auxiliary socket closed before final nomination: port=" + std::to_string(port) + " error=" + std::to_string(error));
          ++retained;
        }
        retainedBeforeNomination = true;
        std::cout << "PASS retained " << retained << " source sockets after plan expiry while nomination pending" << std::endl;
      }
      signaling.echoed = false;
      channel->send(payload);
      auto reply = std::chrono::steady_clock::now() + 1s;
      while (!signaling.echoed && std::chrono::steady_clock::now() < reply) std::this_thread::sleep_for(5ms);
      if (!signaling.echoed) {
        const auto stalled = fixture.snapshot(true);
        std::cerr << "ECHO-STALL elapsedMs=" << std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - began).count() << " heldNominations=" << stalled.heldNominationRequests
          << " reciprocal=" << stalled.reciprocalMappings << std::endl;
        for (unsigned side = 0; side < 2; ++side) {
          rtc::Candidate local, remote;
          peers[side]->getSelectedCandidatePair(&local, &remote);
          std::cerr << "ECHO-STALL side=" << side << " ice=" << peers[side]->iceState()
            << " local=" << local.candidate() << " remote=" << remote.candidate() << std::endl;
        }
        fixture.printControlTrace(name, result.beganEpochMs);
        require(false, "selected auxiliary socket stopped carrying DTLS/SCTP data or consent failed");
      }
      std::this_thread::sleep_for(100ms);
    }
    require(!delayedNomination || retainedBeforeNomination, "pre-nomination retention assertion was not exercised");
  }
  if (multiSocket && result.connected) {
    const auto running = fixture.snapshot();
    for (unsigned side = 0; side < 2; ++side) {
      // Connected can precede final ICE nomination. Verify spare release against
      // the current nominated winner, not the snapshot before seven seconds of data.
      require(peers[side]->iceState() == rtc::PeerConnection::IceState::Completed,
              name + ": nomination did not finish before spare-socket release check");
      rtc::Candidate nominatedLocal, nominatedRemote;
      require(peers[side]->getSelectedCandidatePair(&nominatedLocal, &nominatedRemote),
              name + ": missing nominated pair at release check");
      nominatedLocal.resolve();
      const unsigned liveWinner = fixture.mappingOwner(side, nominatedLocal.port().value_or(0));
      require(liveWinner != 0, name + ": nominated winner has no real NAT mapping");
      if (liveWinner != result.selectedInternalPorts[side]) ++result.selectedPairChanges;
      for (unsigned port : running.internalPorts[side]) {
        if (port == running.primaryInternalPorts[side] || port == liveWinner) continue;
        try {
          UdpSocket released(address(side ? "127.0.0.11" : "127.0.0.10", static_cast<std::uint16_t>(port)));
        } catch (const std::exception& error) {
          rtc::Candidate currentLocal, currentRemote;
          const bool selected = peers[side]->getSelectedCandidatePair(&currentLocal, &currentRemote);
          throw std::runtime_error(name + ": live spare-port check side=" + std::to_string(side) +
            " first-winner=" + std::to_string(result.selectedInternalPorts[side]) +
            " current=" + (selected ? currentLocal.candidate() : "none") + ": " + error.what());
        }
      }
    }
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
  const auto closeStarted = std::chrono::steady_clock::now();
  peers[0]->close();
  peers[1]->close();
  std::this_thread::sleep_for(700ms); // drain packets issued before close
  const auto afterClose = fixture.snapshot();
  std::this_thread::sleep_for(350ms);
  result.fixture = fixture.snapshot(true);
  require(afterClose.internalDatagrams == result.fixture.internalDatagrams &&
          afterClose.stunRequests == result.fixture.stunRequests,
          name + ": closed ICE agent kept sending enhanced probes/checks");
  for (unsigned side = 0; side < 2; ++side) {
    for (const unsigned target : result.fixture.checkedExternalPorts[side])
      if (predictedCandidatePorts[1 - side].count(target)) ++result.checkedPredictions[side];
    require((pattern == MappingPattern::Random && (multiSocket || result.fixture.internalPorts[side].size() == 1)) ||
            (result.fixture.internalPorts[side].size() == 1 &&
             *result.fixture.internalPorts[side].begin() == fixture.internalPort(side)),
            name + ": STUN and ICE did not share the real agent UDP source port");
    require(result.fixture.sampledTargets[side].size() == stunCount,
            name + ": did not sample every configured STUN target");
    require(result.fixture.mappingCount[side] <= VirtualNat::kPortPool,
            name + ": exceeded finite mapping budget");
  }
  if (pattern == MappingPattern::Random) {
    // PeerConnection::close queues transport destruction on TearDownProcessor.
    // Assert eventual release, not that this worker ran during a fixed sleep.
    // The deadline belongs only to this test; leaked ports still fail it.
    const auto releaseDeadline = closeStarted + 3s;
    // Opt-in fixture fault: temporarily retain, or deliberately leak, an
    // already closed port to test this assertion itself. Never used normally.
    const char* holdMode = std::getenv("VDS_NAT_TEST_CLOSED_PORT");
    std::unique_ptr<UdpSocket> heldPort;
    const auto holdStarted = std::chrono::steady_clock::now();
    if (holdMode && name == "random-invalid-ice-no-false-connect") {
      require(!result.fixture.internalPorts[0].empty(), "closed-port fault needs an observed source");
      heldPort = std::make_unique<UdpSocket>(address("127.0.0.10",
          static_cast<std::uint16_t>(*result.fixture.internalPorts[0].begin())));
    }
    for (;;) {
      if (heldPort && std::string(holdMode) == "release" &&
          std::chrono::steady_clock::now() >= holdStarted + 150ms) heldPort.reset();
      std::string pending;
      const bool checkOwners = std::chrono::steady_clock::now() >= releaseDeadline;
      for (unsigned side = 0; side < 2; ++side)
        for (unsigned port : result.fixture.internalPorts[side]) {
          try {
            UdpSocket released(address(side ? "127.0.0.11" : "127.0.0.10", static_cast<std::uint16_t>(port)));
          } catch (const std::exception& error) {
            const std::string blocked = "side=" + std::to_string(side) + " " + error.what();
            if (checkOwners) {
              const auto owners = udpPortOwners(side, port);
              if (owners.queried && owners.foreign && !owners.own) {
                // The port was released by this process and subsequently
                // taken by another process. It is not a transport leak.
                std::cout << "CLOSE-PORT-REASSIGNED " << name << ' ' << blocked << owners.details << std::endl;
              } else pending = blocked + owners.details;
            } else pending = blocked;
          }
        }
      if (pending.empty()) break;
      if (checkOwners)
        throw std::runtime_error(name + ": closed-peer UDP port could not be rebound within 3s: " + pending);
      if (std::chrono::steady_clock::now() < releaseDeadline) std::this_thread::sleep_for(25ms);
    }
    const auto released = fixture.snapshot();
    require(afterClose.internalDatagrams == released.internalDatagrams &&
            afterClose.stunRequests == released.stunRequests,
            name + ": closed ICE agent sent packets while waiting for socket release");
    std::cout << "CLOSE-RELEASE " << name << " elapsedMs="
      << std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - closeStarted).count()
      << std::endl;
  }
  if (respondingStun < 4) require(result.fixture.droppedStunResponses > 0 &&
      result.fixture.primaryPathDrops > 0 && result.linearPredictions == 0,
      "sparse fixture must drop STUN replies and primary traffic without inventing a mapping pattern");
  if (respondingStun == 2) require(result.fixture.heldStunResponses > 0,
      "two-sample fixture must separate STUN callbacks across the sampling deadline");
  if (respondingStun < 4 && result.connected) require(result.selectedAuxiliarySockets > 0,
      "sparse discovery must use a real authenticated auxiliary path");
  if (exportSdp) require(result.fixture.primaryPathDrops > 0 && result.selectedAuxiliarySockets > 0 && result.embeddedSdpExchanges == 2,
      "SDP-exported candidates must enable a real auxiliary path without trickle metadata rescue");
  if (lateStun) require(result.fixture.heldStunResponses > 0 && lateMetadataComplete &&
      result.fixture.primaryPathDrops > 0 && result.selectedAuxiliarySockets > 0 && result.connectedAtMs >= 2500,
      "late STUN must retain current-session punch metadata and complete authenticated auxiliary media");
  if (latePath) require(result.fixture.outageDrops > 0 && result.connectedAtMs >= 18000 &&
      result.payloadReceived && result.channelOpen,
      "late path must complete real ICE/DTLS/SCTP after the old renderer deadline");
  if (pacedRecovery) require(result.fixture.outageDrops > 0 && result.fixture.primaryPathDrops > 0 &&
      result.selectedAuxiliarySockets > 0 && result.connectedAtMs < 5000,
      "same-plan pacing must recover real auxiliary DTLS/SCTP after outage, before a new plan");
  if (corrupt) require(result.fixture.corruptedPackets > 0 && !result.connected, "invalid ICE fixture: corrupted=" + std::to_string(result.fixture.corruptedPackets) + " connected=" + std::to_string(result.connected));
  if (corrupt && (respondingStun < 4 || standardPeer)) require(result.fixture.corruptedIntegrityPackets > 0,
      "sparse negative control must reach MESSAGE-INTEGRITY validation");
  if (standardPeer) {
    require(result.fixture.internalPorts[0].size() == 1 && result.fixture.checkedExternalPorts[1].size() == 1,
      "standard-peer fallback must target only the advertised endpoint, without remote guesses or peer auxiliary sockets");
    if (standardPeer >= 4) require(result.fixture.outsideAllocations[1] > 0,
      "multi-exit test never exercised a dead advertised address");
    for (const auto& endpoint : result.fixture.checkedExternalEndpoints[1]) {
      const auto separator = endpoint.find(':');
      const auto ip = static_cast<unsigned>(std::stoul(endpoint.substr(0, separator)));
      require(ip == 0x7f000002 || (standardPeer >= 4 && ip >= 0x7f000004 && ip <= 0x7f000007),
        "standard-peer fallback probed an unadvertised public address");
    }
    if (result.connected) require(result.selectedAuxiliarySockets > 0 && result.fixture.primaryPathDrops > 0,
      "standard-peer test must use an authenticated auxiliary path after primary-path loss");
    if (standardPeer == 3) require(result.fixture.internalPorts[1].size() == 1 && !result.connected,
      "stale candidate credentials must not enable auxiliary probing");
    if (standardPeer == 6) require(!result.connected && result.fixture.forwardedDatagrams == 0,
      "stale live exit was admitted through another valid address group");
  }
#ifdef VDS_TEST_FULL_EGRESS
  require(result.fixture.fullEgress && result.fixture.egressPackets == result.fixture.internalDatagrams &&
          result.fixture.egressPackets == vds_test_egress_sent(),
          "full-egress fixture lost an outbound peer or STUN accounting path");
#endif
  require(result.predictions <= 32, name + ": exceeded 16 predictions per endpoint");
#ifdef VDS_TEST_SEEDED_PLANNER
  const unsigned plannerCalls = vds_test_plan_seed_calls();
  if (pattern == MappingPattern::Random && multiSocket && standardPeer != 3 && (!result.connected || result.selectedAuxiliarySockets))
    require(plannerCalls > 0, "seeded planner seam was not exercised");
  std::cout << "PLANNER-CALLS " << name << " count=" << plannerCalls << std::endl;
#endif
  require(result.fixture.internalDatagrams < (multiSocket ? 12000u : 4000u), name + ": unbounded ICE packet budget");
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
            << ",\"connectedAtMs\":" << result.connectedAtMs
            << ",\"iceStates\":[\"" << result.iceStates[0] << "\",\"" << result.iceStates[1] << "\"]"
            << ",\"peerStates\":[\"" << result.peerStates[0] << "\",\"" << result.peerStates[1] << "\"]"
            << ",\"iceReadyAtMs\":[" << result.iceReadyAtMs[0] << "," << result.iceReadyAtMs[1] << "]"
            << ",\"firstPeerPacketAtMs\":["
            << (result.fixture.firstPeerPacketAtMs[0] ? result.fixture.firstPeerPacketAtMs[0] - result.beganEpochMs : 0) << ","
            << (result.fixture.firstPeerPacketAtMs[1] ? result.fixture.firstPeerPacketAtMs[1] - result.beganEpochMs : 0) << "]"
            << ",\"heldIceResponses\":" << result.fixture.heldIceResponses
            << ",\"clientHellos\":" << result.fixture.clientHellos
            << ",\"firstClientHelloAtMs\":" << (result.fixture.firstClientHelloAtMs ? result.fixture.firstClientHelloAtMs - result.beganEpochMs : 0)
            << ",\"dtlsPackets\":[" << result.fixture.dtlsPackets[0] << "," << result.fixture.dtlsPackets[1] << "]"
            << ",\"channelOpen\":" << (result.channelOpen ? "true" : "false")
            << ",\"payloadReceived\":" << (result.payloadReceived ? "true" : "false")
            << ",\"outageDrops\":" << result.fixture.outageDrops
            << ",\"heldStunResponses\":" << result.fixture.heldStunResponses
            << ",\"heldNominationRequests\":" << result.fixture.heldNominationRequests
            << ",\"droppedStunResponses\":" << result.fixture.droppedStunResponses
            << ",\"corruptedIntegrityPackets\":" << result.fixture.corruptedIntegrityPackets
            << ",\"primaryPathDrops\":" << result.fixture.primaryPathDrops
            << ",\"linearPredictions\":" << result.linearPredictions
            << ",\"checkedPredictedPorts\":[" << result.checkedPredictions[0]
            << "," << result.checkedPredictions[1] << "]"
            << ",\"auxiliaryWinners\":" << result.selectedAuxiliarySockets
            << ",\"internalSockets\":[" << result.fixture.internalPorts[0].size() << "," << result.fixture.internalPorts[1].size() << "]"
            << ",\"selectedPairChanges\":" << result.selectedPairChanges
            << ",\"embeddedSdpExchanges\":" << result.embeddedSdpExchanges
            << ",\"candidates\":" << result.candidates
            << ",\"stunRequests\":" << result.fixture.stunRequests
            << ",\"internalDatagrams\":" << result.fixture.internalDatagrams
            << ",\"fullEgress\":" << (result.fixture.fullEgress ? "true" : "false")
            << ",\"egressPackets\":" << result.fixture.egressPackets
            << ",\"outsidePackets\":[" << result.fixture.outsidePackets[0] << ',' << result.fixture.outsidePackets[1] << ']'
            << ",\"outsideAllocations\":[" << result.fixture.outsideAllocations[0] << ',' << result.fixture.outsideAllocations[1] << ']'
            << ",\"forwardedDatagrams\":" << result.fixture.forwardedDatagrams
            << ",\"unmappedDrops\":" << result.fixture.unmappedDrops
            << ",\"filteringDrops\":" << result.fixture.filteringDrops
            << ",\"mappingCount\":[" << result.fixture.mappingCount[0] << "," << result.fixture.mappingCount[1] << "]"
            << ",\"mappedDestinations\":[" << result.fixture.mappedDestinations[0] << "," << result.fixture.mappedDestinations[1] << "]"
            << ",\"reciprocalMappings\":" << result.fixture.reciprocalMappings
            << ",\"outOfPoolDrops\":" << result.fixture.outOfPoolDrops << "}" << std::endl;
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

int main(int argc, char** argv) {
  try {
    Winsock winsock;
    rtc::InitLogger(std::getenv("VDS_NAT_TRACE") ? rtc::LogLevel::Verbose : rtc::LogLevel::Warning);
#ifdef VDS_TEST_FULL_EGRESS
    if (argc > 1 && std::string(argv[1]) == "--full-egress") {
      {
        VirtualNat fixture(MappingPattern::Random);
        UdpSocket first(address("127.0.0.10", 0)), second(address("127.0.0.10", 0));
        require(!fixture.listensAtPort(12000) && !fixture.listensAtPort(12001), "allocation probes must be outside pool");
        for (unsigned i = 0; i < 3; ++i)
          require(vds_test_egress_send(first.handle, 0x7f000003, 12000) == 15, "outside test send failed");
        require(vds_test_egress_send(first.handle, 0x7f000003, 12001) == 15, "second destination send failed");
        require(vds_test_egress_send(second.handle, 0x7f000003, 12000) == 15, "second source send failed");
        const auto deadline = std::chrono::steady_clock::now() + 1s;
        while (fixture.snapshot().egressPackets < 5 && std::chrono::steady_clock::now() < deadline)
          std::this_thread::sleep_for(1ms);
        const auto observed = fixture.snapshot(true);
        require(vds_test_egress_sent() == 5 && observed.egressPackets == 5 && observed.outsidePackets[0] == 5 &&
                observed.outsideAllocations[0] == 3 && observed.mappingCount[0] == 3 &&
                observed.mappingCount[1] == 0 && observed.forwardedDatagrams == 0 &&
                observed.internalPorts[0].size() == 2,
                "outside-pool sends must allocate by source+destination, reuse repeats, and never create receiver mappings");
        std::cout << "PASS full-egress allocation boundary: 5 sends, 3 source/destination mappings, 0 receiver mappings" << std::endl;
      }
      printResult(runScenario("full-egress-stable-random-control", MappingPattern::Random,
        4, true, false, true, false, true, 7, false, false, true));
      printResult(runScenario("full-egress-invalid-control", MappingPattern::Random,
        4, false, true, true, false, true, 1, false, true));
      for (unsigned seed : {1u, 2u}) {
        const auto result = runScenario("full-egress-double-random-" + std::to_string(seed),
          MappingPattern::Random, 4, true, false, true, false, true, seed, true);
        require(result.fixture.fullEgress && result.fixture.egressPackets > 0,
                "full-egress test did not traverse the accounting gateway");
        // A real early connection stops exploration before distant hypotheses.
        // Outside allocation is proved independently by the boundary test above;
        // an unfinished search must still exercise the global fallback.
        if (!result.connected) require(
                result.fixture.outsidePackets[0] + result.fixture.outsidePackets[1] > 0 &&
                result.fixture.outsideAllocations[0] + result.fixture.outsideAllocations[1] > 0,
                "unfinished full-egress search failed to exercise outside-pool allocation");
        printResult(result);
      }
      return 0;
    }
#endif
    if (argc > 1 && (std::string(argv[1]) == "--standard-peer-multiexit" ||
        std::string(argv[1]) == "--standard-peer-multiexit-control")) {
      const bool controlOnly = std::string(argv[1]) == "--standard-peer-multiexit-control";
      for (unsigned mode : {5u, 4u, 6u}) {
        if (controlOnly && mode != 5) continue;
        printResult(runScenario("standard-peer-multiexit-" + std::to_string(mode), MappingPattern::Random, 4,
          mode != 6, true, false, false, true, 3, false, false, true, 0, 8,
          false, false, false, 4, false, false, false, 0, false, mode));
      }
      if (!controlOnly) printResult(runScenario("standard-peer-multiexit-invalid-ice", MappingPattern::Random, 4,
        false, true, false, false, true, 3, false, true, true, 0, 8,
        false, false, false, 4, false, false, false, 0, false, 4));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--standard-peer") {
      for (unsigned mode : {1u, 2u, 3u}) {
        printResult(runScenario("standard-peer-metadata-" + std::to_string(mode), MappingPattern::Random, 4,
          mode != 3, true, false, false, true, 3, false, false, true, 0, 8,
          false, false, false, 4, false, false, false, 0, false, mode));
      }
      printResult(runScenario("standard-peer-invalid-ice", MappingPattern::Random, 4,
        false, true, false, false, true, 3, false, true, true, 0, 8,
        false, false, false, 4, false, false, false, 0, false, 2));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--target-overlap") {
      printResult(runScenario("target-overlap-native-wire", MappingPattern::Random, 4,
        false, false, true, false, true, 1, false, false, false, 5));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--same-address-stun") {
      const auto result = runScenario("same-stun-ip-address-dependent-nat", MappingPattern::Random, 4,
        true, true, false, false, true, 3, false, false, true, 0, 12,
        false, false, false, 4, false, false, false, 0, true);
      printResult(result);
      require(result.connectedAtMs < 5000 && result.predictions == 0 && result.candidates == 2 && result.selectedAuxiliarySockets > 0 &&
          result.fixture.primaryPathDrops > 0 && result.fixture.internalPorts[1].size() > 1,
          "same-IP STUN must recover on authenticated auxiliary path without predictions or primary rescue");
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--sampled-range") {
      printResult(runScenario("sampled-range-native-wire", MappingPattern::Random, 4,
        false, false, true, false, true, 1, false, false, false, 4, 12,
        false, false, false, 4, false, false, false, 128));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--delayed-nomination") {
      printResult(runScenario("retain-paths-until-final-nomination", MappingPattern::Random, 4,
        true, true, true, false, true, 3, false, false, true, 0, 12, false, false, false, 4, false, false, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--sdp-candidates") {
      printResult(runScenario("sdp-exported-candidates-real-datachannel", MappingPattern::Random, 4,
        true, true, true, false, true, 3, false, false, true, 0, 12, false, false, false, 4, false, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--late-stun") {
      printResult(runScenario("late-stun-retains-punch-metadata", MappingPattern::Random, 4,
        true, true, true, false, true, 3, false, false, true, 0, 12, false, false, false, 4, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--sparse-samples") {
      for (unsigned replies : {1u, 2u}) printResult(runScenario(
        "sparse-stun-" + std::to_string(replies) + "-real-datachannel", MappingPattern::Random, 4,
        true, true, true, false, true, 3, false, false, true, 0, 12, false, false, false, replies));
      const auto invalid = runScenario("sparse-stun-invalid-ice", MappingPattern::Random, 4,
        true, true, true, false, true, 3, true, true, true, 0, 7, false, false, false, 1);
      printResult(invalid);
      require(!invalid.connected, "sparse fallback accepted invalid ICE authentication");
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--late-path") {
      printResult(runScenario("native-ice-survives-renderer-deadline", MappingPattern::Random, 4, true, true,
        true, false, true, 3, false, false, true, 0, 35, false, false, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--early-handshake") {
      const auto result = runScenario("early-dtls-before-ice-ready", MappingPattern::Random, 4, true, true,
        true, false, true, 3, false, false, true, 0, 12, false, true);
      printResult(result);
      require(result.fixture.heldIceResponses > 0 && result.fixture.firstClientHelloAtMs > 0 &&
          result.fixture.firstClientHelloAtMs - result.beganEpochMs < result.iceReadyAtMs[0],
          "fault must deliver ClientHello before receiver ICE ready");
      require(result.fixture.clientHellos == 1,
          "early ClientHello was lost: handshake needed a retransmission despite an open NAT path");
      require(result.connectedAtMs - std::max(result.iceReadyAtMs[0], result.iceReadyAtMs[1]) < 600,
          "handoff from ICE to DTLS must not wait for the one-second retransmission timer");
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--primary-exploration") {
      printResult(runScenario("random-single-available-port", MappingPattern::Random, 4, false, false,
        true, false, true, 5, false, false, false, 3));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--paced-recovery") {
      printResult(runScenario("same-plan-outage-recovery", MappingPattern::Random, 4, true, true,
        false, false, true, 3, false, false, true, 0, 5, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--exploration-plans") {
      printResult(runScenario("random-fresh-plan", MappingPattern::Random, 4, false, false,
        true, false, true, 3, false, false, false, 1));
      printResult(runScenario("dead-exit-rotation", MappingPattern::Random, 4, false, false,
        true, false, true, 3, false, false, false, 2));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--random-invalid") {
      printResult(runScenario("random-invalid-ice-no-false-connect", MappingPattern::Random,
        4, false, true, true, false, true, 1, false, true));
      return 0;
    }
    if (argc > 1 && std::string(argv[1]).find("--random") == 0) {
      const bool extended = std::string(argv[1]) == "--random-multi-long";
      const bool shifted = std::string(argv[1]) == "--random-multi-offset";
      const unsigned allocationOffset = shifted && argc > 2 ? static_cast<unsigned>(std::stoul(argv[2])) : 0;
      require(!shifted || (argc > 2 && allocationOffset > 0 && allocationOffset < 256), "offset must be 1..255");
      const bool multi = std::string(argv[1]) == "--random-multi" || extended || shifted;
      if (multi) printResult(runScenario("stable-to-random-exact-filtering", MappingPattern::Random,
        4, true, false, true, false, true, 7, false, false, true, 0, 12, false, false, false, 4, false, false, false, allocationOffset));
      unsigned connected = 0, auxiliaryWinners = 0;
      std::vector<unsigned> seeds = {1, 2, 3, 4, 5, 6};
      if (argc > (shifted ? 3 : 2)) { seeds.clear(); for (int i = shifted ? 3 : 2; i < argc; ++i) seeds.push_back(static_cast<unsigned>(std::stoul(argv[i]))); }
      for (unsigned seed : seeds) {
        auto result = runScenario("random-nat-seed-" + std::to_string(seed) +
          (allocationOffset ? "-offset-" + std::to_string(allocationOffset) : ""),
          MappingPattern::Random, 4, multi, false, true, false, multi, seed, multi,
          false, false, 0, extended ? 35 : 12, false, false, false, 4, false, false, false, allocationOffset);
        connected += result.connected;
        auxiliaryWinners += result.selectedAuxiliarySockets;
        if (multi && !result.connected) for (const auto& ports : result.fixture.internalPorts)
          require(ports.size() > 1, "unsuccessful random exploration never expanded source diversity");
        printResult(result);
      }
      std::cout << "RANDOM-NAT " << (multi ? "multi" : "single") << " connected=" << connected << "/" << seeds.size() << std::endl;
      if (multi && argc == 2) {
        require(connected >= 2, "random multi socket did not improve finite NAT reachability");
        require(auxiliaryWinners > 0, "matrix never selected an auxiliary socket for real DTLS/SCTP");
      }
      return 0;
    }

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
