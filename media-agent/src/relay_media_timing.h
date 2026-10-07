#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "media_frame_timing.h"
#include "video_bootstrap_helpers.h"

namespace vds::media_agent {

// RTP is a compatibility input. Its arbitrary stream origin cannot establish
// A/V synchronization; this only prevents a 32-bit wrap from resetting PTS.
struct RelayRtpClock {
  std::uint64_t unwrapped_ticks = 0;
  std::uint64_t next_sequence = 0;
  std::uint64_t clock_rate = 0;
  bool initialized = false;

  std::uint64_t timestamp_us(std::uint32_t timestamp, std::uint64_t rate) {
    if (!initialized || clock_rate != rate) {
      unwrapped_ticks = timestamp;
      clock_rate = rate;
      initialized = true;
    } else {
      const std::uint32_t previous = static_cast<std::uint32_t>(unwrapped_ticks);
      const std::uint32_t forward = timestamp - previous;
      if (forward < 0x80000000u) {
        unwrapped_ticks += forward;
      } else {
        // A reordered packet must not move the high-water mark backwards.
        const std::uint64_t backward = previous - timestamp;
        const std::uint64_t ticks = backward <= unwrapped_ticks ? unwrapped_ticks - backward : 0;
        return to_microseconds(ticks, rate);
      }
    }
    return to_microseconds(unwrapped_ticks, rate);
  }

  static std::uint64_t to_microseconds(std::uint64_t ticks, std::uint64_t rate) {
    return rate == 0 ? 0 : (ticks / rate) * 1000000ull + ((ticks % rate) * 1000000ull) / rate;
  }
};

struct RelayTimedVideoAccessUnit {
  std::vector<std::uint8_t> bytes;
  MediaFrameTiming timing;
};

// This cache keeps a complete, contiguous reference chain. A size limit never
// removes its IDR while leaving dependent pictures advertised as a bootstrap.
class RelayVideoBootstrapCache {
 public:
  struct Observation {
    bool reset_subscribers = false;
    bool sequence_reset = false;
    bool duplicate = false;
  };

  static constexpr std::size_t kMaxAccessUnits = 96;
  static constexpr std::size_t kMaxBytes = 16 * 1024 * 1024;

  Observation observe(const std::string& codec, RelayTimedVideoAccessUnit unit) {
    Observation result;
    if (codec_ != codec || (!source_id_.empty() && source_id_ != unit.timing.source_id) ||
        source_epoch_ != unit.timing.source_epoch) {
      clear();
      result.reset_subscribers = true;
      result.sequence_reset = true;
    }
    codec_ = codec;
    source_id_ = unit.timing.source_id;
    source_epoch_ = unit.timing.source_epoch;
    if (unit.timing.sequence_valid && last_sequence_valid_) {
      if (unit.timing.sequence == last_sequence_) {
        result.duplicate = true;
        return result;
      }
      if (unit.timing.sequence < last_sequence_ ||
          last_sequence_ == std::numeric_limits<std::uint64_t>::max() ||
          unit.timing.sequence != last_sequence_ + 1) {
        invalidate_gop();
        result.reset_subscribers = true;
        result.sequence_reset = unit.timing.sequence < last_sequence_;
        if (result.sequence_reset) config_by_nal_type_.clear();
      }
    }
    last_sequence_ = unit.timing.sequence;
    last_sequence_valid_ = unit.timing.sequence_valid;

    bool changed_config = false;
    const auto config_in_unit = video_bootstrap_detail::parameter_sets(codec_, unit.bytes);
    for (const auto& nal : config_in_unit) {
      const auto found = config_by_nal_type_.find(nal.first);
      if (found != config_by_nal_type_.end() && found->second != nal.second) {
        changed_config = true;
      }
      config_by_nal_type_[nal.first] = nal.second;
    }
    unit.timing.keyframe = contains_random_access(codec_, unit.bytes);
    unit.timing.config = !config_in_unit.empty();
    if (changed_config && !unit.timing.keyframe) {
      invalidate_gop();
      result.reset_subscribers = true;
    }
    if (unit.timing.keyframe) {
      invalidate_gop();
      if (configuration_complete()) {
        // Prefix only missing parameter sets. A cached config AU may have
        // contained an old picture; only its parameter-set NALs are retained.
        const auto& existing = config_in_unit;
        std::vector<std::uint8_t> prefix;
        for (const auto& parameter_set : config_by_nal_type_) {
          if (existing.find(parameter_set.first) == existing.end()) {
            prefix.insert(prefix.end(), parameter_set.second.begin(), parameter_set.second.end());
          }
        }
        prefix.insert(prefix.end(), unit.bytes.begin(), unit.bytes.end());
        unit.bytes = std::move(prefix);
        unit.timing.config = true;
        append(std::move(unit));
      }
    } else if (!gop_.empty()) {
      append(std::move(unit));
    }
    return result;
  }

  std::vector<RelayTimedVideoAccessUnit> snapshot() const { return gop_; }
  void invalidate_gop() { gop_.clear(); cached_bytes_ = 0; }
  void clear() {
    invalidate_gop();
    config_by_nal_type_.clear();
    source_id_.clear();
    source_epoch_.clear();
    last_sequence_valid_ = false;
  }

 private:
  static bool contains_random_access(const std::string& codec, const std::vector<std::uint8_t>& bytes) {
    bool found = false;
    video_bootstrap_detail::visit_nals(codec, bytes, [&](unsigned int type, std::size_t, std::size_t) {
      found = found || (codec == "h265" ? type >= 16 && type <= 21 : type == 5);
    });
    return found;
  }
  bool configuration_complete() const {
    return codec_ == "h265"
      ? config_by_nal_type_.count(32) && config_by_nal_type_.count(33) && config_by_nal_type_.count(34)
      : config_by_nal_type_.count(7) && config_by_nal_type_.count(8);
  }
  void append(RelayTimedVideoAccessUnit unit) {
    if (gop_.size() >= kMaxAccessUnits || unit.bytes.size() > kMaxBytes - cached_bytes_) {
      invalidate_gop();
      return;
    }
    cached_bytes_ += unit.bytes.size();
    gop_.push_back(std::move(unit));
  }

  std::string codec_ = "h264";
  std::string source_id_;
  std::string source_epoch_;
  video_bootstrap_detail::ParameterSets config_by_nal_type_;
  std::vector<RelayTimedVideoAccessUnit> gop_;
  std::size_t cached_bytes_ = 0;
  std::uint64_t last_sequence_ = 0;
  bool last_sequence_valid_ = false;
};

} // namespace vds::media_agent
