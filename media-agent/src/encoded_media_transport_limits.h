#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "peer_transport.h"

namespace vds::media_agent::encoded_transport {

inline constexpr std::size_t kHeaderBytes = 16 * 1024;
inline constexpr std::size_t kFrameBytes = 2 * 1024 * 1024;
inline constexpr std::size_t kChunkBytes = 12 * 1024;
inline constexpr std::size_t kChunksPerFrame = (kFrameBytes + kChunkBytes - 1) / kChunkBytes;
// Only incomplete frames occupy this budget; completed media does not consume
// an allowance over time. This bounds damaged peers without limiting bitrate.
inline constexpr std::size_t kPendingFrames = 64;
inline constexpr std::size_t kPendingBytes = 8 * kFrameBytes;
inline constexpr std::size_t kGlobalPendingBytes = 32 * kFrameBytes;
inline std::atomic<std::size_t> global_pending_bytes{0};
inline constexpr std::int64_t kChunkLifetimeMs = 10000;

inline bool valid_chunk_shape(const PeerEncodedMediaDataChannelFrame& frame) {
  if (frame.frame_id.empty() || frame.frame_id.size() > 512 ||
      frame.frame_payload_bytes == 0 || frame.frame_payload_bytes > kFrameBytes ||
      frame.chunk_count == 0 || frame.chunk_count > kChunksPerFrame ||
      frame.chunk_index >= frame.chunk_count) return false;
  const auto bytes = static_cast<std::size_t>(frame.frame_payload_bytes);
  if (frame.chunk_count != (bytes + kChunkBytes - 1) / kChunkBytes) return false;
  const auto offset = static_cast<std::size_t>(frame.chunk_index) * kChunkBytes;
  return offset < bytes && frame.payload.size() == std::min(kChunkBytes, bytes - offset);
}

class Reassembler {
 public:
  enum class Result { complete, pending, rejected };
  Reassembler() = default;
  Reassembler(const Reassembler&) = delete;
  Reassembler& operator=(const Reassembler&) = delete;
  ~Reassembler() { clear(); }

