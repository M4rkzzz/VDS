#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

namespace vds::media_agent {

std::string normalize_video_codec(const std::string& codec, const std::string& fallback = "h264");

size_t find_next_annexb_start_code(const std::vector<std::uint8_t>& data, size_t start_offset);
bool should_emit_video_access_unit(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit);
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
