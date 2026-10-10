#include "video_access_unit.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {
using namespace vds::media_agent;
using Bytes = std::vector<std::uint8_t>;
int checks = 0;
int failures = 0;

void expect(bool condition, const std::string& message) {
  ++checks;
  if (!condition) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}

Bytes join(Bytes left, const Bytes& right) {
  left.insert(left.end(), right.begin(), right.end());
  return left;
}

const Bytes h264_aud = {0, 0, 0, 1, 9, 0xf0};
const Bytes h264_config = {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x68, 0xee, 0x80};
const Bytes h264_idr = {0, 0, 1, 0x65, 0x80, 0x55};
const Bytes h264_delta = {0, 0, 0, 1, 0x41, 0x80, 0x33};
const Bytes h265_config = {0, 0, 0, 1, 0x40, 1, 0x80, 0, 0, 1, 0x42, 1, 0x80,
  0, 0, 0, 1, 0x44, 1, 0x80};
const Bytes h265_idr = {0, 0, 0, 1, 0x26, 1, 0x80, 0x55};
const Bytes h265_delta = {0, 0, 1, 0x02, 1, 0x80, 0x33};

void test_complete_packet_boundaries() {
  expect(is_complete_annexb_video_access_unit("h264", h264_config), "separate H.264 configuration AU remains valid");
  expect(is_complete_annexb_video_access_unit("h264", h264_idr), "separate H.264 IDR remains valid");
  expect(is_complete_annexb_video_access_unit("h265", h265_config), "separate HEVC configuration AU remains valid");
  expect(is_complete_annexb_video_access_unit("h265", h265_idr), "separate HEVC IDR remains valid");
  expect(!is_complete_annexb_video_access_unit("h264", Bytes(4096, 0x55)), "a damaged standalone frame is rejected");
  expect(!is_complete_annexb_video_access_unit("h264", join(Bytes{0x55}, h264_idr)), "garbage before a complete frame is rejected");
  expect(!is_complete_annexb_video_access_unit("h264", join(h264_idr, Bytes{0, 0, 1})), "truncated final start code is rejected");
  expect(!is_complete_annexb_video_access_unit("h265", Bytes{0, 0, 1, 0x26, 0, 0x80}), "HEVC temporal_id_plus1 zero is rejected");
  for (const auto& codec : {std::string("h264"), std::string("h265")}) {
    auto config = codec == "h264" ? h264_config : h265_config;
    auto idr = codec == "h264" ? h264_idr : h265_idr;
    const auto configs = extract_annexb_video_access_units(codec, config, true);
    const auto pictures = extract_annexb_video_access_units(codec, idr, true);
    expect(configs.size() == 1 && pictures.size() == 1, codec + " packet parsing does not require AUD or merge PTS");
    expect(config.empty() && idr.empty(), codec + " complete packets retain no pending tail");
  }
}

void test_incremental_boundaries() {
  for (const auto& codec : {std::string("h264"), std::string("h265")}) {
    const auto config = codec == "h264" ? h264_config : h265_config;
    const auto idr = codec == "h264" ? h264_idr : h265_idr;
    const auto delta = codec == "h264" ? h264_delta : h265_delta;
    const Bytes first = join(config, idr);
    const Bytes stream = join(first, delta);
    AnnexBVideoAccessUnitParser parser;
    std::vector<Bytes> units;
    for (const auto byte : stream) {
      auto ready = parser.push(codec, &byte, 1);
      units.insert(units.end(), ready.begin(), ready.end());
    }
    auto tail = parser.push(codec, nullptr, 0, true);
    units.insert(units.end(), tail.begin(), tail.end());
    expect(units.size() == 2 && units[0] == first && units[1] == delta,
      codec + " split start codes, headers and first-slice flags are parsed exactly once");
    expect(parser.pending_bytes() == 0, codec + " EOF releases the byte stream");
    expect(parser.scanned_bytes() < stream.size() * 8, codec + " byte-at-a-time parsing revisits only start-code overlap");
  }
  // A continuation slice is not a new picture.
  AnnexBVideoAccessUnitParser parser;
  const Bytes second_slice = {0, 0, 1, 0x41, 0x40, 0x44};
  const Bytes picture = join(h264_idr, second_slice);
  const auto units = parser.push("h264", picture.data(), picture.size(), true);
  expect(units.size() == 1 && units[0] == picture, "multiple slices of a picture are kept together");
}

