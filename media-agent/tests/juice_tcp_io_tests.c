/* Compile the fingerprinted production TCP parser and poll handlers, replacing
 * only socket reads/writes and agent callbacks with deterministic fixtures. */
#include "agent.h"
#include "tcp.h"
#include "conn_poll.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned checks, failures, receives, receive_errors, updates;
static unsigned char input[70000], output[70000];
static size_t input_size, input_cursor, output_size, read_allowance, write_allowance;
static unsigned write_calls;
static int eof, send_error, zero_write;
static mutex_t *observed_mutex;
static unsigned send_lock_depth, unlocked_writes, locked_callbacks;
static int tracked_lock(mutex_t *mutex) {
 int ret = mutex_lock(mutex);
 if (mutex == observed_mutex) ++send_lock_depth;
 return ret;
}
static void tracked_unlock(mutex_t *mutex) {
 if (mutex == observed_mutex) --send_lock_depth;
 mutex_unlock(mutex);
}

static void check(int ok, const char *why) {
 ++checks;
 if (!ok) { ++failures; fprintf(stderr, "FAIL %s\n", why); }
}
static void reset_io(void) {
 input_size = input_cursor = output_size = 0;
 read_allowance = write_allowance = sizeof(input);
 write_calls = receives = receive_errors = updates = 0;
 eof = send_error = zero_write = 0;
}
static void append_frame(unsigned size, unsigned char value) {
 input[input_size++] = (unsigned char)(size >> 8);
 input[input_size++] = (unsigned char)size;
 memset(input + input_size, value, size); input_size += size;
}
static int fixture_recv(socket_t sock, char *buffer, int size, int flags) {
 (void)sock; (void)flags;
 if (size == 0) return 0;
 if (input_cursor == input_size && eof) return 0;
 if (!read_allowance || input_cursor == input_size) { WSASetLastError(WSAEWOULDBLOCK); return SOCKET_ERROR; }
 size_t n = (size_t)size;
 if (n > input_size - input_cursor) n = input_size - input_cursor;
 if (n > read_allowance) n = read_allowance;
 memcpy(buffer, input + input_cursor, n); input_cursor += n; read_allowance -= n;
 return (int)n;
}
static int fixture_send(socket_t sock, const char *buffer, int size, int flags) {
 (void)sock; (void)flags; ++write_calls;
 if (observed_mutex && !send_lock_depth) ++unlocked_writes;
 if (zero_write) {
  if (write_calls == 1) return 0;
  WSASetLastError(WSAECONNRESET); return SOCKET_ERROR;
 }
 if (send_error || !write_allowance) { WSASetLastError(send_error ? send_error : WSAEWOULDBLOCK); return SOCKET_ERROR; }
 size_t n = (size_t)size;
 if (n > write_allowance) n = write_allowance;
 if (n > sizeof(output) - output_size) abort();
 memcpy(output + output_size, buffer, n); output_size += n; write_allowance -= n;
 return (int)n;
}
static int fixture_agent_recv(juice_agent_t *agent, const char *data, size_t size, const addr_record_t *src) {
 (void)agent; (void)data; (void)src;
 ++receives; if (!size || size > TCP_ICE_BUFFER_SIZE) ++receive_errors;
 return 0;
}
static int fixture_agent_update(juice_agent_t *agent, timestamp_t *next) {
 (void)agent; ++updates; *next = current_timestamp() + 1000; return 0;
}
static int fixture_agent_tcp_state(juice_agent_t *agent, const addr_record_t *dst, tcp_state_t state) {
 (void)agent; (void)dst; (void)state;
 if (send_lock_depth) ++locked_callbacks;
 return 0;
}
static int fixture_agent_fail(juice_agent_t *agent) { (void)agent; return 0; }

