#include "video_access_unit.h"

#include <algorithm>
#include <cctype>

namespace vds::media_agent {

namespace {

std::string trim_ascii_copy(const std::string& value) {
  const auto begin = std::find_if_not(value.begin(), value.end(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  });
  const auto end = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  }).base();

  if (begin >= end) {
    return {};
  }

  return std::string(begin, end);
}

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

size_t annexb_start_code_size(const std::vector<std::uint8_t>& data, size_t offset) {
  if (offset + 3 >= data.size()) {
    return 0;
  }
  if (data[offset] == 0 && data[offset + 1] == 0) {
    if (data[offset + 2] == 1) {
      return 3;
    }
    if (offset + 3 < data.size() && data[offset + 2] == 0 && data[offset + 3] == 1) {
      return 4;
    }
  }
  return 0;
}

size_t find_next_h264_aud_offset(const std::vector<std::uint8_t>& data, size_t start_offset) {
  size_t offset = start_offset;
  while (true) {
    offset = find_next_annexb_start_code(data, offset);
    if (offset == std::string::npos) {
      return offset;
    }

    const size_t start_code_size = annexb_start_code_size(data, offset);
    if (start_code_size == 0 || offset + start_code_size >= data.size()) {
      return std::string::npos;
    }

    const std::uint8_t nal_type = data[offset + start_code_size] & 0x1F;
    if (nal_type == 9) {
      return offset;
    }

    offset += start_code_size;
  }
}

bool h265_vcl_nal_is_first_slice_segment(
  const std::vector<std::uint8_t>& data,
  size_t offset,
  size_t start_code_size) {
  const size_t payload_offset = offset + start_code_size + 2;
  if (payload_offset >= data.size()) {
    return false;
  }

  return (data[payload_offset] & 0x80) != 0;
}

bool h264_access_unit_has_vcl_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type >= 1 && nal_type <= 5) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h264_access_unit_has_decoder_config_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type == 7 || nal_type == 8) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h264_access_unit_has_idr_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type == 5) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_vcl_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type <= 31) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_decoder_config_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type == 32 || nal_type == 33 || nal_type == 34) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_random_access_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type >= 16 && nal_type <= 21) {
      return true;
    }

    offset += start_code_size;
  }
}

bool should_emit_h264_access_unit(const std::vector<std::uint8_t>& access_unit) {
  return h264_access_unit_has_vcl_nal(access_unit) ||
    h264_access_unit_has_decoder_config_nal(access_unit);
}

bool should_emit_h265_access_unit(const std::vector<std::uint8_t>& access_unit) {
  return h265_access_unit_has_vcl_nal(access_unit) ||
    h265_access_unit_has_decoder_config_nal(access_unit);
}

std::vector<std::vector<std::uint8_t>> extract_annexb_h264_access_units(
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  std::vector<std::vector<std::uint8_t>> access_units;

  while (true) {
    size_t first_aud = find_next_h264_aud_offset(buffer, 0);
    if (first_aud == std::string::npos) {
      if (!flush && buffer.size() > (1024 * 1024)) {
        buffer.clear();
      }
      break;
    }

    if (first_aud > 0) {
      buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(first_aud));
      first_aud = 0;
    }

    const size_t second_aud = find_next_h264_aud_offset(buffer, 4);
    if (second_aud == std::string::npos) {
      if (flush && !buffer.empty()) {
        if (should_emit_h264_access_unit(buffer)) {
          access_units.push_back(buffer);
        }
        buffer.clear();
      }
      break;
    }

    std::vector<std::uint8_t> access_unit(
      buffer.begin(),
      buffer.begin() + static_cast<std::ptrdiff_t>(second_aud)
    );
    if (should_emit_h264_access_unit(access_unit)) {
      access_units.push_back(std::move(access_unit));
    }
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(second_aud));
  }

  return access_units;
}

