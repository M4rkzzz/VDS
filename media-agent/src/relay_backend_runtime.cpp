#include "relay_backend_runtime.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <condition_variable>
#include <deque>
#include <map>
#include <iomanip>
#include <memory>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>
#include <vector>

#include "json_protocol.h"
#include "peer_transport.h"
#include "relay_media_timing.h"
#include "video_access_unit.h"

namespace {

constexpr unsigned int kRelayTransportAudioSampleRate = 48000;
constexpr std::uint64_t kRelayVideoRtpClockRate = 90000;
constexpr std::size_t kMaxQueuedRelayVideoDispatches = 512;
constexpr std::size_t kMaxQueuedRelayVideoBytes = 32 * 1024 * 1024;
using RelayTimedVideoAccessUnit = vds::media_agent::RelayTimedVideoAccessUnit;
using RelayVideoBootstrapCache = vds::media_agent::RelayVideoBootstrapCache;

std::string next_relay_source_epoch() {
  static const std::uint64_t process_nonce = []() {
    std::random_device random;
    return (static_cast<std::uint64_t>(random()) << 32) ^ random();
  }();
  static std::atomic<std::uint64_t> next_binding{1};
  std::ostringstream epoch;
  epoch << "r-" << std::hex << std::setw(16) << std::setfill('0') << process_nonce
        << '-' << next_binding.fetch_add(1, std::memory_order_relaxed);
  return epoch.str();
}

struct QueuedRelayVideoDispatch {
  std::string upstream_peer_id;
  std::string codec;
  std::vector<RelayTimedVideoAccessUnit> access_units;
  std::uint64_t upstream_generation = 0;
  std::size_t payload_bytes = 0;
};

struct RelayBackendState {
  std::mutex mutex;
  std::mutex shutdown_mutex;
  std::condition_variable video_cv;
  std::thread video_worker;
  std::map<std::string, std::vector<RelaySubscriberState>> subscribers_by_upstream_peer;
  std::map<std::string, RelayVideoBootstrapCache> video_bootstrap_by_upstream_peer;
  std::map<std::string, vds::media_agent::RelayRtpClock> video_clock_by_upstream_peer;
  std::map<std::string, vds::media_agent::RelayRtpClock> audio_clock_by_upstream_peer;
  std::map<std::string, std::uint64_t> video_generation_by_upstream_peer;
  std::map<std::string, std::string> source_epoch_by_upstream_peer;
  std::deque<QueuedRelayVideoDispatch> pending_video_dispatches;
  std::size_t pending_video_bytes = 0;
  bool video_worker_started = false;
  bool video_worker_stop = false;
  bool closed = false;
};

struct RelayDispatchTarget {
  std::string peer_id;
  std::shared_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
  std::uint64_t video_recovery_generation = 0;
  std::string source_epoch;
};

} // namespace

namespace vds::media_agent::relay_backend {

struct Runtime::State : RelayBackendState {};

Runtime::Runtime() : state_(std::make_unique<State>()) {}

std::unique_ptr<Runtime> create_runtime() {
  return std::make_unique<Runtime>();
}

Runtime::~Runtime() {
  close();
}

Runtime::State& relay_backend_state(Runtime& runtime) {
  return *runtime.state_;
}

} // namespace vds::media_agent::relay_backend

