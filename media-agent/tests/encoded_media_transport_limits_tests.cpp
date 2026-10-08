#include "encoded_media_transport_limits.h"

#include <iostream>
#include <limits>
#include <stdexcept>

using namespace vds::media_agent::encoded_transport;

namespace {
unsigned checks = 0;
void require(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(message);
}

PeerEncodedMediaDataChannelFrame chunk(const std::string& id, std::size_t total,
                                      std::size_t index) {
  PeerEncodedMediaDataChannelFrame frame;
  frame.message_type = "chunk";
  frame.stream_type = "video";
  frame.codec = "h264";
  frame.payload_format = "annexb";
  frame.source_epoch = "fixture-epoch";
  frame.frame_id = id;
  frame.frame_payload_bytes = total;
  frame.chunk_count = (total + kChunkBytes - 1) / kChunkBytes;
  frame.chunk_index = index;
  frame.payload.assign(std::min(kChunkBytes, total - index * kChunkBytes),
                       static_cast<std::uint8_t>(index + 1));
  return frame;
}

void shapes() {
  require(kChunksPerFrame == 171, "wire contract changed");
  auto frame = chunk("shape", kFrameBytes, 170);
  require(frame.payload.size() == 8192 && valid_chunk_shape(frame), "maximum frame tail rejected");
  frame.chunk_count = std::numeric_limits<std::uint64_t>::max();
  require(!valid_chunk_shape(frame), "uint64 chunk count admitted");
  frame = chunk("shape", kChunkBytes + 1, 0);
  frame.chunk_count = 3;
  require(!valid_chunk_shape(frame), "count not derived from frame length");
  frame = chunk("shape", kChunkBytes + 1, 1);
  frame.payload.push_back(0);
  require(!valid_chunk_shape(frame), "long final chunk admitted");
  frame.payload.clear();
  require(!valid_chunk_shape(frame), "empty final chunk admitted");
  frame = chunk("shape", kChunkBytes + 1, 0);
  frame.payload.push_back(0);
  require(!valid_chunk_shape(frame), "oversized fragment admitted");
  frame = chunk("shape", kChunkBytes + 1, 1);
  frame.chunk_index = 2;
  require(!valid_chunk_shape(frame), "out of range index admitted");
  frame.frame_id.assign(513, 'x');
  require(!valid_chunk_shape(frame), "oversized frame id admitted");
}

void reassembly() {
  Reassembler r;
  PeerEncodedMediaDataChannelFrame output;
  std::string reason;
  const std::size_t total = kChunkBytes * 3 + 97;
  require(r.accept(chunk("reorder", total, 3), &output, 0, &reason) == Reassembler::Result::pending,
          "out of order final chunk rejected");
  r.accept(chunk("reorder", total, 1), &output, 1, &reason);
  const auto before = r.pending_bytes();
  r.accept(chunk("reorder", total, 1), &output, 2, &reason);
  require(r.pending_bytes() == before, "duplicate fragment consumed budget");
  r.accept(chunk("reorder", total, 0), &output, 3, &reason);
  require(r.accept(chunk("reorder", total, 2), &output, 4, &reason) == Reassembler::Result::complete,
          "valid reordered frame did not complete");
  require(output.payload.size() == total && output.message_type == "frame" && output.frame_id.empty(),
          "assembled frame metadata/size wrong");
  for (std::size_t i = 0; i < total; ++i)
    require(output.payload[i] == static_cast<std::uint8_t>(i / kChunkBytes + 1), "fragment ordering wrong");
  require(r.pending_bytes() == 0 && r.pending_frames() == 0 && global_pending_bytes.load() == 0,
          "completed frame did not release budget");

  r.accept(chunk("mismatch", total, 0), &output, 5, &reason);
  auto changed = chunk("mismatch", total, 1);
  changed.payload_format = "other";
  require(r.accept(std::move(changed), &output, 6, &reason) == Reassembler::Result::rejected,
          "fragment payload format mismatch admitted");
  require(r.pending_bytes() == 0 && r.dropped_frames() == 1, "mismatch left memory allocated");
  auto huge = chunk("huge", total, 0);
  huge.chunk_count = std::numeric_limits<std::uint64_t>::max();
  require(r.accept(std::move(huge), &output, 7, &reason) == Reassembler::Result::rejected && r.pending_frames() == 0,
          "hostile count allocated an entry");
  Reassembler::Result result = Reassembler::Result::pending;
  for (std::size_t index = 0; index < kChunksPerFrame; ++index)
    result = r.accept(chunk("maximum", kFrameBytes, index), &output, 8, &reason);
  require(result == Reassembler::Result::complete && output.payload.size() == kFrameBytes &&
          output.payload.front() == 1 && output.payload.back() == 171 && r.pending_bytes() == 0,
          "maximum 2 MiB / 171-fragment frame no longer works");
}

void budgets() {
  Reassembler r;
  PeerEncodedMediaDataChannelFrame output;
  std::string reason;
  for (std::size_t i = 0; i <= kPendingFrames; ++i)
    r.accept(chunk("count-" + std::to_string(i), kChunkBytes + 1, 0), &output, 0, &reason);
  require(r.pending_frames() == kPendingFrames && r.dropped_frames() == 1,
          "incomplete frame count not bounded");
  r.expire(kChunkLifetimeMs + 1);
  require(r.pending_bytes() == 0 && r.pending_frames() == 0 && global_pending_bytes.load() == 0,
          "expiry did not release all budgets");
  for (std::size_t id = 0; id < 9; ++id) {
    for (std::size_t index = 0; index < kChunksPerFrame - 1; ++index) {
      r.accept(chunk("bytes-" + std::to_string(id), kFrameBytes, index), &output, 10002, &reason);
      require(r.pending_bytes() <= kPendingBytes, "incomplete byte budget exceeded");
    }
  }
  require(r.dropped_frames() > kPendingFrames + 1, "byte pressure did not evict old incomplete frame");
  r.clear();
  require(global_pending_bytes.load() == 0, "clear did not release global bytes");

  r.accept(chunk("global", kChunkBytes + 1, 0), &output, 20000, &reason);
  // Simulate other peers' reservations without allocating a 64 MiB attack.
  const auto other_peers = kGlobalPendingBytes - r.pending_bytes();
  global_pending_bytes.fetch_add(other_peers);
  require(r.accept(chunk("global", kChunkBytes + 1, 1), &output, 20001, &reason) == Reassembler::Result::rejected,
          "aggregate incomplete byte budget exceeded");
  require(r.pending_bytes() == 0 && r.pending_frames() == 0, "global rejection retained partial frame");
  global_pending_bytes.fetch_sub(other_peers);
  require(global_pending_bytes.load() == 0, "global rejected frame leaked its reservation");
}

void admission() {
  SendAdmission a;
  std::string reason;
  const auto budget = a.queue_budget();
  require(!a.admit(SendAdmission::Kind::video, 1000, budget, &reason), "full video queue admitted another frame");
  require(a.waiting_for_keyframe(), "dropped delta did not break reference chain");
  require(!a.admit(SendAdmission::Kind::video, 1000, 0, &reason) && reason == "datachannel-waiting-for-fresh-keyframe",
          "dependent delta sent after predecessor was dropped");
  require(a.admit(SendAdmission::Kind::audio, 1000, budget, &reason), "audio recovery reserve unavailable");
  require(a.admit(SendAdmission::Kind::configuration, 1000, budget, &reason), "decoder config reserve unavailable");
  a.sent(SendAdmission::Kind::configuration, 1000, 0);
  require(a.waiting_for_keyframe(), "config incorrectly repaired a video reference chain");
  require(a.admit(SendAdmission::Kind::keyframe, kFrameBytes + 50000, 0, &reason), "maximum recovery frame rejected");
  a.sent(SendAdmission::Kind::keyframe, kFrameBytes + 50000, 1000);
  require(!a.waiting_for_keyframe() && a.admit(SendAdmission::Kind::video, 1000, 0, &reason),
          "fresh keyframe did not restore normal sending");
  const auto whole_frame = kChunkBytes * 4 + 4096;
  require(!a.admit(SendAdmission::Kind::video, whole_frame, a.queue_budget() - whole_frame + 1, &reason),
          "admission only checked first fragment, not whole frame");
  a.failed(SendAdmission::Kind::keyframe);
  require(a.waiting_for_keyframe(), "partial send failure did not protect reference chain");
  require(a.allow_control(1000, a.queue_budget() + SendAdmission::kAudioReserve), "control recovery reserve unavailable");
  require(!a.allow_control(1000, std::numeric_limits<std::size_t>::max()), "unbounded control queue admitted");
  SendAdmission fast;
  for (std::int64_t i = 0; i < 10000; ++i) {
    require(fast.admit(SendAdmission::Kind::keyframe, kFrameBytes + 50000, 0, &reason),
            "fast drained connection hit a frame/bitrate cap");
    fast.sent(SendAdmission::Kind::keyframe, kFrameBytes + 50000, i * 1000);
  }

  PeerEncodedMediaDataChannelFrame config;
  config.stream_type = "video";
  config.codec = "h264";
  config.config = true;
  config.payload = {0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 1};
  require(configuration_only(config), "pure AVC config not recognized");
  config.payload.insert(config.payload.end(), {0, 0, 1, 0x41, 1});
  require(!configuration_only(config), "AVC config plus dependent picture bypassed chain guard");
  config.codec = "h265";
  config.payload = {0, 0, 1, 64, 1, 1, 0, 0, 1, 66, 1, 1, 0, 0, 1, 68, 1, 1};
  require(configuration_only(config), "pure HEVC config not recognized");
  config.payload.insert(config.payload.end(), {0, 0, 1, 2, 1, 1});
  require(!configuration_only(config), "HEVC config plus dependent picture bypassed chain guard");
}
}  // namespace

int main() {
  try {
    shapes(); reassembly(); budgets(); admission();
    std::cout << "encoded-media-transport-limits: " << checks << " checks passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "encoded-media-transport-limits: " << error.what() << '\n';
    return 1;
  }
}
