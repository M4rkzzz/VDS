#pragma once

#include "media_frame_timing.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <iterator>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// These helpers contain no decoder, device or wall-clock calls. The owner uses a
// single monotonic clock, supplies microseconds and serializes access to them.
namespace native_playback_detail {
inline std::uint64_t add_saturated(std::uint64_t value, std::uint64_t amount) {
  return amount > std::numeric_limits<std::uint64_t>::max() - value
      ? std::numeric_limits<std::uint64_t>::max() : value + amount;
}

inline std::int64_t difference(std::uint64_t value, std::uint64_t base) {
  constexpr auto limit = static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
  if (value >= base) {
    return static_cast<std::int64_t>(std::min(value - base, limit));
  }
  return -static_cast<std::int64_t>(std::min(base - value, limit));
}

inline std::uint64_t add_signed(std::uint64_t value, std::int64_t offset) {
  if (offset >= 0) {
    return add_saturated(value, static_cast<std::uint64_t>(offset));
  }
  // difference() never returns INT64_MIN.
  const auto amount = static_cast<std::uint64_t>(-offset);
  return amount > value ? 0 : value - amount;
}

inline std::size_t encoded_capacity_for_frame_rate(unsigned int frame_rate) {
  // A normal MPEG-TS AAC PES may release roughly 235ms of synchronized video.
  // Keep compressed AUs, rather than expanding the decoded/GPU ready queue.
  const auto fps = static_cast<std::uint64_t>(frame_rate ? frame_rate : 60u);
  return static_cast<std::size_t>((fps + 3u) / 4u + 2u);
}

// Sequence numbers describe encoded/decode order, including wrapping at 64
// bits. Presentation timestamps must never be used to sort compressed AUs.
inline bool sequence_before(std::uint64_t value, std::uint64_t next) {
  return value != next && (next - value) < (std::uint64_t{1} << 63);
}
}  // namespace native_playback_detail

template <typename Frame>
class NativeEncodedFrameQueue {
 public:
  struct Entry {
    Frame frame;
    MediaFrameTiming timing;
    std::uint64_t arrival_us = 0;
    bool config_only = false;
    // Private-to-the-queue identity survives cached replay; never a media seq.
    std::uint64_t cache_token = 0;
    std::size_t byte_size = 0;
  };

  struct PushResult {
    bool accepted = false;
    bool duplicate = false;
    bool reset_required = false;
    std::size_t dropped_frames = 0;
  };

  enum class PopState { Empty, Waiting, Frame, Reset };

  explicit NativeEncodedFrameQueue(std::size_t capacity = 8,
                                  std::uint64_t reorder_wait_us = 20000,
                                  std::size_t max_pending_bytes = 0,
                                  std::uint64_t max_pending_age_us = 0)
      : capacity_(std::max<std::size_t>(2, capacity)),
        reorder_wait_us_(reorder_wait_us), max_pending_bytes_(max_pending_bytes),
        max_pending_age_us_(max_pending_age_us) {}

  void set_capacity(std::size_t capacity) { capacity_ = std::max<std::size_t>(2, capacity); }
  std::size_t capacity() const { return capacity_; }
  std::size_t pending_bytes() const {
    std::size_t bytes = 0;
    for (const auto& entry : pending_) bytes += entry.byte_size;
    return bytes;
  }

