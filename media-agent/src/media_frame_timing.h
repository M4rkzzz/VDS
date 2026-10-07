#pragma once

#include <cstdint>
#include <string>

// Source presentation time is independent of transport/RTP clock wrap and of
// the receiver's wall clock. Zero is a valid source timestamp.
struct MediaFrameTiming {
  std::uint64_t timestamp_us = 0;
  std::uint64_t sequence = 0;
  bool timestamp_valid = false;
  bool sequence_valid = false;
  bool keyframe = false;
  bool config = false;
  std::string source_id;
  // Optional v1 wire epoch identifies an origin across a retained relay peer.
  std::string source_epoch;
};
