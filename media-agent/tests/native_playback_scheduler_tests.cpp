#include "native_playback_scheduler.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {
int checks = 0;
int failures = 0;
using Queue = NativeEncodedFrameQueue<int>;

void expect(bool value, const std::string& message) {
  ++checks;
  if (!value) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

MediaFrameTiming timing(std::uint64_t sequence, bool keyframe = false,
                        std::uint64_t pts = 0, const std::string& source = "source-a") {
  MediaFrameTiming value;
  value.sequence = sequence;
  value.sequence_valid = true;
  value.timestamp_us = pts;
  value.timestamp_valid = true;
  value.keyframe = keyframe;
  value.source_id = source;
  return value;
}

Queue::Entry take(Queue& queue, std::uint64_t now, int expected_payload,
                  const std::string& message) {
  Queue::Entry output{};
  expect(queue.pop(now, output) == Queue::PopState::Frame, message + " is ready");
  expect(output.frame == expected_payload, message + " encoded order");
  return output;
}

void expect_reset(Queue& queue, std::uint64_t now, const std::string& message) {
  Queue::Entry output{};
  expect(queue.pop(now, output) == Queue::PopState::Reset, message);
}

void test_bootstrap_and_short_reorder() {
  Queue queue;
  expect(queue.needs_keyframe(), "startup waits for random access");
  expect(!queue.push(99, timing(99), 0).accepted, "startup drops dependent pictures");
  expect(queue.push(100, timing(100, true, 50000), 1000).accepted, "startup accepts key");
  expect(!queue.push(98, timing(98), 1100).accepted, "old picture cannot precede startup key");
  take(queue, 1000, 100, "startup key");
  expect(!queue.needs_keyframe(), "key opens reference chain");
  expect(queue.push(102, timing(102, false, 20000), 2000).accepted, "future AU is bounded pending");
  Queue::Entry output{};
  expect(queue.pop(2000, output) == Queue::PopState::Waiting, "short sequence gap waits");
  expect(queue.next_deadline_us() == std::optional<std::uint64_t>{22000}, "gap exposes worker deadline");
  expect(queue.push(101, timing(101, false, 90000), 10000).accepted, "reordered predecessor accepted");
  take(queue, 10000, 101, "reordered predecessor");
  take(queue, 10000, 102, "reordered successor with earlier PTS");
  expect(!queue.next_deadline_us(), "filled gap cancels deadline");
  expect(queue.pop(50000, output) == Queue::PopState::Empty, "drained queue has no false gap");
}

void test_true_gap_and_config_replay() {
  Queue queue;
  auto config = timing(10);
  config.config = true;
  queue.push(10, config, 0, true);
  queue.push(11, timing(11, true), 0);
  take(queue, 0, 10, "independent bootstrap config");
  take(queue, 0, 11, "independent bootstrap key");
  queue.push(13, timing(13), 100);
  Queue::Entry output{};
  expect(queue.pop(100, output) == Queue::PopState::Waiting, "true missing AU waits briefly");
  auto incidental_config = config;
  incidental_config.sequence_valid = false;
  queue.push(100, incidental_config, 10000, true);
  take(queue, 10000, 100, "sequence-less config during unresolved gap");
  expect(queue.next_deadline_us() == std::optional<std::uint64_t>{20100},
      "configuration traffic cannot postpone missing-reference deadline");
  expect(queue.pop(20099, output) == Queue::PopState::Waiting, "gap cannot expire early");
  expect_reset(queue, 20100, "missing reference emits decoder reset");
  expect(queue.needs_keyframe(), "missing reference needs new key");
  const auto replay = take(queue, 20100, 100, "cached config after true gap");
  expect(replay.config_only && !replay.timing.sequence_valid, "cached replay cannot create sequence gap");
  expect(!queue.push(14, timing(14), 21000).accepted, "recovery rejects dependent picture");
  queue.push(20, timing(20, true), 22000);
  take(queue, 22000, 20, "new random access resumes after gap");
  queue.push(21, timing(21), 23000);
  take(queue, 23000, 21, "resumed chain remains contiguous");
}

void test_overflow_protects_reference_chain() {
  Queue queue(4);
  auto config = timing(0);
  config.config = true;
  queue.push(0, config, 0, true);
  queue.push(1, timing(1, true), 0);
  take(queue, 0, 0, "overflow config bootstrap");
  take(queue, 0, 1, "overflow initial key");
  for (int sequence = 2; sequence <= 6; ++sequence) {
    const auto result = queue.push(sequence, timing(static_cast<std::uint64_t>(sequence)), 100);
    if (sequence == 6) {
      expect(result.reset_required, "hard overflow resets whole reference chain");
      expect(result.dropped_frames == 5, "overflow does not pop only one old compressed frame");
    }
  }
  expect(queue.size() <= 4 && queue.needs_keyframe(), "overflow queue remains bounded and waits for key");
  expect_reset(queue, 100, "overflow emits reset once");
  take(queue, 100, 0, "overflow preserves parameter sets");

  Queue with_key(4);
  with_key.push(0, config, 0, true);
  with_key.push(1, timing(1, true), 0);
  take(with_key, 0, 0, "retained-key config bootstrap");
  take(with_key, 0, 1, "retained-key first key");
  with_key.push(2, timing(2), 100);
  with_key.push(3, timing(3), 100);
  with_key.push(4, timing(4, true), 100);
  with_key.push(5, timing(5), 100);
  const auto result = with_key.push(6, timing(6), 100);
  expect(result.reset_required && result.dropped_frames == 2, "overflow retains latest key and complete suffix");
  expect(with_key.size() == 4 && !with_key.needs_keyframe(), "cached config plus latest key suffix fit cap");
  expect_reset(with_key, 100, "retained-key reset precedes compressed input");
  take(with_key, 100, 0, "retained config");
  take(with_key, 100, 4, "retained latest key");
  take(with_key, 100, 5, "retained contiguous suffix one");
  take(with_key, 100, 6, "retained contiguous suffix two");

  Queue broken_suffix(4);
  broken_suffix.push(1, timing(1, true), 0);
  take(broken_suffix, 0, 1, "broken suffix bootstrap");
  broken_suffix.push(2, timing(2), 100);
  broken_suffix.push(3, timing(3), 100);
  broken_suffix.push(5, timing(5, true), 100);
  broken_suffix.push(7, timing(7), 100);
  broken_suffix.push(8, timing(8), 100);
  expect_reset(broken_suffix, 100, "broken suffix overflow reset");
  take(broken_suffix, 100, 5, "broken suffix retains only usable key");
  expect(broken_suffix.empty(), "later dependent AUs cannot cross missing reference after latest key");

  Queue future_config(4);
  future_config.push(0, config, 0, true);
  future_config.push(1, timing(1, true), 0);
  take(future_config, 0, 0, "future parameter-set bootstrap");
  take(future_config, 0, 1, "future parameter-set initial key");
  future_config.push(2, timing(2), 100);
  future_config.push(3, timing(3), 100);
  future_config.push(4, timing(4, true), 100);
  auto later_config = timing(8);
  later_config.config = true;
  future_config.push(80, later_config, 200, true);
  future_config.push(9, timing(9), 200);
  expect_reset(future_config, 200, "future parameter-set overflow reset");
  take(future_config, 200, 0, "latest retained key receives preceding parameter sets");
  take(future_config, 200, 4, "future parameter sets cannot be applied ahead of old retained key");
  expect(future_config.empty(), "noncontiguous future configuration discarded with dependent suffix");
}

void test_configuration_sequence_semantics() {
  Queue queue;
  auto config = timing(5);
  config.config = true;
  queue.push(50, config, 0, true);
  queue.push(51, timing(5, true), 0);
  queue.push(6, timing(6), 0);
  take(queue, 0, 50, "same sequence config");
  take(queue, 0, 51, "same sequence key is not deduplicated as config");
  take(queue, 0, 6, "same sequence pair advances only once");
  expect(queue.push(51, timing(5, true), 0).duplicate, "consumed key duplicate rejected");
  expect(queue.push(50, config, 0, true).duplicate, "consumed config duplicate rejected separately");

  Queue after_key;
  after_key.push(7, timing(7, true), 0);
  take(after_key, 0, 7, "key before matching config");
  config = timing(7);
  config.config = true;
  expect(after_key.push(70, config, 0, true).accepted, "same sequence config may arrive after key");
  after_key.push(8, timing(8), 0);
  take(after_key, 0, 70, "late matching config does not advance expected sequence");
  take(after_key, 0, 8, "following picture remains contiguous");
  Queue::Entry output{};
  expect(after_key.pop(20000, output) == Queue::PopState::Empty && !after_key.needs_keyframe(),
      "a queued following picture cannot overtake its late CONFIG counterpart or create a false gap");

  auto no_sequence_config = timing(12345);
  no_sequence_config.sequence_valid = false;
  no_sequence_config.config = true;
  after_key.push(80, no_sequence_config, 0, true);
  take(after_key, 0, 80, "sequence-less config is independently consumable");
  auto combined = timing(9);
  combined.config = true;
  after_key.push(9, combined, 0, false);
  take(after_key, 0, 9, "config flag on P AU still consumes VCL sequence");
  after_key.push(10, timing(10), 0);
  take(after_key, 0, 10, "combined config/VCL sequence advances");

  Queue late_vcl;
  late_vcl.push(1, timing(1, true), 0);
  take(late_vcl, 0, 1, "late VCL bootstrap");
  config = timing(2);
  late_vcl.push(20, config, 0, true);
  take(late_vcl, 0, 20, "late VCL config independently occupies sequence");
  late_vcl.push(3, timing(3), 0);
  take(late_vcl, 0, 3, "later VCL already decoded");
  expect(!late_vcl.push(2, timing(2), 0).accepted, "late same-sequence VCL cannot reverse decoded reference order");
  auto stale_config = timing(1);
  stale_config.config = true;
  expect(!late_vcl.push(10, stale_config, 0, true).accepted,
      "late old configuration cannot roll parameter sets back after a later VCL");
}

void test_consumed_config_survives_repeated_recovery() {
  Queue queue;
  auto config = timing(0);
  config.config = true;
  queue.push(100, config, 0, true);
  queue.push(1, timing(1, true), 0);
  take(queue, 0, 100, "repeated recovery original CONFIG");
  take(queue, 0, 1, "repeated recovery original IDR");

  // Sequence 2 is missing. CONFIG 5 follows the usable IDR 4 and must not be
  // applied ahead of it, but it becomes authoritative after that IDR is decoded.
  queue.push(4, timing(4, true), 100);
  config.sequence = 5;
  queue.push(500, config, 100, true);
  queue.push(6, timing(6), 100);
  Queue::Entry output{};
  expect(queue.pop(100, output) == Queue::PopState::Waiting, "first config-change gap waits");
  expect_reset(queue, 20100, "first config-change gap resets");
  take(queue, 20100, 100, "old IDR receives its preceding CONFIG");
  take(queue, 20100, 4, "retained IDR precedes CONFIG change");
  take(queue, 20100, 500, "retained newer CONFIG is consumed in encoded order");
  take(queue, 20100, 6, "picture under newer CONFIG");

  // A second missing reference must replay CONFIG 5, rather than rolling back
  // to the parameter sets selected for the first recovered IDR.
  queue.push(8, timing(8), 20200);
  expect(queue.pop(20200, output) == Queue::PopState::Waiting, "second config-change gap waits");
  expect_reset(queue, 40200, "second config-change gap resets");
  const auto replay = take(queue, 40200, 500, "latest consumed CONFIG survives second recovery");
  expect(replay.config_only && replay.timing.config && !replay.timing.sequence_valid,
      "newest CONFIG replay remains independent of the media sequence");
  queue.push(10, timing(10, true), 40300);
  take(queue, 40300, 10, "second recovered IDR resumes with newer CONFIG");

  Queue future;
  config.sequence = 0;
  future.push(100, config, 0, true);
  future.push(1, timing(1, true), 0);
  take(future, 0, 100, "future CONFIG cache original CONFIG");
  take(future, 0, 1, "future CONFIG cache original IDR");
  config.sequence = 2;
  future.push(200, config, 100, true);
  future.push(3, timing(3), 100);
  config.sequence = 5;
  future.push(500, config, 200, true);
  take(future, 200, 200, "consuming an older CONFIG preserves a queued future CONFIG");
  take(future, 200, 3, "future CONFIG still waits behind older pictures");
  expect(future.pop(200, output) == Queue::PopState::Waiting, "future CONFIG cannot cross missing reference");
  expect_reset(future, 20200, "future CONFIG gap resets");
  take(future, 20200, 500, "queued future CONFIG remains available for the next IDR");
  future.push(6, timing(6, true), 20300);
  take(future, 20300, 6, "next IDR uses the retained future CONFIG");
}

void test_wrap_generation_and_dedup_bounds() {
  Queue wrap;
  constexpr auto max = std::numeric_limits<std::uint64_t>::max();
  wrap.push(1, timing(max - 1, true), 0);
  take(wrap, 0, 1, "64-bit wrap bootstrap");
  wrap.push(3, timing(0), 0);
  wrap.push(2, timing(max), 0);
  take(wrap, 0, 2, "last sequence before wrap");
  take(wrap, 0, 3, "wrapped sequence remains contiguous");

  Queue generation;
  auto old_config = timing(0);
  old_config.config = true;
  generation.push(100, old_config, 0, true);
  generation.push(101, timing(1, true), 0);
  const auto result = generation.push(201, timing(1, false, 0, "source-b"), 100);
  expect(result.reset_required && !result.accepted && result.dropped_frames == 3,
      "new source clears old queued frames and rejects new dependent frame");
  expect_reset(generation, 100, "source generation emits decoder reset");
  expect(generation.empty() && generation.needs_keyframe(), "new source cannot reuse old parameter sets");
  auto new_config = timing(5, false, 0, "source-b");
  new_config.config = true;
  generation.push(205, new_config, 100, true);
  generation.push(206, timing(6, true, 0, "source-b"), 100);
  take(generation, 100, 205, "new source parameter sets");
  take(generation, 100, 206, "new source random access");
  generation.reset();
  expect(generation.empty() && generation.needs_keyframe() && !generation.reset_pending(), "explicit reset clears all state");

  Queue history;
  history.push(0, timing(0, true), 0);
  take(history, 0, 0, "dedup bound bootstrap");
  for (int sequence = 1; sequence < 1000; ++sequence) {
    history.push(sequence, timing(static_cast<std::uint64_t>(sequence)), 0);
    take(history, 0, sequence, "bounded history continuous sequence");
  }
  expect(!history.push(-1, timing(1), 0).accepted, "evicted dedup history cannot admit stale encoded AU");
}

void test_all_short_reorder_permutations() {
  std::array<int, 3> order{{2, 3, 4}};
  do {
    Queue queue;
    queue.push(1, timing(1, true), 0);
    take(queue, 0, 1, "permutation bootstrap");
    for (const auto sequence : order) {
      queue.push(sequence, timing(static_cast<std::uint64_t>(sequence), false,
          static_cast<std::uint64_t>(10 - sequence) * 1000), 1000);
    }
    for (int sequence = 2; sequence <= 4; ++sequence) {
      take(queue, 1000, sequence, "all reorders preserve encoded sequence despite reverse PTS");
    }
  } while (std::next_permutation(order.begin(), order.end()));
}

void test_non_vcl_cache_and_discard_metrics() {
  Queue queue(4);
  auto parameter_sets = timing(0);
  parameter_sets.config = true;
  queue.push(100, parameter_sets, 0, true);
  queue.push(1, timing(1, true), 0);
  take(queue, 0, 100, "parameter sets before non-VCL slots");
  take(queue, 0, 1, "non-VCL slot bootstrap key");
  queue.push(200, timing(2), 0, true);  // AUD, no parameter sets.
  take(queue, 0, 200, "AUD consumes its encoded sequence");
  queue.push(300, timing(3), 0, true);  // SEI, no parameter sets.
  take(queue, 0, 300, "SEI consumes its encoded sequence");
  queue.push(5, timing(5), 100);
  Queue::Entry output{};
  std::size_t discarded = 999;
  expect(queue.pop(100, output, &discarded) == Queue::PopState::Waiting && discarded == 0,
      "waiting pop clears caller's old discard metric");
  expect(queue.pop(20100, output, &discarded) == Queue::PopState::Reset && discarded == 1,
      "gap reports one discarded dependent AU despite one configuration replay");
  expect(queue.pop(20100, output, &discarded) == Queue::PopState::Frame &&
      output.frame == 100 && output.timing.config && discarded == 0,
      "AUD/SEI never replace cached parameter sets and replay is not discarded again");
  expect(queue.pop(20100, output, &discarded) == Queue::PopState::Empty && discarded == 0,
      "empty pop clears discard metric");

  Queue overflow(4);
  overflow.push(100, parameter_sets, 0, true);
  overflow.push(1, timing(1, true), 0);
  take(overflow, 0, 100, "AUD overflow parameter sets");
  take(overflow, 0, 1, "AUD overflow bootstrap");
  overflow.push(2, timing(2), 100);
  overflow.push(3, timing(3), 100);
  overflow.push(4, timing(4, true), 100);
  overflow.push(500, timing(5), 100, true);
  const auto pushed = overflow.push(600, timing(6), 100, true);
  expect(pushed.reset_required && pushed.dropped_frames == 2,
      "overflow metrics count only discarded pre-key AUs");
  discarded = 999;
  expect(overflow.pop(100, output, &discarded) == Queue::PopState::Reset && discarded == 0,
      "overflow pending reset does not double count PushResult discards");
  take(overflow, 100, 100, "overflow does not replay pending AUD/SEI as parameter sets");
  take(overflow, 100, 4, "overflow latest key remains usable");
  take(overflow, 100, 500, "retained AUD remains an ordinary sequence slot");
  take(overflow, 100, 600, "retained SEI remains an ordinary sequence slot");
  overflow.push(7, timing(7), 200);
  take(overflow, 200, 7, "retained non-VCL suffix advances encoded sequence correctly");

  Queue no_parameter_sets;
  no_parameter_sets.push(200, timing(0), 0, true);
  take(no_parameter_sets, 0, 200, "non-config bootstrap AUD");
  no_parameter_sets.push(1, timing(1, true), 0);
  take(no_parameter_sets, 0, 1, "non-config bootstrap key");
  no_parameter_sets.push(3, timing(3), 100);
  expect(no_parameter_sets.pop(100, output) == Queue::PopState::Waiting, "missing reference after AUD-only bootstrap");
  expect(no_parameter_sets.pop(20100, output, &discarded) == Queue::PopState::Reset && discarded == 1,
      "AUD-only bootstrap gap has accurate discard count");
  expect(no_parameter_sets.empty(), "AUD-only bootstrap cannot manufacture a configuration replay");

  Queue source_change;
  source_change.push(1, timing(1, true), 0);
  const auto changed = source_change.push(2, timing(2, false, 0, "other-source"), 100);
  expect(changed.reset_required && changed.dropped_frames == 2, "source change discards counted in PushResult");
  expect(source_change.pop(100, output, &discarded) == Queue::PopState::Reset && discarded == 0,
      "source pending reset does not double count discards");

  Queue queued_parameters(4);
  queued_parameters.push(1, timing(1, true), 0);
  take(queued_parameters, 0, 1, "queued parameter-set metric bootstrap");
  auto queued_config = timing(2);
  queued_config.config = true;
  queued_parameters.push(200, queued_config, 100, true);
  queued_parameters.push(3, timing(3), 100);
  queued_parameters.push(4, timing(4, true), 100);
  queued_parameters.push(5, timing(5), 100);
  const auto queued_overflow = queued_parameters.push(6, timing(6), 100);
  expect(queued_overflow.reset_required && queued_overflow.dropped_frames == 1,
      "parameter-set AU already in queue is retained, not counted as discarded replay");
  expect_reset(queued_parameters, 100, "queued parameter-set recovery reset");
  take(queued_parameters, 100, 200, "queued parameter sets replay once");
  take(queued_parameters, 100, 4, "queued parameter-set latest key");
  take(queued_parameters, 100, 5, "queued parameter-set suffix one");
  take(queued_parameters, 100, 6, "queued parameter-set suffix two");

  Queue config_gap;
  config_gap.push(1, timing(1, true), 0);
  take(config_gap, 0, 1, "configuration-only gap metric bootstrap");
  auto config_after_gap = timing(3);
  config_after_gap.config = true;
  config_gap.push(300, config_after_gap, 100, true);
  expect(config_gap.pop(100, output) == Queue::PopState::Waiting,
      "sequence-valid parameter set beyond missing AU waits");
  expect(config_gap.pop(20100, output, &discarded) == Queue::PopState::Reset && discarded == 0,
      "gap does not count retained parameter sets as discarded AU");
  take(config_gap, 20100, 300, "gap retains unconsumed parameter set for next IDR");
}

void test_fallback_clock_and_adaptive_buffer() {
  NativePlaybackScheduler clock;
  clock.observe(0, 100000);
  expect(clock.anchored() && clock.buffer_delay_us() == 20000, "zero PTS anchors fallback clock at 20ms");
  expect(clock.target_time_us(33333) == 153333, "fallback target follows source PTS rather than arrival bursts");
  auto decision = clock.decision(33333, 140000);
  expect(decision.action == NativePlaybackScheduler::Action::Wait && decision.due_us == 153333,
      "early decoded picture waits until target");
  decision = clock.decision(33333, 153333);
  expect(decision.action == NativePlaybackScheduler::Action::Present && decision.lateness_us == 0,
      "due picture is presentable");
  decision = clock.decision(33333, 193334);
  expect(decision.action == NativePlaybackScheduler::Action::Drop && decision.lateness_us == 40001,
      "late decoded display picture is discardable after reference decoding");
  clock.observe(100000, 240000);
  expect(clock.buffer_delay_us() == 60000, "40ms jitter raises buffer immediately to 60ms bound");
  clock.observe(200000, 300000);
  expect(clock.buffer_delay_us() == 60000, "stable arrival cannot immediately shrink buffer");
  for (std::uint64_t pts = 300000; pts <= 2200000; pts += 100000) {
    clock.observe(pts, pts + 100000);
  }
  expect(clock.buffer_delay_us() < 60000 && clock.buffer_delay_us() >= 58000,
      "buffer shrinks slowly only after stable interval");
  for (std::uint64_t pts = 2300000; pts <= 62000000; pts += 100000) {
    clock.observe(pts, pts + 100000);
    expect(clock.buffer_delay_us() >= 20000 && clock.buffer_delay_us() <= 60000,
        "adaptive buffer stays within bounds");
  }
  expect(clock.buffer_delay_us() >= 20000 && clock.buffer_delay_us() <= 22000,
      "long stable period approaches minimum without undershoot");
  clock.observe(1000, 100000000);
  expect(clock.buffer_delay_us() == 20000 && clock.target_time_us(1000) == 100020000,
      "source discontinuity reanchors instead of accumulating unbounded latency");
  clock.reset();
  expect(!clock.anchored() && clock.buffer_delay_us() == 20000, "fallback reset resets epoch and jitter");
  expect(clock.decision(9999, 1234).action == NativePlaybackScheduler::Action::Present,
      "unanchored legacy timestamp does not stall worker");
}

void test_audio_master_and_integer_safety() {
  NativePlaybackScheduler clock;
  clock.observe(100000, 1000000);
  auto decision = clock.decision(200000, 1100000, 180000);
  expect(decision.audio_clock && decision.action == NativePlaybackScheduler::Action::Wait &&
      decision.due_us == 1120000, "matched audio source clock determines video deadline");
  decision = clock.decision(200000, 1100000, 200000);
  expect(decision.action == NativePlaybackScheduler::Action::Present, "audio/video equal PTS presents now");
  decision = clock.decision(200000, 1100000, 250000);
  expect(decision.action == NativePlaybackScheduler::Action::Drop && decision.lateness_us == 50000,
      "video behind audio discards display picture");
  constexpr auto max = std::numeric_limits<std::uint64_t>::max();
  clock.reset();
  clock.observe(max - 10, max - 100);
  expect(clock.target_time_us(max) == max, "due calculation saturates uint64 addition");
  decision = clock.decision(max, max - 5, 0);
  expect(decision.due_us == max && decision.action == NativePlaybackScheduler::Action::Wait,
      "extreme audio delta does not wrap future deadline into the past");
  decision = clock.decision(0, 10, max);
  expect(decision.due_us == 0 && decision.action == NativePlaybackScheduler::Action::Drop,
      "extreme negative audio delta saturates without losing true media lateness");

  Queue deadline;
  deadline.push(1, timing(1, true), 0);
  take(deadline, 0, 1, "deadline overflow bootstrap");
  deadline.push(3, timing(3), max - 10);
  Queue::Entry output{};
  expect(deadline.pop(max - 10, output) == Queue::PopState::Waiting, "gap near uint64 maximum waits");
  expect(deadline.next_deadline_us() == std::optional<std::uint64_t>{max}, "gap deadline saturates");
  expect_reset(deadline, max, "saturated gap deadline still triggers recovery");
}

void test_output_driven_fallback_recovery() {
  for (const std::uint64_t step : {100000, 100001, 120000, 150000, 200000}) {
    NativePlaybackScheduler clock;
    clock.observe(0, 0);
    unsigned int reanchors = 0;
    for (std::uint64_t index = 1; index <= 20; ++index) {
      const auto pts = index * 16667;
      const auto arrival = pts + step;
      clock.observe(pts, arrival);
      if (clock.observe_output(pts, arrival, false)) {
        ++reanchors;
      }
      if (step == 100000) {
        expect(clock.decision(pts, arrival).action == NativePlaybackScheduler::Action::Present,
            "exact 40ms lateness boundary is presentable and needs no recovery");
      } else if (index <= 3) {
        expect(clock.decision(pts, arrival).action == NativePlaybackScheduler::Action::Drop,
            "persistent path step is not mistaken for a one-frame reset");
      } else {
        expect(clock.decision(pts, arrival).action == NativePlaybackScheduler::Action::Wait,
            "every continuously dropped baseline recovers bounded future presentation deadline");
        expect(clock.target_time_us(pts) - arrival <= 60000,
            "recovered fallback adds at most bounded 60ms jitter latency");
      }
    }
    expect(reanchors == (step == 100000 ? 0u : 1u),
        "every persistent drop baseline reanchors once instead of dropping forever");
  }

  NativePlaybackScheduler single;
  single.observe(0, 0);
  expect(!single.observe_output(16667, 216667, false), "single late output cannot reanchor");
  expect(!single.observe_output(33334, 33334, false), "on-time output clears consecutive late streak");
  expect(single.target_time_us(33334) == 53334, "single outlier leaves original fallback epoch");

  NativePlaybackScheduler audio;
  audio.observe(0, 0);
  for (std::uint64_t index = 1; index <= 10; ++index) {
    const auto pts = index * 16667;
    audio.observe(pts, pts + 200000);
    expect(!audio.observe_output(pts, pts + 200000, true),
        "active audio master cannot be replaced by video fallback recovery");
  }
  expect(audio.target_time_us(166670) == 226670,
      "audio-authoritative video leaves fallback epoch unchanged");

  NativePlaybackScheduler b_frames;
  b_frames.observe(0, 0);
  // Compressed decode order can contain later PTS before earlier B pictures.
  for (std::uint64_t group = 1; group <= 10; ++group) {
    const auto base = group * 50001;
    b_frames.observe(base + 16667, base + 200000);
    b_frames.observe(base - 16667, base + 200001);
  }
  expect(b_frames.target_time_us(500010) == 560010,
      "nonmonotonic compressed B-frame observations do not recover output epoch");
  expect(!b_frames.observe_output(100000, 300000, false), "first presentation-ordered late output waits for evidence");
  expect(!b_frames.observe_output(110000, 310000, false), "second presentation-ordered late output waits for evidence");
  expect(!b_frames.observe_output(90000, 320000, false), "backwards decoded PTS clears recovery streak");
  expect(!b_frames.observe_output(120000, 320000, false), "backwards output cannot contribute to monotonic streak");
  expect(!b_frames.observe_output(130000, 330000, false), "third sparse monotonic output still requires four consecutive samples");
  b_frames.reset();
  b_frames.observe(0, 0);
  expect(!b_frames.observe_output(16667, 216667, false), "reset clears output-recovery generation");
}

void test_ready_queue_backpressure_cadence(std::size_t ready_capacity,
                                          std::uint64_t fallback_delay_us) {
  constexpr std::uint64_t interval = 16667;
  constexpr int frames = 3600;
  Queue encoded(8);
  NativePlaybackScheduler clock(fallback_delay_us, fallback_delay_us);
  std::deque<std::uint64_t> ready;
  int produced = 0;
  int decoded = 0;
  int painted = 0;
  int reset_count = 0;
  std::size_t maximum_encoded = 0;
  std::size_t maximum_ready = 0;
  std::uint64_t now = 0;
  unsigned int iterations = 0;

  while (produced < frames || !encoded.empty() || !ready.empty()) {
    if (++iterations > static_cast<unsigned int>(frames * 5)) {
      expect(false, "cadence simulator must make bounded progress");
      break;
    }
    while (produced < frames && static_cast<std::uint64_t>(produced) * interval <= now) {
      const auto pts = static_cast<std::uint64_t>(produced) * interval;
      encoded.push(produced, timing(static_cast<std::uint64_t>(produced), produced == 0, pts), pts);
      maximum_encoded = std::max(maximum_encoded, encoded.size());
      ++produced;
    }
    bool have_paint = false;
    while (!ready.empty()) {
      const auto decision = clock.decision(ready.front(), now);
      if (decision.action == NativePlaybackScheduler::Action::Wait) {
        break;
      }
      if (decision.action == NativePlaybackScheduler::Action::Present) {
        have_paint = true;
      }
      ready.pop_front();
    }
    if (have_paint) {
      ++painted;
    }

    // The production worker uses this same boundary: keep the earliest decoded
    // display frame and stop consuming compressed input while ready is full.
    while (ready.size() < ready_capacity) {
      Queue::Entry entry{};
      const auto state = encoded.pop(now, entry);
      if (state == Queue::PopState::Reset) {
        ++reset_count;
        continue;
      }
      if (state != Queue::PopState::Frame) {
        break;
      }
      ++decoded;
      clock.observe(entry.timing.timestamp_us, entry.arrival_us);
      clock.observe_output(entry.timing.timestamp_us, now, false);
      if (clock.decision(entry.timing.timestamp_us, now).action != NativePlaybackScheduler::Action::Drop) {
        ready.push_back(entry.timing.timestamp_us);
        maximum_ready = std::max(maximum_ready, ready.size());
      }
    }

    std::optional<std::uint64_t> next;
    if (produced < frames) {
      next = static_cast<std::uint64_t>(produced) * interval;
    }
    if (!ready.empty()) {
      const auto due = clock.target_time_us(ready.front());
      if (!next || due < *next) {
        next = due;
      }
    }
    if (const auto gap = encoded.next_deadline_us(); gap && (!next || *gap < *next)) {
      next = *gap;
    }
    if (!next) {
      break;
    }
    expect(*next >= now, "backpressure event deadlines never regress");
    now = std::max(now, *next);
  }
  expect(decoded == frames && reset_count == 0,
      "bounded ready queue with encoded backpressure preserves reference chain");
  expect(painted >= frames * 9 / 10,
      "60fps backpressure paints at least 90 percent of frames with bounded fallback delay");
  expect(maximum_encoded <= 8 && maximum_ready <= ready_capacity,
      "encoded and decoded backlog both remain bounded under backpressure");
  std::cout << "cadence: ready=" << ready_capacity << ", buffer="
      << fallback_delay_us / 1000 << "ms, painted=" << painted << '/' << frames
      << ", max encoded=" << maximum_encoded << ", max ready=" << maximum_ready << '\n';
}
void test_source_cadence_burst_budget() {
  expect(native_playback_detail::encoded_capacity_for_frame_rate(0) == 17,
      "unknown cadence accepts the first ordinary 60fps PES before SPS decode");
  expect(native_playback_detail::encoded_capacity_for_frame_rate(30) == 10 &&
      native_playback_detail::encoded_capacity_for_frame_rate(60) == 17,
      "compressed capacity represents 250ms of the source and two codec slots");
  expect(native_playback_detail::encoded_capacity_for_frame_rate(120) == 32 &&
      native_playback_detail::encoded_capacity_for_frame_rate(240) == 62 &&
      native_playback_detail::encoded_capacity_for_frame_rate(1000) == 252,
      "a faster source receives compressed capacity without an FPS clamp");
  Queue queue(17, 20000, 1000, 500000);
  for (int index = 0; index < 14; ++index) {
    const auto result = queue.push(index, timing(index, index == 0, index * 16667), 0, false, 10);
    expect(result.accepted && !result.reset_required && result.dropped_frames == 0,
        "first normal 235ms burst preserves every compressed reference");
  }
  for (int index = 0; index < 9; ++index) take(queue, 100000, index, "audio-paced first PES reference");
  // A real waveOut clock can still be behind the previous batch when the next
  // PES arrives. Capacity follows that live backlog; it never expands BGRA.
  queue.set_capacity(23);
  for (int index = 14; index < 28; ++index) {
    const auto result = queue.push(index, timing(index, false, index * 16667), 234667, false, 10);
    expect(result.accepted && !result.reset_required && result.dropped_frames == 0,
        "ordinary PES plus current audio lead is accepted at full ingress speed");
  }
  expect(queue.size() == 19 && queue.pending_bytes() == 190, "only compressed AUs carry the live audio-master backlog");
  for (int index = 9; index < 28; ++index) take(queue, 250000, index, "complete synchronized PES reference");

  Queue age(17, 20000, 1000, 500000);
  age.push(0, timing(0, true), 0, false, 10);
  age.push(1, timing(1), 234667, false, 10);
  const auto expired = age.push(2, timing(2), 500001, false, 10);
  expect(expired.reset_required && expired.dropped_frames == 3 && age.needs_keyframe() && age.empty(),
      "only a persistently stalled half-second backlog abandons stale references");
  expect(age.push(3, timing(3, true), 500002, false, 10).accepted,
      "an actual new IDR immediately recovers the expired backlog");
  expect_reset(age, 500002, "expired backlog resets codec before replay");
  take(age, 500002, 3, "fresh IDR after sustained stall");

  Queue cached_age(17, 20000, 1000, 500000);
  auto aged_config = timing(0);
  aged_config.config = true;
  cached_age.push(0, aged_config, 0, true, 10);
  cached_age.push(1, timing(1, true), 0, false, 10);
  take(cached_age, 0, 0, "age-budget initial CONFIG");
  take(cached_age, 0, 1, "age-budget initial IDR");
  cached_age.push(2, timing(2), 1, false, 10);
  const auto aged_picture = cached_age.push(3, timing(3), 500002, false, 10);
  expect(aged_picture.reset_required && cached_age.needs_keyframe(), "stale picture starts CONFIG-backed recovery");
  const auto fresh_key = cached_age.push(4, timing(4, true), 500003, false, 10);
  expect(fresh_key.accepted && !fresh_key.reset_required,
      "replayed old SPS/PPS cannot age-reject a fresh IDR");
  expect_reset(cached_age, 500003, "aged picture clears codec before CONFIG-backed recovery");
  take(cached_age, 500003, 0, "old reusable SPS/PPS after stale picture");
  take(cached_age, 500003, 4, "fresh IDR after old reusable SPS/PPS");

  Queue bytes(17, 20000, 100, 500000);
  auto config = timing(0);
  config.config = true;
  bytes.push(0, config, 0, true, 10);
  bytes.push(1, timing(1, true), 0, false, 30);
  bytes.push(2, timing(2), 0, false, 40);
  const auto large = bytes.push(3, timing(3), 0, false, 40);
  expect(large.reset_required && large.dropped_frames == 1 && bytes.pending_bytes() <= 100,
      "byte overload keeps a bounded contiguous CONFIG/IDR suffix");
  expect_reset(bytes, 0, "byte overload resets codec before retained bootstrap");
  take(bytes, 0, 0, "byte-budget cached CONFIG");
  take(bytes, 0, 1, "byte-budget retained IDR");
  take(bytes, 0, 2, "byte-budget contiguous dependent picture");
}
}  // namespace

int main() {
  test_bootstrap_and_short_reorder();
  test_true_gap_and_config_replay();
  test_overflow_protects_reference_chain();
  test_configuration_sequence_semantics();
  test_consumed_config_survives_repeated_recovery();
  test_wrap_generation_and_dedup_bounds();
  test_all_short_reorder_permutations();
  test_non_vcl_cache_and_discard_metrics();
  test_fallback_clock_and_adaptive_buffer();
  test_audio_master_and_integer_safety();
  test_output_driven_fallback_recovery();
  test_ready_queue_backpressure_cadence(2, 60000);
  test_ready_queue_backpressure_cadence(1, 20000);
  test_source_cadence_burst_budget();
  std::cout << "native playback scheduler: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
