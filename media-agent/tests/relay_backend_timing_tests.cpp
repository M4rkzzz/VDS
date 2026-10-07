#include "peer_transport.h"
#include "relay_backend_runtime.h"

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// The real relay runtime uses this transport boundary. A bounded blocking send
// lets the test create queue pressure without a network, FFmpeg, or a decoder.
class PeerTransportSession {
 public:
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<PeerEncodedMediaDataChannelFrame> frames;
  std::vector<PeerEncodedMediaDataChannelFrame> attempts;
  bool fail_once = false;
  std::uint64_t failure_sequence = 0;
  bool block_next_video = false;
  bool block_entered = false;
  bool release_block = false;
  bool block_timed_out = false;
};

PeerTransportSnapshot get_peer_transport_snapshot(const std::shared_ptr<PeerTransportSession>&) {
  PeerTransportSnapshot snapshot;
  snapshot.remote_description_set = true;
  snapshot.connection_state = "connected";
  snapshot.encoded_media_data_channel_supported = true;
  snapshot.encoded_media_data_channel_ready = true;
  snapshot.video_track_open = true;
  snapshot.audio_track_open = true;
  return snapshot;
}

bool send_peer_transport_encoded_media_frame(const std::shared_ptr<PeerTransportSession>& session,
    const PeerEncodedMediaDataChannelFrame& frame, std::string* error) {
  std::unique_lock<std::mutex> lock(session->mutex);
  session->attempts.push_back(frame);
  if (frame.stream_type == "video" && session->block_next_video) {
    session->block_next_video = false;
    session->block_entered = true;
    session->cv.notify_all();
    if (!session->cv.wait_for(lock, std::chrono::seconds(2), [&] { return session->release_block; })) {
      session->block_timed_out = true;
      if (error) *error = "mock-send-block-timeout";
      return false;
    }
  }
  if (frame.stream_type == "video" && session->fail_once && frame.sequence == session->failure_sequence) {
    session->fail_once = false;
    if (error) *error = "mock-injected-send-failure";
    session->cv.notify_all();
    return false;
  }
  session->frames.push_back(frame);
  session->cv.notify_all();
  return true;
}

bool send_peer_transport_video_frame(const std::shared_ptr<PeerTransportSession>&,
    const std::vector<std::uint8_t>&, const std::string&, std::uint64_t, std::string* error) {
  if (error) *error = "unexpected-legacy-video-send";
  return false;
}

bool send_peer_transport_audio_frame(const std::shared_ptr<PeerTransportSession>&,
    const std::vector<std::uint8_t>&, std::uint64_t, std::string* error) {
  if (error) *error = "unexpected-legacy-audio-send";
  return false;
}