namespace {
void mark_relay_video_recovery_locked(
  RelayBackendState& state,
  const std::string& upstream_peer_id,
  bool sequence_reset = false) {
  const auto found = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (found == state.subscribers_by_upstream_peer.end()) return;
  for (auto& subscriber : found->second) {
    subscriber.pending_video_bootstrap = true;
    subscriber.bootstrap_snapshot_sent = false;
    subscriber.video_recovery_generation += 1;
    if (sequence_reset) subscriber.last_video_sequence_valid = false;
  }
}

void discard_pending_upstream_video_locked(RelayBackendState& state, const std::string& upstream_peer_id) {
  for (auto it = state.pending_video_dispatches.begin(); it != state.pending_video_dispatches.end();) {
    if (it->upstream_peer_id == upstream_peer_id) {
      state.pending_video_bytes -= it->payload_bytes;
      it = state.pending_video_dispatches.erase(it);
    } else ++it;
  }
}

void prepare_relay_source_origin_locked(
  RelayBackendState& state, const std::string& upstream_peer_id, const std::string& source_epoch) {
  const auto previous = state.source_epoch_by_upstream_peer.find(upstream_peer_id);
  const bool initialized = previous != state.source_epoch_by_upstream_peer.end();
  if (initialized && previous->second == source_epoch) return;
  state.source_epoch_by_upstream_peer[upstream_peer_id] = source_epoch;
  if (initialized) {
    ++state.video_generation_by_upstream_peer[upstream_peer_id];
    discard_pending_upstream_video_locked(state, upstream_peer_id);
    state.video_bootstrap_by_upstream_peer.erase(upstream_peer_id);
    state.video_clock_by_upstream_peer.erase(upstream_peer_id);
    state.audio_clock_by_upstream_peer.erase(upstream_peer_id);
    mark_relay_video_recovery_locked(state, upstream_peer_id, true);
  }
  const auto subscribers = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (subscribers == state.subscribers_by_upstream_peer.end()) return;
  for (auto& subscriber : subscribers->second) {
    subscriber.upstream_source_epoch = source_epoch;
    if (initialized) subscriber.source_epoch = next_relay_source_epoch();
  }
}

bool collect_relay_video_bootstrap_access_units(
  vds::media_agent::relay_backend::Runtime& runtime,
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  std::vector<RelayTimedVideoAccessUnit>* out_access_units,
  std::uint64_t upstream_generation,
  std::uint64_t recovery_generation) {
  if (!out_access_units || upstream_peer_id.empty() || peer_id.empty()) return false;
  auto& state = relay_backend_state(runtime);
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.closed) return false;
  if (state.video_generation_by_upstream_peer[upstream_peer_id] != upstream_generation) return false;
  const auto upstream = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  const auto cached = state.video_bootstrap_by_upstream_peer.find(upstream_peer_id);
  if (upstream == state.subscribers_by_upstream_peer.end() || cached == state.video_bootstrap_by_upstream_peer.end()) return false;
  for (const auto& subscriber : upstream->second) {
    if (subscriber.peer_id != peer_id || !subscriber.pending_video_bootstrap) continue;
    if (subscriber.video_recovery_generation != recovery_generation) return false;
    auto snapshot = cached->second.snapshot();
    if (snapshot.empty()) return false;
    // A partial send failure cannot replay old sequence numbers into an active
    // decoder. Recover it with a fresh IDR; a newly joined peer can replay the
    // cached, contiguous GOP without changing its original source timeline.
    if (subscriber.last_video_sequence_valid && snapshot.front().timing.sequence_valid &&
        snapshot.front().timing.sequence <= subscriber.last_video_sequence) return false;
    *out_access_units = std::move(snapshot);
    return true;
  }
  return false;
}
void commit_relay_video_bootstrap_state(
  vds::media_agent::relay_backend::Runtime& runtime,
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  bool clear_pending_bootstrap,
  std::uint64_t recovery_generation) {
  if (upstream_peer_id.empty() || peer_id.empty()) {
    return;
  }

  auto& state = relay_backend_state(runtime);
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return;
  }

  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id != peer_id) {
      continue;
    }
    if (subscriber.video_recovery_generation != recovery_generation) return;
    subscriber.bootstrap_snapshot_sent = true;
    if (clear_pending_bootstrap) {
      subscriber.pending_video_bootstrap = false;
    }
    return;
  }
}

std::vector<RelayDispatchTarget> collect_relay_dispatch_targets(
  vds::media_agent::relay_backend::Runtime& runtime, const std::string& upstream_peer_id,
  const std::uint64_t* expected_upstream_generation = nullptr) {
  std::vector<RelayDispatchTarget> targets;
  if (upstream_peer_id.empty()) {
    return targets;
  }

  auto& state = relay_backend_state(runtime);
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.closed) return targets;
  if (expected_upstream_generation &&
      state.video_generation_by_upstream_peer[upstream_peer_id] != *expected_upstream_generation) return targets;
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return targets;
  }

  auto& subscribers = upstream_it->second;
  for (auto subscriber_it = subscribers.begin(); subscriber_it != subscribers.end();) {
    const auto session = subscriber_it->session.lock();
    if (!session) {
      subscriber_it = subscribers.erase(subscriber_it);
      continue;
    }

    RelayDispatchTarget target;
    target.peer_id = subscriber_it->peer_id;
    target.session = session;
    target.audio_enabled = subscriber_it->audio_enabled;
    target.video_recovery_generation = subscriber_it->video_recovery_generation;
    target.source_epoch = subscriber_it->source_epoch;
    targets.push_back(std::move(target));
    ++subscriber_it;
  }

  if (subscribers.empty()) {
    state.subscribers_by_upstream_peer.erase(upstream_it);
  }

  return targets;
}

