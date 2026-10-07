#include "relay_media_timing.h"
#include "video_bootstrap_helpers.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {
using vds::media_agent::RelayRtpClock;
using vds::media_agent::RelayTimedVideoAccessUnit;
using vds::media_agent::RelayVideoBootstrapCache;
using Bytes = std::vector<std::uint8_t>;

int checks = 0;
int failures = 0;

void expect(bool condition, const std::string& message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

Bytes join(const Bytes& left, const Bytes& right) {
  Bytes result = left;
  result.insert(result.end(), right.begin(), right.end());
  return result;
}

// Small Annex B fixtures exercise NAL selection, not codec decoding. Distinct
// picture payloads let assertions detect an accidental copy of an old VCL NAL.
const Bytes kSps{0, 0, 0, 1, 0x67, 0x42, 0x11};
const Bytes kPps{0, 0, 1, 0x68, 0xce, 0x22};
const Bytes kIdr{0, 0, 0, 1, 0x65, 0xb8, 0x33};
const Bytes kPredictive{0, 0, 1, 0x41, 0x9a, 0x44};
const Bytes kNewSps{0, 0, 0, 1, 0x67, 0x4d, 0x55};
const Bytes kVps265{0, 0, 0, 1, 0x40, 0x01, 0xaa};
const Bytes kSps265{0, 0, 1, 0x42, 0x01, 0xbb};
const Bytes kPps265{0, 0, 0, 1, 0x44, 0x01, 0xcc};
const Bytes kIdr265{0, 0, 1, 0x26, 0x01, 0x80, 0xdd};
const Bytes kPredictive265{0, 0, 0, 1, 0x02, 0x01, 0x80, 0xee};

Bytes h264_config() { return join(kSps, kPps); }
Bytes h265_config() { return join(join(kVps265, kSps265), kPps265); }

RelayTimedVideoAccessUnit unit(const Bytes& bytes, std::uint64_t sequence,
    std::uint64_t timestamp_us, const std::string& source_id = "upstream-a",
    const std::string& source_epoch = "") {
  RelayTimedVideoAccessUnit result;
  result.bytes = bytes;
  result.timing.timestamp_us = timestamp_us;
  result.timing.timestamp_valid = true;
  result.timing.sequence = sequence;
  result.timing.sequence_valid = true;
  result.timing.source_id = source_id;
  result.timing.source_epoch = source_epoch;
  return result;
}

void test_configuration_is_not_a_picture() {
  using vds::media_agent::extract_video_decoder_config;
  using vds::media_agent::merge_video_decoder_config;
  using vds::media_agent::video_decoder_config_is_complete;

  const Bytes old_picture_with_config = join(h264_config(), kPredictive);
  expect(extract_video_decoder_config("h264", old_picture_with_config) == h264_config(),
      "H.264 extraction excludes a picture carried beside SPS/PPS");
  expect(merge_video_decoder_config("h264", old_picture_with_config, kIdr) ==
      join(h264_config(), kIdr), "bootstrap contains exactly the requested IDR picture");
  expect(merge_video_decoder_config("h264", h264_config(), join(kNewSps, kIdr)) ==
      join(kPps, join(kNewSps, kIdr)), "IDR parameter sets override old cached sets");
  const auto complete_idr = join(h264_config(), kIdr);
  expect(merge_video_decoder_config("h264", h264_config(), complete_idr) == complete_idr,
      "a self-contained IDR receives no duplicate parameter sets");
  expect(!video_decoder_config_is_complete("h264", kSps), "SPS alone is incomplete");
  expect(!video_decoder_config_is_complete("h264", kPps), "PPS alone is incomplete");
  expect(video_decoder_config_is_complete("h264", old_picture_with_config),
      "a full SPS/PPS pair is accepted beside VCL");
  expect(extract_video_decoder_config("h264", {0, 0, 1}).empty(),
      "a truncated start code cannot supply a decoder configuration");

  const auto old_h265_picture = join(h265_config(), kPredictive265);
  expect(extract_video_decoder_config("h265", old_h265_picture) == h265_config(),
      "H.265 extraction excludes an old picture beside VPS/SPS/PPS");
  expect(merge_video_decoder_config("h265", old_h265_picture, kIdr265) ==
      join(h265_config(), kIdr265), "H.265 bootstrap contains one current IDR");
  expect(!video_decoder_config_is_complete("h265", join(kSps265, kPps265)),
      "H.265 requires VPS as well as SPS and PPS");
  expect(video_decoder_config_is_complete("h265", h265_config()),
      "the full H.265 parameter-set triplet is accepted");
}

void test_source_timing_and_single_bootstrap_unit() {
  RelayVideoBootstrapCache cache;
  cache.observe("h264", unit(join(h264_config(), kIdr), 0, 0));
  auto snapshot = cache.snapshot();
  expect(snapshot.size() == 1, "a self-contained IDR is one bootstrap AU");
  if (snapshot.size() == 1) {
    expect(snapshot[0].timing.timestamp_valid && snapshot[0].timing.timestamp_us == 0,
        "PTS zero is a valid source time");
    expect(snapshot[0].timing.sequence_valid && snapshot[0].timing.sequence == 0,
        "source sequence zero is preserved");
    expect(snapshot[0].timing.keyframe && snapshot[0].timing.config,
        "bootstrap IDR reports both random access and decoder config");
  }

  cache.clear();
  constexpr std::uint64_t late_join_pts = 9000000000123ull;
  cache.observe("h264", unit(join(h264_config(), kPredictive), 700, late_join_pts - 16667));
  expect(cache.snapshot().empty(), "configuration plus P picture cannot start a GOP");
  cache.observe("h264", unit(kIdr, 701, late_join_pts));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1, "cached configuration merges into IDR without another frame");
  if (snapshot.size() == 1) {
    expect(snapshot[0].bytes == join(h264_config(), kIdr),
        "bootstrap does not replay the old configuration-bearing P picture");
    expect(snapshot[0].timing.timestamp_us == late_join_pts,
        "64-bit source PTS survives late-join bootstrap unchanged");
    expect(snapshot[0].timing.sequence == 701 && snapshot[0].timing.source_id == "upstream-a",
        "bootstrap uses IDR sequence and source identity");
  }
  cache.observe("h264", unit(kPredictive, 702, late_join_pts + 16667));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 2 && snapshot[1].timing.sequence == 702 &&
      snapshot[1].timing.timestamp_us == late_join_pts + 16667,
      "a late subscriber receives the original contiguous GOP timeline");
}

