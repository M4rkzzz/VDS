// Test-only poll-event delay. Real sockets, STUN authentication, DTLS and SCTP
// remain intact. This DLL is isolated from the shipped runtime.
#include "conn_poll.h"
#include "tcp.h"
#include "timestamp.h"
#include <windows.h>

static volatile LONG target_port, delay_ms, withheld, zero_timeouts;
static volatile LONG64 delayed_socket = (LONG64)INVALID_SOCKET, not_before, began, released;
#define READ64(value) InterlockedCompareExchange64(&(value), 0, 0)
#define READ32(value) InterlockedCompareExchange(&(value), 0, 0)

__declspec(dllexport) void vds_test_tcp_delay(unsigned port, unsigned delay) {
 InterlockedExchange(&delay_ms, delay); InterlockedExchange64(&delayed_socket, (LONG64)INVALID_SOCKET);
 InterlockedExchange64(&began, 0); InterlockedExchange64(&not_before, 0); InterlockedExchange64(&released, 0);
 InterlockedExchange(&withheld, 0); InterlockedExchange(&zero_timeouts, 0); InterlockedExchange(&target_port, port);
}
__declspec(dllexport) unsigned vds_test_tcp_delay_elapsed(void) {
 const LONG64 finish = READ64(released), start = READ64(began);
 return finish && start ? (unsigned)(finish - start) : 0;
}
__declspec(dllexport) unsigned vds_test_tcp_delay_withheld(void) { return (unsigned)READ32(withheld); }
__declspec(dllexport) unsigned vds_test_tcp_delay_zero_timeouts(void) { return (unsigned)READ32(zero_timeouts); }

static socket_t track_delayed_socket(socket_t sock, const addr_record_t *dst) {
 const LONG port = READ32(target_port);
 if (sock != INVALID_SOCKET && port && addr_get_port((const struct sockaddr *)&dst->addr) == port) {
  const timestamp_t now = current_timestamp();
  InterlockedExchange64(&began, now); InterlockedExchange64(&not_before, now + READ32(delay_ms));
  InterlockedExchange64(&delayed_socket, (LONG64)sock);
 }
 return sock;
}
static socket_t delayed_create(const addr_record_t *dst) {
 return track_delayed_socket(tcp_create_socket(dst), dst);
}
static socket_t delayed_bound_create(const addr_record_t *dst, const addr_record_t *base) {
 return track_delayed_socket(tcp_create_bound_socket(dst, base), dst);
}
static int delayed_poll(struct pollfd *fds, nfds_t count, int timeout) {
 int delayed_index = -1; short events = 0;
 for (nfds_t i = 0; i < count; ++i) if (fds[i].fd == (socket_t)READ64(delayed_socket) && !READ64(released)) {
  if (current_timestamp() < READ64(not_before)) {
   if (timeout == 0) InterlockedIncrement(&zero_timeouts);
   delayed_index = (int)i; events = fds[i].events; fds[i].events = 0; InterlockedIncrement(&withheld);
   if (timeout < 0 || timeout > 10) timeout = 10;
  }
 }
 const int result = poll(fds, count, timeout);
 if (delayed_index >= 0) {
  fds[delayed_index].events = events;
  if (result == 0 && timeout == 0) Sleep(1);
 } else for (nfds_t i = 0; i < count; ++i)
  if (fds[i].fd == (socket_t)READ64(delayed_socket) && (fds[i].revents & POLLOUT) && !READ64(released))
   InterlockedExchange64(&released, current_timestamp());
 return result;
}
#define tcp_create_socket delayed_create
#define tcp_create_bound_socket delayed_bound_create
#undef poll
#define poll delayed_poll
#include "conn_poll.c"
