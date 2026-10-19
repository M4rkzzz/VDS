// Compile the exact fingerprinted header used by the shipped libjuice build.
// The DNS answer is synthetic; selection and localhost resolution are production code.
#define NOMINMAX
#include "stun_resolver.h"

#include <algorithm>
#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
unsigned checks = 0;
void require(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(message);
}

struct Answer {
  sockaddr_storage address{};
  addrinfo info{};
  Answer(int family, unsigned id, unsigned scope = 0) {
    info.ai_family = family;
    info.ai_socktype = SOCK_DGRAM;
    info.ai_protocol = IPPROTO_UDP;
    info.ai_addr = reinterpret_cast<sockaddr*>(&address);
    if (family == AF_INET) {
      auto& v4 = *reinterpret_cast<sockaddr_in*>(&address);
      v4.sin_family = AF_INET;
      v4.sin_port = htons(3478);
      v4.sin_addr.s_addr = htonl(0x7f000000u + id);
      info.ai_addrlen = sizeof(v4);
    } else {
      auto& v6 = *reinterpret_cast<sockaddr_in6*>(&address);
      v6.sin6_family = AF_INET6;
      v6.sin6_port = htons(3478);
      v6.sin6_addr.s6_addr[15] = static_cast<unsigned char>(id);
      v6.sin6_scope_id = scope;
      info.ai_addrlen = sizeof(v6);
    }
  }
};

void verify(std::vector<Answer*> answers, const std::vector<Answer*>& expected) {
  for (size_t i = 0; i < answers.size(); ++i)
    answers[i]->info.ai_next = i + 1 < answers.size() ? &answers[i + 1]->info : nullptr;
  struct Guarded {
    unsigned before = 0x12345678;
    addr_record_t records[2]{};
    unsigned after = 0x87654321;
  } output;
  const int count = vds_stun_select(answers.empty() ? nullptr : &answers[0]->info, output.records);
  require(count == static_cast<int>(expected.size()), "wrong number of distinct endpoints");
  require(output.before == 0x12345678 && output.after == 0x87654321, "selection exceeded two-record budget");
  for (int i = 0; i < count; ++i) {
    require(output.records[i].socktype == SOCK_DGRAM, "lost UDP socket type");
    require(output.records[i].len == expected[i]->info.ai_addrlen, "wrong address length");
    require(memcmp(&output.records[i].addr, expected[i]->info.ai_addr, output.records[i].len) == 0,
            "viable address family lost or resolver preference changed");
  }
}

void permutations() {
  Answer a(AF_INET6, 1), b(AF_INET6, 2), c(AF_INET, 1), d(AF_INET, 2);
  std::array<Answer*, 4> values{&a, &b, &c, &d};
  std::array<int, 4> order{0, 1, 2, 3};
  do {
    std::vector<Answer*> answers;
    for (int index : order) answers.push_back(values[index]);
    Answer* other = nullptr;
    for (auto* answer : answers)
      if (answer->info.ai_family != answers[0]->info.ai_family) { other = answer; break; }
    verify(answers, {answers[0], other});
  } while (std::next_permutation(order.begin(), order.end()));
  // Show the old two-record prefix's exact lost-family condition explicitly.
  require(a.info.ai_family == b.info.ai_family && b.info.ai_family != c.info.ai_family,
          "regression input does not exercise a third-position family");
  verify({&a, &b, &c}, {&a, &c});
  verify({&c, &d, &a}, {&c, &a});
}
} // namespace

int main() {
  try {
    permutations();
    Answer a(AF_INET, 1), same(AF_INET, 1), b(AF_INET, 2), c(AF_INET, 3);
    Answer v6(AF_INET6, 1), same6(AF_INET6, 1), scoped6(AF_INET6, 1, 7);
    verify({}, {});
    verify({&a}, {&a});
    verify({&v6}, {&v6});
    verify({&a, &same}, {&a});
    verify({&v6, &same6}, {&v6});
    verify({&v6, &scoped6}, {&v6, &scoped6});
    verify({&a, &same, &b, &c}, {&a, &b});
    verify({&a, &same, &b, &v6}, {&a, &v6});
    Answer invalid(AF_INET, 1);
    invalid.info.ai_addrlen = 1;
    verify({&invalid, &v6, &a}, {&v6, &a});
    invalid.info.ai_addrlen = sizeof(sockaddr_in);
    invalid.info.ai_addr = nullptr;
    verify({&invalid, &a}, {&a});
    invalid.info.ai_family = AF_UNSPEC;
    verify({&invalid}, {});
    invalid.info.ai_addr = reinterpret_cast<sockaddr*>(&invalid.address);
    invalid.info.ai_family = AF_INET6;
    invalid.info.ai_addrlen = sizeof(sockaddr_in6);
    verify({&invalid, &a}, {&a});
    WSADATA data{};
    require(WSAStartup(MAKEWORD(2, 2), &data) == 0, "Winsock startup failed");
    addr_record_t records[2]{};
    require(vds_stun_resolve("127.0.0.1", "3478", records) == 1, "numeric IPv4 resolution failed");
    require(records[0].addr.ss_family == AF_INET, "numeric IPv4 changed family");
    require(vds_stun_resolve("::1", "3478", records) == 1, "numeric IPv6 resolution failed");
    require(records[0].addr.ss_family == AF_INET6, "numeric IPv6 changed family");
    // Invalid numeric service fails locally, with no dependency on external DNS.
    require(vds_stun_resolve("127.0.0.1", "invalid-service-vds", records) == -1,
            "resolver failure was treated as a usable record");
    WSACleanup();
    std::cout << "PASS STUN DNS family selection: " << checks
              << " checks, 24 address-order permutations, duplicate/scope/invalid records, numeric resolution\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL STUN DNS family selection: " << error.what() << '\n';
    return 1;
  }
}
