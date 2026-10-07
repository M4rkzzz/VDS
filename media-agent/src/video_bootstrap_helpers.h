#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace vds::media_agent {

namespace video_bootstrap_detail {
using ParameterSets = std::map<unsigned int, std::vector<std::uint8_t>>;

inline std::size_t start_code_size(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
  if (offset + 3 <= bytes.size() && bytes[offset] == 0 && bytes[offset + 1] == 0) {
    if (bytes[offset + 2] == 1) return 3;
    if (offset + 4 <= bytes.size() && bytes[offset + 2] == 0 && bytes[offset + 3] == 1) return 4;
  }
  return 0;
}

template <class Visitor>
inline void visit_nals(const std::string& codec, const std::vector<std::uint8_t>& bytes, Visitor visitor) {
  for (std::size_t offset = 0; offset < bytes.size();) {
    const auto size = start_code_size(bytes, offset);
    if (size == 0) { ++offset; continue; }
    const auto payload = offset + size;
    if (payload >= bytes.size() || (codec == "h265" && payload + 1 >= bytes.size())) break;
    std::size_t end = payload + 1;
    while (end < bytes.size() && start_code_size(bytes, end) == 0) ++end;
    const unsigned int type = codec == "h265" ? (bytes[payload] >> 1) & 0x3f : bytes[payload] & 0x1f;
    visitor(type, offset, end);
    offset = end;
  }
}

inline ParameterSets parameter_sets(const std::string& codec, const std::vector<std::uint8_t>& bytes) {
  ParameterSets result;
  visit_nals(codec, bytes, [&](unsigned int type, std::size_t begin, std::size_t end) {
    const bool config = codec == "h265" ? type >= 32 && type <= 34 : type == 7 || type == 8;
    if (config) result[type] = std::vector<std::uint8_t>(bytes.begin() + begin, bytes.begin() + end);
  });
  return result;
}
} // namespace video_bootstrap_detail

inline std::vector<std::uint8_t> extract_video_decoder_config(
  const std::string& codec, const std::vector<std::uint8_t>& bytes) {
  std::vector<std::uint8_t> result;
  for (const auto& parameter_set : video_bootstrap_detail::parameter_sets(codec, bytes)) {
    result.insert(result.end(), parameter_set.second.begin(), parameter_set.second.end());
  }
  return result;
}

inline std::vector<std::uint8_t> merge_video_decoder_config(
  const std::string& codec,
  const std::vector<std::uint8_t>& cached_config,
  const std::vector<std::uint8_t>& random_access) {
  const auto current = video_bootstrap_detail::parameter_sets(codec, random_access);
  std::vector<std::uint8_t> result;
  for (const auto& parameter_set : video_bootstrap_detail::parameter_sets(codec, cached_config)) {
    if (current.find(parameter_set.first) == current.end()) {
      result.insert(result.end(), parameter_set.second.begin(), parameter_set.second.end());
    }
  }
  result.insert(result.end(), random_access.begin(), random_access.end());
  return result;
}

inline bool video_decoder_config_is_complete(const std::string& codec, const std::vector<std::uint8_t>& bytes) {
  const auto config = video_bootstrap_detail::parameter_sets(codec, bytes);
  return codec == "h265" ? config.count(32) && config.count(33) && config.count(34) : config.count(7) && config.count(8);
}

inline std::vector<std::uint8_t> extract_video_decoder_config_nals(
  const std::string& codec, const std::vector<std::uint8_t>& bytes) {
  return extract_video_decoder_config(codec, bytes);
}

inline std::vector<std::uint8_t> prepend_config_if_needed(
  const std::string& codec,
  const std::vector<std::uint8_t>& cached_config,
  const std::vector<std::uint8_t>& random_access) {
  return merge_video_decoder_config(codec, cached_config, random_access);
}

} // namespace vds::media_agent
