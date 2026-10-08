#include "nat_port_prediction.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
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

int main() {
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