#define send fixture_send
#define recv fixture_recv
#include "tcp.c"
#undef send
#undef recv
#undef BUFFER_SIZE
// Authentication itself is covered with real credentials in tcp_ice_e2e.
// I/O fixtures use already-authenticated connections and fail closed otherwise.
static bool fixture_is_stun(const void *data, size_t size) { (void)data; (void)size; return false; }
static int fixture_stun_read(void *data, size_t size, stun_message_t *msg) { (void)data; (void)size; (void)msg; return -1; }
static bool fixture_stun_integrity(void *data, size_t size, const stun_message_t *msg, const char *password) { (void)data; (void)size; (void)msg; (void)password; return false; }
static int fixture_verify(juice_agent_t *agent, void *data, size_t size, const stun_message_t *msg) { (void)agent; (void)data; (void)size; (void)msg; return -1; }
static int fixture_reflexive(juice_agent_t *agent, ice_candidate_type_t type, uint32_t priority, const addr_record_t *record) { (void)agent; (void)type; (void)priority; (void)record; return -1; }
static int fixture_reflexive_transport(juice_agent_t *agent, ice_candidate_type_t type, uint32_t priority, const addr_record_t *record, ice_candidate_transport_t transport) {
 (void)transport; return fixture_reflexive(agent, type, priority, record);
}
static agent_stun_entry_t *fixture_server(juice_agent_t *agent, const addr_record_t *record) { (void)agent; (void)record; return NULL; }
static agent_stun_entry_t *fixture_transaction(juice_agent_t *agent, const uint8_t *id) { (void)agent; (void)id; return NULL; }
static int fixture_dispatch(juice_agent_t *agent, void *data, size_t size, stun_message_t *msg, const addr_record_t *src, const addr_record_t *relayed) {
 (void)agent; (void)data; (void)size; (void)msg; (void)src; (void)relayed; return -1;
}
#define FIXTURE_TCP_SOCKET (INVALID_SOCKET - 1)
#define FIXTURE_ACCEPT_SOCKET (INVALID_SOCKET - 2)
#define FIXTURE_LISTENER_SOCKET (INVALID_SOCKET - 3)
static unsigned accepted;
static int fixture_close(socket_t sock) { return sock == FIXTURE_TCP_SOCKET || sock == FIXTURE_ACCEPT_SOCKET ? 0 : closesocket(sock); }
static socket_t fixture_accept(socket_t sock, struct sockaddr *addr, socklen_t *length) {
 if (sock != FIXTURE_LISTENER_SOCKET) return accept(sock, addr, length);
 struct sockaddr_in *endpoint = (struct sockaddr_in *)addr;
 memset(endpoint, 0, sizeof(*endpoint)); endpoint->sin_family = AF_INET;
 endpoint->sin_addr.s_addr = htonl(INADDR_LOOPBACK); endpoint->sin_port = htons((uint16_t)(20000 + ++accepted));
 *length = sizeof(*endpoint); return FIXTURE_ACCEPT_SOCKET;
}
static int fixture_ioctl(socket_t sock, long command, ctl_t *value) {
 return sock == FIXTURE_ACCEPT_SOCKET ? 0 : ioctlsocket(sock, command, value);
}
static timestamp_t fixture_now;
static timestamp_t fixture_timestamp(void) { return fixture_now ? fixture_now : current_timestamp(); }
#define current_timestamp fixture_timestamp
#define accept fixture_accept
#define ioctlsocket fixture_ioctl
#define closesocket fixture_close
#define is_stun_datagram fixture_is_stun
#define stun_read fixture_stun_read
#define stun_check_integrity fixture_stun_integrity
#define agent_verify_stun_binding fixture_verify
#define agent_add_remote_reflexive_candidate fixture_reflexive
#define agent_add_remote_reflexive_candidate_with_transport fixture_reflexive_transport
#define agent_find_tcp_server_entry fixture_server
#define agent_find_entry_from_transaction_id fixture_transaction
#define agent_dispatch_stun fixture_dispatch
static int fixture_connected(juice_agent_t *agent, const addr_record_t *dst, const addr_record_t *local) { (void)local; return fixture_agent_tcp_state(agent, dst, TCP_STATE_CONNECTED); }
#define agent_conn_tcp_connected fixture_connected
#define agent_conn_recv fixture_agent_recv
#define agent_conn_update fixture_agent_update
#define agent_conn_tcp_state fixture_agent_tcp_state
#define agent_conn_fail fixture_agent_fail
#undef mutex_lock
#undef mutex_unlock
#define mutex_lock tracked_lock
#define mutex_unlock tracked_unlock
#include "conn_poll.c"
#undef current_timestamp
#undef closesocket
#undef accept
#undef ioctlsocket
#undef agent_conn_recv
#undef agent_conn_update
#undef agent_conn_tcp_state
#undef agent_conn_fail
#undef BUFFER_SIZE
#include "ice.c"

