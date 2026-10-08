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
  if (offset + 2 >= data.size()) {
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
  if (data.size() < 3 || start_offset >= data.size()) {
    return std::string::npos;
  }

  for (size_t index = start_offset; index + 2 < data.size(); ++index) {
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

bool is_complete_annexb_video_access_unit(
  const std::string& codec, const std::vector<std::uint8_t>& access_unit) {
  if (access_unit.empty() || access_unit.size() > kMaxPendingAnnexBAccessUnitBytes) return false;
  const bool hevc = normalize_video_codec(codec) == "h265";
  size_t offset = find_next_annexb_start_code(access_unit, 0);
  if (offset == std::string::npos ||
      std::any_of(access_unit.begin(), access_unit.begin() + static_cast<std::ptrdiff_t>(offset),
                  [](std::uint8_t byte) { return byte != 0; })) return false;
  bool has_media = false;
  while (offset != std::string::npos) {
    const size_t prefix = annexb_start_code_size(access_unit, offset);
    const size_t next = find_next_annexb_start_code(access_unit, offset + prefix);
    const size_t end = next == std::string::npos ? access_unit.size() : next;
    const size_t header = offset + prefix;
    if (header + (hevc ? 2 : 1) >= end || (access_unit[header] & 0x80)) return false;
    const unsigned type = hevc ? (access_unit[header] >> 1) & 0x3f : access_unit[header] & 0x1f;
    if (hevc) {
      if ((access_unit[header + 1] & 7) == 0) return false;
      has_media = has_media || type <= 31 || (type >= 32 && type <= 34);
    } else {
      if (type == 0 || type > 23) return false;
      has_media = has_media || (type >= 1 && type <= 5) || type == 7 || type == 8;
    }
    offset = next;
  }
  return has_media;
}

void AnnexBVideoAccessUnitParser::clear() {
  buffer_.clear();
  scan_offset_ = 0;
  access_unit_start_ = std::string::npos;
  access_unit_has_vcl_ = false;
  access_unit_has_media_ = false;
  discarding_ = false;
}

void AnnexBVideoAccessUnitParser::discard_incomplete_access_unit() {
  ++discarded_access_units_;
  // Keep only a split start-code prefix; never decode the tail of the lost AU.
  const size_t retain = std::min<size_t>(3, buffer_.size());
  buffer_.erase(buffer_.begin(), buffer_.end() - static_cast<std::ptrdiff_t>(retain));
  scan_offset_ = 0;
  access_unit_start_ = std::string::npos;
  access_unit_has_vcl_ = false;
  access_unit_has_media_ = false;
  discarding_ = true;
}

void AnnexBVideoAccessUnitParser::scan(
  std::vector<std::vector<std::uint8_t>>& units, bool flush) {
  const bool hevc = codec_ == "h265";
  while (scan_offset_ < buffer_.size()) {
    const size_t offset = find_next_annexb_start_code(buffer_, scan_offset_);
    scanned_bytes_ += offset == std::string::npos
      ? buffer_.size() - scan_offset_ : offset - scan_offset_ + 1;
    if (offset == std::string::npos) {
      scan_offset_ = buffer_.size() > 3 ? buffer_.size() - 3 : 0;
      break;
    }
    const size_t prefix = annexb_start_code_size(buffer_, offset);
    const size_t header = offset + prefix;
    // A first-slice flag may arrive in the next read, even when the start code
    // and NAL header were already available. Revisit only this tiny prefix.
    if (header + (hevc ? 2 : 1) >= buffer_.size()) {
      scan_offset_ = offset;
      break;
    }
    const unsigned type = hevc ? (buffer_[header] >> 1) & 0x3f : buffer_[header] & 0x1f;
    const bool is_aud = type == (hevc ? 35u : 9u);
    const bool is_vcl = hevc ? type <= 31 : type >= 1 && type <= 5;
    const bool is_config = hevc ? type >= 32 && type <= 34 : type == 7 || type == 8;
    const bool first_slice = is_vcl && (buffer_[header + (hevc ? 2 : 1)] & 0x80) != 0;
    scan_offset_ = header + (hevc ? 2 : 1);
    if (discarding_) {
      if (!is_aud && !first_slice && !is_config) continue;
      discarding_ = false;
    }
    if (access_unit_start_ == std::string::npos) {
      access_unit_start_ = offset;
    } else if (access_unit_has_vcl_ && (is_aud || first_slice || is_config)) {
      std::vector<std::uint8_t> unit(
        buffer_.begin() + static_cast<std::ptrdiff_t>(access_unit_start_),
        buffer_.begin() + static_cast<std::ptrdiff_t>(offset));
      if (is_complete_annexb_video_access_unit(codec_, unit)) units.push_back(std::move(unit));
      access_unit_start_ = offset;
      access_unit_has_vcl_ = false;
      access_unit_has_media_ = false;
    }
    access_unit_has_vcl_ = access_unit_has_vcl_ || is_vcl;
    access_unit_has_media_ = access_unit_has_media_ || is_vcl || is_config;
  }

  if (flush) {
    if (!discarding_ && access_unit_has_media_ && access_unit_start_ != std::string::npos) {
      std::vector<std::uint8_t> unit(
        buffer_.begin() + static_cast<std::ptrdiff_t>(access_unit_start_), buffer_.end());
      if (is_complete_annexb_video_access_unit(codec_, unit)) units.push_back(std::move(unit));
    }
    clear();
    return;
  }
  const size_t retain = access_unit_start_ == std::string::npos ? scan_offset_ : access_unit_start_;
  if (retain > 0) {
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(retain));
    scan_offset_ -= retain;
    if (access_unit_start_ != std::string::npos) access_unit_start_ -= retain;
  }
}

std::vector<std::vector<std::uint8_t>> AnnexBVideoAccessUnitParser::push(
  const std::string& codec, const std::uint8_t* bytes, size_t size, bool flush) {
  const auto normalized = normalize_video_codec(codec);
  if (codec_ != normalized) { clear(); codec_ = normalized; }
  std::vector<std::vector<std::uint8_t>> units;
  while (size > 0) {
    if (buffer_.size() == kMaxPendingAnnexBAccessUnitBytes) discard_incomplete_access_unit();
    const size_t count = std::min({size, size_t{64 * 1024}, kMaxPendingAnnexBAccessUnitBytes - buffer_.size()});
    const size_t required = buffer_.size() + count;
    if (required > buffer_.capacity()) {
      buffer_.reserve(std::min(kMaxPendingAnnexBAccessUnitBytes,
        std::max(required, std::max<size_t>(64 * 1024, buffer_.capacity() * 2))));
    }
    buffer_.insert(buffer_.end(), bytes, bytes + count);
    bytes += count;
    size -= count;
    scan(units, false);
  }
  if (flush) scan(units, true);
  return units;
}

std::vector<std::uint8_t> AnnexBVideoAccessUnitParser::take_pending_bytes() {
  auto result = std::move(buffer_);
  clear();
  return result;
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
  AnnexBVideoAccessUnitParser parser;
  auto result = parser.push(codec, buffer.data(), buffer.size(), flush);
  buffer = parser.take_pending_bytes();
  return result;
}

} // namespace vds::media_agent
