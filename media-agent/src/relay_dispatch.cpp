#include "relay_dispatch.h"

#include <algorithm>
#include <cctype>
#include <mutex>
#include <sstream>
#include <thread>

#include "json_protocol.h"
#include "time_utils.h"
#include "video_access_unit.h"

namespace {

constexpr unsigned int kRelayTransportAudioSampleRate = 48000;
constexpr std::uint64_t kRelayVideoRtpClockRate = 90000;
constexpr std::size_t kMaxQueuedRelayVideoDispatches = 512;
constexpr std::size_t kMaxRelayBootstrapGopAccessUnits = 96;

RelayDispatchState& relay_dispatch_state() {
  static RelayDispatchState state;
  return state;
}

void cache_relay_video_bootstrap_access_unit(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit,
  std::uint64_t timestamp_us) {
  if (upstream_peer_id.empty() || access_unit.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto& bootstrap = state.video_bootstrap_by_upstream_peer[upstream_peer_id];
  const std::string normalized_codec = vds::media_agent::normalize_video_codec(codec);
  if (bootstrap.codec_path != normalized_codec) {
    bootstrap.codec_path = normalized_codec;
    bootstrap.decoder_config_au.clear();
    bootstrap.random_access_au.clear();
    bootstrap.gop_access_units.clear();

    auto subscribers_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
    if (subscribers_it != state.subscribers_by_upstream_peer.end()) {
      for (auto& subscriber : subscribers_it->second) {
        subscriber.pending_video_bootstrap = true;
        subscriber.bootstrap_snapshot_sent = false;
      }
    }
  }

  if (vds::media_agent::video_access_unit_has_decoder_config_nal(bootstrap.codec_path, access_unit)) {
    bootstrap.decoder_config_au = access_unit;
  }
  if (vds::media_agent::video_access_unit_has_random_access_nal(bootstrap.codec_path, access_unit)) {
    bootstrap.random_access_au = access_unit;
    bootstrap.gop_access_units.clear();
  }
  if (!bootstrap.random_access_au.empty()) {
    RelayUpstreamVideoBootstrapState::CachedAccessUnit cached;
    cached.bytes = access_unit;
    cached.timestamp_us = timestamp_us;
    bootstrap.gop_access_units.push_back(std::move(cached));
    while (bootstrap.gop_access_units.size() > kMaxRelayBootstrapGopAccessUnits) {
      bootstrap.gop_access_units.erase(bootstrap.gop_access_units.begin());
    }
  }
}

bool collect_relay_video_bootstrap_access_units(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::vector<std::vector<std::uint8_t>>& current_access_units,
  std::uint64_t current_timestamp_us,
  std::vector<RelayUpstreamVideoBootstrapState::CachedAccessUnit>* out_access_units) {
  if (!out_access_units || upstream_peer_id.empty() || peer_id.empty()) {
    return false;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return false;
  }

  RelaySubscriberState* matched_subscriber = nullptr;
  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id == peer_id) {
      matched_subscriber = &subscriber;
      break;
    }
  }
  if (!matched_subscriber || !matched_subscriber->pending_video_bootstrap) {
    return false;
  }

  auto bootstrap_it = state.video_bootstrap_by_upstream_peer.find(upstream_peer_id);
  if (bootstrap_it == state.video_bootstrap_by_upstream_peer.end()) {
    return false;
  }

  if (!vds::media_agent::video_bootstrap_is_complete(
        bootstrap_it->second.codec_path,
        bootstrap_it->second.decoder_config_au,
        bootstrap_it->second.random_access_au)) {
    return false;
  }

