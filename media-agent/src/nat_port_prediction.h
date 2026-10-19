#ifndef VDS_NAT_PORT_PREDICTION_H
#define VDS_NAT_PORT_PREDICTION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VDS_NAT_MAX_OBSERVATIONS 8u
#define VDS_NAT_MAX_PREDICTED_PORTS 16u

/* Controls only whether an IPv4 ICE check waits for NAT sampling. Shared
 * carrier addresses use the immediate path, like private LAN peers. */
static inline bool vds_nat_is_public_ipv4_destination(uint32_t address) {
  return (address >> 24) != 10 && (address >> 24) != 127 &&
      (address >> 16) != 0xa9fe && (address >> 20) != 0xac1 &&
      (address >> 16) != 0xc0a8 && (address & 0xffc00000u) != 0x64400000u;
}

/* Inputs must come from validated STUN responses on the transport socket.
 * sequence is the first-send order, not the order in which replies arrive.
 * address is the mapped IPv4 address in the caller's consistent byte order.
 * An invalid/missing reply must retain its sequence gap in later samples. */
typedef struct vds_nat_port_observation {
  uint32_t address;
  uint16_t port;
  uint32_t sequence;
  bool valid;
} vds_nat_port_observation;

typedef enum vds_nat_mapping_behavior {
  VDS_NAT_MAPPING_UNKNOWN = 0,
  VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT = 1,
  VDS_NAT_MAPPING_SEQUENTIAL = 2
} vds_nat_mapping_behavior;

/* Stable mappings only establish endpoint independence when the caller has
 * sampled different STUN destinations. These helpers never invent an address,
 * transmit a packet, or establish that any predicted port is reachable. */

static inline bool vds_nat_prepare_observations(
    const vds_nat_port_observation* observations, size_t count,
    vds_nat_port_observation* ordered, size_t* ordered_count) {
  size_t input_index;
  size_t used = 0;
  uint32_t address = 0;
  *ordered_count = 0;
  if (!observations || count == 0 || count > VDS_NAT_MAX_OBSERVATIONS) {
    return false;
  }
  for (input_index = 0; input_index < count; ++input_index) {
    size_t insertion_index;
    vds_nat_port_observation observation = observations[input_index];
    if (!observation.valid) { continue; }
    if (observation.address == 0 || observation.port == 0) { return false; }
    if (used != 0 && observation.address != address) { return false; }
    address = observation.address;
    insertion_index = used;
    while (insertion_index > 0 &&
        ordered[insertion_index - 1].sequence > observation.sequence) {
      ordered[insertion_index] = ordered[insertion_index - 1];
      --insertion_index;
    }
    ordered[insertion_index] = observation;
    ++used;
  }
  *ordered_count = used;
  return used != 0;
}

static inline vds_nat_mapping_behavior vds_nat_classify_ports(
    const vds_nat_port_observation* observations, size_t count, int* step) {
  vds_nat_port_observation ordered[VDS_NAT_MAX_OBSERVATIONS];
  size_t used = 0;
  size_t index;
  int delta;
  if (step) { *step = 0; }
  if (!vds_nat_prepare_observations(observations, count, ordered, &used) ||
      used < 3) {
    return VDS_NAT_MAPPING_UNKNOWN;
  }
  for (index = 1; index < used; ++index) {
    if (ordered[index - 1].sequence == UINT32_MAX ||
        ordered[index].sequence != ordered[index - 1].sequence + 1u) {
      return VDS_NAT_MAPPING_UNKNOWN;
    }
  }
  delta = (int)ordered[1].port - (int)ordered[0].port;
  if (delta < -16 || delta > 16) { return VDS_NAT_MAPPING_UNKNOWN; }
  for (index = 2; index < used; ++index) {
    if ((int)ordered[index].port - (int)ordered[index - 1].port != delta) {
      return VDS_NAT_MAPPING_UNKNOWN;
    }
  }
  if (delta == 0) { return VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT; }
  if (step) { *step = delta; }
  return VDS_NAT_MAPPING_SEQUENTIAL;
}

/* Equal mapped ports to one server IP cannot distinguish endpoint-independent
 * from address-dependent mappings. Destinations are confirmed IPv4 response
 * origins on the same transport, not configured hostnames or unanswered probes. */