  // config_only means a non-VCL AU, as determined from actual NAL contents by
  // the caller. Only timing.config parameter-set AUs are cached; AUD/SEI are
  // ordinary non-VCL encoded slots. Configuration may also accompany VCL.
  PushResult push(Frame frame, const MediaFrameTiming& timing,
                  std::uint64_t now_us, bool config_only = false,
                  std::size_t byte_size = 0) {
    PushResult result;
    Entry entry{std::move(frame), timing, now_us, config_only};
    entry.byte_size = byte_size;
    entry.cache_token = ++next_cache_token_;
    if (entry.cache_token == 0) {
      entry.cache_token = ++next_cache_token_;
    }

    if (!timing.source_id.empty()) {
      if (!source_id_.empty() && source_id_ != timing.source_id) {
        result.dropped_frames = pending_.size();
        reset();
        pending_reset_ = true;
        result.reset_required = true;
      }
      source_id_ = timing.source_id;
    }

    if (timing.sequence_valid) {
      if (was_consumed(timing.sequence, config_only) ||
          std::any_of(pending_.begin(), pending_.end(), [&](const Entry& other) {
            return other.timing.sequence_valid &&
                other.timing.sequence == timing.sequence &&
                other.config_only == config_only;
          })) {
        result.duplicate = true;
        return result;
      }
      if (!waiting_for_keyframe_ && expected_sequence_ &&
          native_playback_detail::sequence_before(timing.sequence, *expected_sequence_) &&
          !is_consumed_counterpart(entry) && !(bootstrap_pending_ && config_only)) {
        ++result.dropped_frames;
        return result;
      }
    }

    if (config_only) {
      if (timing.config) {
        cached_config_ = entry;
      }
    } else if (waiting_for_keyframe_ && !timing.keyframe) {
      ++result.dropped_frames;
      return result;
    }

    if (!config_only && timing.keyframe && waiting_for_keyframe_) {
      waiting_for_keyframe_ = false;
      bootstrap_pending_ = true;
      expected_sequence_ = timing.sequence_valid
          ? std::optional<std::uint64_t>{timing.sequence} : std::nullopt;
    }

    pending_.push_back(std::move(entry));
    result.accepted = true;
    const bool expired = max_pending_age_us_ && std::any_of(pending_.begin(), pending_.end(), [&](const Entry& candidate) {
      // Cached SPS/PPS intentionally outlives a picture backlog. Replaying an
      // old configuration must not make a fresh IDR look half a second stale.
      return !candidate.config_only && now_us > candidate.arrival_us &&
          now_us - candidate.arrival_us > max_pending_age_us_;
    });
    if (pending_.size() > capacity_ ||
        (max_pending_bytes_ && pending_bytes() > max_pending_bytes_) || expired) {
      result.dropped_frames += recover_reference_chain(now_us);
      result.reset_required = true;
    }
    return result;
  }

  PopState pop(std::uint64_t now_us, Entry& output,
               std::size_t* discarded_frames = nullptr) {
    if (discarded_frames) {
      *discarded_frames = 0;
    }
    if (pending_reset_) {
      pending_reset_ = false;
      return PopState::Reset;
    }
    if (pending_.empty()) {
      gap_since_us_.reset();
      return PopState::Empty;
    }

    const auto ready = ready_index();
    if (!ready) {
      if (!gap_since_us_) {
        gap_since_us_ = now_us;
      }
      const auto deadline = native_playback_detail::add_saturated(*gap_since_us_, reorder_wait_us_);
      if (now_us < deadline) {
        return PopState::Waiting;
      }
      const auto discarded = recover_reference_chain(now_us);
      if (discarded_frames) {
        *discarded_frames = discarded;
      }
      pending_reset_ = false;
      return PopState::Reset;
    }

    output = std::move(pending_[*ready]);
    pending_.erase(pending_.begin() + static_cast<std::ptrdiff_t>(*ready));
    if (output.config_only && output.timing.config) {
      last_consumed_config_ = output;
      // Recovery may temporarily select older parameter sets for an older IDR.
      // Upgrade that cache when a retained newer CONFIG is consumed, without
      // replacing a still-queued future CONFIG or erasing a replay's sequence.
      if (!cached_config_ || (output.cache_token != cached_config_->cache_token &&
          (output.timing.sequence_valid && cached_config_->timing.sequence_valid
              ? native_playback_detail::sequence_before(cached_config_->timing.sequence,
                    output.timing.sequence)
              : (output.arrival_us > cached_config_->arrival_us ||
                 (output.arrival_us == cached_config_->arrival_us &&
                  native_playback_detail::sequence_before(cached_config_->cache_token,
                      output.cache_token)))))) {
        cached_config_ = output;
      }
    }
    if (output.timing.sequence_valid) {
      const bool advance = !expected_sequence_ ||
          output.timing.sequence == *expected_sequence_;
      remember_consumed(output.timing.sequence, output.config_only);
      if (advance && (!waiting_for_keyframe_ || !output.config_only)) {
        expected_sequence_ = output.timing.sequence + 1;
        gap_since_us_.reset();
      }
    }
    if (!output.config_only && output.timing.keyframe) {
      bootstrap_pending_ = false;
      gap_since_us_.reset();
      if (output.timing.sequence_valid && !expected_sequence_) {
        expected_sequence_ = output.timing.sequence + 1;
      }
    }
    if (!output.config_only && output.timing.sequence_valid) {
      last_vcl_sequence_ = output.timing.sequence;
    }
    return PopState::Frame;
  }