  if (!matched_subscriber->bootstrap_snapshot_sent) {
    if (!bootstrap_it->second.gop_access_units.empty()) {
      const std::uint64_t bootstrap_timestamp_us =
        bootstrap_it->second.gop_access_units.front().timestamp_us > 0
          ? bootstrap_it->second.gop_access_units.front().timestamp_us
          : current_timestamp_us;
      if (!bootstrap_it->second.decoder_config_au.empty()) {
        RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
        config_unit.bytes = bootstrap_it->second.decoder_config_au;
        config_unit.timestamp_us = bootstrap_timestamp_us;
        out_access_units->push_back(std::move(config_unit));
      }
      for (const auto& cached_unit : bootstrap_it->second.gop_access_units) {
        if (!out_access_units->empty() && out_access_units->back().bytes == cached_unit.bytes) {
          continue;
        }
        out_access_units->push_back(cached_unit);
      }
      if (!out_access_units->empty()) {
        matched_subscriber->bootstrap_snapshot_sent = true;
        matched_subscriber->pending_video_bootstrap = false;
        return true;
      }
    }

    if (!bootstrap_it->second.decoder_config_au.empty()) {
      RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
      config_unit.bytes = bootstrap_it->second.decoder_config_au;
      config_unit.timestamp_us = current_timestamp_us;
      out_access_units->push_back(std::move(config_unit));
    }
    if (!bootstrap_it->second.random_access_au.empty() &&
        (out_access_units->empty() || out_access_units->back().bytes != bootstrap_it->second.random_access_au)) {
      RelayUpstreamVideoBootstrapState::CachedAccessUnit random_access_unit;
      random_access_unit.bytes = bootstrap_it->second.random_access_au;
      random_access_unit.timestamp_us = current_timestamp_us;
      out_access_units->push_back(std::move(random_access_unit));
    }
    if (!out_access_units->empty()) {
      matched_subscriber->bootstrap_snapshot_sent = true;
      return true;
    }
  }

  auto random_access_it = std::find_if(
    current_access_units.begin(),
    current_access_units.end(),
    [&](const std::vector<std::uint8_t>& access_unit) {
      return vds::media_agent::video_access_unit_has_random_access_nal(bootstrap_it->second.codec_path, access_unit);
    }
  );
  if (random_access_it == current_access_units.end()) {
    return false;
  }

  if (!bootstrap_it->second.decoder_config_au.empty()) {
    RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
    config_unit.bytes = bootstrap_it->second.decoder_config_au;
    config_unit.timestamp_us = current_timestamp_us;
    out_access_units->push_back(std::move(config_unit));
  }
  for (auto it = random_access_it; it != current_access_units.end(); ++it) {
    if (!out_access_units->empty() && out_access_units->back().bytes == *it) {
      continue;
    }
    RelayUpstreamVideoBootstrapState::CachedAccessUnit unit;
    unit.bytes = *it;
    unit.timestamp_us = current_timestamp_us;
    out_access_units->push_back(std::move(unit));
  }
  if (out_access_units->empty()) {
    return false;
  }

  matched_subscriber->bootstrap_snapshot_sent = true;
  matched_subscriber->pending_video_bootstrap = false;
  return true;
}

std::vector<RelayDispatchTarget> collect_relay_dispatch_targets(const std::string& upstream_peer_id) {
  std::vector<RelayDispatchTarget> targets;
  if (upstream_peer_id.empty()) {
    return targets;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
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
    target.upstream_peer_id = upstream_peer_id;
    target.session = session;
    target.audio_enabled = subscriber_it->audio_enabled;
    targets.push_back(std::move(target));
    ++subscriber_it;
  }

  if (subscribers.empty()) {
    state.subscribers_by_upstream_peer.erase(upstream_it);
  }

  return targets;
}

void update_relay_subscriber_runtime(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::string& reason,
  const std::string& last_error,
  unsigned long long frames_delta,
  unsigned long long bytes_delta) {
  if (upstream_peer_id.empty() || peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return;
  }

  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id != peer_id) {
      continue;
    }

    subscriber.reason = reason;
    subscriber.last_error = last_error;
    subscriber.frames_sent += frames_delta;
    subscriber.bytes_sent += bytes_delta;
    subscriber.updated_at_unix_ms = vds::media_agent::current_time_millis();
    return;
  }
}