std::vector<std::vector<std::uint8_t>> extract_annexb_h265_access_units(
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  std::vector<std::vector<std::uint8_t>> access_units;
  std::vector<size_t> nal_offsets;
  size_t search_offset = 0;
  while (true) {
    const size_t nal_offset = find_next_annexb_start_code(buffer, search_offset);
    if (nal_offset == std::string::npos) {
      break;
    }
    nal_offsets.push_back(nal_offset);
    search_offset = nal_offset + 3;
  }

  if (nal_offsets.empty()) {
    if (!flush && buffer.size() > (1024 * 1024)) {
      buffer.clear();
    }
    return access_units;
  }

  const size_t parsable_nal_count = flush
    ? nal_offsets.size()
    : (nal_offsets.size() > 1 ? nal_offsets.size() - 1 : 0);
  if (parsable_nal_count == 0) {
    if (!flush && nal_offsets.front() > 0) {
      buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(nal_offsets.front()));
    }
    return access_units;
  }

  size_t current_access_unit_start = std::string::npos;
  bool current_access_unit_has_vcl = false;

  for (size_t index = 0; index < parsable_nal_count; ++index) {
    const size_t nal_offset = nal_offsets[index];
    const size_t nal_end = (index + 1 < nal_offsets.size()) ? nal_offsets[index + 1] : buffer.size();
    const size_t start_code_size = annexb_start_code_size(buffer, nal_offset);
    if (start_code_size == 0 || nal_offset + start_code_size + 1 >= nal_end) {
      continue;
    }

    const std::uint8_t nal_type = (buffer[nal_offset + start_code_size] >> 1) & 0x3F;
    const bool is_aud = nal_type == 35;
    const bool is_vcl = nal_type <= 31;
    const bool is_first_slice = is_vcl &&
      h265_vcl_nal_is_first_slice_segment(buffer, nal_offset, start_code_size);

    if (current_access_unit_start == std::string::npos) {
      current_access_unit_start = nal_offset;
    } else if ((is_aud || is_first_slice) && current_access_unit_has_vcl) {
      std::vector<std::uint8_t> access_unit(
        buffer.begin() + static_cast<std::ptrdiff_t>(current_access_unit_start),
        buffer.begin() + static_cast<std::ptrdiff_t>(nal_offset)
      );
      if (should_emit_h265_access_unit(access_unit)) {
        access_units.push_back(std::move(access_unit));
      }
      current_access_unit_start = nal_offset;
      current_access_unit_has_vcl = false;
    }

    if (is_vcl) {
      current_access_unit_has_vcl = true;
    }
  }

  if (flush) {
    if (current_access_unit_start != std::string::npos &&
        current_access_unit_start < buffer.size()) {
      std::vector<std::uint8_t> access_unit(
        buffer.begin() + static_cast<std::ptrdiff_t>(current_access_unit_start),
        buffer.end()
      );
      if (should_emit_h265_access_unit(access_unit)) {
        access_units.push_back(std::move(access_unit));
      }
    }
    buffer.clear();
    return access_units;
  }

  const size_t retain_offset = current_access_unit_start != std::string::npos
    ? current_access_unit_start
    : nal_offsets[parsable_nal_count];
  if (retain_offset > 0) {
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(retain_offset));
  }
  return access_units;
}

} // namespace

std::string normalize_video_codec(const std::string& codec, const std::string& fallback) {
  const std::string normalized = to_lower_ascii(trim_ascii_copy(codec));
  if (normalized == "h265" || normalized == "hevc") {
    return "h265";
  }
  if (normalized == "h264") {
    return "h264";
  }
  return fallback;
}

size_t find_next_annexb_start_code(const std::vector<std::uint8_t>& data, size_t start_offset) {
  if (data.size() < 4 || start_offset >= data.size()) {
    return std::string::npos;
  }

  for (size_t index = start_offset; index + 3 < data.size(); ++index) {
    if (data[index] != 0 || data[index + 1] != 0) {
      continue;
    }

    if (index + 3 < data.size() && data[index + 2] == 0 && data[index + 3] == 1) {
      return index;
    }

    if (data[index + 2] == 1 && (index == 0 || data[index - 1] != 0)) {
      return index;
    }
  }

  return std::string::npos;
}

bool should_emit_video_access_unit(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? should_emit_h265_access_unit(access_unit)
    : should_emit_h264_access_unit(access_unit);
}

bool video_access_unit_has_decoder_config_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? h265_access_unit_has_decoder_config_nal(access_unit)
    : h264_access_unit_has_decoder_config_nal(access_unit);
}

bool video_access_unit_has_random_access_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? h265_access_unit_has_random_access_nal(access_unit)
    : h264_access_unit_has_idr_nal(access_unit);
}

bool video_bootstrap_is_complete(
  const std::string& codec,
  const std::vector<std::uint8_t>& decoder_config_au,
  const std::vector<std::uint8_t>& random_access_au) {
  if (decoder_config_au.empty() || random_access_au.empty()) {
    return false;
  }

  const std::string normalized_codec = normalize_video_codec(codec);
  return video_access_unit_has_decoder_config_nal(normalized_codec, decoder_config_au) &&
    video_access_unit_has_random_access_nal(normalized_codec, random_access_au);
}

std::vector<std::vector<std::uint8_t>> extract_annexb_video_access_units(
  const std::string& codec,
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  return normalize_video_codec(codec) == "h265"
    ? extract_annexb_h265_access_units(buffer, flush)
    : extract_annexb_h264_access_units(buffer, flush);
}

} // namespace vds::media_agent