  std::optional<std::uint64_t> next_deadline_us() const {
    if (!gap_since_us_) {
      return std::nullopt;
    }
    return native_playback_detail::add_saturated(*gap_since_us_, reorder_wait_us_);
  }

  std::size_t size() const { return pending_.size(); }
  bool empty() const { return pending_.empty(); }
  bool needs_keyframe() const { return waiting_for_keyframe_; }
  bool reset_pending() const { return pending_reset_; }

  // A source/codec generation change discards cached configuration as well.
  void reset() {
    pending_.clear();
    cached_config_.reset();
    last_consumed_config_.reset();
    consumed_.clear();
    expected_sequence_.reset();
    gap_since_us_.reset();
    last_vcl_sequence_.reset();
    source_id_.clear();
    waiting_for_keyframe_ = true;
    bootstrap_pending_ = false;
    pending_reset_ = false;
  }

 private:
  struct Consumed {
    std::uint64_t sequence;
    bool config = false;
    bool vcl = false;
  };

  const Consumed* consumed_record(std::uint64_t sequence) const {
    const auto it = std::find_if(consumed_.begin(), consumed_.end(),
        [&](const Consumed& item) { return item.sequence == sequence; });
    return it == consumed_.end() ? nullptr : &*it;
  }

  bool was_consumed(std::uint64_t sequence, bool config_only) const {
    const auto* record = consumed_record(sequence);
    return record && (config_only ? record->config : record->vcl);
  }

  bool is_consumed_counterpart(const Entry& entry) const {
    if (!entry.timing.sequence_valid) {
      return false;
    }
    const auto* record = consumed_record(entry.timing.sequence);
    if (last_vcl_sequence_ &&
        native_playback_detail::sequence_before(entry.timing.sequence, *last_vcl_sequence_)) {
      return false;
    }
    return record && (entry.config_only ? (!record->config && record->vcl)
                                        : (!record->vcl && record->config));
  }

  void remember_consumed(std::uint64_t sequence, bool config_only) {
    auto it = std::find_if(consumed_.begin(), consumed_.end(),
        [&](const Consumed& item) { return item.sequence == sequence; });
    if (it == consumed_.end()) {
      consumed_.push_back({sequence, false, false});
      it = std::prev(consumed_.end());
    }
    if (config_only) {
      it->config = true;
    } else {
      it->vcl = true;
    }
    while (consumed_.size() > 64) {
      consumed_.pop_front();
    }
  }

  std::optional<std::size_t> ready_index() const {
    // Cached configuration has no sequence, and startup configuration may have
    // an earlier independent sequence than the first random-access AU.
    for (std::size_t index = 0; index < pending_.size(); ++index) {
      const auto& entry = pending_[index];
      if (entry.config_only && (!entry.timing.sequence_valid ||
          (bootstrap_pending_ && expected_sequence_ &&
           native_playback_detail::sequence_before(entry.timing.sequence, *expected_sequence_)))) {
        return index;
      }
    }

    if (!expected_sequence_) {
      return std::size_t{0};
    }
    // A config/VCL pair may share one sequence. Complete either counterpart before
    // releasing the following encoded AU; a configuration-only AU with its
    // own sequence simply has no such counterpart queued.
    for (std::size_t index = 0; index < pending_.size(); ++index) {
      const auto& entry = pending_[index];
      if (is_consumed_counterpart(entry)) {
        return index;
      }
    }
    // Prefer non-VCL configuration if it shares a sequence with its VCL AU.
    std::optional<std::size_t> vcl_match;
    for (std::size_t index = 0; index < pending_.size(); ++index) {
      const auto& entry = pending_[index];
      if (entry.timing.sequence_valid && entry.timing.sequence == *expected_sequence_) {
        if (entry.config_only) {
          return index;
        }
        if (!vcl_match) {
          vcl_match = index;
        }
      }
    }
    if (vcl_match) {
      return vcl_match;
    }
    for (std::size_t index = 0; index < pending_.size(); ++index) {
      const auto& entry = pending_[index];
      if (!entry.timing.sequence_valid || is_consumed_counterpart(entry)) {
        return index;
      }
    }
    return std::nullopt;
  }

