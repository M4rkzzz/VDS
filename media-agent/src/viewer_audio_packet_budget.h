#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include <limits>

struct ViewerAudioPacketUnit {
  std::size_t bytes = 0;
  unsigned int device_frames = 0;
  unsigned int source_samples = 0;
  unsigned int source_rate = 0;
};

inline ViewerAudioPacketUnit viewer_audio_packet_unit(
  const std::string& codec, const std::vector<std::uint8_t>& bytes, std::size_t offset = 0) {
  if (offset >= bytes.size()) { return {}; }
  if (codec == "pcmu") {
    const auto count = static_cast<unsigned int>(std::min<std::size_t>(160, bytes.size() - offset));
    return {count, count * 6, count, 8000};
  }
  if (codec != "aac" || bytes.size() - offset < 7 || bytes[offset] != 0xff ||
      (bytes[offset + 1] & 0xf6) != 0xf0) { return {}; }
  constexpr unsigned int rates[] = {96000, 88200, 64000, 48000, 44100, 32000, 24000,
    22050, 16000, 12000, 11025, 8000, 7350};
  const auto rate_index = (bytes[offset + 2] >> 2) & 15;
  const auto frame_bytes = static_cast<unsigned int>(((bytes[offset + 3] & 3) << 11) |
    (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5));
  const unsigned int header_bytes = (bytes[offset + 1] & 1) ? 7 : 9;
  if (rate_index >= 13 || frame_bytes < header_bytes || frame_bytes > bytes.size() - offset) { return {}; }
  const auto samples = 1024u * ((bytes[offset + 6] & 3) + 1);
  const auto frames = static_cast<unsigned int>((static_cast<std::uint64_t>(samples) * 48000 +
    rates[rate_index] - 1) / rates[rate_index]);
  return {frame_bytes, frames, samples, rates[rate_index]};
}

// Validate framing and estimate normalized device frames before decoding.
// Duration is a scheduling input, never a reason to ban a valid codec format;
// the worker consumes blobs by cursor and gives a large AU one soft allowance.
inline unsigned int viewer_audio_packet_device_frames(
  const std::string& codec, const std::vector<std::uint8_t>& bytes) {
  if (bytes.empty()) { return 0; }
  if (codec == "pcmu") {
    return bytes.size() <= std::numeric_limits<unsigned int>::max() / 6 ?
      static_cast<unsigned int>(bytes.size() * 6) : 0;
  }
  if (codec == "opus") {
    const auto config = bytes[0] >> 3;
    const unsigned int duration_us = config >= 16 ? 2500u << (config & 3) :
      config >= 12 ? 10000u << (config & 1) : (config & 3) == 3 ? 60000u : 10000u << (config & 3);
    const auto count_code = bytes[0] & 3;
    const unsigned int frame_count = count_code == 0 ? 1 : count_code != 3 ? 2 :
      bytes.size() > 1 ? bytes[1] & 63 : 0;
    if (frame_count == 0 || static_cast<std::uint64_t>(duration_us) * frame_count > 120000) { return 0; }
    return duration_us * frame_count * 48 / 1000;
  }
  if (codec != "aac") { return 0; }
  std::size_t offset = 0;
  std::uint64_t frames = 0;
  while (offset < bytes.size()) {
    const auto unit = viewer_audio_packet_unit(codec, bytes, offset);
    if (unit.bytes == 0) { return 0; }
    frames += unit.device_frames;
    if (frames > std::numeric_limits<unsigned int>::max()) { return 0; }
    offset += unit.bytes;
  }
  return static_cast<unsigned int>(frames);
}