namespace {
using Runtime = vds::media_agent::relay_backend::Runtime;
using Bytes = std::vector<std::uint8_t>;
int checks = 0;
int failures = 0;
const Bytes kConfig{0, 0, 0, 1, 0x67, 0x42, 0x11, 0, 0, 1, 0x68, 0xce, 0x22};
const Bytes kIdr{0, 0, 0, 1, 0x65, 0xb8, 0x33};
const Bytes kP{0, 0, 1, 0x41, 0x9a, 0x44};

void expect(bool condition, const std::string& message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

Bytes join(const Bytes& left, const Bytes& right) {
  auto result = left;
  result.insert(result.end(), right.begin(), right.end());
  return result;
}

MediaFrameTiming timing(std::uint64_t sequence, std::uint64_t timestamp_us,
    const std::string& source_epoch = "original-source-epoch") {
  MediaFrameTiming value;
  value.sequence = sequence;
  value.sequence_valid = true;
  value.timestamp_us = timestamp_us;
  value.timestamp_valid = true;
  value.source_id = "original-host-source";
  value.source_epoch = source_epoch;
  return value;
}

void video(Runtime& runtime, const Bytes& bytes, std::uint64_t sequence, std::uint64_t timestamp_us) {
  // A deliberately unrelated RTP timestamp catches fallback to the old 32-bit
  // clock when an authoritative 64-bit source time was supplied.
  runtime.fanout_video_units("upstream", "h264", {bytes}, 12345, timing(sequence, timestamp_us));
}

std::vector<PeerEncodedMediaDataChannelFrame> frames(const std::shared_ptr<PeerTransportSession>& session) {
  std::lock_guard<std::mutex> lock(session->mutex);
  return session->frames;
}

std::size_t attempt_count(const std::shared_ptr<PeerTransportSession>& session) {
  std::lock_guard<std::mutex> lock(session->mutex);
  return session->attempts.size();
}

std::string binding_epoch(Runtime& runtime, const std::string& peer_id) {
  RelaySubscriberState state;
  return runtime.query_subscriber_state(peer_id, &state) ? state.source_epoch : "";
}

bool short_opaque_epoch(const std::string& epoch) {
  return !epoch.empty() && epoch.size() <= 64 && epoch != "original-source-epoch";
}

bool wait_for_state(Runtime& runtime, const std::string& peer_id,
    const std::function<bool(const RelaySubscriberState&)>& predicate) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  do {
    RelaySubscriberState state;
    if (runtime.query_subscriber_state(peer_id, &state) && predicate(state)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  } while (std::chrono::steady_clock::now() < deadline);
  return false;
}

bool wait_live(Runtime& runtime, const std::string& peer_id, std::uint64_t sequence) {
  return wait_for_state(runtime, peer_id, [=](const RelaySubscriberState& state) {
    return !state.pending_video_bootstrap && state.last_video_sequence_valid && state.last_video_sequence == sequence;
  });
}

bool wait_bootstrap(Runtime& runtime, const std::string& peer_id) {
  return wait_for_state(runtime, peer_id, [](const RelaySubscriberState& state) {
    return state.pending_video_bootstrap && state.reason == "relay-waiting-for-random-access";
  });
}

void test_zero_time_bootstrap_and_audio() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", viewer, true);
  video(runtime, kConfig, 0, 0);
  expect(wait_bootstrap(runtime, "viewer"), "config alone leaves subscriber waiting for random access");
  expect(frames(viewer).empty(), "configuration does not invent a standalone bootstrap frame");
  video(runtime, kIdr, 1, 0);
  expect(wait_live(runtime, "viewer", 1), "the first configured IDR starts the subscriber");
  auto received = frames(viewer);
  expect(received.size() == 1, "configuration plus IDR is exactly one outbound frame");
  if (received.size() == 1) {
    expect(received[0].sequence == 1 && received[0].timestamp_us == 0,
        "bootstrap preserves source IDR sequence and valid PTS zero");
    expect(short_opaque_epoch(received[0].source_epoch) &&
        received[0].source_epoch == binding_epoch(runtime, "viewer"),
        "video forwarding uses the short opaque subscriber binding epoch");
    expect(received[0].keyframe && received[0].config && received[0].payload == join(kConfig, kIdr),
        "the single bootstrap frame includes parameter sets and only the IDR picture");
  }
  video(runtime, kP, 2, 16667);
  expect(wait_live(runtime, "viewer", 2), "next live picture continues directly after the IDR");
  received = frames(viewer);
  expect(received.size() == 2 && received[1].sequence == 2 && received[1].timestamp_us == 16667,
      "configuration merging creates no artificial video sequence gap");

  runtime.fanout_audio_frame("upstream", {0xf8, 0xff, 0xfe}, "opus", 98765, timing(3123, 0));
  received = frames(viewer);
  expect(received.size() == 3 && received[2].stream_type == "audio" &&
      received[2].sequence == 3123 && received[2].timestamp_us == 0,
      "audio forwarding preserves original sequence and PTS zero");
  expect(received.size() == 3 && received[2].source_epoch == received[0].source_epoch &&
      received[1].source_epoch == received[0].source_epoch,
      "audio and continuing video share the stable subscriber binding epoch");
}

void test_late_join_preserves_gop_timeline() {
  Runtime runtime;
  auto existing = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "existing", existing, true);
  constexpr std::uint64_t pts = 9000000000123ull;
  video(runtime, join(kConfig, kP), 500, pts - 16667);
  expect(wait_bootstrap(runtime, "existing"), "configuration-bearing old P picture does not start playback");
  video(runtime, kIdr, 501, pts);
  expect(wait_live(runtime, "existing", 501), "existing subscriber receives source IDR");
  video(runtime, kP, 502, pts + 16667);
  video(runtime, kP, 503, pts + 33334);
  expect(wait_live(runtime, "existing", 503), "existing subscriber advances through the cached GOP");

