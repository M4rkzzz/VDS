// Test-only UDP boundary. The fingerprinted ICE engine is unchanged. Its
// outbound peer datagrams use their original socket but carry the destination
// to a loopback NAT gateway, including ports outside the finite receiver pool.
// This DLL lives beside the isolated test EXE, never in the shipped runtime.
#include "udp.h"
#include <windows.h>
#include <string.h>

#define udp_sendto vds_test_original_udp_sendto
#include "udp.c"
#undef udp_sendto

static volatile LONG gateway_port;
static volatile LONG64 sent_datagrams;

__declspec(dllexport) void vds_test_egress_configure(unsigned short port) {
 InterlockedExchange64(&sent_datagrams, 0);
 InterlockedExchange(&gateway_port, port);
}

__declspec(dllexport) unsigned long long vds_test_egress_sent(void) {
 return (unsigned long long)InterlockedCompareExchange64(&sent_datagrams, 0, 0);
}

int udp_sendto(socket_t sock, const char *data, size_t size, const addr_record_t *dst) {
 const LONG port = InterlockedCompareExchange(&gateway_port, 0, 0);
 if (port && dst->addr.ss_family == AF_INET) {
  const struct sockaddr_in *remote = (const struct sockaddr_in *)&dst->addr;
  const unsigned long ip = ntohl(remote->sin_addr.s_addr);
  // .2/.3 are the live NATs; .4 through .7 are dead advertised exits.
  if (ip >= 0x7f000001 && ip <= 0x7f000007) {
   if (size > 65497) { WSASetLastError(WSAEMSGSIZE); return SOCKET_ERROR; }
   char header[10] = {'V', 'D', 'S', 'E'};
   memcpy(header + 4, &remote->sin_addr.s_addr, 4);
   memcpy(header + 8, &remote->sin_port, 2);
   struct sockaddr_in gateway = {0};
   gateway.sin_family = AF_INET;
   gateway.sin_addr.s_addr = htonl(0x7f000001);
   gateway.sin_port = htons((unsigned short)port);
   WSABUF buffers[2] = {{sizeof(header), header}, {(ULONG)size, (char *)data}};
   DWORD sent = 0;
   if (WSASendTo(sock, buffers, 2, &sent, 0, (const struct sockaddr *)&gateway,
                 sizeof(gateway), NULL, NULL) == SOCKET_ERROR) return SOCKET_ERROR;
   InterlockedIncrement64(&sent_datagrams);
   return (int)sent - (int)sizeof(header);
  }
 }
 return vds_test_original_udp_sendto(sock, data, size, dst);
}

// Exercise the gateway boundary independently of ICE for allocation/reuse
// assertions. This export is absent from the production DLL.
__declspec(dllexport) int vds_test_egress_send(socket_t sock, unsigned long ip, unsigned short port) {
 addr_record_t target = {0};
 struct sockaddr_in *address = (struct sockaddr_in *)&target.addr;
 address->sin_family = AF_INET;
 address->sin_addr.s_addr = htonl(ip);
 address->sin_port = htons(port);
 target.len = sizeof(*address);
 return udp_sendto(sock, "allocation-only", 15, &target);
}