void test_duplicate_gap_and_recovery() {
  RelayVideoBootstrapCache cache;
  cache.observe("h264", unit(join(h264_config(), kIdr), 10, 100000));
  cache.observe("h264", unit(kPredictive, 11, 116667));
  const auto repeated = cache.observe("h264", unit(kIdr, 11, 999999));
  auto snapshot = cache.snapshot();
  expect(repeated.duplicate && !repeated.reset_subscribers,
      "duplicate source sequence is rejected without resetting subscribers");
  expect(snapshot.size() == 2 && snapshot[1].bytes == kPredictive &&
      snapshot[1].timing.timestamp_us == 116667, "a repeated frame cannot rewrite the cached picture");
  const auto gap = cache.observe("h264", unit(kPredictive, 13, 150001));
  expect(gap.reset_subscribers && cache.snapshot().empty(),
      "a missing reference frame invalidates the complete GOP");
  cache.observe("h264", unit(kPredictive, 14, 166668));
  expect(cache.snapshot().empty(), "P frames after a sequence gap remain ineligible for bootstrap");
  cache.observe("h264", unit(kIdr, 15, 183335));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].timing.sequence == 15 &&
      snapshot[0].bytes == join(h264_config(), kIdr), "a fresh IDR repairs the chain using retained configuration");
  const auto reordered = cache.observe("h264", unit(kPredictive, 14, 166668));
  expect(reordered.reset_subscribers && cache.snapshot().empty(),
      "an out-of-order source sequence cannot be advertised as a contiguous chain");

  cache.clear();
  cache.observe("h264", unit(join(h264_config(), kIdr),
      std::numeric_limits<std::uint64_t>::max(), 1));
  const auto wrapped = cache.observe("h264", unit(kPredictive, 0, 2));
  expect(wrapped.reset_subscribers && cache.snapshot().empty(),
      "source sequence rollover requires a new random-access chain");
}