static void parser_tests(void) {
 tcp_ice_read_context_t context;
 reset_io(); memset(&context, 0, sizeof(context)); append_frame(3, 'x');
 read_allowance = 1;
 check(tcp_ice_read(INVALID_SOCKET, &context) == -SEWOULDBLOCK && context.pending, "split header survives would-block");
 read_allowance = 2;
 check(tcp_ice_read(INVALID_SOCKET, &context) == -SEWOULDBLOCK && context.pending, "split payload survives would-block");
 read_allowance = 10;
 const int fragmented = tcp_ice_read(INVALID_SOCKET, &context);
 if (fragmented != 3 || context.pending || memcmp(context.buffer, "xxx", 3))
  fprintf(stderr, "fragment details: result=%d length=%u read=%u pending=%d cursor=%zu data=%u,%u,%u\n", fragmented, context.length, (unsigned)context.bytes_read, context.pending, input_cursor, (unsigned char)context.buffer[0], (unsigned char)context.buffer[1], (unsigned char)context.buffer[2]);
 check(fragmented == 3 && !context.pending && !memcmp(context.buffer, "xxx", 3), "fragmented datagram reassembles exactly");
 const unsigned sizes[] = {TCP_ICE_BUFFER_SIZE, TCP_ICE_BUFFER_SIZE + 1, 65534, 65535};
 for (unsigned i = 0; i < sizeof(sizes)/sizeof(*sizes); ++i) {
  reset_io(); memset(&context, 0, sizeof(context)); append_frame(sizes[i], 'a'); append_frame(3, 'z');
  const int result = tcp_ice_read(INVALID_SOCKET, &context);
  check(result == (sizes[i] <= TCP_ICE_BUFFER_SIZE ? (int)sizes[i] : -SEMSGSIZE), "oversized frame never exposes a length beyond its buffer");
  check(tcp_ice_read(INVALID_SOCKET, &context) == 3 && !memcmp(context.buffer, "zzz", 3), "discard preserves next frame boundary including 65535-byte frame");
 }
 reset_io(); memset(&context, 0, sizeof(context)); append_frame(0, 0); append_frame(2, 'b');
 int result = tcp_ice_read(INVALID_SOCKET, &context);
 if (result == -SEAGAIN || result == -SEWOULDBLOCK) result = tcp_ice_read(INVALID_SOCKET, &context);
 check(result == 2 && !memcmp(context.buffer, "bb", 2), "empty frame is ignored without consuming next payload");
 reset_io(); memset(&context, 0, sizeof(context)); append_frame(4, 'a'); input_size = 3; eof = 1;
 check(tcp_ice_read(INVALID_SOCKET, &context) == 0, "truncated EOF is not a completed datagram");
}

static void writer_tests(void) {
 tcp_ice_write_context_t context;
 reset_io(); memset(&context, 0, sizeof(context)); write_allowance = 1;
 check(tcp_ice_write(INVALID_SOCKET, "abc", 3, &context) == -SEWOULDBLOCK && context.pending, "write reports normalized would-block after partial header");
 check(tcp_ice_write(INVALID_SOCKET, "new", 3, &context) == -SEAGAIN, "pending datagram is not overwritten");
 write_allowance = 3;
 check(tcp_ice_write(INVALID_SOCKET, NULL, 0, &context) == -SEWOULDBLOCK, "partial payload keeps normalized would-block");
 write_allowance = 10;
 check(tcp_ice_write(INVALID_SOCKET, NULL, 0, &context) == 3 && !context.pending, "buffer resumes without re-sending header");
 const unsigned char expected[] = {0,3,'a','b','c'};
 check(output_size == sizeof(expected) && !memcmp(output, expected, sizeof(expected)), "partial writes produce one exact wire frame");
 reset_io(); memset(&context, 0, sizeof(context)); send_error = WSAECONNRESET;
 check(tcp_ice_write(INVALID_SOCKET, "abc", 3, &context) == -SECONNRESET, "fatal write error retains its actual cause");
 reset_io(); memset(&context, 0, sizeof(context)); zero_write = 1;
 check(tcp_ice_write(INVALID_SOCKET, "abc", 3, &context) == -SECONNRESET && write_calls == 1, "zero-progress write cannot spin");
}

