#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>

namespace vds::media_agent {

// Choose the nearest RTP cycle to the latest observed source timestamp. Late
// packets never move the reference backwards; PTS may still arrive out of order.
struct RtpTimestampUnwrapper {
  bool initialized = false;
  std::uint64_t latest = 0;

  std::uint64_t unwrap(std::uint32_t timestamp) {
    if (!initialized) {
      initialized = true;
      latest = timestamp;
      return latest;
    }
    constexpr std::uint64_t cycle = std::uint64_t{1} << 32;
    constexpr std::uint64_t half = cycle / 2;
    std::uint64_t candidate = (latest & ~(cycle - 1)) | timestamp;
    if (candidate < latest && latest - candidate > half &&
        candidate <= std::numeric_limits<std::uint64_t>::max() - cycle) {
      candidate += cycle;
    } else if (candidate > latest && candidate - latest > half) {
      // A packet from the cycle before our first observation has negative
      // relative time. It cannot advance the reference into a future cycle.
      if (candidate < cycle) return 0;
      candidate -= cycle;
    }
    latest = std::max(latest, candidate);
    return candidate;
  }

  void reset() { initialized = false; latest = 0; }
};

inline std::uint64_t media_clock_ticks_to_us(std::uint64_t ticks, std::uint32_t clock_rate) {
  if (clock_rate == 0) return 0;
  const std::uint64_t seconds = ticks / clock_rate;
  if (seconds > std::numeric_limits<std::uint64_t>::max() / 1000000u) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  const auto whole_us = seconds * 1000000u;
  const auto fraction_us = ((ticks % clock_rate) * 1000000u) / clock_rate;
  return fraction_us > std::numeric_limits<std::uint64_t>::max() - whole_us
    ? std::numeric_limits<std::uint64_t>::max() : whole_us + fraction_us;
}

inline std::uint32_t media_timestamp_us_to_rtp(std::uint64_t timestamp_us, std::uint32_t clock_rate) {
  // Keep the modulo operation before multiplication so 64-bit source PTS never
  // overflows just to make a legacy 32-bit transport timestamp.
  return static_cast<std::uint32_t>(
    static_cast<std::uint64_t>(static_cast<std::uint32_t>(timestamp_us / 1000000u)) * clock_rate +
    ((timestamp_us % 1000000u) * clock_rate) / 1000000u);
}

// One signed input timeline for all streams in an ingest session. Do not reset
// it for individual streams or force monotonic PTS: video with B frames needs
// decode order and presentation order to remain distinct.
struct MediaSourceTimeline {
  bool origin_valid = false;
  std::int64_t origin_us = 0;
  std::uint64_t source_offset_us = 0;

  std::uint64_t map(std::int64_t presentation_us) {
    if (!origin_valid) { origin_us = presentation_us; origin_valid = true; }
    if (presentation_us <= origin_us) return source_offset_us;
    // Unsigned subtraction also represents a difference crossing signed zero.
    const std::uint64_t delta = static_cast<std::uint64_t>(presentation_us) -
      static_cast<std::uint64_t>(origin_us);
    const auto maximum = std::numeric_limits<std::uint64_t>::max();
    return delta > maximum - source_offset_us ? maximum : source_offset_us + delta;
  }
};

}  // namespace vds::media_agent