  std::size_t recover_reference_chain(std::uint64_t now_us) {
    const auto original_size = pending_.size();
    std::optional<std::size_t> latest_key;
    for (std::size_t index = 0; index < pending_.size(); ++index) {
      const auto& entry = pending_[index];
      if (max_pending_age_us_ && now_us > entry.arrival_us &&
          now_us - entry.arrival_us > max_pending_age_us_) continue;
      if (!entry.config_only && entry.timing.keyframe) {
        if (!latest_key) {
          latest_key = index;
        } else {
          const auto& previous = pending_[*latest_key];
          if ((entry.timing.sequence_valid && previous.timing.sequence_valid &&
               native_playback_detail::sequence_before(previous.timing.sequence, entry.timing.sequence)) ||
              ((!entry.timing.sequence_valid || !previous.timing.sequence_valid) &&
               entry.arrival_us >= previous.arrival_us)) {
            latest_key = index;
          }
        }
      }
    }

    std::optional<Entry> recovery_config;
    if (!latest_key) {
      recovery_config = cached_config_;
    } else {
      const auto& key = pending_[*latest_key];
      const auto consider_config = [&](const Entry& candidate) {
        const bool eligible = candidate.timing.sequence_valid && key.timing.sequence_valid
            ? (candidate.timing.sequence == key.timing.sequence ||
               native_playback_detail::sequence_before(candidate.timing.sequence, key.timing.sequence))
            : candidate.arrival_us <= key.arrival_us;
        if (!eligible) {
          return;
        }
        if (!recovery_config ||
            (candidate.timing.sequence_valid && recovery_config->timing.sequence_valid
                ? native_playback_detail::sequence_before(recovery_config->timing.sequence,
                    candidate.timing.sequence)
                : candidate.arrival_us >= recovery_config->arrival_us)) {
          recovery_config = candidate;
        }
      };
      if (last_consumed_config_) {
        consider_config(*last_consumed_config_);
      }
      if (cached_config_) {
        consider_config(*cached_config_);
      }
      for (const auto& entry : pending_) {
        if (entry.config_only && entry.timing.config) {
          consider_config(entry);
        }
      }
      cached_config_ = recovery_config;
    }

    const bool original_config_replayed = recovery_config &&
        std::any_of(pending_.begin(), pending_.end(), [&](const Entry& entry) {
          return entry.cache_token == recovery_config->cache_token;
        });
    std::deque<Entry> retained;
    std::size_t retained_bytes = 0;
    if (recovery_config) {
      auto replay = *recovery_config;
      replay.timing.sequence_valid = false;
      retained.push_back(std::move(replay));
      retained_bytes += retained.back().byte_size;
    }
    if (latest_key) {
      const auto key_timing = pending_[*latest_key].timing;
      auto key = std::move(pending_[*latest_key]);
      pending_.erase(pending_.begin() + static_cast<std::ptrdiff_t>(*latest_key));
      retained.push_back(std::move(key));
      retained_bytes += retained.back().byte_size;
      if (key_timing.sequence_valid) {
        // Retain only a contiguous encoded suffix. A missing reference is not
        // repaired by preserving arbitrary later P pictures.
        auto next = key_timing.sequence + 1;
        while (retained.size() < capacity_) {
          const auto matches = static_cast<std::size_t>(std::count_if(
              pending_.begin(), pending_.end(), [&](const Entry& entry) {
                return entry.timing.sequence_valid && entry.timing.sequence == next;
              }));
          if (matches == 0 || retained.size() + matches > capacity_) {
            break;
          }
          std::size_t next_bytes = 0;
          for (const auto& candidate : pending_) {
            if (candidate.timing.sequence_valid && candidate.timing.sequence == next) next_bytes += candidate.byte_size;
          }
          if (max_pending_bytes_ && next_bytes > max_pending_bytes_ - std::min(max_pending_bytes_, retained_bytes)) break;
          // Config precedes VCL when both occupy the same encoded slot.
          for (const bool config_kind : {true, false}) {
            auto match = std::find_if(pending_.begin(), pending_.end(), [&](const Entry& entry) {
              return entry.timing.sequence_valid && entry.timing.sequence == next &&
                  entry.config_only == config_kind;
            });
            if (match != pending_.end()) {
              retained.push_back(std::move(*match));
              retained_bytes += retained.back().byte_size;
              pending_.erase(match);
            }
          }
          ++next;
        }
        expected_sequence_ = key_timing.sequence;
      } else {
        expected_sequence_.reset();
      }
      waiting_for_keyframe_ = false;
      bootstrap_pending_ = true;
    } else {
      expected_sequence_.reset();
      waiting_for_keyframe_ = true;
      bootstrap_pending_ = false;
    }
    // Replay configuration is a cached extra, not a retained compressed AU.
    const auto retained_original =
        (latest_key ? retained.size() - (recovery_config ? 1 : 0) : 0) +
        (original_config_replayed ? 1 : 0);
    pending_ = std::move(retained);
    consumed_.clear();
    last_vcl_sequence_.reset();
    gap_since_us_.reset();
    pending_reset_ = true;
    return original_size > retained_original ? original_size - retained_original : 0;
  }