  auto late = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "late", late, true);
  video(runtime, kP, 504, pts + 50001);
  expect(wait_live(runtime, "late", 504), "late subscriber starts from the complete cached GOP");
  auto received = frames(late);
  const auto late_epoch = binding_epoch(runtime, "late");
  expect(short_opaque_epoch(late_epoch) && late_epoch != binding_epoch(runtime, "existing"),
      "a late subscriber receives a unique binding epoch");
  expect(received.size() == 4, "late join receives one IDR and its three dependent pictures");
  bool timeline_preserved = received.size() == 4;
  for (std::size_t index = 0; index < received.size(); ++index) {
    timeline_preserved = timeline_preserved && received[index].sequence == 501 + index &&
        received[index].timestamp_us == pts + index * 16667 &&
        received[index].source_epoch == late_epoch;
  }
  expect(timeline_preserved, "cached GOP retains source timing while sharing the late subscriber binding epoch");
  expect(!received.empty() && received.front().payload == join(kConfig, kIdr),
      "late join does not duplicate the old configuration-bearing P picture");
  video(runtime, kP, 505, pts + 66668);
  expect(wait_live(runtime, "late", 505), "late subscriber changes from cached GOP to the next live sequence");
  received = frames(late);
  expect(received.size() == 5 && received.back().sequence == 505,
      "switching to live forwarding neither duplicates nor skips a sequence");
  runtime.fanout_audio_frame("upstream", {1, 2, 3}, "AAC", 1, timing(8800123, pts + 80000));
  received = frames(late);
  expect(received.size() == 6 && received.back().stream_type == "audio" &&
      received.back().codec == "aac" && received.back().sequence == 8800123 &&
      received.back().timestamp_us == pts + 80000 && received.back().source_epoch == late_epoch,
      "audio retains source timing and the cached video binding epoch");
}

void test_partial_send_failure_waits_for_fresh_idr() {
  Runtime runtime;
  auto existing = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "existing", existing, false);
  video(runtime, join(kConfig, kIdr), 100, 0);
  video(runtime, kP, 101, 16667);
  video(runtime, kP, 102, 33334);
  expect(wait_live(runtime, "existing", 102), "reference GOP is cached before failure injection");
  auto late = std::make_shared<PeerTransportSession>();
  late->fail_once = true;
  late->failure_sequence = 102;
  runtime.register_subscriber("upstream", "late", late, false);
  video(runtime, kP, 103, 50001);
  expect(wait_for_state(runtime, "late", [](const RelaySubscriberState& state) {
    return state.pending_video_bootstrap && state.reason == "relay-video-send-failed" &&
        state.last_video_sequence_valid && state.last_video_sequence == 101;
  }), "partial bootstrap failure retains the last successfully sent source sequence");
  auto received = frames(late);
  expect(received.size() == 2 && received[0].sequence == 100 && received[1].sequence == 101,
      "the failure occurs after a real partial GOP delivery");
  expect(attempt_count(late) == 3, "partial delivery stopped at the injected failed picture");
  video(runtime, kP, 104, 66668);
  expect(wait_bootstrap(runtime, "late"), "a failed active subscriber waits for a fresh random-access frame");
  expect(frames(late).size() == 2 && attempt_count(late) == 3,
      "recovery does not replay old source sequences or send dependent P pictures");
  video(runtime, kIdr, 105, 83335);
  expect(wait_live(runtime, "late", 105), "fresh IDR recovers the partially delivered subscriber");
  video(runtime, kP, 106, 100002);
  expect(wait_live(runtime, "late", 106), "normal forwarding resumes after the fresh IDR");
  received = frames(late);
  expect(received.size() == 4 && received[2].sequence == 105 && received[2].keyframe &&
      received[3].sequence == 106, "the recovered output starts with a new IDR, followed by its direct successor");
}