  Result accept(PeerEncodedMediaDataChannelFrame frame,
                PeerEncodedMediaDataChannelFrame* output,
                std::int64_t now_ms, std::string* reason) {
    expire(now_ms);
    if (frame.stream_type != "video" && frame.stream_type != "audio")
      return reject(reason, "datachannel-frame-invalid-stream");
    if (frame.message_type == "frame") {
      if (frame.payload.empty() || frame.payload.size() > kFrameBytes)
        return reject(reason, "datachannel-frame-too-large");
      if (output) *output = std::move(frame);
      return Result::complete;
    }
    if (frame.message_type != "chunk" || !valid_chunk_shape(frame))
      return reject(reason, "datachannel-chunk-invalid-header");

    auto it = frames_.find(frame.frame_id);
    if (it != frames_.end() && !same_frame(it->second.header, frame)) {
      erase(it, true);
      return reject(reason, "datachannel-chunk-mismatch");
    }
    if (it != frames_.end() && !it->second.chunks[static_cast<std::size_t>(frame.chunk_index)].empty()) {
      if (reason) *reason = "datachannel-chunk-pending";
      return Result::pending;
    }

    // Allocate metadata only after validating the complete fragment shape.
    // Eviction always removes a whole incomplete frame, never a fragment of a
    // frame that might subsequently be handed to the decoder.
    while ((it == frames_.end() && frames_.size() >= kPendingFrames) ||
           bytes_ > kPendingBytes - frame.payload.size()) {
      auto oldest = frames_.end();
      for (auto candidate = frames_.begin(); candidate != frames_.end(); ++candidate) {
        if (candidate == it) continue;
        if (oldest == frames_.end() || candidate->second.created_ms < oldest->second.created_ms)
          oldest = candidate;
      }
      if (oldest == frames_.end()) {
        if (it != frames_.end()) erase(it, true);
        return reject(reason, "datachannel-chunk-budget-exceeded");
      }
      erase(oldest, true);
    }
    auto global_bytes = global_pending_bytes.load(std::memory_order_relaxed);
    while (true) {
      if (global_bytes > kGlobalPendingBytes - frame.payload.size()) {
        if (it != frames_.end()) erase(it, true);
        return reject(reason, "datachannel-chunk-budget-exceeded");
      }
      if (global_pending_bytes.compare_exchange_weak(global_bytes, global_bytes + frame.payload.size(),
          std::memory_order_relaxed)) break;
    }
    const auto reserved_bytes = frame.payload.size();
    try {
    if (it == frames_.end()) {
      const auto id = frame.frame_id;
      Entry entry;
      entry.chunks.resize(static_cast<std::size_t>(frame.chunk_count));
      entry.created_ms = now_ms;
      // Move the payload out first: the metadata must not retain a second
      // allocation for the first fragment after vector::clear().
      auto first_payload = std::move(frame.payload);
      entry.header = std::move(frame);
      const auto index = static_cast<std::size_t>(entry.header.chunk_index);
      entry.bytes = first_payload.size();
      entry.chunks[index] = std::move(first_payload);
      entry.received = 1;
      it = frames_.emplace(id, std::move(entry)).first;
      bytes_ += it->second.bytes;
    } else {
      const auto index = static_cast<std::size_t>(frame.chunk_index);
      it->second.bytes += frame.payload.size();
      bytes_ += frame.payload.size();
      it->second.chunks[index] = std::move(frame.payload);
      ++it->second.received;
    }
    } catch (...) {
      global_pending_bytes.fetch_sub(reserved_bytes, std::memory_order_relaxed);
      throw;
    }
    auto& entry = it->second;
    if (entry.received != entry.chunks.size()) {
      if (reason) *reason = "datachannel-chunk-pending";
      return Result::pending;
    }

    PeerEncodedMediaDataChannelFrame complete = entry.header;
    complete.payload.reserve(entry.bytes);
    for (const auto& chunk : entry.chunks)
      complete.payload.insert(complete.payload.end(), chunk.begin(), chunk.end());
    complete.message_type = "frame";
    complete.frame_id.clear();
    complete.chunk_index = complete.chunk_count = complete.frame_payload_bytes = 0;
    erase(it, false);
    if (output) *output = std::move(complete);
    return Result::complete;
  }

  void expire(std::int64_t now_ms) {
    for (auto it = frames_.begin(); it != frames_.end();) {
      if (now_ms - it->second.created_ms > kChunkLifetimeMs) {
        auto expired = it++;
        erase(expired, true);
      } else ++it;
    }
  }
  void clear() {
    global_pending_bytes.fetch_sub(bytes_, std::memory_order_relaxed);
    frames_.clear();
    bytes_ = 0;
  }
  std::size_t pending_frames() const { return frames_.size(); }
  std::size_t pending_bytes() const { return bytes_; }
  std::uint64_t dropped_frames() const { return dropped_; }

 private:
  struct Entry {
    PeerEncodedMediaDataChannelFrame header;
    std::vector<std::vector<std::uint8_t>> chunks;
    std::size_t bytes = 0;
    std::size_t received = 0;
    std::int64_t created_ms = 0;
  };
  static Result reject(std::string* reason, const char* value) {
    if (reason) *reason = value;
    return Result::rejected;
  }
  static bool same_frame(const PeerEncodedMediaDataChannelFrame& a,
                         const PeerEncodedMediaDataChannelFrame& b) {
    return a.chunk_count == b.chunk_count && a.frame_payload_bytes == b.frame_payload_bytes &&
      a.source_epoch == b.source_epoch && a.stream_type == b.stream_type && a.codec == b.codec &&
      a.payload_format == b.payload_format && a.timestamp_us == b.timestamp_us &&
      a.sequence == b.sequence && a.keyframe == b.keyframe && a.config == b.config;
  }
  void erase(std::map<std::string, Entry>::iterator it, bool dropped) {
    bytes_ -= it->second.bytes;
    global_pending_bytes.fetch_sub(it->second.bytes, std::memory_order_relaxed);
    frames_.erase(it);
    if (dropped) ++dropped_;
  }
  std::map<std::string, Entry> frames_;
  std::size_t bytes_ = 0;
  std::uint64_t dropped_ = 0;
};

// Admission is per complete frame and per peer. Throughput has no cap: a fast
// connection with an empty queue always accepts any valid complete frame.
class SendAdmission {
 public:
  enum class Kind { video, audio, configuration, keyframe };
  static constexpr std::size_t kAudioReserve = 256 * 1024;
  static constexpr std::size_t kControlReserve = 64 * 1024;