static inline vds_nat_mapping_behavior vds_nat_classify_mapping(
    const vds_nat_port_observation* observations, size_t count,
    const uint32_t* destinations, size_t destination_count) {
  vds_nat_mapping_behavior mode = vds_nat_classify_ports(observations, count, NULL);
  if (mode != VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT) return mode;
  if (!destinations || destination_count > VDS_NAT_MAX_OBSERVATIONS)
    return VDS_NAT_MAPPING_UNKNOWN;
  uint32_t first = 0;
  for (size_t i = 0; i < destination_count; ++i) {
    if (!destinations[i]) continue;
    if (first && destinations[i] != first) return mode;
    first = destinations[i];
  }
  return VDS_NAT_MAPPING_UNKNOWN;
}

static inline void vds_nat_append_prediction(
    int port, const vds_nat_port_observation* ordered, size_t observed_count,
    uint16_t* output, size_t capacity, size_t* used) {
  size_t index;
  if (*used >= capacity || port < 1024 || port > UINT16_MAX) { return; }
  for (index = 0; index < observed_count; ++index) {
    if (ordered[index].port == (uint16_t)port) { return; }
  }
  for (index = 0; index < *used; ++index) {
    if (output[index] == (uint16_t)port) { return; }
  }
  output[*used] = (uint16_t)port;
  ++*used;
}

/* High-confidence linear policy: the next four allocation centers first,
 * then their +/-1 neighborhoods. No wraparound or observed endpoint repeats.
 * A hole, duplicate sequence, address change, or noisy delta disables it. */
static inline size_t vds_nat_predict_ports(
    const vds_nat_port_observation* observations, size_t count,
    uint16_t* output, size_t capacity, int* step) {
  vds_nat_port_observation ordered[VDS_NAT_MAX_OBSERVATIONS];
  size_t observed_count = 0;
  size_t used = 0;
  int delta = 0;
  int centers[4];
  size_t index;
  if (step) { *step = 0; }
  if (!output || capacity == 0 ||
      vds_nat_classify_ports(observations, count, &delta) !=
          VDS_NAT_MAPPING_SEQUENTIAL ||
      !vds_nat_prepare_observations(observations, count, ordered,
          &observed_count)) {
    return 0;
  }
  if (capacity > VDS_NAT_MAX_PREDICTED_PORTS) {
    capacity = VDS_NAT_MAX_PREDICTED_PORTS;
  }
  if (step) { *step = delta; }
  for (index = 0; index < 4; ++index) {
    centers[index] = (int)ordered[observed_count - 1].port +
        delta * ((int)index + 1);
    vds_nat_append_prediction(centers[index], ordered, observed_count,
        output, capacity, &used);
  }
  for (index = 0; index < 4; ++index) {
    /* Do not turn an out-of-range center into a valid neighboring guess. */
    if (centers[index] < 1024 || centers[index] > UINT16_MAX) { continue; }
    vds_nat_append_prediction(centers[index] - 1, ordered, observed_count,
        output, capacity, &used);
    vds_nat_append_prediction(centers[index] + 1, ordered, observed_count,
        output, capacity, &used);
  }
  return used;
}

/* Explicit low-confidence multi-port policy for unknown/noisy allocation:
 * +/-1 and +/-2 around at most four latest confirmed STUN ports. This never
 * extrapolates a linear sequence and does not guess for a stable mapping.
 * Caller must use this policy's label and its own bounded probing budget. */
static inline size_t vds_nat_neighbor_ports(
    const vds_nat_port_observation* observations, size_t count,
    uint16_t* output, size_t capacity) {
  vds_nat_port_observation ordered[VDS_NAT_MAX_OBSERVATIONS];
  size_t observed_count = 0;
  size_t used = 0;
  size_t anchors = 0;
  size_t index;
  if (!output || capacity == 0 ||
      !vds_nat_prepare_observations(observations, count, ordered,
          &observed_count) ||
      vds_nat_classify_ports(observations, count, NULL) ==
          VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT) {
    return 0;
  }
  if (capacity > VDS_NAT_MAX_PREDICTED_PORTS) {
    capacity = VDS_NAT_MAX_PREDICTED_PORTS;
  }
  for (index = observed_count; index > 0 && anchors < 4; --index) {
    int radius;
    size_t newer;
    bool repeated_anchor = false;
    int port = (int)ordered[index - 1].port;
    for (newer = index; newer < observed_count; ++newer) {
      if (ordered[newer].port == (uint16_t)port) {
        repeated_anchor = true;
        break;
      }
    }
    if (repeated_anchor) { continue; }
    ++anchors;
    for (radius = 1; radius <= 2; ++radius) {
      vds_nat_append_prediction(port + radius, ordered, observed_count,
          output, capacity, &used);
      vds_nat_append_prediction(port - radius, ordered, observed_count,
          output, capacity, &used);
    }
  }
  return used;
}

