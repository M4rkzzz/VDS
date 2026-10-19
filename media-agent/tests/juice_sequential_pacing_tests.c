// Exercise the actual production scheduler with a hole before an occupied
// STUN slot. No sockets, sleeps, network emulation, or substituted clock.
#include "agent.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(int condition, const char *message) {
 if (!condition) { fprintf(stderr, "FAIL %s\n", message); exit(1); }
}

static void run(int prediction, int enabled, int already_sent, int same_generation) {
 juice_agent_t *agent = calloc(1, sizeof(*agent));
 check(agent != NULL, "allocation");
 agent->config.enable_port_prediction = enabled;
 strcpy(agent->remote.ice_ufrag, "test");
 agent->remote.candidates_count = 3;
 agent->entries_count = 3;
 for (int i = 0; i < 3; ++i) {
  ice_candidate_t *candidate = &agent->remote.candidates[i];
  candidate->type = ICE_CANDIDATE_TYPE_SERVER_REFLEXIVE;
  candidate->transport = ICE_CANDIDATE_TRANSPORT_UDP;
  candidate->resolved.addr.ss_family = AF_INET;
  ((struct sockaddr_in *)&candidate->resolved.addr)->sin_addr.s_addr = htonl(0x7f000002);
  candidate->resolved.len = sizeof(struct sockaddr_in);
  candidate->priority = 1000 - i;
  candidate->vds_predicted = i > 0 && prediction;
  candidate->vds_nat_step = 1;
  strcpy(candidate->vds_ufrag, same_generation ? "test" : "old");
  agent->candidate_pairs[i].remote = candidate;
  agent->entries[i].pair = &agent->candidate_pairs[i];
  agent->entries[i].record = candidate->resolved;
  agent->entries[i].type = AGENT_STUN_ENTRY_TYPE_CHECK;
 }
 // Occupy a near-future slot: the first prediction must shift past it.
 // The second would otherwise jump into the gap left before the first.
 agent->entries[0].next_transmission = current_timestamp() + 1025;
 agent_arm_transmission(agent, &agent->entries[1], 1000);
 // A response cancels the original slot between candidate callbacks.
 agent->entries[0].next_transmission = 0;
 agent->entries[1].vds_first_send_sequence = already_sent ? 1 : 0;
 agent_arm_transmission(agent, &agent->entries[2], 1000);
 const timediff_t delta = agent->entries[2].next_transmission - agent->entries[1].next_transmission;
 printf("prediction=%d enabled=%d sent=%d generation=%d delta=%lld\n",
        prediction, enabled, already_sent, same_generation, (long long)delta);
 if (prediction && enabled && !already_sent && same_generation)
  check(delta >= STUN_PACING_TIME, "later sequential prediction overtook first unsent prediction");
 else
  check(delta < 0, "ordinary checks or retransmissions were unnecessarily serialized");
 free(agent);
}

static void tcp_connect_wait(void) {
 juice_agent_t *agent = calloc(1, sizeof(*agent));
 check(agent != NULL, "TCP scheduling fixture allocation");
 agent->state = JUICE_STATE_CONNECTING; agent->mode = AGENT_MODE_CONTROLLED;
 agent->entries_count = agent->candidate_pairs_count = agent->remote.candidates_count = 2;
 const timestamp_t now = current_timestamp();
 for (int i = 0; i < 2; ++i) {
  ice_candidate_t *remote = &agent->remote.candidates[i];
  remote->type = ICE_CANDIDATE_TYPE_HOST;
  remote->transport = i ? ICE_CANDIDATE_TRANSPORT_UDP : ICE_CANDIDATE_TRANSPORT_TCP_TYPE_PASSIVE;
  remote->resolved.socktype = i ? SOCK_DGRAM : SOCK_STREAM;
  remote->resolved.addr.ss_family = AF_INET; remote->resolved.len = sizeof(struct sockaddr_in);
  ((struct sockaddr_in *)&remote->resolved.addr)->sin_addr.s_addr = htonl(0x7f000001);
  ((struct sockaddr_in *)&remote->resolved.addr)->sin_port = htons((uint16_t)(12345 + i));
  ice_candidate_pair_t *pair = &agent->candidate_pairs[i];
  pair->remote = remote; pair->state = ICE_CANDIDATE_PAIR_STATE_PENDING;
  pair->tcp_state = TCP_STATE_CONNECTING; agent->ordered_pairs[i] = pair;
  agent_stun_entry_t *entry = &agent->entries[i];
  entry->pair = pair; entry->record = remote->resolved;
  entry->type = AGENT_STUN_ENTRY_TYPE_CHECK; entry->state = AGENT_STUN_ENTRY_STATE_PENDING;
  entry->next_transmission = i ? now + 5000 : now - 1;
 }
 timestamp_t next = 0;
 check(agent_bookkeeping(agent, &next) == 0, "bookkeeping pending TCP and scheduled UDP");
 printf("TCP waiting: next delta=%lld ms\n", (long long)(next - now));
 check(next == agent->entries[1].next_transmission,
   "waiting TCP must not retain an expired STUN timer ahead of another candidate");
 check(agent->entries[0].state == AGENT_STUN_ENTRY_STATE_PENDING &&
   agent->entries[0].pair->state == ICE_CANDIDATE_PAIR_STATE_PENDING,
   "sleeping for TCP readiness must not cancel the candidate");
 check(agent_conn_tcp_state(agent, &agent->entries[0].record, TCP_STATE_CONNECTED) == 0,
   "TCP ready callback must find pending candidate");
 check(agent->entries[0].next_transmission >= now && agent->entries[0].next_transmission <= current_timestamp(),
   "TCP ready callback immediately rearms authenticated ICE check");
 free(agent);
}

int main(void) {
 run(1, 1, 0, 1);
 run(0, 1, 0, 1);
 run(1, 0, 0, 1);
 run(1, 1, 1, 1);
 run(1, 1, 0, 0);
 tcp_connect_wait();
 puts("PASS sequential initial scheduling preserves order without restricting ordinary ICE");
 return 0;
}