void test_gop_limits_and_explicit_loss() {
  RelayVideoBootstrapCache cache;
  cache.observe("h264", unit(join(h264_config(), kIdr), 0, 0));
  for (std::uint64_t sequence = 1; sequence < 96; ++sequence) {
    cache.observe("h264", unit(kPredictive, sequence, sequence * 16667));
  }
  expect(cache.snapshot().size() == 96, "the 96-frame cache limit still retains its IDR");
  const auto overflow = cache.observe("h264", unit(kPredictive, 96, 96 * 16667));
  expect(cache.snapshot().empty(), "the 97th frame invalidates the GOP instead of evicting its IDR");
  expect(!overflow.reset_subscribers,
      "cache capacity alone does not interrupt subscribers that received the live reference chain");
  cache.observe("h264", unit(kPredictive, 97, 97 * 16667));
  expect(cache.snapshot().empty(), "after overflow the cache waits for another IDR");
  cache.observe("h264", unit(kIdr, 98, 98 * 16667));
  expect(cache.snapshot().size() == 1, "the next IDR restores bootstrap after frame-count overflow");
  cache.invalidate_gop();
  expect(cache.snapshot().empty(), "explicit local reference loss removes the old GOP");
  cache.observe("h264", unit(kPredictive, 99, 99 * 16667));
  expect(cache.snapshot().empty(), "local-loss recovery does not promote a P picture");
  cache.observe("h264", unit(kIdr, 100, 100 * 16667));
  expect(cache.snapshot().size() == 1, "configuration remains available after explicit GOP invalidation");

  Bytes large_picture(8 * 1024 * 1024, 0x55);
  std::copy(kPredictive.begin(), kPredictive.end(), large_picture.begin());
  cache.observe("h264", unit(large_picture, 101, 101 * 16667));
  const auto byte_overflow = cache.observe("h264", unit(large_picture, 102, 102 * 16667));
  expect(cache.snapshot().empty(), "the byte limit cannot leave an IDR-less partial chain");
  expect(!byte_overflow.reset_subscribers,
      "byte capacity alone does not interrupt subscribers that received the live reference chain");
  cache.observe("h264", unit(kPredictive, 103, 103 * 16667));
  expect(cache.snapshot().empty(), "after byte overflow dependent pictures cannot start a bootstrap");
  cache.observe("h264", unit(kIdr, 104, 104 * 16667));
  expect(cache.snapshot().size() == 1,
      "the next IDR restores bootstrap after byte-budget overflow");
}

void test_stream_identity_and_configuration_changes() {
  RelayVideoBootstrapCache cache;
  cache.observe("h264", unit(join(h264_config(), kIdr), 1, 100));
  const auto source_change = cache.observe("h264", unit(kIdr, 1, 0, "upstream-b"));
  expect(source_change.reset_subscribers && cache.snapshot().empty(),
      "a new source cannot reuse the previous source's decoder configuration");
  cache.observe("h264", unit(join(h264_config(), kIdr), 2, 16667, "upstream-b"));
  expect(cache.snapshot().size() == 1, "a new source recovers with its own full IDR configuration");
  const auto codec_change = cache.observe("h265", unit(kIdr265, 3, 33334, "upstream-b"));
  expect(codec_change.reset_subscribers && cache.snapshot().empty(),
      "codec change cannot combine H.264 configuration with an H.265 IDR");
  cache.observe("h265", unit(join(kSps265, kPps265), 4, 50001, "upstream-b"));
  cache.observe("h265", unit(kIdr265, 5, 66668, "upstream-b"));
  expect(cache.snapshot().empty(), "H.265 IDR waits while VPS is missing");
  cache.observe("h265", unit(kVps265, 6, 83335, "upstream-b"));
  cache.observe("h265", unit(kIdr265, 7, 100002, "upstream-b"));
  auto snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].bytes == join(h265_config(), kIdr265) &&
      snapshot[0].timing.sequence == 7, "split H.265 parameter sets form one correctly timed IDR");

  cache.clear();
  cache.observe("h264", unit(kSps, 10, 0));
  cache.observe("h264", unit(kIdr, 11, 16667));
  expect(cache.snapshot().empty(), "H.264 IDR waits while PPS is missing");
  cache.observe("h264", unit(kPps, 12, 33334));
  cache.observe("h264", unit(kIdr, 13, 50001));
  expect(cache.snapshot().size() == 1, "split SPS and PPS restore the next IDR");
  const auto changed = cache.observe("h264", unit(join(kNewSps, kPredictive), 14, 66668));
  expect(changed.reset_subscribers && cache.snapshot().empty(),
      "a changed parameter set cannot keep an old IDR reference chain");
  cache.observe("h264", unit(kIdr, 15, 83335));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].bytes == join(join(kNewSps, kPps), kIdr),
      "new IDR uses the new parameter set without the configuration-bearing old picture");
}