/* Connection-only exploration resources, never media rate or session limits. */
#define VDS_NAT_PUNCH_SOCKETS 16u
#define VDS_NAT_PUNCH_TARGETS 100u

/* Destination-dependent random mappings already change for each destination.
 * A cartesian socket fanout consumes the NAT table without adding destinations.
 * Start unknown/unknown sparsely, then add source diversity on later passes.
 * Existing sockets stay open for delayed authenticated checks and media.
 * Stable or predictable remote endpoints can use immediate fanout. */
static inline unsigned vds_nat_punch_socket_count(int local_mode, int remote_mode,
    unsigned exploration_round) {
  if (local_mode == VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT) return 1u;
  if (local_mode == VDS_NAT_MAPPING_UNKNOWN && remote_mode == VDS_NAT_MAPPING_UNKNOWN)
    return 1u << (exploration_round < 4 ? exploration_round : 4);
  return VDS_NAT_PUNCH_SOCKETS;
}

/* Spread each wave across destinations before allocating another mapping to
 * the same destination. Target-major cartesian bursts can fill a small NAT
 * table after only a handful of destination ports. Every (target, socket)
 * pair is still visited once; stable local mappings keep socket zero. */
static inline unsigned vds_nat_punch_socket(size_t target, unsigned wave,
    unsigned first_socket, unsigned socket_count) {
  return socket_count ? first_socket + (unsigned)((target + wave) % socket_count) : first_socket;
}

/* Reuse the primary source only for endpoints already owned by ordinary ICE.
 * Novel destination hypotheses retain their auxiliary source. Replacing one
 * wave avoids duplicate allocations without adding probes or source sockets. */
static inline unsigned vds_nat_punch_target_socket(size_t target, unsigned wave,
    unsigned first_socket, unsigned socket_count, bool primary_target) {
  return primary_target && wave == 0 ? 0u :
    vds_nat_punch_socket(target, wave, first_socket, socket_count);
}

/* Discover new mappings promptly, then reuse them after transient loss. The
 * same two transmissions fit the same plan; only the second is spread out. */
static inline unsigned vds_nat_punch_batch_offset(unsigned probes, unsigned batch) {
  unsigned batches = (probes + 31u) / 32u;
  unsigned delay = batches ? 2500u / batches : 20u;
  if (batch < batches) return batch * 20u;
  return 2500u + (batch - batches) * (delay < 20u ? 20u : delay);
}

/* Concentration is a scheduling hint, never proof of a NAT allocation range.
 * Sparse, duplicated, privileged, or wide-spread samples retain the old plan.
 * Four distinct samples may cross an aligned block if their span is <256.
 * Three-sample aligned hints preserve the existing behavior. */
static inline bool vds_nat_ports_concentrated(const uint16_t* ports, size_t count) {
  uint16_t distinct[VDS_NAT_MAX_OBSERVATIONS];
  size_t used = 0;
  unsigned low = 65535, high = 0;
  if (!ports || count < 3 || count > VDS_NAT_MAX_OBSERVATIONS) return false;
  for (size_t i = 0; i < count; ++i) {
    size_t j;
    if (ports[i] < 1024) return false;
    if (ports[i] < low) low = ports[i];
    if (ports[i] > high) high = ports[i];
    if (high - low >= 256) return false;
    for (j = 0; j < used && distinct[j] != ports[i]; ++j) {}
    if (j == used) distinct[used++] = ports[i];
  }
  return used >= 3 && ((low & 0xff00u) == (high & 0xff00u) || used >= 4);
}

static inline bool vds_nat_observations_concentrated(
    const vds_nat_port_observation* observations, size_t count) {
  uint16_t ports[VDS_NAT_MAX_OBSERVATIONS];
  uint32_t address = 0;
  size_t used = 0;
  if (!observations || count > VDS_NAT_MAX_OBSERVATIONS) return false;
  for (size_t i = 0; i < count; ++i) {
    const vds_nat_port_observation* sample = observations + i;
    if (!sample->valid || !sample->sequence || !sample->address) continue;
    if (address && sample->address != address) return false;
    address = sample->address;
    for (size_t j = 0; j < i; ++j)
      if (observations[j].valid && observations[j].sequence == sample->sequence) return false;
    ports[used++] = sample->port;
  }
  return vds_nat_ports_concentrated(ports, used);
}

/* Unknown mapping: sample the observed allocation block and the wider user-port
 * space. These are hypotheses, never advertised as verified mappings. */