void update_relay_subscriber_runtime(
  vds::media_agent::relay_backend::Runtime& runtime,
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::string& reason,
  const std::string& last_error,
  unsigned long long frames_delta,
  std::uint64_t video_sequence_delta = 0,
  std::uint64_t audio_sequence_delta = 0,
  const MediaFrameTiming* last_video_timing = nullptr,
  bool video_recovery = false,
  const std::uint64_t* expected_video_generation = nullptr) {
  if (upstream_peer_id.empty() || peer_id.empty()) {
    return;
  }

  auto& state = relay_backend_state(runtime);
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return;
  }

  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id != peer_id) {
      continue;
    }

    const bool current_video_generation = !expected_video_generation ||
      subscriber.video_recovery_generation == *expected_video_generation;
    if (current_video_generation) {
      subscriber.reason = reason;
      subscriber.last_error = last_error;
    }
    subscriber.frames_sent += frames_delta;
    subscriber.video_sequence += video_sequence_delta;
    subscriber.audio_sequence += audio_sequence_delta;
    if (last_video_timing && current_video_generation) {
      subscriber.last_video_sequence = last_video_timing->sequence;
      subscriber.last_video_timestamp_us = last_video_timing->timestamp_us;
      subscriber.last_video_sequence_valid = last_video_timing->sequence_valid;
    }
    if (video_recovery && current_video_generation) {
      subscriber.pending_video_bootstrap = true;
      subscriber.bootstrap_snapshot_sent = false;
      subscriber.video_recovery_generation += 1;
    }
    return;
  }
}

