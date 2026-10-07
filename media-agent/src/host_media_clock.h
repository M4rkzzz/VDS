#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <mutex>
#include <random>
#include <sstream>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace vds::media_agent {

struct HostMediaClockSnapshot {
  std::int64_t epoch_steady_us = 0;
  std::uint64_t generation = 0;
  std::uint64_t epoch_system_relative_100ns = 0;
  std::string source_epoch;
};

inline const std::string& host_media_process_nonce() {
  static const std::string nonce = [] {
    std::random_device entropy;
    std::ostringstream value;
    value << std::hex << std::setfill('0');
    for (int index = 0; index < 4; ++index) {
      value << std::setw(8) << static_cast<std::uint32_t>(entropy());
    }
    return value.str();
  }();
  return nonce;
}

inline std::int64_t host_media_steady_now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline HostMediaClockSnapshot make_host_media_clock_snapshot(std::uint64_t generation) {
  HostMediaClockSnapshot snapshot;
  snapshot.epoch_steady_us = host_media_steady_now_us();
  snapshot.generation = generation;
  snapshot.source_epoch = "host-" + host_media_process_nonce() + "-" +
    std::to_string(generation) + "-" + std::to_string(snapshot.epoch_steady_us);
#ifdef _WIN32
  LARGE_INTEGER counter{}, frequency{};
  if (QueryPerformanceCounter(&counter) && QueryPerformanceFrequency(&frequency) && frequency.QuadPart > 0) {
    const auto ticks = static_cast<std::uint64_t>(counter.QuadPart);
    const auto rate = static_cast<std::uint64_t>(frequency.QuadPart);
    snapshot.epoch_system_relative_100ns =
      (ticks / rate) * 10000000ull + ((ticks % rate) * 10000000ull) / rate;
  }
#endif
  return snapshot;
}

struct SharedHostMediaClock {
  std::mutex mutex;
  HostMediaClockSnapshot snapshot = make_host_media_clock_snapshot(1);
};

inline SharedHostMediaClock& shared_host_media_clock() {
  static SharedHostMediaClock clock;
  return clock;
}

inline HostMediaClockSnapshot host_media_clock_snapshot() {
  auto& clock = shared_host_media_clock();
  std::lock_guard<std::mutex> lock(clock.mutex);
  return clock.snapshot;
}

// Call only after producers from the previous host session have been drained.
inline void reset_shared_host_media_clock() {
  auto& clock = shared_host_media_clock();
  std::lock_guard<std::mutex> lock(clock.mutex);
  clock.snapshot = make_host_media_clock_snapshot(clock.snapshot.generation + 1);
}

inline std::uint64_t host_media_timestamp_us(
  const HostMediaClockSnapshot& clock, std::int64_t steady_us) {
  return steady_us > clock.epoch_steady_us
    ? static_cast<std::uint64_t>(steady_us - clock.epoch_steady_us) : 0;
}

inline std::uint64_t host_media_now_us(const HostMediaClockSnapshot& clock) {
  return host_media_timestamp_us(clock, host_media_steady_now_us());
}

inline std::uint64_t host_media_system_relative_timestamp_us(
  const HostMediaClockSnapshot& clock, std::uint64_t timestamp_100ns) {
  if (clock.epoch_system_relative_100ns == 0 || timestamp_100ns == 0) {
    return host_media_now_us(clock);
  }
  return timestamp_100ns > clock.epoch_system_relative_100ns
    ? (timestamp_100ns - clock.epoch_system_relative_100ns) / 10 : 0;
}

inline std::uint64_t host_media_samples_to_us(std::uint64_t samples, std::uint64_t rate) {
  return rate == 0 ? 0 : (samples / rate) * 1000000ull + ((samples % rate) * 1000000ull) / rate;
}

inline std::uint64_t host_media_us_to_samples(std::uint64_t timestamp_us, std::uint64_t rate) {
  return (timestamp_us / 1000000ull) * rate + ((timestamp_us % 1000000ull) * rate) / 1000000ull;
}

inline std::uint64_t host_media_packet_first_sample_us(
  std::uint64_t capture_end_us, std::uint64_t frames, std::uint64_t rate) {
  const auto duration_us = host_media_samples_to_us(frames, rate);
  return capture_end_us > duration_us ? capture_end_us - duration_us : 0;
}

// Annex-B does not carry FFmpeg timestamps. Internal screen capture therefore
// uses a bounded estimate; source-clock jumps cannot leave a late joiner at zero.
inline std::uint64_t host_media_next_synthetic_video_us(
  std::uint64_t previous_us, bool previous_valid, std::uint64_t interval_us, std::uint64_t now_us) {
  if (!previous_valid) {
    return now_us;
  }
  const auto next_us = previous_us + std::max<std::uint64_t>(1, interval_us);
  constexpr std::uint64_t max_lag_us = 250000;
  if (now_us > next_us && now_us - next_us > max_lag_us) {
    return now_us;
  }
  return std::min(next_us, now_us);
}

}  // namespace vds::media_agent