void test_upstream_gap_and_duplicate() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", viewer, false);
  video(runtime, join(kConfig, kIdr), 10, 0);
  video(runtime, kP, 11, 16667);
  expect(wait_live(runtime, "viewer", 11), "subscriber is live before the upstream gap");
  video(runtime, kP, 13, 50001);
  expect(wait_bootstrap(runtime, "viewer"), "upstream sequence gap invalidates subscriber references");
  expect(frames(viewer).size() == 2, "a P picture beyond an upstream gap is not forwarded");
  video(runtime, kP, 14, 66668);
  video(runtime, kIdr, 15, 83335);
  expect(wait_live(runtime, "viewer", 15), "a new upstream IDR repairs the gap");
  video(runtime, kIdr, 15, 83335);
  video(runtime, kP, 16, 100002);
  expect(wait_live(runtime, "viewer", 16), "a duplicate source frame does not prevent the next live picture");
  const auto received = frames(viewer);
  expect(received.size() == 4 && received[2].sequence == 15 && received[3].sequence == 16,
      "gap recovery skips dependent frames and suppresses the duplicate IDR");
}

void test_dispatch_queue_loss_recovers_with_idr() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  viewer->block_next_video = true;
  runtime.register_subscriber("upstream", "viewer", viewer, false);
  video(runtime, join(kConfig, kIdr), 0, 0);
  bool blocked = false;
  {
    std::unique_lock<std::mutex> lock(viewer->mutex);
    blocked = viewer->cv.wait_for(lock, std::chrono::seconds(2), [&] { return viewer->block_entered; });
  }
  expect(blocked, "mock transport holds a real relay worker send while the queue grows");
  if (blocked) {
    for (std::uint64_t sequence = 1; sequence <= 520; ++sequence) {
      video(runtime, kP, sequence, sequence * 16667);
    }
    RelaySubscriberState state;
    expect(runtime.query_subscriber_state("viewer", &state) && state.pending_video_bootstrap &&
        state.video_recovery_generation > 0, "queue loss immediately marks the affected subscriber for recovery");
  }
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    viewer->release_block = true;
  }
  viewer->cv.notify_all();
  if (blocked) {
    video(runtime, kIdr, 521, 521 * 16667);
    expect(wait_live(runtime, "viewer", 521), "relay dispatch drains the bounded queue and recovers at a fresh IDR");
    const auto received = frames(viewer);
    expect(received.size() == 2 && received[0].sequence == 0 && received[1].sequence == 521 &&
        received[1].keyframe && received[1].config,
        "queue overflow never forwards an incomplete predictive chain after the blocked bootstrap");
  }
  runtime.shutdown_dispatch();
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    expect(!viewer->block_timed_out, "all blocking mock sends are released within the timeout");
  }
}