void test_rtp_wrap_and_reordering() {
  RelayRtpClock clock;
  expect(clock.timestamp_us(0, 90000) == 0, "RTP zero maps to valid source time zero");
  expect(clock.timestamp_us(90000, 90000) == 1000000, "video RTP clock has 90000 ticks per second");
  expect(clock.timestamp_us(45000, 90000) == 500000, "reordered RTP gets its own earlier presentation time");
  expect(clock.timestamp_us(180000, 90000) == 2000000,
      "reordering does not move the RTP unwrap high-water mark backwards");

  RelayRtpClock wrapping;
  constexpr std::uint64_t wrap = 1ull << 32;
  const auto before = wrapping.timestamp_us(0xffffff00u, 90000);
  const auto after = wrapping.timestamp_us(90000, 90000);
  expect(after > before && after == ((wrap + 90000) * 1000000ull) / 90000,
      "32-bit RTP wrap keeps advancing the 64-bit presentation timeline");
  const auto reordered_before_wrap = wrapping.timestamp_us(0xfffffff0u, 90000);
  expect(reordered_before_wrap == ((wrap - 16) * 1000000ull) / 90000,
      "a delayed pre-wrap RTP packet is assigned to its original cycle");
  expect(wrapping.timestamp_us(180000, 90000) == ((wrap + 180000) * 1000000ull) / 90000,
      "a delayed pre-wrap packet does not cause a second false wrap");
  expect(wrapping.timestamp_us(48000, 48000) == 1000000,
      "a codec clock-rate change starts its own RTP compatibility clock");
  expect(wrapping.timestamp_us(0, 0) == 0, "an unspecified RTP clock rate avoids division by zero");
}

void test_source_epoch_restarts_retained_peer() {
  RelayVideoBootstrapCache cache;
  cache.observe("h264", unit(join(h264_config(), kIdr), 0, 100000,
      "retained-peer", "epoch-old"));
  auto snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].timing.source_epoch == "epoch-old",
      "cached bootstrap retains the original source epoch");
  const auto restarted = cache.observe("h264", unit(kIdr, 0, 0,
      "retained-peer", "epoch-new"));
  expect(restarted.reset_subscribers && restarted.sequence_reset && !restarted.duplicate,
      "new epoch on the same peer resets even when its first sequence equals the old sequence");
  expect(cache.snapshot().empty(), "new epoch IDR cannot bootstrap with old-epoch parameter sets");
  cache.observe("h264", unit(kNewSps, 1, 16667, "retained-peer", "epoch-new"));
  cache.observe("h264", unit(kIdr, 2, 33334, "retained-peer", "epoch-new"));
  expect(cache.snapshot().empty(), "new epoch SPS cannot borrow a PPS from the previous epoch");
  cache.observe("h264", unit(kPps, 3, 50001, "retained-peer", "epoch-new"));
  cache.observe("h264", unit(kIdr, 4, 66668, "retained-peer", "epoch-new"));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].bytes == join(join(kNewSps, kPps), kIdr) &&
      snapshot[0].timing.sequence == 4 && snapshot[0].timing.timestamp_us == 66668 &&
      snapshot[0].timing.source_epoch == "epoch-new",
      "only new-epoch configuration restores the IDR with its original epoch and source timing");
  const auto returned_origin = cache.observe("h264", unit(kIdr, 0, 0,
      "retained-peer", "epoch-old"));
  expect(returned_origin.reset_subscribers && returned_origin.sequence_reset && cache.snapshot().empty(),
      "A-to-B-to-A ingress origin return still resets and cannot borrow B configuration");
  cache.observe("h264", unit(join(h264_config(), kIdr), 1, 16667,
      "retained-peer", "epoch-old"));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].timing.source_epoch == "epoch-old" &&
      snapshot[0].bytes == join(h264_config(), kIdr),
      "returning origin needs its own newly supplied complete configuration");
  RelayVideoBootstrapCache next_hop;
  next_hop.observe("h264", unit(join(h264_config(), kIdr), 0, 0,
      "different-local-peer", "epoch-new"));
  snapshot = next_hop.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].timing.source_epoch == "epoch-new",
      "the internal cache retains ingress origin before outbound binding mapping");
  cache.clear();
  cache.observe("h264", unit(join(h264_config(), kIdr), 0, 0));
  snapshot = cache.snapshot();
  expect(snapshot.size() == 1 && snapshot[0].timing.source_epoch.empty(),
      "internal legacy cache keeps its unspecified ingress origin");
}
} // namespace

int main() {
  test_configuration_is_not_a_picture();
  test_source_timing_and_single_bootstrap_unit();
  test_duplicate_gap_and_recovery();
  test_gop_limits_and_explicit_loss();
  test_stream_identity_and_configuration_changes();
  test_rtp_wrap_and_reordering();
  test_source_epoch_restarts_retained_peer();
  std::cout << "Relay media timing: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