void fanout_relay_video_units_now(
  vds::media_agent::relay_backend::Runtime& runtime,
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<RelayTimedVideoAccessUnit>& access_units,
  std::uint64_t upstream_generation) {
  if (upstream_peer_id.empty() || access_units.empty()) return;
  auto inspected_units = access_units;
  std::vector<RelayVideoBootstrapCache::Inspection> inspections;
  inspections.reserve(inspected_units.size());
  for (auto& unit : inspected_units) {
    inspections.push_back(RelayVideoBootstrapCache::inspect(codec, unit.bytes));
    unit.timing.keyframe = inspections.back().keyframe;
    unit.timing.config = !inspections.back().parameter_sets.empty();
  }
  std::vector<RelayTimedVideoAccessUnit> live_units;
  live_units.reserve(inspected_units.size());
  {
    auto& state = relay_backend_state(runtime);
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.video_generation_by_upstream_peer[upstream_peer_id] != upstream_generation) return;
    auto& cache = state.video_bootstrap_by_upstream_peer[upstream_peer_id];
    for (std::size_t index = 0; index < inspected_units.size(); ++index) {
      auto& access_unit = inspected_units[index];
      const auto observation = cache.observe(codec, access_unit, inspections[index]);
      if (observation.reset_subscribers) mark_relay_video_recovery_locked(state, upstream_peer_id, observation.sequence_reset);
      if (!observation.duplicate) live_units.push_back(std::move(access_unit));
    }
  }
  if (live_units.empty()) return;

  for (const auto& target : collect_relay_dispatch_targets(runtime, upstream_peer_id, &upstream_generation)) {
    const auto readiness = get_peer_transport_media_readiness(target.session);
    const bool use_encoded_data_channel = readiness.use_encoded_data_channel;
    std::string waiting_reason;
    if (!readiness.connected) waiting_reason = "relay-waiting-for-peer-connected";
    else if (!readiness.video_ready) waiting_reason = use_encoded_data_channel
      ? "relay-waiting-for-datachannel-encoded-ready" : "relay-waiting-for-video-track-open";
    if (!waiting_reason.empty()) {
      update_relay_subscriber_runtime(runtime, upstream_peer_id, target.peer_id, waiting_reason, "", 0, 0, 0, nullptr, true);
      continue;
    }

    std::vector<RelayTimedVideoAccessUnit> bootstrap_units;
    const bool using_bootstrap = collect_relay_video_bootstrap_access_units(
      runtime, upstream_peer_id, target.peer_id, &bootstrap_units, upstream_generation, target.video_recovery_generation);
    if (!using_bootstrap) {
      RelaySubscriberState subscriber;
      if (!runtime.query_subscriber_state(target.peer_id, &subscriber) || subscriber.pending_video_bootstrap) {
        update_relay_subscriber_runtime(runtime, upstream_peer_id, target.peer_id, "relay-waiting-for-random-access", "", 0);
        continue;
      }
    }
    const auto& units_to_send = using_bootstrap ? bootstrap_units : live_units;

    std::string send_error;
    unsigned long long sent_frames = 0;
    bool send_failed = false;
    MediaFrameTiming last_sent_timing;
    for (const auto& access_unit : units_to_send) {
      {
        auto& state = relay_backend_state(runtime);
        std::lock_guard<std::mutex> lock(state.mutex);
        const auto subscribers = state.subscribers_by_upstream_peer.find(upstream_peer_id);
        bool current_binding = false;
        if (subscribers != state.subscribers_by_upstream_peer.end()) {
          for (const auto& subscriber : subscribers->second) {
            if (subscriber.peer_id == target.peer_id &&
                subscriber.video_recovery_generation == target.video_recovery_generation) current_binding = true;
          }
        }
        if (state.video_generation_by_upstream_peer[upstream_peer_id] != upstream_generation || !current_binding) {
          send_failed = true;
          send_error = "relay-source-binding-changed";
          break;
        }
      }
      bool sent = false;
      if (use_encoded_data_channel) {
        PeerEncodedMediaDataChannelFrame frame;
        frame.stream_type = "video";
        frame.codec = codec;
        frame.payload_format = "annexb";
        frame.timestamp_us = access_unit.timing.timestamp_us;
        frame.sequence = access_unit.timing.sequence;
        frame.source_epoch = target.source_epoch;
        frame.keyframe = access_unit.timing.keyframe;
        frame.config = access_unit.timing.config;
        frame.payload = access_unit.bytes;
        sent = send_peer_transport_encoded_media_frame(target.session, frame, &send_error);
      } else {
        sent = send_peer_transport_video_frame(target.session, access_unit.bytes, codec, access_unit.timing.timestamp_us, &send_error);
      }
      if (!sent) { send_failed = true; break; }
      ++sent_frames;
      last_sent_timing = access_unit.timing;
    }
    if (!send_failed && using_bootstrap) {
      commit_relay_video_bootstrap_state(runtime, upstream_peer_id, target.peer_id, true, target.video_recovery_generation);
    }
    update_relay_subscriber_runtime(
      runtime, upstream_peer_id, target.peer_id,
      send_failed ? "relay-video-send-failed" : use_encoded_data_channel ? "relay-datachannel-video-forwarding" : "relay-video-forwarding",
      send_failed ? send_error : "", sent_frames, sent_frames, 0,
      sent_frames ? &last_sent_timing : nullptr, send_failed, &target.video_recovery_generation);
  }
}
bool ensure_relay_video_dispatch_worker_running(vds::media_agent::relay_backend::Runtime& runtime) {
  auto& state = relay_backend_state(runtime);
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.closed || state.video_worker_stop) return false;
  if (state.video_worker_started) {
    return true;
  }

  state.video_worker_stop = false;
  auto* worker_runtime = &runtime;
  state.video_worker = std::thread([worker_runtime]() {
    auto& worker_state = relay_backend_state(*worker_runtime);
    while (true) {
      QueuedRelayVideoDispatch task;
      {
        std::unique_lock<std::mutex> lock(worker_state.mutex);
        worker_state.video_cv.wait(lock, [&]() {
          return worker_state.video_worker_stop || !worker_state.pending_video_dispatches.empty();
        });
        if (worker_state.video_worker_stop && worker_state.pending_video_dispatches.empty()) {
          break;
        }
        task = std::move(worker_state.pending_video_dispatches.front());
        worker_state.pending_video_bytes -= task.payload_bytes;
        worker_state.pending_video_dispatches.pop_front();
      }

      fanout_relay_video_units_now(
        *worker_runtime,
        task.upstream_peer_id,
        task.codec,
        task.access_units,
        task.upstream_generation
      );
    }
  });
  state.video_worker_started = true;
  return true;
}

} // namespace