void test_duplicate_empty_delimiters() {
  const Bytes picture = join(h264_aud, join(h264_config, h264_idr));
  const Bytes stream = join(h264_aud, join(picture, h264_delta));
  for (const size_t chunk_size : {size_t{1}, size_t{7}, stream.size()}) {
    AnnexBVideoAccessUnitParser parser;
    std::vector<Bytes> units;
    for (size_t offset = 0; offset < stream.size(); offset += chunk_size) {
      auto ready = parser.push("h264", stream.data() + offset, std::min(chunk_size, stream.size() - offset));
      units.insert(units.end(), ready.begin(), ready.end());
    }
    auto tail = parser.push("h264", nullptr, 0, true);
    units.insert(units.end(), tail.begin(), tail.end());
    expect(units.size() == 2 && units[0] == picture && units[1] == h264_delta,
      "duplicate empty AUD does not mask the real configuration and IDR or lose the next picture");
  }
}

void test_large_legal_frame_and_linear_scan() {
  for (const auto& codec : {std::string("h264"), std::string("h265")}) {
    Bytes large = codec == "h264" ? join(h264_aud, h264_idr) : h265_idr;
    large.resize(2 * 1024 * 1024, 0x55);
    AnnexBVideoAccessUnitParser parser;
    size_t emitted = 0;
    for (size_t offset = 0; offset < large.size(); offset += 4096) {
      emitted += parser.push(codec, large.data() + offset, std::min<size_t>(4096, large.size() - offset)).size();
    }
    expect(emitted == 0 && parser.pending_bytes() == large.size(), codec + " legal 2 MiB AU survives partial reads");
    const auto units = parser.push(codec, nullptr, 0, true);
    expect(units.size() == 1 && units[0] == large, codec + " legal 2 MiB AU is byte-identical");
    expect(parser.scanned_bytes() <= large.size() * 2, codec + " an unfinished NAL is not repeatedly rescanned from zero");
  }
}

void test_oversized_incomplete_au_recovers() {
  for (const auto& codec : {std::string("h264"), std::string("h265")}) {
    AnnexBVideoAccessUnitParser parser;
    const Bytes prefix = codec == "h264" ? join(h264_aud, h264_idr) : h265_idr;
    parser.push(codec, prefix.data(), prefix.size());
    const Bytes garbage(64 * 1024, 0x55);
    const size_t repetitions = kMaxPendingAnnexBAccessUnitBytes / garbage.size() + 2;
    for (size_t i = 0; i < repetitions; ++i) {
      expect(parser.push(codec, garbage.data(), garbage.size()).empty(), codec + " incomplete oversized AU is not emitted");
      expect(parser.pending_bytes() <= kMaxPendingAnnexBAccessUnitBytes, codec + " incomplete AU stays within byte guard");
    }
    expect(parser.discarded_access_units() > 0, codec + " damaged oversized AU is explicitly discarded");
    const Bytes fresh = join(codec == "h264" ? h264_config : h265_config,
      codec == "h264" ? h264_idr : h265_idr);
    const auto recovered = parser.push(codec, fresh.data(), fresh.size(), true);
    expect(recovered.size() == 1 && recovered[0] == fresh, codec + " fresh config and IDR recover without old tail bytes");
    expect(parser.scanned_bytes() <= (prefix.size() + repetitions * garbage.size() + fresh.size()) * 2,
      codec + " malformed streaming input remains linear");
    expect(parser.pending_bytes() == 0, codec + " recovery flush releases retained memory");
  }
}
} // namespace

int main() {
  test_complete_packet_boundaries();
  test_incremental_boundaries();
  test_duplicate_empty_delimiters();
  test_large_legal_frame_and_linear_scan();
  test_oversized_incomplete_au_recovers();
  std::cout << "video access unit checks: " << checks << ", failures: " << failures << '\n';
  return failures ? 1 : 0;
}