void test_source_clear_during_inflight_send() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  viewer->block_next_video = true;
  runtime.register_subscriber("upstream", "viewer", viewer, false);
  video(runtime, join(kConfig, kIdr), 10, 100000);
  bool blocked = false;
  {
    std::unique_lock<std::mutex> lock(viewer->mutex);
    blocked = viewer->cv.wait_for(lock, std::chrono::seconds(2), [&] { return viewer->block_entered; });
  }
  expect(blocked, "old-source bootstrap send is in flight during source clear");
  if (blocked) {
    runtime.clear_upstream_bootstrap_state("upstream");
    RelaySubscriberState cleared;
    expect(runtime.query_subscriber_state("viewer", &cleared) && cleared.pending_video_bootstrap &&
        !cleared.last_video_sequence_valid && cleared.video_recovery_generation > 0,
        "source clear invalidates the previous subscriber sequence baseline");
  }
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    viewer->release_block = true;
  }
  viewer->cv.notify_all();
  if (blocked) {
    expect(wait_for_state(runtime, "viewer", [](const RelaySubscriberState& state) {
      return state.frames_sent == 1;
    }), "the already in-flight old send finishes after source clear");
    RelaySubscriberState completed;
    expect(runtime.query_subscriber_state("viewer", &completed) && completed.pending_video_bootstrap &&
        !completed.last_video_sequence_valid,
        "old send completion cannot restore a stale sequence or clear the new recovery flag");
    video(runtime, join(kConfig, kIdr), 0, 0);
    expect(wait_live(runtime, "viewer", 0), "new source sequence zero can bootstrap after an old sequence ten send");
    video(runtime, kP, 1, 16667);
    expect(wait_live(runtime, "viewer", 1), "the new source establishes its own live sequence baseline");
    const auto received = frames(viewer);
    expect(received.size() == 3 && received[0].sequence == 10 && received[1].sequence == 0 &&
        received[1].timestamp_us == 0 && received[1].keyframe && received[2].sequence == 1,
        "in-flight old delivery does not suppress or renumber the new-source bootstrap");
    expect(received.size() == 3 && received[0].source_epoch != received[1].source_epoch &&
        received[1].source_epoch == received[2].source_epoch,
        "source clear rotates the binding epoch before new-source media is delivered");
  }
  runtime.shutdown_dispatch();
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    expect(!viewer->block_timed_out, "source-clear regression releases its mock send within the timeout");
  }
}

void test_epoch_crosses_two_relay_hops() {
  Runtime first_hop;
  Runtime second_hop;
  auto intermediate = std::make_shared<PeerTransportSession>();
  auto final_viewer = std::make_shared<PeerTransportSession>();
  first_hop.register_subscriber("upstream", "intermediate", intermediate, true);
  second_hop.register_subscriber("different-upstream-peer", "final-viewer", final_viewer, true);
  video(first_hop, join(kConfig, kIdr), 0, 0);
  video(first_hop, kP, 1, 16667);
  expect(wait_live(first_hop, "intermediate", 1), "first relay emits the original video timeline");
  first_hop.fanout_audio_frame("upstream", {1, 2, 3}, "opus", 1, timing(71234, 9000000000123ull));
  const auto forwarded = frames(intermediate);
  expect(forwarded.size() == 3, "first hop forwards both video pictures and the source audio frame");
  const auto first_epoch = binding_epoch(first_hop, "intermediate");
  expect(short_opaque_epoch(first_epoch), "first hop emits a short opaque binding epoch");
  for (const auto& frame : forwarded) {
    auto incoming_timing = timing(frame.sequence, frame.timestamp_us, frame.source_epoch);
    incoming_timing.source_id = "a-different-local-source-id";
    if (frame.stream_type == "video") {
      second_hop.fanout_video_units("different-upstream-peer", frame.codec, {frame.payload}, 34567, incoming_timing);
    } else {
      second_hop.fanout_audio_frame("different-upstream-peer", frame.payload, frame.codec, 76543, incoming_timing);
    }
  }
  expect(wait_live(second_hop, "final-viewer", 1), "second relay accepts the forwarded video source baseline");
  const auto received = frames(final_viewer);
  expect(received.size() == 3, "second relay emits one copy of each original media frame");
  const auto second_epoch = binding_epoch(second_hop, "final-viewer");
  expect(short_opaque_epoch(second_epoch) && second_epoch != first_epoch,
      "another relay hop creates its own bounded epoch instead of extending the incoming epoch");
  bool video_preserved = false;
  bool audio_preserved = false;
  std::size_t video_count = 0;
  for (const auto& frame : received) {
    expect(frame.source_epoch == second_epoch,
        "audio and video across different local identities share the second hop binding epoch");
    if (frame.stream_type == "video") {
      ++video_count;
      video_preserved = frame.sequence == 0 ? frame.timestamp_us == 0 && frame.keyframe :
          frame.sequence == 1 && frame.timestamp_us == 16667;
      expect(video_preserved, "second relay preserves original video sequence and PTS");
    } else {
      audio_preserved = frame.sequence == 71234 && frame.timestamp_us == 9000000000123ull;
    }
  }
  expect(video_count == 2 && audio_preserved,
      "two-hop media forwarding keeps original audio timing and both video frames");
}

