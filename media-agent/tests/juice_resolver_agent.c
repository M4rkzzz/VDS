// Test-only DNS seam: compile the fingerprinted production agent unchanged,
// substituting only its getaddrinfo call. Never linked into the shipped DLL.
#include "addr.h"
int WSAAPI vds_test_getaddrinfo(const char *, const char *, const struct addrinfo *, struct addrinfo **);
#define getaddrinfo vds_test_getaddrinfo
#include "agent.c"
