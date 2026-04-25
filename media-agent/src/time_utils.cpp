#include "time_utils.h"

#include <algorithm>
#include <chrono>
#include <thread>

namespace vds::media_agent {

namespace {

constexpr std::int64_t kSteadySleepMaxChunkUs = 10000;

} // namespace

long long current_time_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

std::int64_t current_time_micros_steady() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now().time_since_epoch()
  ).count();
}

bool sleep_until_steady_us(std::int64_t target_us, const std::atomic<bool>* stop_flag) {
  while (true) {
    if (stop_flag && stop_flag->load()) {
      return false;
    }

    const std::int64_t now_us = current_time_micros_steady();
    if (target_us <= now_us) {
      return true;
    }

    const std::int64_t remaining_us = target_us - now_us;
    const auto sleep_for = std::chrono::microseconds(std::min<std::int64_t>(
      remaining_us,
      kSteadySleepMaxChunkUs
    ));
    std::this_thread::sleep_for(sleep_for);
  }
}

std::uint64_t rtp_timestamp_to_us(std::uint32_t timestamp, std::uint64_t clock_rate) {
  if (clock_rate == 0) {
    return 0;
  }
  return (static_cast<std::uint64_t>(timestamp) * 1000000ull) / clock_rate;
}

} // namespace vds::media_agent