  std::size_t capacity_;
  std::uint64_t reorder_wait_us_;
  std::size_t max_pending_bytes_;
  std::uint64_t max_pending_age_us_;
  std::deque<Entry> pending_;
  std::optional<Entry> cached_config_;
  std::optional<Entry> last_consumed_config_;
  std::deque<Consumed> consumed_;
  std::optional<std::uint64_t> expected_sequence_;
  std::optional<std::uint64_t> gap_since_us_;
  std::optional<std::uint64_t> last_vcl_sequence_;
  std::string source_id_;
  std::uint64_t next_cache_token_ = 0;
  bool waiting_for_keyframe_ = true;
  bool bootstrap_pending_ = false;
  bool pending_reset_ = false;
};

class NativePlaybackScheduler {
 public:
  enum class Action { Wait, Present, Drop };
  struct Decision {
    Action action = Action::Present;
    std::uint64_t due_us = 0;
    std::int64_t lateness_us = 0;
    bool audio_clock = false;
  };

  explicit NativePlaybackScheduler(std::uint64_t minimum_buffer_us = 20000,
                                   std::uint64_t maximum_buffer_us = 60000,
                                   std::uint64_t late_drop_us = 40000)
      : minimum_buffer_us_(std::min(minimum_buffer_us, maximum_buffer_us)),
        maximum_buffer_us_(std::max(minimum_buffer_us, maximum_buffer_us)),
        late_drop_us_(late_drop_us), buffer_delay_us_(minimum_buffer_us_) {}

  void reset() {
    anchored_ = false;
    base_source_us_ = 0;
    base_local_us_ = 0;
    last_observation_us_ = 0;
    stable_since_us_.reset();
    last_output_source_us_.reset();
    continuously_late_outputs_ = 0;
    buffer_delay_us_ = minimum_buffer_us_;
  }