void fanout_relay_video_units_now(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  const std::uint64_t timestamp_us = vds::media_agent::rtp_timestamp_to_us(rtp_timestamp, kRelayVideoRtpClockRate);
  for (const auto& access_unit : access_units) {
    cache_relay_video_bootstrap_access_unit(upstream_peer_id, codec, access_unit, timestamp_us);
  }

  const auto targets = collect_relay_dispatch_targets(upstream_peer_id);
  if (targets.empty()) {
    return;
  }

  for (const auto& target : targets) {
    const PeerTransportSnapshot snapshot = get_peer_transport_snapshot(target.session);
    if (!snapshot.remote_description_set || snapshot.connection_state != "connected") {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-peer-connected",
        "",
        0,
        0
      );
      continue;
    }
    if (!snapshot.video_track_open) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-video-track-open",
        "",
        0,
        0
      );
      continue;
    }

    bool send_failed = false;
    std::string send_error;
    unsigned long long sent_frames = 0;
    unsigned long long sent_bytes = 0;
    std::vector<RelayUpstreamVideoBootstrapState::CachedAccessUnit> units_to_send;
    const bool using_bootstrap =
      collect_relay_video_bootstrap_access_units(
        upstream_peer_id,
        target.peer_id,
        access_units,
        timestamp_us,
        &units_to_send
      );
    if (!using_bootstrap) {
      RelaySubscriberState relay_state;
      if (query_relay_subscriber_state(target.peer_id, &relay_state) && relay_state.pending_video_bootstrap) {
        update_relay_subscriber_runtime(
          upstream_peer_id,
          target.peer_id,
          "relay-waiting-for-random-access",
          "",
          0,
          0
        );
        continue;
      }
      for (const auto& access_unit : access_units) {
        RelayUpstreamVideoBootstrapState::CachedAccessUnit live_unit;
        live_unit.bytes = access_unit;
        live_unit.timestamp_us = timestamp_us;
        units_to_send.push_back(std::move(live_unit));
      }
    }
    for (const auto& access_unit : units_to_send) {
      const std::uint64_t unit_timestamp_us = access_unit.timestamp_us > 0 ? access_unit.timestamp_us : timestamp_us;
      if (!send_peer_transport_video_frame(target.session, access_unit.bytes, codec, unit_timestamp_us, &send_error)) {
        send_failed = true;
        break;
      }
      sent_frames += 1;
      sent_bytes += static_cast<unsigned long long>(access_unit.bytes.size());
    }

    if (send_failed) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-video-send-failed",
        send_error,
        sent_frames,
        sent_bytes
      );
    } else {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-video-forwarding",
        "",
        sent_frames,
        sent_bytes
      );
    }
  }
}

void ensure_relay_video_dispatch_worker_running() {
  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.video_worker_started) {
    return;
  }

  state.video_worker_started = true;
  std::thread([]() {
    auto& worker_state = relay_dispatch_state();
    while (true) {
      QueuedRelayVideoDispatch task;
      {
        std::unique_lock<std::mutex> lock(worker_state.mutex);
        worker_state.video_cv.wait(lock, [&]() {
          return !worker_state.pending_video_dispatches.empty();
        });
        task = std::move(worker_state.pending_video_dispatches.front());
        worker_state.pending_video_dispatches.pop_front();
      }

      fanout_relay_video_units_now(
        task.upstream_peer_id,
        task.codec,
        task.access_units,
        task.rtp_timestamp
      );
    }
  }).detach();
}

} // namespace

void register_relay_subscriber(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::shared_ptr<PeerTransportSession>& session,
  bool audio_enabled) {
  if (upstream_peer_id.empty() || peer_id.empty() || !session) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto& subscribers = state.subscribers_by_upstream_peer[upstream_peer_id];
  for (auto& subscriber : subscribers) {
    if (subscriber.peer_id == peer_id) {
      subscriber.session = session;
      subscriber.audio_enabled = audio_enabled;
      subscriber.pending_video_bootstrap = true;
      subscriber.bootstrap_snapshot_sent = false;
      subscriber.last_video_timestamp_us = 0;
      subscriber.next_video_send_deadline_steady_us = -1;
      subscriber.reason = "relay-subscriber-registered";
      subscriber.last_error.clear();
      subscriber.updated_at_unix_ms = vds::media_agent::current_time_millis();
      return;
    }
  }

  RelaySubscriberState subscriber;
  subscriber.peer_id = peer_id;
  subscriber.upstream_peer_id = upstream_peer_id;
  subscriber.session = session;
  subscriber.audio_enabled = audio_enabled;
  subscriber.pending_video_bootstrap = true;
  subscriber.bootstrap_snapshot_sent = false;
  subscriber.last_video_timestamp_us = 0;
  subscriber.next_video_send_deadline_steady_us = -1;
  subscriber.reason = "relay-subscriber-registered";
  subscriber.updated_at_unix_ms = vds::media_agent::current_time_millis();
  subscribers.push_back(std::move(subscriber));
}