void test_epoch_switch_on_retained_peer() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", viewer, false);
  auto old_timing = timing(0, 100000, "epoch-old");
  old_timing.source_id = "retained-peer";
  runtime.fanout_video_units("upstream", "h264", {join(kConfig, kIdr)}, 123, old_timing);
  expect(wait_live(runtime, "viewer", 0), "retained peer starts with the old source epoch");
  const auto old_binding_epoch = binding_epoch(runtime, "viewer");
  auto new_timing = timing(0, 0, "epoch-new");
  new_timing.source_id = "retained-peer";
  runtime.fanout_video_units("upstream", "h264", {kIdr}, 456, new_timing);
  expect(wait_bootstrap(runtime, "viewer"), "new epoch resets retained peer even at the same source sequence");
  const auto new_binding_epoch = binding_epoch(runtime, "viewer");
  expect(short_opaque_epoch(new_binding_epoch) && new_binding_epoch != old_binding_epoch,
      "new ingress origin rotates the retained subscriber binding epoch");
  expect(frames(viewer).size() == 1, "old epoch configuration cannot bootstrap the new epoch IDR");
  auto new_config = kConfig;
  new_config[5] = 0x4d;
  new_timing.sequence = 1;
  runtime.fanout_video_units("upstream", "h264", {new_config}, 789, new_timing);
  new_timing.sequence = 2;
  new_timing.timestamp_us = 16667;
  runtime.fanout_video_units("upstream", "h264", {kIdr}, 987, new_timing);
  expect(wait_live(runtime, "viewer", 2), "only the new epoch configuration and IDR resume the retained peer");
  const auto received = frames(viewer);
  expect(received.size() == 2 && received[0].source_epoch == old_binding_epoch &&
      received[1].source_epoch == new_binding_epoch && received[1].sequence == 2 &&
      received[1].timestamp_us == 16667 && received[1].payload == join(new_config, kIdr),
      "epoch restart preserves the new source baseline without borrowing old configuration");
}

void test_legacy_input_receives_binding_epoch() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", viewer, true);
  runtime.fanout_video_units("upstream", "h264", {join(kConfig, kIdr)}, 90000);
  expect(wait_live(runtime, "viewer", 0), "legacy RTP video remains compatible without sourceEpoch");
  runtime.fanout_audio_frame("upstream", {1, 2, 3}, "opus", 48000);
  const auto received = frames(viewer);
  const auto epoch = binding_epoch(runtime, "viewer");
  expect(received.size() == 2 && received[0].stream_type == "video" &&
      received[0].timestamp_us == 1000000 && received[0].source_epoch == epoch &&
      received[1].stream_type == "audio" && received[1].timestamp_us == 1000000 &&
      received[1].source_epoch == epoch && short_opaque_epoch(epoch),
      "legacy input uses a shared opaque egress binding epoch without changing source timing");
}

