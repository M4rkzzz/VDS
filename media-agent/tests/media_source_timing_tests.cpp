#include "media_timestamp_helpers.h"
#include "media_source_epoch.h"
#include "obs_ingest_media.h"

#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>

extern "C" {
#include <libavutil/avutil.h>
}

namespace {
unsigned checks = 0;
void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(message);
}
}

int main() {
  try {
    AVStream stream{};
    stream.time_base = AVRational{1, 90000};
    AVPacket packet{};
    packet.pts = 90000;
    packet.dts = 81000;
    expect(packet_timestamp_at_clock_rate(&stream, &packet, 90000) == 90000,
      "one second source PTS must remain 90000 video ticks");
    expect(packet_timestamp_at_clock_rate(&stream, &packet, 48000) == 48000,
      "one second source PTS must become 48000 audio ticks");
    std::int64_t microseconds = -1;
    expect(packet_presentation_timestamp_us(&packet, stream.time_base, &microseconds) && microseconds == 1000000,
      "packet presentation time preserves microseconds");
    packet.pts = AV_NOPTS_VALUE;
    packet.dts = 180000;
    expect(packet_timestamp_at_clock_rate(&stream, &packet, 48000) == 96000,
      "missing PTS falls back to DTS at correct clock rate");
    expect(packet_presentation_timestamp_us(&packet, stream.time_base, &microseconds) && microseconds == 2000000,
      "64-bit helper uses DTS fallback");
    packet.dts = AV_NOPTS_VALUE;
    expect(!packet_presentation_timestamp_us(&packet, stream.time_base, &microseconds),
      "missing timestamp remains distinguishable from valid zero");
    packet.pts = 0;
    expect(packet_presentation_timestamp_us(&packet, stream.time_base, &microseconds) && microseconds == 0,
      "zero is a valid presentation timestamp");
    packet.pts = static_cast<std::int64_t>(std::uint64_t{1} << 32) + 90000;
    expect(packet_presentation_timestamp_us(&packet, stream.time_base, &microseconds) && microseconds > 47000000000LL,
      "OBS presentation time survives the 32-bit RTP wrap");
    expect(packet_timestamp_at_clock_rate(&stream, &packet, 90000) == 90000,
      "legacy RTP conversion alone wraps by contract");

    using namespace vds::media_agent;
    RtpTimestampUnwrapper unwrap;
    expect(unwrap.unwrap(0xfffffff0u) == 0xfffffff0ull, "initial RTP epoch");
    expect(unwrap.unwrap(0x20u) == 0x100000020ull, "forward RTP wrap");
    expect(unwrap.unwrap(0xfffffff8u) == 0xfffffff8ull, "late previous-cycle packet");
    expect(unwrap.unwrap(0x40u) == 0x100000040ull, "late packet must not rewind unwrap reference");
    RtpTimestampUnwrapper just_after_wrap;
    expect(just_after_wrap.unwrap(0x20u) == 0x20u, "first observation may be immediately after wrap");
    expect(just_after_wrap.unwrap(0xfffffff8u) == 0, "previous cycle before first observation clamps without poisoning epoch");
    expect(just_after_wrap.unwrap(0x40u) == 0x40u, "previous-cycle late packet does not push reference a full cycle ahead");
    expect(media_clock_ticks_to_us(90000, 90000) == 1000000, "video ticks to microseconds");
    expect(media_clock_ticks_to_us(48000, 48000) == 1000000, "audio ticks to microseconds");
    expect(media_timestamp_us_to_rtp(1000000, 90000) == 90000, "source microseconds to video RTP");
    const auto huge = std::numeric_limits<std::uint64_t>::max();
    const auto near_overflow_ticks = (huge / 1000000) * 90000 + 89999;
    expect(media_clock_ticks_to_us(near_overflow_ticks, 90000) == huge,
      "fractional tick conversion saturates after whole seconds");
    const auto expected_huge = static_cast<std::uint32_t>(
      (huge / 1000000 % (std::uint64_t{1} << 32)) * 90000 + (huge % 1000000) * 90000 / 1000000);
    expect(media_timestamp_us_to_rtp(huge, 90000) == expected_huge,
      "long-running source PTS conversion cannot overflow before modulo");

    MediaSourceTimeline shared;
    shared.origin_valid = true;
    shared.origin_us = 1400000;
    shared.source_offset_us = 25000;
    expect(shared.map(1500000) == 125000, "video mapped to shared ingest origin");
    expect(shared.map(1420000) == 45000, "audio preserves offset from same source origin");
    expect(shared.map(1460000) == 85000, "B-frame PTS can precede previous decode-order input");
    expect(shared.map(1400000) == 25000, "shared source timestamp zero is valid");
    shared.origin_us = -20000;
    expect(shared.map(10000) == 55000, "signed source timeline crosses zero without underflow");
    shared.source_offset_us = huge - 10;
    expect(shared.map(10000) == huge, "source timestamp addition saturates");
    MediaSourceEpochGate origins;
    using EpochResult = MediaSourceEpochGate::Result;
    expect(origins.accept("") == EpochResult::accepted, "legacy v1 peer without epoch remains compatible");
    expect(origins.accept("host-A") == EpochResult::accepted, "first declared source origin is accepted");
    expect(origins.accept("host-A") == EpochResult::accepted, "audio and video share same epoch");
    expect(origins.accept("host-B") == EpochResult::accepted, "same peer can switch source without replacing ICE");
    expect(origins.accept("host-A") == EpochResult::retired, "late frame from retired source cannot switch clock back");
    expect(origins.current() == "host-B", "rejected late source leaves current source unchanged");
    expect(origins.accept("host-A-rebound") == EpochResult::accepted, "A to B to A uses a fresh output epoch without changing the peer");
    expect(origins.accept("host-A") == EpochResult::retired, "late A1 cannot replace the rebound A2 output");
    expect(origins.accept("") == EpochResult::retired, "epoch-less old frame cannot reactivate after enhanced source starts");
    expect(origins.accept(std::string(129, 'a')) == EpochResult::invalid, "epoch identifier is bounded");
    expect(origins.accept(std::string("a\0b", 3)) == EpochResult::invalid, "control characters cannot enter source identifiers");
    const auto retired_before_many_switches = origins.retired_count();
    constexpr unsigned source_switches = 2048;
    for (unsigned index = 0; index < source_switches; ++index) {
      const std::string epoch = "new-" + std::to_string(index);
      const auto retired_before_switch = origins.retired_count();
      expect(origins.accept(epoch) == EpochResult::accepted, "long-running sessions accept every new source epoch");
      expect(origins.retired_count() == retired_before_switch + 1, "only changing source retires the previous epoch");
      expect(origins.accept(epoch) == EpochResult::accepted, "repeated current audio or video epoch remains accepted");
      expect(origins.retired_count() == retired_before_switch + 1, "current epoch packets do not grow retired history");
    }
    expect(origins.retired_count() == retired_before_many_switches + source_switches,
      "exact retired origin history has no artificial source-switch budget");
    const auto current_after_many_switches = origins.current();
    const auto retired_after_many_switches = origins.retired_count();
    expect(origins.accept("host-A") == EpochResult::retired, "oldest epoch remains retired after thousands of switches");
    expect(origins.current() == current_after_many_switches, "oldest late packet cannot replace the active source");
    expect(origins.accept(origins.current()) == EpochResult::accepted, "current media continues after thousands of switches");
    expect(origins.retired_count() == retired_after_many_switches, "late and current packets do not grow history");
    expect(origins.accept("") == EpochResult::retired, "legacy epoch-less packet stays retired after many switches");
    expect(origins.accept(std::string(129, 'a')) == EpochResult::invalid, "epoch length validation survives long-running history");
    for (const unsigned char control : std::string("\0\n\r\t\x1b\x7f", 6)) {
      expect(origins.accept(std::string("source-") + static_cast<char>(control)) == EpochResult::invalid,
        "control characters remain invalid after many source switches");
    }
    expect(origins.current() == current_after_many_switches && origins.retired_count() == retired_after_many_switches,
      "invalid or epoch-less packets never mutate current origin or history");
    expect(origins.accept(std::string(128, 'a')) == EpochResult::accepted, "128-byte epoch remains a valid source identifier");
    expect(origins.accept("host-A-rebound-again") == EpochResult::accepted, "returning to A with a new binding epoch remains legal");
    expect(origins.accept("host-A") == EpochResult::retired && origins.accept("host-A-rebound") == EpochResult::retired,
      "both earlier A bindings remain retired without eviction");
    MediaSourceEpochGate legacy_origins;
    expect(legacy_origins.accept("") == EpochResult::accepted && legacy_origins.accept("") == EpochResult::accepted,
      "legacy packets remain accepted until a declared source epoch begins");
    expect(legacy_origins.retired_count() == 0, "epoch-less legacy traffic never adds history");
    expect(legacy_origins.accept("first-declared") == EpochResult::accepted && legacy_origins.retired_count() == 0,
      "the first declared source does not retire the empty legacy identifier");
    expect(legacy_origins.accept("") == EpochResult::retired, "declared source prevents old epoch-less packets from returning");
    std::cout << "media source timing: " << checks << " checks passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