static void poll_tests(void) {
 juice_agent_t agent; conn_impl_t impl; tcp_connection_t tcp;
 memset(&tcp, 0, sizeof(tcp)); tcp.authenticated = true;
 conn_registry_t registry; registry_impl_t registry_impl;
 memset(&registry, 0, sizeof(registry)); memset(&registry_impl, 0, sizeof(registry_impl));
 mutex_init(&registry.mutex, MUTEX_RECURSIVE); registry.impl = &registry_impl;
 udp_socket_config_t interrupt_config; memset(&interrupt_config, 0, sizeof(interrupt_config));
 interrupt_config.bind_address = "127.0.0.1";
 registry_impl.interrupt_sock = udp_create_socket(&interrupt_config);
 if (registry_impl.interrupt_sock == INVALID_SOCKET) abort();
 memset(&agent, 0, sizeof(agent)); memset(&impl, 0, sizeof(impl));
 impl.tcp_so_reservations[0] = impl.tcp_so_reservations[1] = INVALID_SOCKET;
 impl.registry = &registry;
 agent.conn_impl = &impl; impl.state = CONN_STATE_READY; impl.tcp_connections = &tcp; tcp.sock = FIXTURE_TCP_SOCKET;
 mutex_init(&impl.send_mutex, 0);
 observed_mutex = &impl.send_mutex;
 struct pollfd pfd = {INVALID_SOCKET, POLLOUT, POLLOUT};
 reset_io(); tcp.state = TCP_STATE_CONNECTED; tcp.write_context.pending = true;
 tcp.write_context.length = 3; write_allowance = 0;
 conn_poll_process_tcp(&agent, &tcp, &pfd);
 check(tcp.state == TCP_STATE_CONNECTED && tcp.write_context.pending, "poll preserves connected state on temporary backpressure");
 reset_io(); tcp.state = TCP_STATE_CONNECTED; tcp.write_context.pending = true;
 tcp.write_context.length = 3; send_error = WSAECONNRESET;
 conn_poll_process_tcp(&agent, &tcp, &pfd);
 check(tcp.state == TCP_STATE_FAILED, "poll fails on real write failure");
 reset_io(); memset(&tcp.read_context, 0, sizeof(tcp.read_context));
 tcp.state = TCP_STATE_CONNECTED; eof = 1; pfd.revents = POLLIN;
 conn_poll_process_tcp(&agent, &tcp, &pfd);
 check(receives == 0 && tcp.state == TCP_STATE_FAILED, "EOF never forwards empty packets into ICE");
 reset_io(); memset(&tcp.read_context, 0, sizeof(tcp.read_context));
 tcp.state = TCP_STATE_CONNECTED; append_frame(TCP_ICE_BUFFER_SIZE + 1, 'a'); append_frame(3, 'b');
 conn_poll_process_tcp(&agent, &tcp, &pfd);
 check(receives == 1 && receive_errors == 0 && tcp.state == TCP_STATE_CONNECTED, "poll discards oversize while delivering subsequent valid frame");
 reset_io(); memset(&tcp.write_context, 0, sizeof(tcp.write_context));
 addr_record_t destination; memset(&destination, 0, sizeof(destination)); destination.socktype = SOCK_STREAM;
 destination.len = sizeof(struct sockaddr_in);
 struct sockaddr_in *endpoint = (struct sockaddr_in *)&destination.addr;
 endpoint->sin_family = AF_INET; endpoint->sin_addr.s_addr = htonl(INADDR_LOOPBACK); endpoint->sin_port = htons(12345);
 tcp.dst = destination; tcp.sock = FIXTURE_TCP_SOCKET;
 write_allowance = 1;
 impl.next_timestamp = current_timestamp() + 60000;
 check(conn_poll_send(&agent, &destination, "abc", 3, 0) == 3, "partially buffered frame is accepted exactly once");
 struct pollfd wake_pfd = {registry_impl.interrupt_sock, POLLIN, 0};
 check(WSAPoll(&wake_pfd, 1, 100) > 0 && (wake_pfd.revents & POLLIN) && impl.next_timestamp <= current_timestamp(), "partial write wakes a poll previously armed without POLLOUT");
 check(conn_poll_send(&agent, &destination, "new", 3, 0) == -SEAGAIN, "full send buffer rejects new frame without overwrite");
 write_allowance = 10; pfd.revents = POLLOUT; conn_poll_process_tcp(&agent, &tcp, &pfd);
 const unsigned char expected[] = {0,3,'a','b','c'};
 check(!tcp.write_context.pending && output_size == sizeof(expected) && !memcmp(output, expected, sizeof(expected)), "poll resumes accepted frame exactly");
 check(unlocked_writes == 0, "sender and poll flusher both hold the shared send mutex");
 check(locked_callbacks == 0 && send_lock_depth == 0, "TCP state callbacks run outside send mutex");
 // A continuously readable listener must not starve an established TCP path.
 reset_io(); accepted = 0; append_frame(3, 'f');
 memset(&tcp.read_context, 0, sizeof(tcp.read_context));
 impl.tcp_listener = FIXTURE_LISTENER_SOCKET; impl.udp_sock = INVALID_SOCKET;
 for (unsigned slot = 0; slot < VDS_NAT_PUNCH_SOCKETS; ++slot) impl.vds_sockets[slot] = INVALID_SOCKET;
 juice_agent_t *agents[] = {&agent}; registry.agents = agents; registry.agents_size = registry.agents_count = 1;
 impl.next_timestamp = current_timestamp() + 1000;
 pfds_record_t pfds; memset(&pfds, 0, sizeof(pfds)); timestamp_t next;
 check(conn_poll_prepare(&registry, &pfds, &next) == 3, "poll snapshot includes UDP, established TCP and listener");
 for (nfds_t i = 0; i < pfds.size; ++i) pfds.pfds[i].revents =
   pfds.pfds[i].fd == FIXTURE_TCP_SOCKET || pfds.pfds[i].fd == FIXTURE_LISTENER_SOCKET ? POLLIN : 0;
 conn_poll_process(&registry, &pfds);
 check(receives == 1 && accepted == 16, "established TCP receives even while listener accepts its full batch");
 free(pfds.pfds);
 tcp_connection_t *pending = impl.tcp_connections;
 while (pending != &tcp) { tcp_connection_t *next = pending->next; free(pending); pending = next; }
 impl.tcp_connections = &tcp; impl.tcp_listener = INVALID_SOCKET;
 observed_mutex = NULL;
 mutex_destroy(&impl.send_mutex);
 closesocket(registry_impl.interrupt_sock); mutex_destroy(&registry.mutex);
}