static inline size_t vds_nat_random_ports_joint_round(uint16_t anchor,
    const uint16_t* observed, size_t observed_count, uint32_t seed,
    unsigned exploration_round, bool local_concentrated, uint16_t* output, size_t capacity) {
  const bool concentrated = local_concentrated && vds_nat_ports_concentrated(observed, observed_count);
  size_t used = 0;
  unsigned attempts = 0;
  uint32_t state = seed ? seed : 0x9e3779b9u;
  uint32_t region_begin = anchor & 0xff00u, region_size = 256;
  if (!output) return 0;
  if (capacity > VDS_NAT_PUNCH_TARGETS) capacity = VDS_NAT_PUNCH_TARGETS;
  /* Genuine samples can contradict an aligned allocation-block hypothesis.
   * Use their envelope with tail allowance, without claiming a mapping type.
   * One/two samples and samples in one block retain the old region.
   * Joint concentration changes its early scheduling quota below.
   * Callers must group samples by confirmed address and current ICE ufrag. */
  if (anchor >= 1024 && observed) {
    uint16_t distinct[VDS_NAT_MAX_OBSERVATIONS];
    size_t count = 0, i;
    uint32_t low = 65535, high = 0;
    if (observed_count > VDS_NAT_MAX_OBSERVATIONS) observed_count = VDS_NAT_MAX_OBSERVATIONS;
    for (i = 0; i < observed_count; ++i) {
      size_t j;
      if (observed[i] < 1024) continue;
      for (j = 0; j < count && distinct[j] != observed[i]; ++j) {}
      if (j != count) continue;
      distinct[count++] = observed[i];
      if (observed[i] < low) low = observed[i];
      if (observed[i] > high) high = observed[i];
    }
    if (count >= 3 && (low & 0xff00u) != (high & 0xff00u)) {
      uint32_t margin = (high - low) / (uint32_t)(count - 1);
      int32_t begin, end;
      if (margin < 32) margin = 32;
      begin = (int32_t)low - (int32_t)margin;
      end = (int32_t)high + (int32_t)margin;
      if (end - begin + 1 < 256) {
        begin = (int32_t)((low + high) / 2) - 128;
        end = begin + 255;
      }
      if (begin < 1024) begin = 1024;
      if (end > 65535) end = 65535;
      region_begin = (uint32_t)begin;
      region_size = (uint32_t)(end - begin + 1);
    }
  }
  while (used < capacity && attempts++ < 4096) {
    size_t i;
    int port;
    state ^= state << 13; state ^= state >> 17; state ^= state << 5;
    /* Gradually abandon the unverified allocation-block hypothesis. Each
     * new plan gets a fresh seed; retransmissions keep their original plan. */
    /* Only joint concentration raises the early near-region preference.
     * Keep global hypotheses and abandon the hint at the original fourth-plan boundary. */
    const unsigned percent = concentrated
      ? (exploration_round == 0 ? 95 : exploration_round == 1 ? 75 : exploration_round == 2 ? 50 : 0)
      : (exploration_round >= 3 ? 0 : 25 * (3 - exploration_round));
    const size_t local_count = capacity * percent / 100;
    port = anchor >= 1024 && used < local_count
      ? region_begin + state % region_size : 1024 + state % (65536u - 1024u);
    if (port < 1024 || port == anchor) continue;
    for (i = 0; i < used && output[i] != port; ++i) {}
    if (i == used) output[used++] = (uint16_t)port;
  }
  return used;
}

/* Callers without both sides' evidence retain the byte-identical old plan. */
static inline size_t vds_nat_random_ports_sampled_round(uint16_t anchor,
    const uint16_t* observed, size_t observed_count, uint32_t seed,
    unsigned exploration_round, uint16_t* output, size_t capacity) {
  return vds_nat_random_ports_joint_round(anchor, observed, observed_count,
      seed, exploration_round, false, output, capacity);
}

static inline size_t vds_nat_random_ports_round(uint16_t anchor, uint32_t seed,
    unsigned exploration_round, uint16_t* output, size_t capacity) {
  return vds_nat_random_ports_sampled_round(anchor, NULL, 0, seed, exploration_round, output, capacity);
}

static inline size_t vds_nat_random_ports(uint16_t anchor, uint32_t seed,
    uint16_t* output, size_t capacity) {
  return vds_nat_random_ports_round(anchor, seed, 0, output, capacity);
}

/* Rank only the exploration planner, never change standard ICE priorities.
 * Prefer confirmed stable mappings, then linear predictions, then unknowns. */
static inline unsigned vds_nat_exploration_rank(int mode) {
  return mode == VDS_NAT_MAPPING_ENDPOINT_INDEPENDENT ? 0u :
      mode == VDS_NAT_MAPPING_SEQUENTIAL ? 1u : 2u;
}

#endif /* VDS_NAT_PORT_PREDICTION_H */