void test_origin_round_trip_and_stable_av_epoch() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", viewer, true);
  const auto send_origin_video = [&](const std::string& origin, const Bytes& bytes, std::uint64_t sequence) {
    runtime.fanout_video_units("upstream", "h264", {bytes}, 12345,
        timing(sequence, sequence * 16667, origin));
  };
  const auto send_origin_audio = [&](const std::string& origin, std::uint64_t sequence) {
    runtime.fanout_audio_frame("upstream", {1, 2, 3}, "opus", 23456,
        timing(sequence, 9000000000123ull, origin));
  };
  send_origin_video("origin-A", join(kConfig, kIdr), 0);
  expect(wait_live(runtime, "viewer", 0), "origin A starts the retained binding");
  const auto epoch_a1 = binding_epoch(runtime, "viewer");
  send_origin_audio("origin-A", 700);
  send_origin_video("origin-A", kP, 1);
  expect(wait_live(runtime, "viewer", 1), "more media from origin A continues normally");
  auto received = frames(viewer);
  expect(received.size() == 3 && short_opaque_epoch(epoch_a1) &&
      received[0].source_epoch == epoch_a1 && received[1].source_epoch == epoch_a1 &&
      received[2].source_epoch == epoch_a1 && binding_epoch(runtime, "viewer") == epoch_a1,
      "same ingress origin keeps one stable A/V binding epoch");

  send_origin_video("origin-B", join(kConfig, kIdr), 0);
  expect(wait_live(runtime, "viewer", 0), "origin B establishes a fresh source baseline");
  const auto epoch_b = binding_epoch(runtime, "viewer");
  send_origin_audio("origin-B", 800);
  send_origin_video("origin-B", kP, 1);
  expect(wait_live(runtime, "viewer", 1), "continuing origin B packets share the new source baseline");
  received = frames(viewer);
  expect(received.size() == 6 && short_opaque_epoch(epoch_b) && epoch_b != epoch_a1 &&
      received[3].source_epoch == epoch_b && received[4].source_epoch == epoch_b &&
      received[5].source_epoch == epoch_b, "origin B rotates once and shares its opaque epoch across audio/video");

  send_origin_video("origin-A", join(kConfig, kIdr), 0);
  expect(wait_live(runtime, "viewer", 0), "returning origin A creates another fresh source baseline");
  const auto epoch_a2 = binding_epoch(runtime, "viewer");
  send_origin_audio("origin-A", 900);
  send_origin_video("origin-A", kP, 1);
  expect(wait_live(runtime, "viewer", 1), "returned origin A continues after its new IDR");
  received = frames(viewer);
  expect(received.size() == 9 && short_opaque_epoch(epoch_a2) && epoch_a2 != epoch_a1 && epoch_a2 != epoch_b &&
      received[6].source_epoch == epoch_a2 && received[7].source_epoch == epoch_a2 &&
      received[8].source_epoch == epoch_a2, "A-to-B-to-A never reuses the first A egress epoch");
  expect(received.size() == 9 && received[6].sequence == 0 && received[6].timestamp_us == 0 &&
      received[7].sequence == 900 && received[7].timestamp_us == 9000000000123ull &&
      received[8].sequence == 1 && received[8].timestamp_us == 16667,
      "binding epoch rotation preserves each original media sequence and source PTS");
}

void test_subscriber_rebind_rotates_epoch() {
  Runtime runtime;
  auto original = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", original, true);
  video(runtime, join(kConfig, kIdr), 10, 100000);
  expect(wait_live(runtime, "viewer", 10), "original subscriber binding is live before rebind");
  const auto first_epoch = binding_epoch(runtime, "viewer");
  auto replacement = std::make_shared<PeerTransportSession>();
  runtime.register_subscriber("upstream", "viewer", replacement, true);
  const auto second_epoch = binding_epoch(runtime, "viewer");
  expect(short_opaque_epoch(second_epoch) && second_epoch != first_epoch,
      "replacing a subscriber transport rotates its binding epoch");
  video(runtime, kP, 11, 116667);
  expect(wait_live(runtime, "viewer", 11), "replacement binding bootstraps from the retained contiguous GOP");
  auto received = frames(replacement);
  expect(received.size() == 2 && received[0].sequence == 10 && received[1].sequence == 11 &&
      received[0].source_epoch == second_epoch && received[1].source_epoch == second_epoch,
      "cached GOP is remapped to the new binding epoch without changing source sequences");
  expect(frames(original).size() == 1, "rebind sends new frames only to the replacement transport");
  runtime.fanout_audio_frame("upstream", {1, 2, 3}, "opus", 123, timing(800, 120000));
  received = frames(replacement);
  expect(received.size() == 3 && received.back().source_epoch == second_epoch,
      "replacement binding shares its remapped epoch with audio");
  runtime.register_subscriber("upstream", "viewer", replacement, true);
  const auto third_epoch = binding_epoch(runtime, "viewer");
  expect(short_opaque_epoch(third_epoch) && third_epoch != first_epoch && third_epoch != second_epoch,
      "explicitly registering the same transport again creates another unique binding epoch");
  video(runtime, kP, 12, 133334);
  expect(wait_live(runtime, "viewer", 12), "the newly registered binding replays the complete cached GOP");
  received = frames(replacement);
  expect(received.size() == 6 && received[3].source_epoch == third_epoch &&
      received[4].source_epoch == third_epoch && received[5].source_epoch == third_epoch &&
      received[3].sequence == 10 && received[5].sequence == 12,
      "re-registration remaps all cached pictures to its new epoch");
}

