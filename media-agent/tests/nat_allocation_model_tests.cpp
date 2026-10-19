// Deterministic allocation/filtering model, NOT ICE/DTLS/SCTP or a network test.
// Shares production planning helpers; models all outbound destinations, including
// ports outside the receiver's allocation pool. No wall clock, OS sockets or RNG.
#include "nat_port_prediction.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <map>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

namespace {
unsigned assertions = 0;
void require(bool value, const char* message) {
  ++assertions;
  if (!value) throw std::runtime_error(message);
}
struct Random {
  uint32_t state;
  uint32_t next() { state ^= state << 13; state ^= state >> 17; state ^= state << 5; return state; }
};
// Address IDs 0/1 are peer public IPs, 2 is a STUN server IP.
struct Endpoint {
  unsigned ip, port;
  bool operator<(const Endpoint& other) const { return std::tie(ip, port) < std::tie(other.ip, other.port); }
  bool operator==(const Endpoint& other) const { return ip == other.ip && port == other.port; }
};
struct Mapping { unsigned source; std::set<Endpoint> allowed; };
struct Nat {
  unsigned base, capacity;
  bool stable;
  std::vector<unsigned> order;
  std::map<unsigned, Mapping> slots;
  std::map<std::pair<unsigned, Endpoint>, unsigned> keys;
  unsigned fullDrops = 0, outsideAllocations = 0;
  Nat(unsigned begin, unsigned maxMappings, uint32_t seed, bool independent = false, unsigned width = 0)
      : base(begin), capacity(maxMappings), stable(independent), order(width ? width : maxMappings) {
    require(capacity > 0 && capacity <= order.size() && base >= 1024 && base + order.size() <= 65536, "invalid NAT pool");
    Random random{seed ? seed : 1};
    for (unsigned i = 0; i < order.size(); ++i) order[i] = i;
    // Defined Fisher-Yates order: reproducible across C++ library versions.
    for (unsigned i = static_cast<unsigned>(order.size()); i > 1; --i) std::swap(order[i - 1], order[random.next() % i]);
  }
  bool inPool(unsigned port) const { return port >= base && port - base < order.size(); }
  std::optional<unsigned> send(unsigned source, Endpoint remote, bool outside = false) {
    const auto key = std::make_pair(source, stable ? Endpoint{0, 0} : remote);
    const auto found = keys.find(key);
    if (found != keys.end()) {
      slots.at(found->second).allowed.insert(remote);
      return found->second;
    }
    if (slots.size() == capacity) { ++fullDrops; return std::nullopt; }
    const unsigned port = base + order[slots.size()];
    slots.emplace(port, Mapping{source, {remote}});
    keys.emplace(key, port);
    if (outside) ++outsideAllocations;
    return port;
  }
  std::optional<unsigned> receive(unsigned port, Endpoint remote) const {
    const auto found = slots.find(port);
    if (found == slots.end() || !found->second.allowed.count(remote)) return std::nullopt;
    return found->second.source;
  }
};
struct Event {
  unsigned time, sequence, side, source, target, transaction, expiry;
  // 0=send request, 1=deliver request, 2=deliver response. For delivery,
  // source is the sending public port; target is receiving public port.
  unsigned kind = 0;
  bool operator<(const Event& other) const {
    return std::tie(time, sequence) > std::tie(other.time, other.sequence);
  }
};
struct Result {
  bool responsePath = false;
  unsigned atMs = 0, deliveredRequests = 0, deliveredResponses = 0, requests = 0;
  std::array<unsigned, 2> allocations{}, outside{}, fullDrops{};
  unsigned reciprocalPairs = 0;
  bool operator==(const Result& other) const {
    return std::tie(responsePath, atMs, deliveredRequests, deliveredResponses, requests,
      allocations, outside, fullDrops, reciprocalPairs) ==
      std::tie(other.responsePath, other.atMs, other.deliveredRequests, other.deliveredResponses,
        other.requests, other.allocations, other.outside, other.fullDrops, other.reciprocalPairs);
  }
};

// Probe-start skew models signaling/peer scheduling after both STUN samples
// exist. It does not model DNS delay, mapping expiration or packet loss.
struct Timing { unsigned secondStartMs = 0, oneWayMs = 10; };
Result simulate(unsigned seed, unsigned offset, bool allDestinations, bool stableFirst = false,
    unsigned width = 256, unsigned capacity = 256, unsigned secondWidth = 0,
    unsigned secondCapacity = 0, unsigned secondOffset = ~0u, Timing timing = {}) {
  if (!secondWidth) secondWidth = width;
  if (!secondCapacity) secondCapacity = capacity;
  if (secondOffset == ~0u) secondOffset = offset;
  const unsigned base = (width > 16384 ? 1024 : 32768) + offset;
  const unsigned secondBase = (secondWidth > 16384 ? 1024 : 32768) + secondOffset;
  std::array<Nat, 2> nat{Nat(base, capacity, seed * 31 + 1, stableFirst, width),
    Nat(secondBase, secondCapacity, seed * 31 + 2, false, secondWidth)};
  std::array<std::vector<uint16_t>, 2> observed, ordinary;
  for (unsigned side = 0; side < 2; ++side) {
    std::array<vds_nat_port_observation, 4> samples{};
    for (unsigned i = 0; i < 4; ++i) {
      const auto port = nat[side].send(0, {2, 3478 + i});
      require(port.has_value(), "STUN sample allocation failed");
      samples[i] = {side + 1, static_cast<uint16_t>(*port), i + 1, true};
      if (std::find(observed[side].begin(), observed[side].end(), *port) == observed[side].end())
        observed[side].push_back(static_cast<uint16_t>(*port));
    }
    ordinary[side] = observed[side];
    uint16_t neighbors[16];
    const auto count = vds_nat_neighbor_ports(samples.data(), samples.size(), neighbors, 16);
    ordinary[side].insert(ordinary[side].end(), neighbors, neighbors + count);
  }
  std::priority_queue<Event> events;
  unsigned sequence = 0, transaction = 0;
  std::map<unsigned, std::tuple<unsigned, unsigned, unsigned, unsigned>> outstanding;
  auto schedule = [&](unsigned time, unsigned side, unsigned source, unsigned target, unsigned tx, unsigned expiry) {
    events.push({time, sequence++, side, source, target, tx, expiry});
    outstanding[tx] = {side, source, target, expiry};
  };
  for (unsigned side = 0; side < 2; ++side) {
    const unsigned sideStart = side ? timing.secondStartMs : 0;
    for (const auto port : ordinary[1 - side]) {
      const unsigned tx = ++transaction;
      for (const unsigned time : {0u, 500u, 1500u, 3500u, 7500u})
        schedule(sideStart + time, side, 0, port, tx, sideStart + 12000);
    }
    for (unsigned round = 0; round < 3; ++round) {
      const auto& remote = observed[1 - side];
      std::vector<uint16_t> ports = remote;
      const bool remoteStable = stableFirst && side == 1;
      if (!remoteStable) {
        uint16_t guesses[VDS_NAT_PUNCH_TARGETS];
        // Independent seeded stream per side/plan, held fixed in paired comparisons.
        Random random{seed * 65537u + side * 193u + round * 7919u + 17u};
        const auto count = vds_nat_random_ports_joint_round(remote.front(), remote.data(), remote.size(),
          random.next(), round, vds_nat_ports_concentrated(observed[side].data(), observed[side].size()), guesses, VDS_NAT_PUNCH_TARGETS);
        for (size_t i = 0; i < count && ports.size() < VDS_NAT_PUNCH_TARGETS; ++i)
          if (std::find(ports.begin(), ports.end(), guesses[i]) == ports.end()) ports.push_back(guesses[i]);
        if (remote.size() > 1) std::rotate(ports.begin(), ports.begin() + remote.size(), ports.end());
      }
      const int localMode = stableFirst && side == 0 ? VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT : VDS_NAT_MAPPING_UNKNOWN;
      const int remoteMode = remoteStable ? VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT : VDS_NAT_MAPPING_UNKNOWN;
      const unsigned sockets = vds_nat_punch_socket_count(localMode, remoteMode, round);
      const unsigned first = localMode == VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT ? 0 : 1;
      const unsigned probes = static_cast<unsigned>(ports.size()) * sockets;
      const unsigned batches = (probes + 31) / 32;
      for (unsigned wave = 0; wave < sockets; ++wave) for (unsigned target = 0; target < ports.size(); ++target) {
        const bool primary = remote.size() > 1 && localMode == VDS_NAT_MAPPING_UNKNOWN && remoteMode == VDS_NAT_MAPPING_UNKNOWN &&
          std::find(ordinary[1 - side].begin(), ordinary[1 - side].end(), ports[target]) != ordinary[1 - side].end();
        const unsigned source = vds_nat_punch_target_socket(target, wave, first, sockets, primary);
        const unsigned index = wave * static_cast<unsigned>(ports.size()) + target;
        const unsigned tx = ++transaction, start = sideStart + 500 + round * 5000;
        for (unsigned repeat = 0; repeat < 2; ++repeat)
          schedule(start + vds_nat_punch_batch_offset(probes, repeat * batches + index / 32), side, source, ports[target], tx, start + 5000);
      }
    }
  }
  Result result;
  while (!events.empty()) {
    const auto e = events.top(); events.pop();
    if (e.time > timing.secondStartMs + 12000) break;
    if (e.kind == 0) {
      if (result.responsePath) continue; // usable response path stops further exploration
      ++result.requests;
      const bool outside = !nat[1 - e.side].inPool(e.target);
      if (!allDestinations && outside) continue; // deliberately reproduce clipping error
      const auto port = nat[e.side].send(e.source, {1 - e.side, e.target}, outside);
      if (port) events.push({e.time + timing.oneWayMs, sequence++, e.side, *port, e.target, e.transaction, e.expiry, 1});
      continue;
    }
    const unsigned receiver = 1 - e.side;
    const auto internal = nat[receiver].receive(e.target, {e.side, e.source});
    if (!internal) continue; // inbound never allocates a mapping or opens a filter
    if (e.kind == 1) {
      ++result.deliveredRequests;
      const auto source = nat[receiver].send(*internal, {e.side, e.source});
      if (source) events.push({e.time + timing.oneWayMs, sequence++, receiver, *source, e.source, e.transaction, e.expiry, 2});
    } else {
      const auto found = outstanding.find(e.transaction);
      if (found == outstanding.end()) continue;
      const auto [side, socket, target, expiry] = found->second;
      if (receiver != side || *internal != socket || e.source != target || e.time >= expiry) continue;
      ++result.deliveredResponses;
      if (!result.responsePath) { result.responsePath = true; result.atMs = e.time; }
    }
  }
  for (unsigned side = 0; side < 2; ++side) {
    result.allocations[side] = static_cast<unsigned>(nat[side].slots.size());
    result.outside[side] = nat[side].outsideAllocations;
    result.fullDrops[side] = nat[side].fullDrops;
  }
  for (const auto& [port, mapping] : nat[0].slots) for (const auto& remote : mapping.allowed)
    if (remote.ip == 1 && nat[1].receive(remote.port, {0, port})) ++result.reciprocalPairs;
  return result;
}

void print(unsigned seed, unsigned offset, bool full, const Result& r, unsigned width = 256, unsigned capacity = 256,
    unsigned secondWidth = 0, unsigned secondCapacity = 0, unsigned secondOffset = 0,
    unsigned startSkewMs = 0, unsigned oneWayMs = 0) {
  std::cout << "{\"seed\":" << seed << ",\"offset\":" << offset << ",\"allDestinations\":" << (full ? "true" : "false")
    << ",\"poolWidth\":" << width << ",\"mappingCapacity\":" << capacity;
  if (secondWidth) std::cout << ",\"secondPoolWidth\":" << secondWidth
    << ",\"secondMappingCapacity\":" << secondCapacity << ",\"secondOffset\":" << secondOffset;
  if (oneWayMs) std::cout << ",\"startSkewMs\":" << startSkewMs << ",\"oneWayMs\":" << oneWayMs;
  std::cout << ",\"responsePath\":" << (r.responsePath ? "true" : "false") << ",\"atMs\":" << r.atMs
    << ",\"requests\":" << r.requests << ",\"deliveredRequests\":" << r.deliveredRequests
    << ",\"deliveredResponses\":" << r.deliveredResponses << ",\"allocations\":[" << r.allocations[0] << ',' << r.allocations[1]
    << "],\"outsideAllocations\":[" << r.outside[0] << ',' << r.outside[1] << "],\"fullDrops\":[" << r.fullDrops[0] << ',' << r.fullDrops[1]
    << "],\"reciprocalPairs\":" << r.reciprocalPairs << "}\n";
}
void unitTests() {
  Nat nat(32768, 4, 1);
  require(!nat.receive(32768, {1, 1234}), "inbound created mapping");
  const auto outside = nat.send(1, {1, 1234}, true);
  require(outside && nat.outsideAllocations == 1 && nat.slots.size() == 1, "out-of-pool send must consume mapping");
  require(nat.send(1, {1, 1234}, true) == outside && nat.slots.size() == 1, "retransmission must reuse mapping");
  require(!nat.receive(*outside, {1, 1235}) && !nat.receive(*outside, {0, 1234}), "endpoint filter must match address and port");
  require(nat.receive(*outside, {1, 1234}) == 1, "matching return packet rejected");
  const auto otherSource = nat.send(2, {1, 1234}, true);
  require(otherSource && otherSource != outside, "new source must have own mapping");
  nat.send(1, {1, 1235}, true); nat.send(1, {2, 1234}, true);
  require(!nat.send(1, {1, 1236}, true) && nat.fullDrops == 1, "full table must reject new mapping");
  require(nat.send(1, {1, 1234}, true) == outside, "full table must retain existing mapping");
  require(nat.receive(*outside, {1, 1234}) == 1, "full table must retain return traffic");
  Nat wide(32768, 2, 1, false, 4096);
  const auto w1 = wide.send(0, {1, 60000});
  const auto w2 = wide.send(0, {1, 60001});
  require(w1 && w2 && wide.inPool(*w1) && wide.inPool(*w2), "wide pool allocation invalid");
  require(!wide.send(0, {1, 60002}) && wide.slots.size() == 2, "pool width must not enlarge mapping capacity");
  require(wide.inPool(32768 + 4095) && !wide.inPool(32768 + 4096), "pool range differs from capacity");
  Nat stable(32768, 4, 1, true);
  require(stable.send(1, {1, 1234}) == stable.send(1, {1, 5678}), "stable mapping must reuse external port");
  for (unsigned seed = 1; seed <= 12; ++seed) {
    const auto full = simulate(seed, 64, true);
    require(full == simulate(seed, 64, true, false, 256, 256, 256, 256, 64),
            "explicit symmetric NAT inputs changed the existing baseline");
    const auto mixed = simulate(seed, 64, true, false, 256, 64, 1024, 128, 0);
    require(mixed == simulate(seed, 64, true, false, 256, 64, 1024, 128, 0),
            "mixed NAT simulation must replay exactly");
    require(mixed.allocations[0] <= 64 && mixed.allocations[1] <= 128,
            "one NAT inherited the other NAT's capacity");
    require(!mixed.responsePath || (mixed.reciprocalPairs && mixed.deliveredResponses),
            "mixed NAT coverage mistaken for returned response");
    require(full == simulate(seed, 64, true), "simulation must be exactly replayable");
    require(full.allocations[0] <= 256 && full.allocations[1] <= 256, "finite allocation overflow");
    require(full.outside[0] + full.outside[1] > 0, "full model must allocate missed outside targets");
    require(!full.responsePath || (full.reciprocalPairs && full.deliveredResponses), "coverage mistaken for response path");
    const auto clipped = simulate(seed, 64, false);
    require(clipped.outside[0] + clipped.outside[1] == 0, "clipped negative control allocated outside");
    const auto control = simulate(seed, 64, true, true);
    require(control.responsePath, "stable/random positive control did not form response path");
  }
  const auto unchanged = simulate(1, 64, true);
  require(unchanged == simulate(1, 64, true, false, 256, 256, 0, 0, ~0u, {0,10}),
          "default timing changed baseline behavior");
  for (const Timing timing : {Timing{250,10}, Timing{1000,100}, Timing{6000,300}}) {
    const auto delayed = simulate(1, 64, true, false, 256, 256, 0, 0, ~0u, timing);
    require(delayed == simulate(1, 64, true, false, 256, 256, 0, 0, ~0u, timing),
            "delayed probes must replay exactly");
    require(!delayed.responsePath || delayed.atMs >= timing.secondStartMs + 2 * timing.oneWayMs,
            "response arrived before delayed peer started or before round trip");
    const auto control = simulate(1, 0, true, true, 256, 256, 0, 0, ~0u, timing);
    require(control.responsePath, "delayed stable/random control failed");
  }
  const auto early = simulate(3041, 0, true);
  require(early.responsePath && early.outside[0] == 0 && early.outside[1] == 0,
          "early success must not be required to allocate unused global hypotheses");
  std::cout << "PASS allocation model: " << assertions << " assertions (not ICE/DTLS connectivity)\n";
}
} // namespace
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--matrix") {
      for (unsigned offset : {0u, 64u, 128u, 192u}) for (unsigned seed = 1; seed <= 1000; ++seed)
        for (bool full : {false, true}) print(seed, offset, full, simulate(seed, offset, full));
    } else if (argc == 2 && std::string(argv[1]) == "--pool-matrix") {
      for (const auto [width, capacity] : std::array<std::pair<unsigned, unsigned>, 7>{
          {{256, 256}, {1024, 256}, {1024, 1024}, {4096, 256}, {4096, 1024}, {16384, 1024}, {64512, 4096}}})
        for (unsigned seed = 1; seed <= 1000; ++seed)
          for (bool full : {false, true}) print(seed, 0, full, simulate(seed, 0, full, false, width, capacity), width, capacity);
    } else if (argc == 2 && std::string(argv[1]) == "--mixed-matrix") {
      // Both directions matter: packet scheduling and NAT permutations differ.
      for (const auto profile : std::array<std::array<unsigned, 4>, 10>{{
          {{256,256,1024,256}}, {{1024,256,256,256}},
          {{256,256,1024,1024}}, {{1024,1024,256,256}},
          {{256,256,4096,256}}, {{4096,256,256,256}},
          {{1024,256,4096,1024}}, {{4096,1024,1024,256}},
          {{256,256,64512,4096}}, {{64512,4096,256,256}}}})
        for (unsigned seed = 1; seed <= 1000; ++seed)
          print(seed, 0, true, simulate(seed, 0, true, false, profile[0], profile[1], profile[2], profile[3], 0),
                profile[0], profile[1], profile[2], profile[3], 0);
    } else if (argc == 2 && std::string(argv[1]) == "--timing-matrix") {
      for (const Timing timing : {Timing{0,10}, Timing{250,10}, Timing{1000,10}, Timing{3000,10},
           Timing{6000,10}, Timing{1000,100}, Timing{3000,300}, Timing{6000,300}})
        for (unsigned offset : {0u, 64u, 128u, 192u})
          for (unsigned seed = 1; seed <= 1000; ++seed)
            print(seed, offset, true, simulate(seed, offset, true, false, 256, 256, 0, 0, ~0u, timing),
                  256, 256, 0, 0, 0, timing.secondStartMs, timing.oneWayMs);
    } else {
      require(argc == 1, "usage: vds-nat-allocation-model-tests [--matrix|--pool-matrix|--mixed-matrix|--timing-matrix]");
      unitTests();
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL allocation model: " << error.what() << '\n'; return 1; }
}