void unregister_relay_subscriber(const std::string& peer_id) {
  if (peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
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

void clear_relay_upstream_bootstrap_state(const std::string& upstream_peer_id) {
  if (upstream_peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.video_bootstrap_by_upstream_peer.erase(upstream_peer_id);
}

bool query_relay_subscriber_state(
  const std::string& peer_id,
  RelaySubscriberState* out_state) {
  if (peer_id.empty()) {
    return false;
  }

  auto& state = relay_dispatch_state();
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

std::string relay_subscriber_runtime_json(const std::string& peer_id) {
  RelaySubscriberState relay_state;
  if (!query_relay_subscriber_state(peer_id, &relay_state)) {
    return "null";
  }

  std::ostringstream payload;
  payload
    << "{\"upstreamPeerId\":\"" << vds::media_agent::json_escape(relay_state.upstream_peer_id) << "\""
    << ",\"audioEnabled\":" << (relay_state.audio_enabled ? "true" : "false")
    << ",\"pendingVideoBootstrap\":" << (relay_state.pending_video_bootstrap ? "true" : "false")
    << ",\"bootstrapSnapshotSent\":" << (relay_state.bootstrap_snapshot_sent ? "true" : "false")
    << ",\"framesSent\":" << relay_state.frames_sent
    << ",\"bytesSent\":" << relay_state.bytes_sent
    << ",\"lastVideoTimestampUs\":" << relay_state.last_video_timestamp_us
    << ",\"reason\":\"" << vds::media_agent::json_escape(relay_state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(relay_state.last_error) << "\""
    << ",\"updatedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, relay_state.updated_at_unix_ms);
  payload << "}";
  return payload.str();
}

void fanout_relay_video_units(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  ensure_relay_video_dispatch_worker_running();

  auto& state = relay_dispatch_state();
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    QueuedRelayVideoDispatch task;
    task.upstream_peer_id = upstream_peer_id;
    task.codec = codec;
    task.access_units = access_units;
    task.rtp_timestamp = rtp_timestamp;
    state.pending_video_dispatches.push_back(std::move(task));
    while (state.pending_video_dispatches.size() > kMaxQueuedRelayVideoDispatches) {
      state.pending_video_dispatches.pop_front();
    }
  }
  state.video_cv.notify_one();
}

void fanout_relay_audio_frame(
  const std::string& upstream_peer_id,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || frame.empty()) {
    return;
  }

  std::string lowered_codec = codec;
  std::transform(lowered_codec.begin(), lowered_codec.end(), lowered_codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  const std::uint64_t clock_rate = lowered_codec == "pcmu" ? 8000ull : kRelayTransportAudioSampleRate;
  const std::uint64_t timestamp_us = vds::media_agent::rtp_timestamp_to_us(rtp_timestamp, clock_rate);

  const auto targets = collect_relay_dispatch_targets(upstream_peer_id);
  if (targets.empty()) {
    return;
  }

  for (const auto& target : targets) {
    if (!target.audio_enabled) {
      continue;
    }

    const PeerTransportSnapshot snapshot = get_peer_transport_snapshot(target.session);
    if (!snapshot.remote_description_set || snapshot.connection_state != "connected") {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-peer-connected",
        "",
        0,
        0
      );
      continue;
    }
    if (!snapshot.audio_track_open) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-audio-track-open",
        "",
        0,
        0
      );
      continue;
    }

    std::string send_error;
    if (!send_peer_transport_audio_frame(target.session, frame, timestamp_us, &send_error)) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-audio-send-failed",
        send_error,
        0,
        0
      );
      continue;
    }

    update_relay_subscriber_runtime(
      upstream_peer_id,
      target.peer_id,
      "relay-audio-forwarding",
      "",
      0,
      0
    );
  }
}