namespace vds::media_agent::relay_backend {

void Runtime::shutdown_dispatch() {
  auto& state = relay_backend_state(*this);
  std::lock_guard<std::mutex> shutdown_lock(state.shutdown_mutex);
  std::thread worker;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.video_worker_stop = true;
    state.pending_video_dispatches.clear();
    state.pending_video_bytes = 0;
    if (state.video_worker.joinable()) {
      worker = std::move(state.video_worker);
    }
  }
  state.video_cv.notify_all();
  if (worker.joinable()) {
    worker.join();
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.video_worker_started = false;
    state.video_worker_stop = state.closed;
  }
}

void Runtime::close() {
  auto& state = relay_backend_state(*this);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.closed = true;
  }
  shutdown_dispatch();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.subscribers_by_upstream_peer.clear();
  state.video_bootstrap_by_upstream_peer.clear();
  state.video_clock_by_upstream_peer.clear();
  state.audio_clock_by_upstream_peer.clear();
  state.video_generation_by_upstream_peer.clear();
  state.source_epoch_by_upstream_peer.clear();
}

void Runtime::register_subscriber(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::shared_ptr<PeerTransportSession>& session,
  bool audio_enabled) {
  if (upstream_peer_id.empty() || peer_id.empty() || !session) {
    return;
  }

  auto& state = relay_backend_state(*this);
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.closed) return;
  auto& subscribers = state.subscribers_by_upstream_peer[upstream_peer_id];
  for (auto& subscriber : subscribers) {
    if (subscriber.peer_id == peer_id) {
      subscriber.session = session;
      subscriber.audio_enabled = audio_enabled;
      subscriber.pending_video_bootstrap = true;
      subscriber.bootstrap_snapshot_sent = false;
      subscriber.last_video_sequence_valid = false;
      subscriber.video_recovery_generation += 1;
      subscriber.source_epoch = next_relay_source_epoch();
      subscriber.upstream_source_epoch = state.source_epoch_by_upstream_peer.count(upstream_peer_id)
        ? state.source_epoch_by_upstream_peer[upstream_peer_id] : "";
      subscriber.reason = "relay-subscriber-registered";
      subscriber.last_error.clear();
      return;
    }
  }

  RelaySubscriberState subscriber;
  subscriber.peer_id = peer_id;
  subscriber.session = session;
  subscriber.audio_enabled = audio_enabled;
  subscriber.pending_video_bootstrap = true;
  subscriber.bootstrap_snapshot_sent = false;
  subscriber.source_epoch = next_relay_source_epoch();
  subscriber.upstream_source_epoch = state.source_epoch_by_upstream_peer.count(upstream_peer_id)
    ? state.source_epoch_by_upstream_peer[upstream_peer_id] : "";
  subscriber.reason = "relay-subscriber-registered";
  subscribers.push_back(std::move(subscriber));
}

void Runtime::unregister_subscriber(const std::string& peer_id) {
  if (peer_id.empty()) {
    return;
  }

  auto& state = relay_backend_state(*this);
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto upstream_it = state.subscribers_by_upstream_peer.begin();
       upstream_it != state.subscribers_by_upstream_peer.end();) {
    auto& subscribers = upstream_it->second;
    subscribers.erase(
      std::remove_if(subscribers.begin(), subscribers.end(), [&](const RelaySubscriberState& subscriber) {
        const auto session = subscriber.session.lock();
        return subscriber.peer_id == peer_id || !session;
      }),
      subscribers.end()
    );
    if (subscribers.empty()) {
      upstream_it = state.subscribers_by_upstream_peer.erase(upstream_it);
      continue;
    }
    ++upstream_it;
  }
}

void Runtime::clear_upstream_bootstrap_state(const std::string& upstream_peer_id) {
  if (upstream_peer_id.empty()) {
    return;
  }

  auto& state = relay_backend_state(*this);
  std::lock_guard<std::mutex> lock(state.mutex);
  state.video_bootstrap_by_upstream_peer.erase(upstream_peer_id);
  state.video_generation_by_upstream_peer[upstream_peer_id] += 1;
  state.video_clock_by_upstream_peer.erase(upstream_peer_id);
  state.audio_clock_by_upstream_peer.erase(upstream_peer_id);
  state.source_epoch_by_upstream_peer.erase(upstream_peer_id);
  discard_pending_upstream_video_locked(state, upstream_peer_id);
  mark_relay_video_recovery_locked(state, upstream_peer_id, true);
  const auto subscribers = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (subscribers != state.subscribers_by_upstream_peer.end()) {
    for (auto& subscriber : subscribers->second) {
      subscriber.source_epoch = next_relay_source_epoch();
      subscriber.upstream_source_epoch.clear();
    }
  }
}