void test_origin_change_discards_old_queued_frames() {
  Runtime runtime;
  auto viewer = std::make_shared<PeerTransportSession>();
  viewer->block_next_video = true;
  runtime.register_subscriber("upstream", "viewer", viewer, true);
  runtime.fanout_video_units("upstream", "h264", {join(kConfig, kIdr)}, 123,
      timing(10, 100000, "origin-A"));
  bool blocked = false;
  {
    std::unique_lock<std::mutex> lock(viewer->mutex);
    blocked = viewer->cv.wait_for(lock, std::chrono::seconds(2), [&] { return viewer->block_entered; });
  }
  expect(blocked, "old-origin relay send is held while old tasks queue behind it");
  const auto old_epoch = binding_epoch(runtime, "viewer");
  std::string new_epoch;
  if (blocked) {
    runtime.fanout_video_units("upstream", "h264", {kP}, 234, timing(11, 116667, "origin-A"));
    runtime.fanout_video_units("upstream", "h264", {join(kConfig, kIdr)}, 345,
        timing(12, 133334, "origin-A"));
    runtime.fanout_video_units("upstream", "h264", {join(kConfig, kIdr)}, 456,
        timing(0, 0, "origin-B"));
    new_epoch = binding_epoch(runtime, "viewer");
    expect(short_opaque_epoch(new_epoch) && new_epoch != old_epoch,
        "new ingress origin rotates egress epoch before the async old send returns");
  }
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    viewer->release_block = true;
  }
  viewer->cv.notify_all();
  if (blocked) {
    expect(wait_live(runtime, "viewer", 0), "new-origin IDR bootstraps after the in-flight old send completes");
    auto received = frames(viewer);
    expect(received.size() == 2 && received[0].sequence == 10 && received[0].source_epoch == old_epoch &&
        received[1].sequence == 0 && received[1].source_epoch == new_epoch,
        "old queued pictures are discarded while the old in-flight picture keeps its captured epoch");
    expect(binding_epoch(runtime, "viewer") == new_epoch,
        "discarded old tasks cannot roll the binding epoch back to the previous origin");
    runtime.fanout_video_units("upstream", "h264", {kP}, 567, timing(1, 16667, "origin-B"));
    expect(wait_live(runtime, "viewer", 1), "the new origin continues after queue-generation recovery");
    runtime.fanout_audio_frame("upstream", {1, 2, 3}, "opus", 678,
        timing(500, 20000, "origin-B"));
    received = frames(viewer);
    expect(received.size() == 4 && received[2].source_epoch == new_epoch &&
        received[3].source_epoch == new_epoch && received[3].sequence == 500,
        "continued video and audio retain the new binding epoch after stale work is discarded");
  }
  runtime.shutdown_dispatch();
  {
    std::lock_guard<std::mutex> lock(viewer->mutex);
    expect(!viewer->block_timed_out, "origin-change queue regression releases its send within the timeout");
  }
}
} // namespace

int main() {
  test_zero_time_bootstrap_and_audio();
  test_late_join_preserves_gop_timeline();
  test_partial_send_failure_waits_for_fresh_idr();
  test_upstream_gap_and_duplicate();
  test_dispatch_queue_loss_recovers_with_idr();
  test_source_clear_during_inflight_send();
  test_epoch_crosses_two_relay_hops();
  test_epoch_switch_on_retained_peer();
  test_legacy_input_receives_binding_epoch();
  test_origin_round_trip_and_stable_av_epoch();
  test_subscriber_rebind_rotates_epoch();
  test_origin_change_discards_old_queued_frames();
  std::cout << "Relay backend timing: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
