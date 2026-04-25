#pragma once

#include <atomic>
#include <cstdint>

namespace vds::media_agent {

long long current_time_millis();
std::int64_t current_time_micros_steady();
bool sleep_until_steady_us(std::int64_t target_us, const std::atomic<bool>* stop_flag = nullptr);
std::uint64_t rtp_timestamp_to_us(std::uint32_t timestamp, std::uint64_t clock_rate);

} // namespace vds::media_agent