static void candidate_identity_tests(void) {
 ice_description_t description; memset(&description, 0, sizeof(description));
 addr_record_t endpoint; memset(&endpoint, 0, sizeof(endpoint));
 endpoint.len = sizeof(struct sockaddr_in);
 struct sockaddr_in *address = (struct sockaddr_in *)&endpoint.addr;
 address->sin_family = AF_INET; address->sin_addr.s_addr = htonl(INADDR_LOOPBACK); address->sin_port = htons(12345);
 ice_candidate_t candidate;
 endpoint.socktype = SOCK_DGRAM;
 check(ice_create_local_candidate(ICE_CANDIDATE_TYPE_HOST, 1, 0, &endpoint, &candidate, ICE_CANDIDATE_TRANSPORT_UDP) == 0 && ice_add_candidate(&candidate, &description) == 0, "create UDP identity fixture");
 endpoint.socktype = SOCK_STREAM;
 check(ice_create_local_candidate(ICE_CANDIDATE_TYPE_HOST, 1, 1, &endpoint, &candidate, ICE_CANDIDATE_TRANSPORT_TCP_TYPE_PASSIVE) == 0 && ice_add_candidate(&candidate, &description) == 0, "create TCP identity fixture at same address and port");
 check(ice_find_candidate_from_addr(&description, &endpoint, ICE_CANDIDATE_TYPE_UNKNOWN) == &description.candidates[1], "TCP lookup never aliases equal-address UDP candidate");
 endpoint.socktype = SOCK_DGRAM;
 check(ice_find_candidate_from_addr(&description, &endpoint, ICE_CANDIDATE_TYPE_UNKNOWN) == &description.candidates[0], "UDP lookup retains its own transport identity");
}

