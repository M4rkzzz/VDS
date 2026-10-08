#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

namespace vds::media_agent {

// A damaged byte stream may never provide the next AU boundary. This is a
// parser working-set guard, deliberately above the 2 MiB encoded wire frame.
inline constexpr size_t kMaxPendingAnnexBAccessUnitBytes = 16 * 1024 * 1024;

class AnnexBVideoAccessUnitParser {
public:
  std::vector<std::vector<std::uint8_t>> push(
    const std::string& codec, const std::uint8_t* bytes, size_t size, bool flush = false);
  void clear();
  size_t pending_bytes() const { return buffer_.size(); }
  std::uint64_t scanned_bytes() const { return scanned_bytes_; }
  std::uint64_t discarded_access_units() const { return discarded_access_units_; }
  std::vector<std::uint8_t> take_pending_bytes();

private:
  void scan(std::vector<std::vector<std::uint8_t>>& units, bool flush);
  void discard_incomplete_access_unit();
  std::vector<std::uint8_t> buffer_;
  std::string codec_;
  size_t scan_offset_ = 0;
  size_t access_unit_start_ = std::string::npos;
  bool access_unit_has_vcl_ = false;
  bool access_unit_has_media_ = false;
  bool discarding_ = false;
  std::uint64_t scanned_bytes_ = 0;
  std::uint64_t discarded_access_units_ = 0;
};

std::string normalize_video_codec(const std::string& codec, const std::string& fallback = "h264");

size_t find_next_annexb_start_code(const std::vector<std::uint8_t>& data, size_t start_offset);
bool should_emit_video_access_unit(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit);
// DataChannel and RTP callbacks carry a complete AU, never a byte stream.
bool is_complete_annexb_video_access_unit(
  const std::string& codec, const std::vector<std::uint8_t>& access_unit);
bool video_access_unit_has_decoder_config_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit);
bool video_access_unit_has_random_access_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit);
bool video_bootstrap_is_complete(
  const std::string& codec,
  const std::vector<std::uint8_t>& decoder_config_au,
  const std::vector<std::uint8_t>& random_access_au);

std::vector<std::vector<std::uint8_t>> extract_annexb_video_access_units(
  const std::string& codec,
  std::vector<std::uint8_t>& buffer,
  bool flush);

} // namespace vds::media_agent
