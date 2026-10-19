#include "nat_port_prediction.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <set>
#include <vector>

namespace {
int failures = 0;
int checks = 0;
constexpr std::uint32_t kAddress = 0xc0000201u;

void expect(bool result, const std::string& message) {
  ++checks;
  if (!result) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

vds_nat_port_observation observation(std::uint16_t port, std::uint32_t sequence,
    std::uint32_t address = kAddress, bool valid = true) {
  return {address, port, sequence, valid};
}

std::vector<std::uint16_t> predict(
    const std::vector<vds_nat_port_observation>& inputs,
    std::size_t capacity = 16, int* step = nullptr) {
  std::array<std::uint16_t, 32> output{};
  const auto count = vds_nat_predict_ports(inputs.data(), inputs.size(),
      output.data(), capacity, step);
  expect(count <= std::min<std::size_t>(capacity, 16), "linear output respects cap");
  return {output.begin(), output.begin() + count};
}

std::vector<std::uint16_t> neighbors(
    const std::vector<vds_nat_port_observation>& inputs,
    std::size_t capacity = 16) {
  std::array<std::uint16_t, 32> output{};
  const auto count = vds_nat_neighbor_ports(inputs.data(), inputs.size(),
      output.data(), capacity);
  expect(count <= std::min<std::size_t>(capacity, 16), "neighbor output respects cap");
  return {output.begin(), output.begin() + count};
}

void expect_valid_predictions(const std::vector<vds_nat_port_observation>& inputs,
    const std::vector<std::uint16_t>& ports, const std::string& message) {
  bool valid = ports.size() <= 16;
  for (std::size_t index = 0; index < ports.size(); ++index) {
    valid = valid && ports[index] >= 1024;
    valid = valid && std::find(ports.begin(), ports.begin() + index, ports[index]) ==
        ports.begin() + index;
    valid = valid && std::none_of(inputs.begin(), inputs.end(), [&](const auto& input) {
      return input.valid && input.port == ports[index];
    });
  }
  expect(valid, message);
}

void test_linear_and_reply_order() {
  const std::vector<vds_nat_port_observation> ordered{
      observation(42000, 10), observation(42004, 11), observation(42008, 12)};
  int step = 77;
  const auto ports = predict(ordered, 16, &step);
  expect(step == 4, "constant positive delta is classified");
  expect(ports == std::vector<std::uint16_t>{42012, 42016, 42020, 42024,
      42011, 42013, 42015, 42017, 42019, 42021, 42023, 42025},
      "future centers precede their one-port neighborhoods");
  auto reversed = ordered;
  std::reverse(reversed.begin(), reversed.end());
  expect(predict(reversed) == ports, "reply arrival order does not change prediction");
  expect_valid_predictions(ordered, ports, "positive prediction ports are bounded and distinct");

  const std::vector<vds_nat_port_observation> negative{
      observation(42008, 10), observation(42004, 11), observation(42000, 12)};
  const auto decreasing = predict(negative, 16, &step);
  expect(step == -4 && std::equal(decreasing.begin(), decreasing.begin() + 4,
      std::array<std::uint16_t, 4>{41996, 41992, 41988, 41984}.begin()),
      "negative allocation steps use signed arithmetic");
  expect_valid_predictions(negative, decreasing, "negative prediction ports are valid");
}

void test_mapping_classification() {
  const std::vector<vds_nat_port_observation> stable{
      observation(40000, 0), observation(40000, 1), observation(40000, 2)};
  int step = 77;
  expect(vds_nat_classify_ports(stable.data(), stable.size(), &step) ==
      VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT && step == 0,
      "stable mapping is distinguished from unknown allocation");
  expect(predict(stable).empty() && neighbors(stable).empty(),
      "stable mapping does not cause guessed port probes");

  const std::vector<std::vector<vds_nat_port_observation>> unknown{
      {observation(40000, 0), observation(40004, 1)},
      {observation(40000, 0), observation(40004, 2), observation(40008, 3)},
      {observation(40000, 0), observation(40004, 1), observation(40008, 1)},
      {observation(40000, 0), observation(40004, 1), observation(40000, 2)},
      {observation(40000, 0), observation(40017, 1), observation(40034, 2)},
      {observation(40111, 0), observation(55201, 1), observation(39777, 2)},
      {observation(40000, 0), observation(40004, 1, kAddress, false),
          observation(40008, 2), observation(40012, 3)},
      {observation(40000, UINT32_MAX - 1), observation(40004, UINT32_MAX),
          observation(40008, 0)}};
  for (std::size_t index = 0; index < unknown.size(); ++index) {
    step = 77;
    expect(vds_nat_classify_ports(unknown[index].data(), unknown[index].size(),
        &step) == VDS_NAT_MAPPING_UNKNOWN && step == 0,
        "unknown classification resets step for case " + std::to_string(index));
    expect(predict(unknown[index]).empty(),
        "unproven allocation does not trigger linear prediction");
    const auto fallback = neighbors(unknown[index]);
    expect(!fallback.empty(), "unknown mapping has an explicit bounded neighbor fallback");
    expect_valid_predictions(unknown[index], fallback, "fallback ports are valid");
  }
}

void test_no_cross_address_or_invalid_inputs() {
  const std::vector<std::vector<vds_nat_port_observation>> rejected{
      {observation(40000, 0), observation(40004, 1, kAddress + 1),
          observation(40008, 2)},
      {observation(40000, 0), observation(0, 1), observation(40008, 2)},
      {observation(40000, 0), observation(40004, 1, 0), observation(40008, 2)},
      std::vector<vds_nat_port_observation>(9, observation(40000, 0))};
  for (const auto& input : rejected) {
    expect(predict(input).empty() && neighbors(input).empty(),
        "mixed addresses, malformed observations, and oversized input are rejected");
  }
  expect(predict({}).empty() && neighbors({}).empty(), "empty observations are safe");
  std::uint16_t output = 0;
  int step = 77;
  expect(vds_nat_predict_ports(nullptr, 3, &output, 1, &step) == 0 && step == 0,
      "null input is safe and resets caller step");
  const std::vector<vds_nat_port_observation> valid{
      observation(40000, 0), observation(40004, 1), observation(40008, 2)};
  expect(vds_nat_predict_ports(valid.data(), valid.size(), nullptr, 16, &step) == 0 &&
      vds_nat_neighbor_ports(valid.data(), valid.size(), nullptr, 16) == 0,
      "null output is safe");
}

void test_range_capacity_and_neighbor_policy() {
  const std::vector<vds_nat_port_observation> upper{
      observation(65522, 0), observation(65526, 1), observation(65530, 2)};
  expect(predict(upper) == std::vector<std::uint16_t>{65534, 65533, 65535},
      "upper bound discards invalid centers without wrapping neighbors");
  const std::vector<vds_nat_port_observation> lower{
      observation(1034, 0), observation(1030, 1), observation(1026, 2)};
  expect(predict(lower).empty(), "negative predictions cannot enter privileged ports");
  const std::vector<vds_nat_port_observation> dense{
      observation(40000, 0), observation(40001, 1), observation(40002, 2)};
  expect(predict(dense) == std::vector<std::uint16_t>{40003, 40004, 40005, 40006, 40007},
      "overlapping centers and neighborhoods are deduplicated");
  for (std::size_t capacity = 0; capacity <= 32; ++capacity) {
    const auto ports = predict(dense, capacity);
    expect_valid_predictions(dense, ports, "all linear capacities stay within bounds");
  }
  const std::vector<vds_nat_port_observation> sparse{
      observation(40000, 0), observation(41000, 2), observation(42000, 4),
      observation(43000, 6), observation(44000, 8)};
  const auto fallback = neighbors(sparse, 32);
  expect(fallback.size() == 16 && fallback[0] == 44001 && fallback[1] == 43999,
      "fallback begins at latest confirmed sample and caps at four anchors");
  expect(std::none_of(fallback.begin(), fallback.end(), [](std::uint16_t port) {
    return port >= 39998 && port <= 40002;
  }), "fallback does not expand beyond the four latest anchors");
  expect_valid_predictions(sparse, fallback, "sixteen fallback ports are bounded and unique");
  const std::vector<vds_nat_port_observation> duplicate_anchors{
      observation(40000, 0), observation(40001, 1), observation(40000, 1)};
  expect_valid_predictions(duplicate_anchors, neighbors(duplicate_anchors),
      "duplicate fallback samples do not repeat observed or guessed ports");
  expect(neighbors({observation(1023, 0)}) == std::vector<std::uint16_t>{1024, 1025},
      "fallback applies lower bound independently to every port");
  expect(neighbors({observation(65535, 0)}) ==
      std::vector<std::uint16_t>{65534, 65533}, "fallback never wraps upper bound");
}

void test_deterministic_noise_invariants() {
  std::uint32_t random = 0x53b1802du;
  for (int iteration = 0; iteration < 2000; ++iteration) {
    std::vector<vds_nat_port_observation> input;
    for (std::uint32_t sequence = 0; sequence < 8; ++sequence) {
      random = random * 1664525u + 1013904223u;
      input.push_back(observation(static_cast<std::uint16_t>((random % 65535u) + 1u),
          sequence));
    }
    expect_valid_predictions(input, predict(input), "randomized linear prediction invariant");
    expect_valid_predictions(input, neighbors(input), "randomized neighbor prediction invariant");
  }
}

void test_shared_carrier_address_boundaries() {
  expect(vds_nat_is_public_ipv4_destination(0x643fffffu),
      "100.63.255.255 remains outside shared carrier range");
  expect(!vds_nat_is_public_ipv4_destination(0x64400000u),
      "100.64.0.0 bypasses public NAT sampling wait");
  expect(!vds_nat_is_public_ipv4_destination(0x647fffffu),
      "100.127.255.255 bypasses public NAT sampling wait");
  expect(vds_nat_is_public_ipv4_destination(0x64800000u),
      "100.128.0.0 remains outside shared carrier range");
  expect(!vds_nat_is_public_ipv4_destination(0x0a000001u) &&
      !vds_nat_is_public_ipv4_destination(0xac100001u) &&
      !vds_nat_is_public_ipv4_destination(0xc0a80101u) &&
      !vds_nat_is_public_ipv4_destination(0x7f000001u) &&
      !vds_nat_is_public_ipv4_destination(0xa9fe0001u),
      "LAN, loopback and link-local checks retain the immediate path");
  expect(vds_nat_is_public_ipv4_destination(0xc0000201u),
      "ordinary remote IPv4 checks still use NAT sampling");
}
} // namespace

static void test_random_exploration_policy() {
  expect(vds_nat_punch_target_socket(3, 0, 1, 1, true) == 0 &&
      vds_nat_punch_target_socket(3, 0, 1, 1, false) == 1,
    "only primary ICE destinations reuse their primary source; new hypotheses retain auxiliary diversity");
  expect(vds_nat_punch_target_socket(3, 1, 1, 2, true) == vds_nat_punch_socket(3, 1, 1, 2),
    "primary reuse replaces only one wave, preserving later source diversity");
  expect(vds_nat_punch_target_socket(3, 0, 0, 1, false) == 0,
    "no auxiliary bind still permits destination discovery on the primary socket");
  expect(vds_nat_punch_socket_count(VDS_NAT_MAPPING_UNKNOWN, VDS_NAT_MAPPING_UNKNOWN, 0) == 1,
    "double unknown uses destination diversity instead of a cartesian mapping burst");
  expect(vds_nat_punch_socket_count(VDS_NAT_MAPPING_UNKNOWN, VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT, 0) == 16,
    "random to stable retains source port fanout");
  expect(vds_nat_punch_socket_count(VDS_NAT_MAPPING_UNKNOWN, VDS_NAT_MAPPING_SEQUENTIAL, 0) == 16,
    "random to predictable retains source port fanout");
  expect(vds_nat_punch_socket_count(VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT, VDS_NAT_MAPPING_UNKNOWN, 100) == 1,
    "stable local keeps its original socket");
  for (unsigned pass = 1; pass < 8; ++pass)
    expect(vds_nat_punch_socket_count(VDS_NAT_MAPPING_UNKNOWN, VDS_NAT_MAPPING_UNKNOWN, pass)
      == (1u << std::min(pass, 4u)), "unsuccessful double random exploration expands without replacing old sockets");
  std::set<std::pair<unsigned, unsigned>> visited;
  std::set<unsigned> first_wave_targets, first_wave_sockets;
  for (unsigned wave = 0; wave < VDS_NAT_PUNCH_SOCKETS; ++wave) {
    for (unsigned target = 0; target < VDS_NAT_PUNCH_TARGETS; ++target) {
      const auto socket = vds_nat_punch_socket(target, wave, 1, VDS_NAT_PUNCH_SOCKETS);
      expect(socket >= 1 && socket <= VDS_NAT_PUNCH_SOCKETS, "planner uses an existing auxiliary socket");
      expect(visited.emplace(target, socket).second, "balanced waves must not duplicate a target/socket pair");
      if (!wave) { first_wave_targets.insert(target); first_wave_sockets.insert(socket); }
    }
  }
  expect(first_wave_targets.size() == VDS_NAT_PUNCH_TARGETS && first_wave_sockets.size() == VDS_NAT_PUNCH_SOCKETS,
    "first wave explores all destinations across the socket pool before repeating a destination");
  expect(visited.size() == VDS_NAT_PUNCH_TARGETS * VDS_NAT_PUNCH_SOCKETS,
    "interleaving retains the full search coverage without adding packets");
  expect(vds_nat_punch_socket(99, 0, 0, 1) == 0, "stable mapping keeps the original ICE socket");
  for (const auto anchor : {53u, 1024u, 42001u, 65535u}) {
    std::array<std::uint16_t, 100> ports{};
    auto count = vds_nat_random_ports(static_cast<std::uint16_t>(anchor), 12345u, ports.data(), ports.size());
    expect(count == ports.size(), "random exploration fills its connection-only plan at boundary anchors");
    std::set<std::uint16_t> unique(ports.begin(), ports.begin() + count);
    expect(unique.size() == count && !unique.count(static_cast<std::uint16_t>(anchor)), "random hypotheses are unique and exclude their anchor");
    expect(*unique.begin() >= 1024, "random hypotheses never wrap into low/zero ports");
    if (anchor >= 1024) {
      expect(std::any_of(ports.begin(), ports.end(), [&](auto port) { return (port & 0xff00u) != (anchor & 0xff00u); }),
             "random exploration includes the wider port space, not only a near-port scan");
    }
  }
  expect(vds_nat_random_ports(42000, 0, nullptr, 100) == 0, "absent random output is rejected");
  std::array<std::uint16_t, 100> initial{}, later{};
  vds_nat_random_ports_round(42000, 12345, 0, initial.data(), initial.size());
  vds_nat_random_ports_round(42000, 54321, 3, later.data(), later.size());
  const std::set<std::uint16_t> old(initial.begin(), initial.end());
  expect(std::count_if(later.begin(), later.end(), [&](auto port) { return !old.count(port); }) >= 90,
      "new full-range exploration expands beyond retransmitting the old hypotheses");
  expect(std::count_if(later.begin(), later.end(), [](auto port) { return (port & 0xff00u) != (42000 & 0xff00u); }) >= 90,
      "later plans abandon the allocation-block assumption");
  for (unsigned probes : {1u, 16u, 100u, 1600u}) {
    unsigned batches = (probes + 31u) / 32u;
    expect(vds_nat_punch_batch_offset(probes, 0) == 0 &&
        vds_nat_punch_batch_offset(probes, batches - 1u) == (batches - 1u) * 20u &&
        vds_nat_punch_batch_offset(probes, batches) == 2500 &&
        vds_nat_punch_batch_offset(probes, 2u * batches - 1u) < 5000,
      "first discovery stays fast while the existing retransmission covers the later half");
    for (unsigned batch = 1; batch < 2u * batches; ++batch)
      expect(vds_nat_punch_batch_offset(probes, batch) >= vds_nat_punch_batch_offset(probes, batch - 1u) + 20u,
        "no scheduled batch increases the original poll work rate");
  }
  expect(vds_nat_exploration_rank(VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT) <
      vds_nat_exploration_rank(VDS_NAT_MAPPING_SEQUENTIAL) &&
      vds_nat_exploration_rank(VDS_NAT_MAPPING_SEQUENTIAL) < vds_nat_exploration_rank(VDS_NAT_MAPPING_UNKNOWN),
      "exploration prefers confirmed mappings before uncertain predictions");
}

static void test_observed_random_ranges() {
  // Same-block and insufficient evidence must not perturb existing plans.
  for (unsigned seed = 1; seed <= 1000; ++seed) {
    for (unsigned round = 0; round < 4; ++round) {
      const std::array<uint16_t, 4> same{40100, 40020, 40110, 39990};
      const std::array<uint16_t, 2> sparse{40100, 40300};
      std::array<uint16_t, 100> before{}, after{};
      vds_nat_random_ports_round(40100, seed, round, before.data(), before.size());
      vds_nat_random_ports_sampled_round(40100, same.data(), same.size(), seed, round, after.data(), after.size());
      expect(before == after, "same-block observations preserve exact random plan");
      vds_nat_random_ports_sampled_round(40100, sparse.data(), sparse.size(), seed, round, after.data(), after.size());
      expect(before == after, "two samples do not invent an allocation range");
    }
  }
  for (const std::vector<uint16_t> samples : {
      std::vector<uint16_t>{40180, 40110, 40220, 40270},
      std::vector<uint16_t>{1024, 1279, 1280, 1400},
      std::vector<uint16_t>{65000, 65280, 65534, 65535},
      std::vector<uint16_t>{1040, 20000, 40000, 65000}}) {
    for (unsigned seed = 1; seed <= 100; ++seed) {
      std::array<uint16_t, 100> ports{}, reversed{};
      const auto count = vds_nat_random_ports_sampled_round(samples[0], samples.data(), samples.size(), seed, 0, ports.data(), ports.size());
      std::set<uint16_t> unique(ports.begin(), ports.end());
      expect(count == 100 && unique.size() == 100 && *unique.begin() >= 1024 && !unique.count(samples[0]),
        "cross-boundary hypotheses remain unique, nonzero, unprivileged and within budget");
      auto reordered = samples;
      std::reverse(reordered.begin(), reordered.end());
      vds_nat_random_ports_sampled_round(samples[0], reordered.data(), reordered.size(), seed, 0, reversed.data(), reversed.size());
      expect(ports == reversed, "arrival order does not change inferred sampling interval");
      if (samples[0] == 40180)
        expect(std::all_of(ports.begin(), ports.begin() + 75, [](auto p) { return p >= 40057 && p <= 40323; }),
          "nearby hypotheses use the sample envelope and tail allowance, not arbitrary full-range ports");
      expect(std::any_of(ports.begin(), ports.begin() + 75, [&](auto p) { return (p & 0xff00u) != (samples[0] & 0xff00u); }),
        "nearby exploration respects observations beyond the anchor block");
      vds_nat_random_ports_sampled_round(samples[0], samples.data(), samples.size(), seed, 3, ports.data(), ports.size());
      vds_nat_random_ports_round(samples[0], seed, 3, reversed.data(), reversed.size());
      expect(ports == reversed, "late full-range exploration stays unchanged");
    }
  }
}

void test_joint_concentration_policy() {
  const std::array<uint16_t, 4> compact{40000, 40070, 40130, 40180};
  const std::array<uint16_t, 4> wide{40000, 40200, 40400, 40600};
  const std::array<uint16_t, 4> duplicated{40000, 40000, 40070, 40070};
  expect(vds_nat_ports_concentrated(compact.data(), compact.size()), "three distinct same-block samples enable a hint");
  expect(!vds_nat_ports_concentrated(duplicated.data(), duplicated.size()), "duplicate samples cannot manufacture confidence");
  expect(!vds_nat_ports_concentrated(wide.data(), wide.size()), "wide-spread samples do not enable concentration");
  expect(!vds_nat_ports_concentrated(compact.data(), 2), "two samples retain existing policy");
  expect(!vds_nat_ports_concentrated(nullptr, 4), "missing samples retain existing policy");
  const std::array<uint16_t, 4> shifted{32840, 32892, 33028, 33062};
  expect(vds_nat_ports_concentrated(shifted.data(), shifted.size()), "four compact samples can cross the aligned block boundary");
  expect(!vds_nat_ports_concentrated(shifted.data(), 3), "three cross-boundary samples keep the conservative old behavior");
  const std::array<uint16_t, 4> span255{32840, 32892, 33028, 33095};
  const std::array<uint16_t, 4> span256{32840, 32892, 33028, 33096};
  const std::array<uint16_t, 4> repeated{32840, 32892, 33028, 33028};
  expect(vds_nat_ports_concentrated(span255.data(), span255.size()), "inclusive range of 256 ports is allowed");
  expect(!vds_nat_ports_concentrated(span256.data(), span256.size()), "range exceeding 256 ports is not compact");
  expect(!vds_nat_ports_concentrated(repeated.data(), repeated.size()), "a duplicated cross-boundary sample cannot supply the fourth observation");
  for (unsigned offset = 0; offset < 256; ++offset) {
    std::array<uint16_t, 4> translated{};
    const std::array<unsigned, 4> relative{0, 40, 140, 220};
    for (size_t i = 0; i < translated.size(); ++i) translated[i] = static_cast<uint16_t>(32768 + offset + relative[i]);
    expect(vds_nat_ports_concentrated(translated.data(), translated.size()), "compact four-sample evidence must not depend on block alignment");
    std::reverse(translated.begin(), translated.end());
    expect(vds_nat_ports_concentrated(translated.data(), translated.size()), "trickle arrival order must not change concentration evidence");
  }
  std::array<vds_nat_port_observation, 4> shiftedLocal{};
  for (size_t i = 0; i < shifted.size(); ++i) shiftedLocal[i] = observation(shifted[i], static_cast<unsigned>(i + 1));
  expect(vds_nat_observations_concentrated(shiftedLocal.data(), shiftedLocal.size()), "validated local cross-boundary samples enable the independent hint");
  shiftedLocal[3].valid = false;
  expect(!vds_nat_observations_concentrated(shiftedLocal.data(), shiftedLocal.size()), "invalid local fourth sample cannot broaden the hint");
  auto local = std::array<vds_nat_port_observation, 3>{observation(40000, 1), observation(40070, 2), observation(40130, 3)};
  expect(vds_nat_observations_concentrated(local.data(), local.size()), "validated local observations provide independent evidence");
  local[2].address = kAddress + 1;
  expect(!vds_nat_observations_concentrated(local.data(), local.size()), "different public exits cannot combine evidence");
  local[2] = observation(40130, 2);
  expect(!vds_nat_observations_concentrated(local.data(), local.size()), "one transaction cannot manufacture two samples");
  local[2] = observation(40130, 3, kAddress, false);
  expect(!vds_nat_observations_concentrated(local.data(), local.size()), "invalid samples cannot enable concentration");
  for (unsigned seed = 1; seed <= 1000; ++seed) {
    for (unsigned round = 0; round <= 4; ++round) {
      std::array<uint16_t, 100> before{}, after{};
      vds_nat_random_ports_sampled_round(compact[0], compact.data(), compact.size(), seed, round, before.data(), before.size());
      vds_nat_random_ports_joint_round(compact[0], compact.data(), compact.size(), seed, round, false, after.data(), after.size());
      expect(before == after, "one-sided evidence preserves the exact old plan");
      vds_nat_random_ports_sampled_round(wide[0], wide.data(), wide.size(), seed, round, before.data(), before.size());
      vds_nat_random_ports_joint_round(wide[0], wide.data(), wide.size(), seed, round, true, after.data(), after.size());
      expect(before == after, "local evidence alone cannot narrow a broad remote sample");
    }
    std::array<uint16_t, 100> ports{}, oldLate{};
    const auto count = vds_nat_random_ports_joint_round(compact[0], compact.data(), compact.size(), seed, 0, true, ports.data(), ports.size());
    const std::set<uint16_t> unique(ports.begin(), ports.end());
    expect(count == 100 && unique.size() == 100 && !unique.count(compact[0]) && *unique.begin() >= 1024,
      "joint hint retains target budget, uniqueness and valid ports");
    expect(std::all_of(ports.begin(), ports.begin() + 95, [&](auto p) {return (p & 0xff00u) == (compact[0] & 0xff00u);}),
      "joint hint prioritizes its near region");
    for (unsigned round : {3u, 4u}) {
      vds_nat_random_ports_joint_round(compact[0], compact.data(), compact.size(), seed, round, true, ports.data(), ports.size());
      vds_nat_random_ports_round(compact[0], seed, round, oldLate.data(), oldLate.size());
      expect(ports == oldLate, "concentration hint must not postpone the original full-range search");
    }
  }
}

void test_confirmed_destination_diversity() {
  const std::array<vds_nat_port_observation, 3> stable{
    observation(42000, 1), observation(42000, 2), observation(42000, 3)};
  const std::array<uint32_t, 3> same{0xc0000201u, 0xc0000201u, 0xc0000201u};
  const std::array<uint32_t, 3> diverse{0xc0000201u, 0xc0000201u, 0xc0000202u};
  const std::array<uint32_t, 3> absent{0, 0, 0};
  const auto mode = [&](const uint32_t* addresses, size_t size) {
    return vds_nat_classify_mapping(stable.data(), stable.size(), addresses, size);
  };
  expect(mode(same.data(), same.size()) == VDS_NAT_MAPPING_UNKNOWN,
    "same-IP STUN ports do not prove endpoint-independent mapping");
  expect(mode(diverse.data(), diverse.size()) == VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT,
    "equal mappings across confirmed server addresses preserve stable strategy");
  expect(mode(absent.data(), absent.size()) == VDS_NAT_MAPPING_UNKNOWN,
    "missing address evidence cannot claim stable mapping");
  expect(mode(nullptr, 0) == VDS_NAT_MAPPING_UNKNOWN, "absent destinations remain unknown");
  expect(mode(same.data(), VDS_NAT_MAX_OBSERVATIONS + 1) == VDS_NAT_MAPPING_UNKNOWN,
    "invalid evidence count is rejected without reading it");
  expect(vds_nat_classify_mapping(stable.data(), 2, diverse.data(), 3) == VDS_NAT_MAPPING_UNKNOWN,
    "destination diversity does not override sparse port evidence");
  auto linear = stable; linear[1].port++; linear[2].port += 2;
  expect(vds_nat_classify_mapping(linear.data(), 3, same.data(), 3) == VDS_NAT_MAPPING_SEQUENTIAL,
    "port-dependent linear observations retain existing prediction behavior");
  linear[2].port += 17;
  expect(vds_nat_classify_mapping(linear.data(), 3, diverse.data(), 3) == VDS_NAT_MAPPING_UNKNOWN,
    "destination diversity does not override random mapping evidence");
}

int main() {
  test_joint_concentration_policy();
  test_confirmed_destination_diversity();
  test_observed_random_ranges();
  test_random_exploration_policy();
  test_shared_carrier_address_boundaries();
  test_linear_and_reply_order();
  test_mapping_classification();
  test_no_cross_address_or_invalid_inputs();
  test_range_capacity_and_neighbor_policy();
  test_deterministic_noise_invariants();
  if (failures != 0) {
    std::cerr << failures << " failed assertions out of " << checks << '\n';
    return 1;
  }
  std::cout << "NAT port prediction: " << checks << " assertions passed\n";
  return 0;
}