static void tcp_candidate_attribute_tests(void) {
 ice_candidate_t c;
 const char *prefix = "a=candidate:m 1 TCP 100 127.0.0.1 12345 typ srflx ";
 const char *tails[] = {"tcptype passive", "raddr 10.0.0.1 rport 5555 tcptype passive", "network-id 1 raddr 10.0.0.1 rport 5555 tcptype passive ufrag abcd"};
 char line[512];
 for (size_t i=0;i<sizeof(tails)/sizeof(tails[0]);++i) {
  snprintf(line,sizeof(line),"%s%s",prefix,tails[i]);
  check(ice_parse_candidate_sdp(line,&c)==0 && c.transport==ICE_CANDIDATE_TRANSPORT_TCP_TYPE_PASSIVE,"parse TCP type after complete related-address attributes");
 }
 const char *invalid[] = {"wrong passive", "value tcptype passive", "tcptype passive tcptype active", "tcptype unknown", "raddr 10.0.0.1 rport 5555"};
 for(size_t i=0;i<sizeof(invalid)/sizeof(invalid[0]);++i) {
  snprintf(line,sizeof(line),"%s%s",prefix,invalid[i]);
  check(ice_parse_candidate_sdp(line,&c)!=0,"reject missing, duplicate or fake TCP type attribute");
 }
}

static void handshake_phase_tests(void) {
 juice_agent_t agent; conn_impl_t impl;
 memset(&agent, 0, sizeof(agent)); memset(&impl, 0, sizeof(impl));
 agent.conn_impl = &impl; mutex_init(&impl.send_mutex, 0);
 tcp_connection_t *tcp = calloc(1, sizeof(*tcp));
 udp_socket_config_t config; memset(&config, 0, sizeof(config)); config.bind_address = "127.0.0.1";
 tcp->sock = udp_create_socket(&config); // only getsockname/close are real in this phase unit test
 if (tcp->sock == INVALID_SOCKET) abort();
 tcp->state = TCP_STATE_CONNECTING;
 fixture_now = 1000;
 tcp->auth_deadline = fixture_now + STUN_TCP_TIMEOUT;
 impl.tcp_connections = tcp;
 fixture_now += STUN_TCP_TIMEOUT - 2000;
 impl.next_timestamp = fixture_now + 60000;
 conn_poll_change_tcp_state(&agent, tcp, TCP_STATE_CONNECTED);
 check(impl.next_timestamp == fixture_now,
   "TCP connected callback must immediately wake the poll scheduler for STUN");
 check(tcp->auth_deadline == fixture_now + STUN_TCP_TIMEOUT,
   "TCP connect time must not consume the subsequent STUN authentication interval");
 const timestamp_t phase_deadline = tcp->auth_deadline;
 ++fixture_now;
 conn_poll_change_tcp_state(&agent, tcp, TCP_STATE_CONNECTED);
 check(tcp->auth_deadline == phase_deadline, "duplicate connected notification cannot extend authentication");
 conn_poll_tcp_maintain(&agent, fixture_now + 2500);
 check(impl.tcp_connections == tcp,
   "late TCP completion retains its full authentication interval");
 if (impl.tcp_connections) {
  conn_poll_tcp_maintain(&agent, phase_deadline);
  check(impl.tcp_connections == NULL, "silent unauthenticated TCP still expires at its phase deadline");
 }
 tcp = calloc(1, sizeof(*tcp)); tcp->sock = udp_create_socket(&config);
 if (tcp->sock == INVALID_SOCKET) abort();
 tcp->state = TCP_STATE_CONNECTING; tcp->auth_deadline = fixture_now + STUN_TCP_TIMEOUT;
 impl.tcp_connections = tcp;
 conn_poll_tcp_maintain(&agent, tcp->auth_deadline);
 check(impl.tcp_connections == NULL, "uncompleted TCP connect retains its existing deadline");
 tcp = calloc(1, sizeof(*tcp)); tcp->sock = udp_create_socket(&config);
 if (tcp->sock == INVALID_SOCKET) abort();
 tcp->state = TCP_STATE_CONNECTED; tcp->authenticated = true; tcp->auth_deadline = 0;
 impl.tcp_connections = tcp;
 conn_poll_tcp_maintain(&agent, fixture_now + 1000000);
 check(impl.tcp_connections == tcp, "authenticated media has no handshake deadline");
 conn_poll_change_tcp_fail(&agent, tcp); conn_poll_tcp_maintain(&agent, fixture_now);
 fixture_now = 0;
 mutex_destroy(&impl.send_mutex);
}

