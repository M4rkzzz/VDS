// Actual TCP sockets and the production RFC4571 parser. This is transport I/O
// validation, not a claim that two ICE agents can yet accept TCP connections.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
extern "C" {
#include "tcp.h"
}
#include <array>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
void require(bool ok, const char* why) { if (!ok) throw std::runtime_error(why); }
struct Socket {
 SOCKET value = INVALID_SOCKET;
 ~Socket() { if (value != INVALID_SOCKET) closesocket(value); }
};
void sendExact(SOCKET socket, const unsigned char* data, size_t size) {
 while (size) {
  const int n = send(socket, reinterpret_cast<const char*>(data), static_cast<int>(size), 0);
  require(n > 0, "loopback write failed"); data += n; size -= n;
 }
}
void backpressure(SOCKET sender, SOCKET receiver) {
 const int smallBuffer = 4096;
 require(setsockopt(sender, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&smallBuffer), sizeof(smallBuffer)) == 0, "small send buffer");
 u_long nonblocking = 1;
 require(ioctlsocket(sender, FIONBIO, &nonblocking) == 0, "nonblocking sender");
 tcp_ice_write_context_t write{}; tcp_ice_read_context_t read{};
 constexpr unsigned frames = 2048;
 unsigned sent = 0, received = 0, blocked = 0;
 std::array<char, TCP_ICE_BUFFER_SIZE> payload{};
 const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
 while (received < frames && std::chrono::steady_clock::now() < deadline) {
  // Force the actual OS send queue to fill before letting the slow reader run.
  while (sent < frames) {
   std::fill(payload.begin(), payload.end(), static_cast<char>(sent % 251));
   const int result = tcp_ice_write(sender, write.pending ? nullptr : payload.data(), payload.size(), &write);
   if (result == -SEAGAIN || result == -SEWOULDBLOCK) { ++blocked; break; }
   require(result == payload.size(), "backpressure writer failed"); ++sent;
  }
  for (unsigned batch = 0; batch < 16 && received < frames; ++batch) {
   const int result = tcp_ice_read(receiver, &read);
   if (result == -SEAGAIN || result == -SEWOULDBLOCK) break;
   require(result == payload.size(), "backpressure frame size corrupted");
   require(std::all_of(read.buffer, read.buffer + result, [received](char value) {
    return value == static_cast<char>(received % 251);
   }), "backpressure frame duplicated, reordered or overwritten");
   ++received;
  }
 }
 require(sent == frames && received == frames && !write.pending, "backpressure transfer stalled");
 require(blocked > 0, "test did not exercise real socket backpressure");
 std::cout << "PASS slow reader: frames=" << received << " bytes=" << received * payload.size() << " wouldBlock=" << blocked << '\n';
}
void run(int family) {
 Socket listener, client, peer;
 listener.value = socket(family, SOCK_STREAM, IPPROTO_TCP);
 require(listener.value != INVALID_SOCKET, "listener create");
 sockaddr_storage address{};
 int addressSize;
 if (family == AF_INET) {
  auto& a = reinterpret_cast<sockaddr_in&>(address); a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addressSize = sizeof(a);
 } else {
  auto& a = reinterpret_cast<sockaddr_in6&>(address); a.sin6_family = AF_INET6; a.sin6_addr = in6addr_loopback;
  addressSize = sizeof(a);
 }
 require(bind(listener.value, reinterpret_cast<sockaddr*>(&address), addressSize) == 0, "listener bind");
 require(listen(listener.value, 1) == 0, "listen");
 require(getsockname(listener.value, reinterpret_cast<sockaddr*>(&address), &addressSize) == 0, "listener address");
 client.value = socket(family, SOCK_STREAM, IPPROTO_TCP);
 require(client.value != INVALID_SOCKET && connect(client.value, reinterpret_cast<sockaddr*>(&address), addressSize) == 0, "connect");
 peer.value = accept(listener.value, nullptr, nullptr); require(peer.value != INVALID_SOCKET, "accept");
 const DWORD timeout = 2000;
 setsockopt(client.value, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
 u_long nonblocking = 1;
 require(ioctlsocket(peer.value, FIONBIO, &nonblocking) == 0, "nonblocking receiver");
 tcp_ice_read_context_t context{};
 const std::array<unsigned char, 5> frame{0,3,'a','b','c'};
 sendExact(client.value, frame.data(), 1);
 require(tcp_ice_read(peer.value, &context) == -SEWOULDBLOCK && context.bytes_read == 1, "real socket split header lost");
 sendExact(client.value, frame.data() + 1, frame.size() - 1);
 require(tcp_ice_read(peer.value, &context) == 3 && std::equal(context.buffer, context.buffer + 3, "abc"), "real socket split header payload");
 for (unsigned length : {2049u,65535u}) {
  std::vector<unsigned char> oversized(length + 2, 'x');
  oversized[0] = static_cast<unsigned char>(length >> 8); oversized[1] = static_cast<unsigned char>(length);
  for (size_t offset = 0; offset < oversized.size();) {
   const size_t n = std::min<size_t>(512, oversized.size() - offset);
   sendExact(client.value, oversized.data() + offset, n); offset += n;
   const int result = tcp_ice_read(peer.value, &context);
   require(result == (offset == oversized.size() ? -SEMSGSIZE : -SEWOULDBLOCK), "real socket oversized drain lost boundary");
  }
  sendExact(client.value, frame.data(), frame.size());
  require(tcp_ice_read(peer.value, &context) == 3 && std::equal(context.buffer, context.buffer + 3, "abc"), "valid frame after oversized frame");
 }
 const std::array<unsigned char, 2> empty{0,0}; sendExact(client.value, empty.data(), empty.size());
 require(tcp_ice_read(peer.value, &context) == -SEAGAIN, "empty frame yield");
 sendExact(client.value, frame.data(), frame.size());
 require(tcp_ice_read(peer.value, &context) == 3, "empty frame poisoned next message");
 backpressure(client.value, peer.value);
 shutdown(client.value, SD_SEND);
 // FIN may be delivered after data; poll avoids asserting scheduler timing.
 pollfd pfd{peer.value, POLLIN, 0}; require(WSAPoll(&pfd, 1, 2000) > 0, "FIN not received");
 require(tcp_ice_read(peer.value, &context) == 0, "EOF not reported");
 std::cout << "PASS real TCP framing family=" << (family == AF_INET ? "IPv4" : "IPv6") << '\n';
}
}
int main() {
 WSADATA wsa; if (WSAStartup(MAKEWORD(2,2), &wsa)) return 2;
 int result = 0;
 try { run(AF_INET); run(AF_INET6); }
 catch (const std::exception& error) { std::cerr << "FAIL " << error.what() << '\n'; result = 1; }
 WSACleanup(); return result;
}