  bool admit(Kind kind, std::size_t wire_bytes, std::size_t buffered, std::string* reason) {
    if (kind == Kind::video && waiting_for_keyframe_) {
      if (reason) *reason = "datachannel-waiting-for-fresh-keyframe";
      return false;
    }
    std::size_t budget = std::max(queue_budget(), wire_bytes);
    if (kind == Kind::audio) budget += kAudioReserve;
    if (kind == Kind::configuration || kind == Kind::keyframe) budget += std::max(kFrameBytes, wire_bytes);
    if (buffered > budget || wire_bytes > budget - buffered) {
      if (kind == Kind::video || kind == Kind::keyframe) waiting_for_keyframe_ = true;
      if (reason) *reason = "datachannel-send-backpressure";
      return false;
    }
    return true;
  }
  void sent(Kind kind, std::size_t bytes, std::int64_t now_us) {
    if (kind == Kind::keyframe) waiting_for_keyframe_ = false;
    if (sample_started_us_ < 0) sample_started_us_ = now_us;
    sample_bytes_ += bytes;
    const auto elapsed = now_us - sample_started_us_;
    if (elapsed >= 100000) {
      const double rate = static_cast<double>(sample_bytes_) * 1000000.0 / static_cast<double>(elapsed);
      bytes_per_second_ = bytes_per_second_ == 0 ? rate : bytes_per_second_ * 0.75 + rate * 0.25;
      sample_bytes_ = 0;
      sample_started_us_ = now_us;
    }
  }
  void failed(Kind kind) {
    if (kind == Kind::video || kind == Kind::keyframe) waiting_for_keyframe_ = true;
  }
  bool allow_control(std::size_t bytes, std::size_t buffered) const {
    const auto budget = queue_budget() + kAudioReserve + kControlReserve;
    return buffered <= budget && bytes <= budget - buffered;
  }
  std::size_t queue_budget() const {
    return static_cast<std::size_t>(std::clamp(bytes_per_second_ * 0.25, 256.0 * 1024, 8.0 * 1024 * 1024));
  }
  bool waiting_for_keyframe() const { return waiting_for_keyframe_; }

 private:
  bool waiting_for_keyframe_ = false;
  double bytes_per_second_ = 0;
  std::uint64_t sample_bytes_ = 0;
  std::int64_t sample_started_us_ = -1;
};

inline bool configuration_only(const PeerEncodedMediaDataChannelFrame& frame) {
  if (!frame.config || frame.stream_type != "video" || frame.keyframe) return false;
  const bool hevc = frame.codec == "h265" || frame.codec == "hevc";
  const auto& bytes = frame.payload;
  bool saw_configuration = false;
  for (std::size_t i = 0; i + 3 < bytes.size(); ++i) {
    if (bytes[i] || bytes[i + 1]) continue;
    const auto prefix = bytes[i + 2] == 1 ? 3u :
      (bytes[i + 2] == 0 && bytes[i + 3] == 1 ? 4u : 0u);
    if (!prefix || i + prefix >= bytes.size()) continue;
    const auto type = hevc ? (bytes[i + prefix] >> 1) & 63 : bytes[i + prefix] & 31;
    if (hevc ? type <= 31 : type >= 1 && type <= 5) return false;
    if (hevc ? type >= 32 && type <= 34 : type == 7 || type == 8) saw_configuration = true;
    i += prefix - 1;
  }
  return saw_configuration;
}

}  // namespace vds::media_agent::encoded_transport