// Use actual Winsock UDP bindings here; TCP I/O substitutions above do not
// intercept udp_create_socket/udp_sendto. The namespace fixture separately
// verifies routing, NAT, authentication and sustained DataChannel traffic.
static void udp_source_binding_tests(void) {
 for (unsigned scenario = 0; scenario < 5; ++scenario) {
  juice_agent_t agent; conn_impl_t impl;
  memset(&agent, 0, sizeof(agent)); memset(&impl, 0, sizeof(impl));
  agent.conn_impl = &impl;
  agent.config.bind_address = scenario == 2 ? "127.0.0.2" : NULL;
  udp_socket_config_t config = {agent.config.bind_address, 0, 0};
  impl.udp_sock = udp_create_socket(&config);
  if (impl.udp_sock == INVALID_SOCKET) abort();
  for (unsigned i = 0; i < VDS_NAT_PUNCH_SOCKETS; ++i) impl.vds_sockets[i] = INVALID_SOCKET;
  mutex_init(&impl.send_mutex, 0);
  const char *addresses[] = {scenario == 1 ? "203.0.113.99" : "127.0.0.1", "127.0.0.2"};
  agent.local.candidates_count = scenario == 4 ? 0 : scenario == 3 ? 1 : 2;
  for (int i = 0; i < agent.local.candidates_count; ++i) {
   ice_candidate_t *candidate = &agent.local.candidates[i];
   candidate->type = ICE_CANDIDATE_TYPE_HOST;
   candidate->transport = ICE_CANDIDATE_TRANSPORT_UDP;
   candidate->resolved.len = sizeof(struct sockaddr_in);
   candidate->resolved.socktype = SOCK_DGRAM;
   struct sockaddr_in *address = (struct sockaddr_in *)&candidate->resolved.addr;
   address->sin_family = AF_INET; address->sin_port = htons(12345);
   if (inet_pton(AF_INET, addresses[i], &address->sin_addr) != 1) abort();
  }
  if (scenario == 1) {
   udp_socket_config_t missing = {addresses[0], 0, 0};
   socket_t sock = udp_create_socket(&missing);
   check(sock == INVALID_SOCKET, "retired-interface fixture address is unavailable");
   if (sock != INVALID_SOCKET) closesocket(sock);
  }
  check(conn_poll_open_punch_sockets(&agent, 1) == 1, "first auxiliary source opens despite retired first interface");
  socket_t first = impl.vds_sockets[0];
  check(conn_poll_open_punch_sockets(&agent, 4) == 4, "source pool grows without gaps");
  check(impl.vds_sockets[0] == first, "pool growth preserves existing source socket identity");
  for (unsigned i = 0; i < 4; ++i) {
   addr_record_t actual;
   int ret = udp_get_bound_addr(impl.vds_sockets[i], &actual);
   check(ret == 0, "query actual auxiliary source binding");
   if (ret) continue;
   if (scenario >= 3) {
    check(addr_is_any((struct sockaddr *)&actual.addr), "single/no-interface path retains route-selected wildcard binding");
   } else {
    struct in_addr expected;
    inet_pton(AF_INET, scenario == 0 ? addresses[i % 2] : "127.0.0.2", &expected);
    check(actual.addr.ss_family == AF_INET &&
          ((struct sockaddr_in *)&actual.addr)->sin_addr.s_addr == expected.s_addr,
          "auxiliary source honors explicit binding or available gathered interface");
   }
  }
  conn_poll_close_punch_sockets(&agent, 0);
  for (unsigned i = 0; i < 4; ++i) check(impl.vds_sockets[i] == INVALID_SOCKET, "auxiliary source closes");
  closesocket(impl.udp_sock); mutex_destroy(&impl.send_mutex);
 }
}

int main(void) {
 WSADATA wsa; if (WSAStartup(MAKEWORD(2,2), &wsa)) return 2;
 parser_tests(); writer_tests(); poll_tests(); candidate_identity_tests(); tcp_candidate_attribute_tests(); handshake_phase_tests(); udp_source_binding_tests(); WSACleanup();
 printf("ICE socket I/O: %u assertions, %u failures\n", checks, failures);
 return failures ? 1 : 0;
}
