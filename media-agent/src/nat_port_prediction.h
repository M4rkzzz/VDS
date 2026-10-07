#ifndef VDS_NAT_PORT_PREDICTION_H
#define VDS_NAT_PORT_PREDICTION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VDS_NAT_MAX_OBSERVATIONS 8u
#define VDS_NAT_MAX_PREDICTED_PORTS 16u

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

#endif /* VDS_NAT_PORT_PREDICTION_H */
