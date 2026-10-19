// Test-only planning RNG seam. Only the 32-bit random target-plan seed is
// replayed. ICE credentials, transaction IDs, tiebreakers and DTLS retain their
// original randomness. Compile into an isolated DLL, never the runtime DLL.
#include "agent.h"
#include "random.h"
#include <windows.h>
#include <stdio.h>
#include <string.h>

static volatile LONG scenario_seed;
static volatile LONG planner_calls;
__declspec(dllexport) void vds_test_plan_seed_configure(unsigned seed) {
 InterlockedExchange(&scenario_seed, (LONG)seed);
 InterlockedExchange(&planner_calls, 0);
}
__declspec(dllexport) unsigned vds_test_plan_seed_calls(void) {
 return (unsigned)InterlockedCompareExchange(&planner_calls, 0, 0);
}
static void vds_test_agent_random(juice_agent_t *agent, void *bytes, size_t size, const char *expression) {
 if (strcmp(expression, "&seed")) { juice_random(bytes, size); return; }
 if (size != sizeof(uint32_t)) { fprintf(stderr, "FAIL planner seed width changed\n"); abort(); }
 const char *bind = agent->config.bind_address;
 if (!bind || (strcmp(bind, "127.0.0.10") && strcmp(bind, "127.0.0.11"))) {
  fprintf(stderr, "FAIL seeded planner requires a known fixture side\n"); abort();
 }
 const unsigned side = strcmp(bind, "127.0.0.10") ? 1 : 0;
 const unsigned scenario = (unsigned)InterlockedCompareExchange(&scenario_seed, 0, 0);
 uint32_t value = scenario * 65537u + side * 193u + agent->vds_punch_plan * 7919u + 17u;
 value ^= value << 13; value ^= value >> 17; value ^= value << 5;
 memcpy(bytes, &value, sizeof(value));
 InterlockedIncrement(&planner_calls);
 fprintf(stderr, "PLANNER-SEED scenario=%u side=%u plan=%u value=%u\n",
   scenario, side, agent->vds_punch_plan, value);
}
#define juice_random(bytes, size) vds_test_agent_random(agent, bytes, size, #bytes)
#include "agent.c"
#undef juice_random