bool Runtime::query_subscriber_state(
  const std::string& peer_id,
  RelaySubscriberState* out_state) {
  if (peer_id.empty()) {
    return false;
  }

  auto& state = relay_backend_state(*this);
  std::lock_guard<std::mutex> lock(state.mutex);
  for (const auto& entry : state.subscribers_by_upstream_peer) {
    for (const auto& subscriber : entry.second) {
      if (subscriber.peer_id == peer_id) {
        if (out_state) {
          *out_state = subscriber;
        }
        return true;
      }
    }
  }
  return false;
}

std::string Runtime::subscriber_runtime_json(const std::string& peer_id) {
  RelaySubscriberState relay_state;
  if (!query_subscriber_state(peer_id, &relay_state)) {
    return "null";
  }

  std::ostringstream payload;
  payload
    << "{\"pendingVideoBootstrap\":" << (relay_state.pending_video_bootstrap ? "true" : "false")
    << ",\"bootstrapSnapshotSent\":" << (relay_state.bootstrap_snapshot_sent ? "true" : "false")
    << ",\"framesSent\":" << relay_state.frames_sent
    << ",\"lastVideoSequence\":" << relay_state.last_video_sequence
    << ",\"lastVideoTimestampUs\":" << relay_state.last_video_timestamp_us
    << ",\"lastVideoSequenceValid\":" << (relay_state.last_video_sequence_valid ? "true" : "false")
    << ",\"sourceEpoch\":\"" << vds::media_agent::json_escape(relay_state.source_epoch) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(relay_state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(relay_state.last_error) << "\""
    << "}";
  return payload.str();
}

void Runtime::fanout_video_units(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp,
  const MediaFrameTiming& timing) {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  if (!ensure_relay_video_dispatch_worker_running(*this)) return;

  auto& state = relay_backend_state(*this);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.closed || state.video_worker_stop || !state.video_worker_started) return;
    prepare_relay_source_origin_locked(state, upstream_peer_id, timing.source_epoch);
    QueuedRelayVideoDispatch task;
    task.upstream_peer_id = upstream_peer_id;
    task.codec = vds::media_agent::normalize_video_codec(codec);
    task.upstream_generation = state.video_generation_by_upstream_peer[upstream_peer_id];
    auto& clock = state.video_clock_by_upstream_peer[upstream_peer_id];
    MediaFrameTiming resolved = timing;
    if (!resolved.timestamp_valid) {
      resolved.timestamp_us = clock.timestamp_us(rtp_timestamp, kRelayVideoRtpClockRate);
      resolved.timestamp_valid = true;
      if (resolved.source_id.empty()) resolved.source_id = upstream_peer_id + ":legacy-video";
    } else if (resolved.source_id.empty()) {
      resolved.source_id = upstream_peer_id;
    }
    if (timing.sequence_valid) {
      // One source packet owns one sequence. Parsing its Annex-B payload into
      // several units must not manufacture new sequence numbers or duplicates.
      RelayTimedVideoAccessUnit unit;
      unit.timing = resolved;
      for (const auto& bytes : access_units) unit.bytes.insert(unit.bytes.end(), bytes.begin(), bytes.end());
      task.access_units.push_back(std::move(unit));
    } else {
      for (const auto& bytes : access_units) {
        RelayTimedVideoAccessUnit unit;
        unit.bytes = bytes;
        unit.timing = resolved;
        unit.timing.sequence = clock.next_sequence++;
        unit.timing.sequence_valid = true;
        task.access_units.push_back(std::move(unit));
      }
    }
    for (const auto& unit : task.access_units) task.payload_bytes += unit.bytes.size();
    state.pending_video_bytes += task.payload_bytes;
    state.pending_video_dispatches.push_back(std::move(task));
    while (state.pending_video_dispatches.size() > kMaxQueuedRelayVideoDispatches ||
           state.pending_video_bytes > kMaxQueuedRelayVideoBytes) {
      const auto dropped_upstream = state.pending_video_dispatches.front().upstream_peer_id;
      state.video_bootstrap_by_upstream_peer[dropped_upstream].invalidate_gop();
      mark_relay_video_recovery_locked(state, dropped_upstream);
      state.pending_video_bytes -= state.pending_video_dispatches.front().payload_bytes;
      state.pending_video_dispatches.pop_front();
    }
  }
  state.video_cv.notify_one();
}

