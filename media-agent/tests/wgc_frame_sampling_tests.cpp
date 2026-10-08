#include "wgc_capture.h"

#include <iostream>
#include <vector>

namespace {
int checks = 0;
int failures = 0;
void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

// Reference the sender's previous post-readback sampling, independently of the
// readback sampler. Moving this decision must not change the admitted timeline.
struct PreviousSenderSampling {
  std::uint64_t interval_us;
  std::uint64_t next_timestamp = 0;
  WgcFrameReadbackSampler::Clock::time_point next_time{};
  bool accept(std::uint64_t timestamp, WgcFrameReadbackSampler::Clock::time_point now) {
    if (timestamp > 0) {
      if (next_timestamp == 0) next_timestamp = timestamp;
      if (timestamp < next_timestamp) return false;
      do { next_timestamp += interval_us * 10; } while (next_timestamp <= timestamp);
    } else {
      if (next_time == WgcFrameReadbackSampler::Clock::time_point{}) next_time = now;
      if (now < next_time) return false;
      do { next_time += std::chrono::microseconds(interval_us); } while (next_time <= now);
    }
    return true;
  }
};

void test_original_sampling_timeline() {
  using Clock = WgcFrameReadbackSampler::Clock;
  for (const std::uint64_t fps : {1, 24, 30, 60, 144, 240, 480, 1000}) {
    const auto interval_us = 1000000 / fps;
    WgcFrameReadbackSampler sampler(interval_us, 1920, 1080);
    PreviousSenderSampling previous{interval_us};
    std::uint64_t timestamp = 100000000;
    auto observed_at = Clock::time_point(std::chrono::seconds(5));
    const std::vector<std::uint64_t> arrivals{1, 1000, 10000, 166666, 333333, 10000000, 5000000};
    for (unsigned index = 0; index < 1000; ++index) {
      timestamp += arrivals[index % arrivals.size()];
      observed_at += std::chrono::microseconds(arrivals[(index + 2) % arrivals.size()] / 10);
      const auto source_timestamp = index % 11 == 0 ? 0 : timestamp;
      expect(sampler.accept(1920, 1080, 7680, source_timestamp, observed_at) ==
        previous.accept(source_timestamp, observed_at),
        "pre-readback sampling must preserve existing FPS/PTS admission across gaps and fallback clocks");
    }
  }
}

void test_geometry_and_source_reset() {
  using Clock = WgcFrameReadbackSampler::Clock;
  const auto now = Clock::time_point(std::chrono::seconds(5));
  WgcFrameReadbackSampler sampler(16666, 1920, 1080);
  expect(sampler.accept(1920, 1080, 7680, 10000000, now), "the first source frame is admitted immediately");
  expect(!sampler.accept(1920, 1080, 7680, 10000001, now), "early same-size frames skip GPU readback");
  expect(sampler.accept(1280, 720, 5120, 10000002, now), "size changes always reach existing source reconfiguration");
  expect(sampler.accept(1920, 1080, 8192, 10000003, now), "stride changes always reach existing source reconfiguration");
  expect(!sampler.accept(1920, 1080, 7680, 10000004, now), "geometry checks do not shift the original sampling grid");
  sampler.reset();
  expect(sampler.accept(1920, 1080, 7680, 100, now), "a recreated source admits its own first timestamp");
  sampler.reset();
  expect(sampler.accept(1920, 1080, 7680, 0, now), "missing source timestamps retain the steady-clock fallback");
  expect(!sampler.accept(1920, 1080, 7680, 0, now + std::chrono::microseconds(16665)),
    "fallback frames retain their previous minimum interval");
  expect(sampler.accept(1920, 1080, 7680, 0, now + std::chrono::microseconds(16666)),
    "fallback frames are admitted exactly on the previous deadline");
  expect(sampler.accept(1920, 1080, 7680, 0, now + std::chrono::hours(24)),
    "a long idle period advances without replaying missed sampling slots");
}
}  // namespace

int main() {
  test_original_sampling_timeline();
  test_geometry_and_source_reset();
  std::cout << "WGC frame sampling: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
