#pragma once

#include <algorithm>
#include <chrono>

namespace vds::media_agent {

// A single cold-start diagnostic budget includes child retirement. It never
// applies to capture, encoder, transport, or playback sessions.
class CapabilityProbeBudget {
 public:
  using Clock = std::chrono::steady_clock;
  explicit CapabilityProbeBudget(unsigned long total_ms,
      Clock::time_point started_at = Clock::now())
      : deadline_(started_at + std::chrono::milliseconds(total_ms)) {}

  unsigned long next_timeout_ms(unsigned long requested_ms,
      Clock::time_point now = Clock::now()) const {
    constexpr long long kOwnedChildRetirementAllowanceMs = 2000;
    const auto remaining_ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline_ - now).count();
    if (remaining_ms <= kOwnedChildRetirementAllowanceMs) return 0;
    return static_cast<unsigned long>(std::min<long long>(requested_ms,
        remaining_ms - kOwnedChildRetirementAllowanceMs));
  }

 private:
  Clock::time_point deadline_;
};

}  // namespace vds::media_agent