  // Arrival observations adjust buffering; they do not reorder decode input.
  // Small backwards PTS values (B frames) are normal presentation reordering.
  void observe(std::uint64_t source_pts_us, std::uint64_t arrival_us) {
    if (!anchored_) {
      anchored_ = true;
      base_source_us_ = source_pts_us;
      base_local_us_ = arrival_us;
      last_observation_us_ = arrival_us;
      return;
    }
    const auto translated = native_playback_detail::add_signed(
        base_local_us_, native_playback_detail::difference(source_pts_us, base_source_us_));
    const auto transit = native_playback_detail::difference(arrival_us, translated);
    // Large discontinuities are a new fallback epoch, not unbounded latency.
    if (transit > 2000000 || transit < -2000000) {
      reset();
      observe(source_pts_us, arrival_us);
      return;
    }
    const auto positive_transit = transit > 0 ? static_cast<std::uint64_t>(transit) : 0;
    const auto requested = std::min(maximum_buffer_us_,
        native_playback_detail::add_saturated(minimum_buffer_us_, positive_transit));
    if (requested > buffer_delay_us_) {
      buffer_delay_us_ = requested;
      stable_since_us_.reset();
    } else if (requested < buffer_delay_us_ && buffer_delay_us_ - requested > 2000) {
      if (!stable_since_us_) {
        stable_since_us_ = arrival_us;
      }
      // Shrink at most 1ms/s, and only after one second of stable arrivals.
      if (arrival_us >= *stable_since_us_ && arrival_us - *stable_since_us_ >= 1000000) {
        const auto elapsed = arrival_us >= last_observation_us_
            ? arrival_us - last_observation_us_ : 0;
        const auto decrement = elapsed / 1000;
        buffer_delay_us_ -= std::min(buffer_delay_us_ - requested, decrement);
      }
    } else {
      stable_since_us_.reset();
    }
    last_observation_us_ = std::max(last_observation_us_, arrival_us);
  }

  std::uint64_t target_time_us(std::uint64_t source_pts_us) const {
    if (!anchored_) {
      return 0;
    }
    return native_playback_detail::add_saturated(
        native_playback_detail::add_signed(base_local_us_,
            native_playback_detail::difference(source_pts_us, base_source_us_)),
        buffer_delay_us_);
  }

  // Persistent path latency can change by more than the bounded jitter buffer.
  // Recovery is driven by presentation-ordered decoder output, not compressed
  // input PTS (which can be reordered by B frames). A single outlier cannot
  // change the fallback epoch, and an audio master always remains authoritative.
  bool observe_output(std::uint64_t source_pts_us, std::uint64_t local_now_us,
                      bool audio_clock_active = false) {
    if (last_output_source_us_ && source_pts_us <= *last_output_source_us_) {
      continuously_late_outputs_ = 0;
      return false;
    }
    last_output_source_us_ = source_pts_us;
    if (audio_clock_active || !anchored_) {
      continuously_late_outputs_ = 0;
      return false;
    }
    const auto lateness = native_playback_detail::difference(
        local_now_us, target_time_us(source_pts_us));
    if (lateness <= 0 || static_cast<std::uint64_t>(lateness) <= late_drop_us_) {
      continuously_late_outputs_ = 0;
      return false;
    }
    if (++continuously_late_outputs_ < 4) {
      return false;
    }
    base_source_us_ = source_pts_us;
    base_local_us_ = local_now_us;
    last_observation_us_ = local_now_us;
    stable_since_us_.reset();
    continuously_late_outputs_ = 0;
    return true;
  }

  Decision decision(std::uint64_t source_pts_us, std::uint64_t now_us,
                    std::optional<std::uint64_t> audio_source_us = std::nullopt) const {
    Decision result;
    result.audio_clock = audio_source_us.has_value();
    result.due_us = audio_source_us
        ? native_playback_detail::add_signed(now_us,
            native_playback_detail::difference(source_pts_us, *audio_source_us))
        : (anchored_ ? target_time_us(source_pts_us) : now_us);
    result.lateness_us = audio_source_us
        ? native_playback_detail::difference(*audio_source_us, source_pts_us)
        : native_playback_detail::difference(now_us, result.due_us);
    if (result.lateness_us < 0) {
      result.action = Action::Wait;
    } else if (static_cast<std::uint64_t>(result.lateness_us) > late_drop_us_) {
      result.action = Action::Drop;
    } else {
      result.action = Action::Present;
    }
    return result;
  }

  std::uint64_t buffer_delay_us() const { return buffer_delay_us_; }
  bool anchored() const { return anchored_; }

 private:
  std::uint64_t minimum_buffer_us_;
  std::uint64_t maximum_buffer_us_;
  std::uint64_t late_drop_us_;
  std::uint64_t buffer_delay_us_;
  std::uint64_t base_source_us_ = 0;
  std::uint64_t base_local_us_ = 0;
  std::uint64_t last_observation_us_ = 0;
  std::optional<std::uint64_t> stable_since_us_;
  std::optional<std::uint64_t> last_output_source_us_;
  unsigned int continuously_late_outputs_ = 0;
  bool anchored_ = false;
};
