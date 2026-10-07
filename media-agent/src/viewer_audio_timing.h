#pragma once

#include <algorithm>
#include <cstdint>
#include <deque>
#include <limits>
#include <string>

#include "media_frame_timing.h"

// Small, deterministic policies; platform handles never enter these classes.
class ViewerAudioTimingPlan {
 public:
  void reset() { *this = {}; }
  unsigned int buffer_ms() const { return target_buffer_ms_; }
  bool due(const MediaFrameTiming& timing, std::int64_t now_us, unsigned int delay_ms) const {
    if (!anchored_ || !timing.timestamp_valid || timing.source_id != source_id_) { return true; }
    return arrival_anchor_us_ + timestamp_delta(timing.timestamp_us, source_anchor_us_) +
      static_cast<std::int64_t>(target_buffer_ms_ + delay_ms) * 1000 <= now_us;
  }

  bool discontinuous(const MediaFrameTiming& timing, std::int64_t now_us) const {
    if (!anchored_ || !timing.timestamp_valid) { return false; }
    if (timing.source_id != source_id_) { return true; }
    if (timing.timestamp_us < last_source_us_ &&
        last_source_us_ - timing.timestamp_us > 500000) { return true; }
    const auto delta = timestamp_delta(timing.timestamp_us, source_anchor_us_);
    return delta < -500000 || delta > now_us - arrival_anchor_us_ + 500000;
  }

  void anchor(const MediaFrameTiming& timing, std::int64_t now_us) {
    anchored_ = timing.timestamp_valid && !timing.source_id.empty();
    source_id_ = timing.source_id;
    source_anchor_us_ = timing.timestamp_us;
    last_source_us_ = timing.timestamp_us;
    arrival_anchor_us_ = now_us;
    stable_since_us_ = now_us;
    last_growth_us_ = now_us;
  }

  std::int64_t deadline(const MediaFrameTiming& timing, std::int64_t now_us,
                        unsigned int delay_ms) {
    if (!timing.timestamp_valid || timing.source_id.empty()) {
      return now_us + static_cast<std::int64_t>(delay_ms) * 1000;
    }
    if (!anchored_) { anchor(timing, now_us); }
    last_source_us_ = std::max(last_source_us_, timing.timestamp_us);
    const auto expected_arrival = arrival_anchor_us_ +
      timestamp_delta(timing.timestamp_us, source_anchor_us_);
    const auto lateness_us = now_us - expected_arrival;
    if (lateness_us > static_cast<std::int64_t>(target_buffer_ms_) * 1000 &&
        now_us - last_growth_us_ >= 100000) {
      target_buffer_ms_ = std::min(60u, target_buffer_ms_ + 10);
      stable_since_us_ = last_growth_us_ = now_us;
    } else if (lateness_us > static_cast<std::int64_t>(target_buffer_ms_) * 1000) {
      stable_since_us_ = now_us;
    } else if (now_us - stable_since_us_ >= 2000000 && target_buffer_ms_ > 20) {
      --target_buffer_ms_;
      stable_since_us_ = now_us;
    }
    return expected_arrival + static_cast<std::int64_t>(target_buffer_ms_ + delay_ms) * 1000;
  }

 private:
  static std::int64_t timestamp_delta(std::uint64_t value, std::uint64_t origin) {
    const auto distance = value >= origin ? value - origin : origin - value;
    const auto bounded = static_cast<std::int64_t>(std::min<std::uint64_t>(
      distance, 1000000000000ULL));
    return value >= origin ? bounded : -bounded;
  }
  bool anchored_ = false;
  std::string source_id_;
  std::uint64_t source_anchor_us_ = 0;
  std::uint64_t last_source_us_ = 0;
  std::int64_t arrival_anchor_us_ = 0;
  std::int64_t stable_since_us_ = 0;
  std::int64_t last_growth_us_ = 0;
  unsigned int target_buffer_ms_ = 20;
};

enum class ViewerAudioPositionUnit { Samples, Bytes, Milliseconds, Unsupported };