void Runtime::fanout_audio_frame(
  const std::string& upstream_peer_id,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp,
  const MediaFrameTiming& timing) {
  if (upstream_peer_id.empty() || frame.empty()) {
    return;
  }

  std::string lowered_codec = codec;
  std::transform(lowered_codec.begin(), lowered_codec.end(), lowered_codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  const std::uint64_t clock_rate = lowered_codec == "pcmu" ? 8000ull : kRelayTransportAudioSampleRate;
  MediaFrameTiming resolved = timing;
  std::uint64_t upstream_generation = 0;
  {
    auto& state = relay_backend_state(*this);
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.closed) return;
    prepare_relay_source_origin_locked(state, upstream_peer_id, timing.source_epoch);
    upstream_generation = state.video_generation_by_upstream_peer[upstream_peer_id];
    auto& clock = state.audio_clock_by_upstream_peer[upstream_peer_id];
    if (!resolved.timestamp_valid) {
      resolved.timestamp_us = clock.timestamp_us(rtp_timestamp, clock_rate);
      resolved.timestamp_valid = true;
      if (resolved.source_id.empty()) resolved.source_id = upstream_peer_id + ":legacy-audio";
    } else if (resolved.source_id.empty()) {
      resolved.source_id = upstream_peer_id;
    }
    if (!resolved.sequence_valid) {
      resolved.sequence = clock.next_sequence++;
      resolved.sequence_valid = true;
    }
  }
  const std::uint64_t timestamp_us = resolved.timestamp_us;

  const auto targets = collect_relay_dispatch_targets(*this, upstream_peer_id, &upstream_generation);
  if (targets.empty()) {
    return;
  }

  for (const auto& target : targets) {
    if (!target.audio_enabled) {
      continue;
    }

    const auto readiness = get_peer_transport_media_readiness(target.session);
    if (!readiness.connected) {
      update_relay_subscriber_runtime(
        *this,
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-peer-connected",
        "",
        0
      );
      continue;
    }
    const bool use_encoded_data_channel = readiness.use_encoded_data_channel;
    if (use_encoded_data_channel && !readiness.audio_ready) {
      update_relay_subscriber_runtime(
        *this,
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-datachannel-encoded-ready",
        "",
        0
      );
      continue;
    }
    if (!use_encoded_data_channel && !readiness.audio_ready) {
      update_relay_subscriber_runtime(
        *this,
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-audio-track-open",
        "",
        0
      );
      continue;
    }

    std::string send_error;
    bool sent = false;
    if (use_encoded_data_channel) {
      PeerEncodedMediaDataChannelFrame encoded_frame;
      encoded_frame.stream_type = "audio";
      encoded_frame.codec = lowered_codec;
      encoded_frame.payload_format = lowered_codec == "aac" ? "aac-adts" : "opus-raw";
      encoded_frame.timestamp_us = timestamp_us;
      encoded_frame.sequence = resolved.sequence;
      encoded_frame.source_epoch = target.source_epoch;
      encoded_frame.keyframe = resolved.keyframe;
      encoded_frame.config = resolved.config;
      encoded_frame.payload = frame;
      sent = send_peer_transport_encoded_media_frame(target.session, encoded_frame, &send_error);
    } else {
      sent = send_peer_transport_audio_frame(target.session, frame, timestamp_us, &send_error);
    }
    if (!sent) {
      update_relay_subscriber_runtime(
        *this,
        upstream_peer_id,
        target.peer_id,
        use_encoded_data_channel ? "relay-datachannel-audio-send-failed" : "relay-audio-send-failed",
        send_error,
        0
      );
      continue;
    }

    update_relay_subscriber_runtime(
        *this,
      upstream_peer_id,
      target.peer_id,
      use_encoded_data_channel ? "relay-datachannel-audio-forwarding" : "relay-audio-forwarding",
      "",
      0,
      0,
      1
    );
  }
}

} // namespace vds::media_agent::relay_backend