struct ViewerAudioClockEstimate {
  bool valid = false;
  std::uint64_t timestamp_us = 0;
  std::string source_id;
};

class ViewerAudioDeviceClock {
 public:
  void reset() { *this = {}; }
  void invalidate() { valid_ = false; }
  std::uint64_t position_frames() const { return device_frames_; }

  void record_write(unsigned int frames, const MediaFrameTiming& timing) {
    if (frames == 0) { return; }
    segments_.push_back({written_frames_, frames, timing});
    written_frames_ += frames;
    // At most 60 ms is submitted to waveOut. This is also a defensive bound for
    // malformed one-sample blocks, independent of their time-domain duration.
    if (segments_.size() > 128) {
      segments_.pop_front();
      valid_ = false;
    }
  }

  bool observe(std::uint32_t raw, ViewerAudioPositionUnit unit, std::int64_t now_us) {
    if (unit == ViewerAudioPositionUnit::Unsupported || now_us < last_observation_us_) {
      valid_ = false;
      return false;
    }
    if (observed_ && unit != unit_) {
      valid_ = false;
      return false;
    }
    if (observed_ && raw < last_raw_) {
      if (last_raw_ - raw <= 0x80000000u) {
        valid_ = false;
        return false;
      }
      raw_wrap_ += (std::uint64_t{1} << 32);
    }
    const auto ticks = raw_wrap_ + raw;
    const std::uint64_t samples = unit == ViewerAudioPositionUnit::Samples ? ticks :
      unit == ViewerAudioPositionUnit::Bytes ? ticks / 4 : ticks * 48;
    if (samples > written_frames_ || (observed_ && samples < device_frames_)) {
      valid_ = false;
      return false;
    }
    if (!observed_ || samples > device_frames_) { last_progress_us_ = now_us; }
    // The first query at zero does not establish that the output is running.
    valid_ = observed_ && samples > 0 &&
      now_us - last_progress_us_ <= 80000 && samples < written_frames_;
    observed_ = true;
    unit_ = unit;
    last_raw_ = raw;
    device_frames_ = samples;
    last_observation_us_ = now_us;
    while (segments_.size() > 1 &&
           segments_.front().begin_frame + segments_.front().frames <= samples) {
      segments_.pop_front();
    }
    return true;
  }

  ViewerAudioClockEstimate estimate(std::int64_t now_us) const {
    if (!valid_ || now_us < last_observation_us_ ||
        now_us - last_observation_us_ > 40000 || now_us - last_progress_us_ > 80000) {
      return {};
    }
    const auto elapsed_frames = static_cast<std::uint64_t>(now_us - last_observation_us_) * 48 / 1000;
    const auto position = device_frames_ + elapsed_frames;
    if (position >= written_frames_) { return {}; }
    for (const auto& segment : segments_) {
      if (position >= segment.begin_frame && position < segment.begin_frame + segment.frames) {
        if (!segment.timing.timestamp_valid || segment.timing.source_id.empty()) { return {}; }
        const auto offset_us = (position - segment.begin_frame) * 1000000 / 48000;
        if (segment.timing.timestamp_us > std::numeric_limits<std::uint64_t>::max() - offset_us) {
          return {};
        }
        return {true, segment.timing.timestamp_us + offset_us, segment.timing.source_id};
      }
    }
    return {};
  }

 private:
  struct Segment {
    std::uint64_t begin_frame;
    unsigned int frames;
    MediaFrameTiming timing;
  };
  std::deque<Segment> segments_;
  std::uint64_t written_frames_ = 0;
  std::uint64_t device_frames_ = 0;
  std::uint64_t raw_wrap_ = 0;
  std::uint32_t last_raw_ = 0;
  std::int64_t last_observation_us_ = 0;
  std::int64_t last_progress_us_ = 0;
  ViewerAudioPositionUnit unit_ = ViewerAudioPositionUnit::Unsupported;
  bool observed_ = false;
  bool valid_ = false;
};
