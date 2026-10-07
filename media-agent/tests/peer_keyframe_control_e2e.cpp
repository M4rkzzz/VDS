// Exercise the production keyframe control path over real ICE/DTLS/SCTP.
// The only configured STUN endpoint is localhost; no public server is used.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifdef _WIN32
#include <winsock2.h>
#endif

#include "peer_transport.h"
#include "peer_video_sender_state.h"
#include "json_protocol.h"

#include <rtc/rtc.hpp>

#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

using namespace std::chrono_literals;

namespace {

unsigned checks = 0;

void require(bool value, const std::string& message) {
  ++checks;
  if (!value) throw std::runtime_error(message);
}

struct HostRefreshObservations {
  std::atomic<unsigned> wakes{0};
  std::atomic<unsigned> snapshots_checked{0};
  std::atomic<unsigned> invalid_snapshots{0};
  std::atomic<unsigned> control_publications{0};
  std::atomic<std::uint64_t> control_publication_sequence{0};
  std::weak_ptr<PeerTransportSession> session;
  std::mutex session_mutex;

  void bind(const std::shared_ptr<PeerTransportSession>& value) {
    std::lock_guard<std::mutex> lock(session_mutex);
    session = value;
  }

  void observe(const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
    if (logical_state == snapshot.encoded_media_data_channel_state) {
      control_publication_sequence.store(snapshot.keyframe_requests_received, std::memory_order_release);
      control_publications.fetch_add(1, std::memory_order_release);
    }
    if (logical_state != "host-video-refresh-requested") return;
    std::shared_ptr<PeerTransportSession> current_session;
    {
      std::lock_guard<std::mutex> lock(session_mutex);
      current_session = session.lock();
    }
    // Reading the same transport from its wake callback also proves that this
    // notification is dispatched outside the transport mutex.
    if (!current_session) {
      ++invalid_snapshots;
    } else {
      const auto current = get_peer_transport_snapshot(current_session);
      ++snapshots_checked;
      if (snapshot.keyframe_request_action != "host-encoder-refresh-requested" ||
          current.keyframe_request_action != snapshot.keyframe_request_action ||
          snapshot.keyframe_requests_received == 0 ||
          current.keyframe_requests_received < snapshot.keyframe_requests_received)
        ++invalid_snapshots;
    }
    wakes.fetch_add(1, std::memory_order_release);
  }
};

struct Signal {
  unsigned destination = 0;
  bool description = false;
  std::string first;
  std::string second;
};

// Avoid synchronous signaling reentry from libdatachannel's callbacks. Candidate
// delivery also waits for its destination's remote description.
class SignalBridge {
 public:
  std::function<void(const Signal&)> destinations[2];

  void append(unsigned destination, bool description,
              const std::string& first, const std::string& second) {
    std::lock_guard<std::mutex> lock(mutex_);
    pending_.push_back({destination, description, first, second});
  }

  void pump() {
    std::deque<Signal> work;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      work.swap(pending_);
    }
    std::deque<Signal> deferred;
    for (const auto& signal : work) {
      if (!signal.description && !description_delivered_[signal.destination]) {
        deferred.push_back(signal);
        continue;
      }
      destinations[signal.destination](signal);
      if (signal.description) description_delivered_[signal.destination] = true;
    }
    if (!deferred.empty()) {
      std::lock_guard<std::mutex> lock(mutex_);
      pending_.insert(pending_.begin(), deferred.begin(), deferred.end());
    }
  }

 private:
  bool description_delivered_[2] = {false, false};
  std::deque<Signal> pending_;
  std::mutex mutex_;
};

PeerTransportCallbacks signaling_callbacks(const std::shared_ptr<SignalBridge>& bridge,
                                          unsigned source) {
  PeerTransportCallbacks callbacks;
  callbacks.on_local_description = [bridge, source](const std::string& type,
      const std::string& sdp, const std::string&) {
    bridge->append(1 - source, true, type, sdp);
  };
  callbacks.on_local_candidate = [bridge, source](const std::string& candidate,
      const std::string& mid, const std::string&) {
    bridge->append(1 - source, false, candidate, mid);
  };
  return callbacks;
}

void bind_production_destination(const std::shared_ptr<SignalBridge>& bridge,
                                 unsigned index,
                                 const std::shared_ptr<PeerTransportSession>& session) {
  bridge->destinations[index] = [weak = std::weak_ptr<PeerTransportSession>(session)](
      const Signal& signal) {
    const auto target = weak.lock();
    std::string error;
    const bool ok = signal.description
      ? set_peer_transport_remote_description(target, signal.first, signal.second, &error)
      : add_peer_transport_remote_candidate(target, signal.first, signal.second, &error);
    if (!ok) throw std::runtime_error("signaling failed: " + error);
  };
}

template <class Predicate, class Pump>
void wait_until(Predicate predicate, Pump pump, const std::string& message,
                std::chrono::milliseconds timeout = 10s) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    pump();
    if (predicate()) return;
    std::this_thread::sleep_for(5ms);
  }
  require(false, message);
}

struct ProductionPair {
  std::shared_ptr<SignalBridge> bridge = std::make_shared<SignalBridge>();
  std::shared_ptr<PeerTransportSession> publisher;
  std::shared_ptr<PeerTransportSession> viewer;

  ProductionPair(const std::string& name,
                 std::function<std::string(const std::string&)> handler = {},
                 std::function<void(const PeerTransportSnapshot&, const std::string&)> on_state_change = {}) {
    auto publisher_callbacks = signaling_callbacks(bridge, 0);
    publisher_callbacks.on_keyframe_requested = std::move(handler);
    publisher_callbacks.on_state_change = std::move(on_state_change);
    std::string error;
    // An explicit localhost pool prevents the production default STUN pool.
    const std::vector<std::string> local_stun = {"stun:127.0.0.1:9"};
    publisher = create_peer_transport_session(name + "-publisher", true,
      publisher_callbacks, true, local_stun.front(), local_stun, &error);
    require(publisher != nullptr, "publisher creation failed: " + error);
    viewer = create_peer_transport_session(name + "-viewer", false,
      signaling_callbacks(bridge, 1), true, local_stun.front(), local_stun, &error);
    require(viewer != nullptr, "viewer creation failed: " + error);
    bind_production_destination(bridge, 0, publisher);
    bind_production_destination(bridge, 1, viewer);
    set_peer_transport_media_manifest(publisher, name, 1);
    set_peer_transport_media_manifest(viewer, name, 1);
    require(ensure_peer_transport_local_description(publisher, &error),
            "offer creation failed: " + error);
    wait_until([&] {
      const auto left = get_peer_transport_snapshot(publisher);
      const auto right = get_peer_transport_snapshot(viewer);
      return left.connection_state == "connected" && right.connection_state == "connected" &&
        left.encoded_media_data_channel_ready && right.encoded_media_data_channel_ready;
    }, [&] { bridge->pump(); }, "production DC handshake timed out");
    require(!get_peer_transport_snapshot(viewer).video_receiver_configured,
            "test must exercise DC with no RTP video track");
    require(!get_peer_transport_snapshot(publisher).video_track_configured,
            "test must not configure a host RTP video track");
  }

  ~ProductionPair() {
    close_peer_transport_session(viewer);
    close_peer_transport_session(publisher);
  }

  void request(const std::string& reason) {
    std::string error;
    require(request_peer_transport_keyframe(viewer, reason, &error),
            "DC keyframe request failed: " + error);
  }

  template <class Predicate>
  void wait(Predicate predicate, const std::string& message) {
    wait_until(predicate, [&] { bridge->pump(); }, message);
  }
};

std::shared_ptr<PeerVideoSenderRuntime> host_runtime() {
  auto runtime = std::make_shared<PeerVideoSenderRuntime>();
  runtime->running = true;
  runtime->pending_video_bootstrap = false;
  runtime->source_clock = vds::media_agent::host_media_clock_snapshot();
  return runtime;
}

std::string control_message(const std::string& type, const std::string& session,
                            int manifest_version = 1, int protocol_version = 1,
                            const std::string& stream = "video") {
  return "{\"protocol\":\"vds-media-encoded-v1\",\"type\":\"" + type +
    "\",\"protocolVersion\":" + std::to_string(protocol_version) +
    ",\"mediaSessionId\":\"" + vds::media_agent::json_escape(session) +
    "\",\"manifestVersion\":" + std::to_string(manifest_version) +
    ",\"streamType\":\"" + stream + "\",\"reason\":\"raw-fixture-recovery\"}";
}

// A raw RTC publisher can bypass the public request function's send throttle,
// proving receiver validation/throttling on actual SCTP messages.
struct RawControlPair {
  std::shared_ptr<SignalBridge> bridge = std::make_shared<SignalBridge>();
  std::shared_ptr<rtc::PeerConnection> raw;
  std::shared_ptr<rtc::DataChannel> channel;
  std::shared_ptr<PeerTransportSession> receiver;
  std::shared_ptr<std::atomic<unsigned>> errors = std::make_shared<std::atomic<unsigned>>(0);
  std::shared_ptr<std::atomic<unsigned>> events = std::make_shared<std::atomic<unsigned>>(0);

  explicit RawControlPair(std::function<std::string(const std::string&)> handler,
      std::function<void(const PeerTransportSnapshot&, const std::string&)> on_state_change = {}) {
    rtc::Configuration config;
    config.disableAutoNegotiation = true;
    raw = std::make_shared<rtc::PeerConnection>(config);
    raw->onLocalDescription([signals = bridge](rtc::Description description) {
      signals->append(1, true, description.typeString(), std::string(description));
    });
    raw->onLocalCandidate([signals = bridge](rtc::Candidate candidate) {
      signals->append(1, false, std::string(candidate), candidate.mid());
    });
    rtc::DataChannelInit init;
    init.reliability.unordered = true;
    channel = raw->createDataChannel("vds-media-encoded-v1", init);
    const std::weak_ptr<rtc::DataChannel> weak_channel = channel;
    channel->onOpen([weak_channel] {
      if (const auto open = weak_channel.lock())
        open->send(control_message("hello", "raw-session"));
    });
    channel->onMessage([weak_channel, count = errors](rtc::message_variant message) {
      if (!std::holds_alternative<std::string>(message)) return;
      const auto& text = std::get<std::string>(message);
      const auto type = vds::media_agent::extract_string_value(text, "type");
      if (type == "hello") {
        if (const auto open = weak_channel.lock())
          open->send(control_message("hello-ack", "raw-session"));
      } else if (type == "error") {
        ++*count;
      }
    });

    auto callbacks = signaling_callbacks(bridge, 1);
    callbacks.on_keyframe_requested = std::move(handler);
    callbacks.on_state_change = [count = events, observer = std::move(on_state_change)](
        const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
      ++*count;
      if (observer) observer(snapshot, logical_state);
    };
    std::string error;
    const std::vector<std::string> local_stun = {"stun:127.0.0.1:9"};
    receiver = create_peer_transport_session("raw-production-receiver", false,
      callbacks, true, local_stun.front(), local_stun, &error);
    require(receiver != nullptr, "raw fixture receiver failed: " + error);
    set_peer_transport_media_manifest(receiver, "raw-session", 1);
    bind_production_destination(bridge, 1, receiver);
    bridge->destinations[0] = [weak = std::weak_ptr<rtc::PeerConnection>(raw)](const Signal& signal) {
      const auto target = weak.lock();
      if (!target) throw std::runtime_error("raw fixture closed during signaling");
      if (signal.description) target->setRemoteDescription(rtc::Description(signal.second, signal.first));
      else target->addRemoteCandidate(rtc::Candidate(signal.first, signal.second));
    };
    raw->setLocalDescription();
    wait_until([&] {
      return channel->isOpen() && get_peer_transport_snapshot(receiver).encoded_media_data_channel_ready;
    }, [&] { bridge->pump(); }, "raw RTC DC handshake timed out");
    require(!get_peer_transport_snapshot(receiver).video_receiver_configured,
            "raw fixture unexpectedly has an RTP receiver");
    std::this_thread::sleep_for(50ms);
  }

  ~RawControlPair() {
    close_peer_transport_session(receiver);
    if (raw) raw->close();
  }

  void send(const std::string& message) {
    require(channel->send(message), "raw SCTP send failed");
  }

  template <class Predicate>
  void wait(Predicate predicate, const std::string& message) {
    wait_until(predicate, [&] { bridge->pump(); }, message);
  }
};

void test_host_control() {
  auto runtime = host_runtime();
  std::atomic<unsigned> invoked{0};
  std::mutex reason_mutex;
  std::string received_reason;
  auto actual_handler = vds::media_agent::make_peer_video_sender_keyframe_request_handler(runtime);
  const auto refresh = std::make_shared<HostRefreshObservations>();
  std::weak_ptr<PeerTransportSession> host_session;
  const auto tracked_handler = [&](const std::string& reason) {
    // The production callback must run outside the transport mutex.
    if (const auto session = host_session.lock()) (void)get_peer_transport_snapshot(session);
    {
      std::lock_guard<std::mutex> lock(reason_mutex);
      received_reason = reason;
    }
    const auto action = actual_handler(reason);
    ++invoked;
    return action;
  };
  ProductionPair pair("host-control", tracked_handler,
    [refresh](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
      refresh->observe(snapshot, logical_state);
    });
  host_session = pair.publisher;
  refresh->bind(pair.publisher);
  pair.request("waiting-for-random-access");
  pair.wait([&] { const auto state = get_peer_transport_snapshot(pair.publisher);
      return state.keyframe_requests_received == 1 &&
        state.keyframe_request_action == "host-encoder-refresh-requested" &&
        runtime->soft_refresh_requested.load() && refresh->wakes.load(std::memory_order_acquire) == 1; },
            "publisher never received keyframe request");
  require(runtime->soft_refresh_requested.load(), "real host refresh flag was not set");
  require(invoked.load() == 1, "host handler did not run exactly once");
  require(refresh->wakes.load() == 1, "accepted host request did not emit exactly one wake");
  require(get_peer_transport_snapshot(pair.publisher).keyframe_request_action ==
          "host-encoder-refresh-requested", "host refresh action missing from snapshot");
  {
    std::lock_guard<std::mutex> lock(reason_mutex);
    require(received_reason == "waiting-for-random-access", "request reason was not preserved");
  }
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == 1,
          "request was not counted as an actual DC send");
  for (unsigned index = 0; index < 8; ++index) {
    std::string ignored;
    request_peer_transport_keyframe(pair.viewer, "decoder-recovery", &ignored);
  }
  std::this_thread::sleep_for(80ms);
  require(invoked.load() == 1, "outgoing storm bypassed the send throttle");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == 1,
          "throttled calls were incorrectly counted as sends");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_throttled >= 8,
          "send throttle is not observable");
  require(refresh->wakes.load() == 1, "send-throttled requests emitted another host wake");

  std::this_thread::sleep_for(600ms);
  runtime->soft_refresh_requested = false;
  pair.request("decoder-recovery");
  pair.wait([&] { return invoked.load() == 2 && runtime->soft_refresh_requested.load() &&
      refresh->wakes.load(std::memory_order_acquire) == 2; },
            "request did not resume after throttle window");
  require(runtime->soft_refresh_requested.load(), "second request did not refresh the host");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == 2,
          "second real send was not counted");
  require(refresh->wakes.load() == 2, "second accepted host request did not emit exactly one wake");

  std::this_thread::sleep_for(600ms);
  runtime->stop_requested = true;
  runtime->soft_refresh_requested = false;
  pair.request("decoder-recovery");
  pair.wait([&] { return get_peer_transport_snapshot(pair.publisher).keyframe_request_action ==
      "host-encoder-unavailable" && refresh->control_publication_sequence.load(std::memory_order_acquire) >= 3; },
            "stopped host did not reject refresh");
  require(!runtime->soft_refresh_requested.load(), "stopped host was refreshed");
  require(refresh->wakes.load() == 2, "stopped host request emitted a wake");

  const auto expired = std::weak_ptr<PeerVideoSenderRuntime>(runtime);
  actual_handler = vds::media_agent::make_peer_video_sender_keyframe_request_handler(expired);
  set_peer_transport_keyframe_request_handler(pair.publisher, tracked_handler);
  runtime.reset();
  require(expired.expired(), "host test runtime was unexpectedly retained");
  std::this_thread::sleep_for(600ms);
  pair.request("decoder-recovery");
  pair.wait([&] { return invoked.load() == 4 &&
      get_peer_transport_snapshot(pair.publisher).keyframe_request_action == "host-encoder-unavailable" &&
      refresh->control_publication_sequence.load(std::memory_order_acquire) >= 4; },
            "expired host handler was not exercised");
  require(get_peer_transport_snapshot(pair.publisher).keyframe_request_action ==
          "host-encoder-unavailable", "expired host reported a successful action");
  require(refresh->wakes.load() == 2, "expired host request emitted a wake");

  auto replacement = host_runtime();
  set_peer_transport_keyframe_request_handler(pair.publisher,
    vds::media_agent::make_peer_video_sender_keyframe_request_handler(replacement));
  std::this_thread::sleep_for(600ms);
  pair.request("decoder-recovery");
  pair.wait([&] { return replacement->soft_refresh_requested.load() &&
      refresh->wakes.load(std::memory_order_acquire) == 3; },
            "replacement host handler was not invoked");
  require(invoked.load() == 4, "setter left the old callback installed");
  require(refresh->wakes.load() == 3, "replacement host accepted request did not emit exactly one wake");

  replacement->source_clock.source_epoch += "-stale";
  replacement->soft_refresh_requested = false;
  std::this_thread::sleep_for(600ms);
  pair.request("decoder-recovery");
  pair.wait([&] { return get_peer_transport_snapshot(pair.publisher).keyframe_request_action ==
      "host-encoder-unavailable" && refresh->control_publication_sequence.load(std::memory_order_acquire) >= 6; },
            "stale host epoch was not rejected");
  require(!replacement->soft_refresh_requested.load(), "stale source epoch refreshed encoder");
  require(refresh->wakes.load() == 3, "stale host epoch request emitted a wake");

  const auto sent_before_close = get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent;
  close_peer_transport_session(pair.viewer);
  std::string error;
  require(!request_peer_transport_keyframe(pair.viewer, "decoder-recovery", &error),
          "closed viewer accepted a keyframe send");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == sent_before_close,
          "closed viewer counted a keyframe send");
  require(refresh->wakes.load() == 3, "closed transport request emitted a host wake");
  require(refresh->snapshots_checked.load() == 3 && refresh->invalid_snapshots.load() == 0,
          "host wake callback could not read a consistent snapshot outside the mutex");
  std::cout << "host: DC-only callback, real encoder refresh flag, send throttle, stopped/expired/replaced handler, close passed\n";
}

void test_host_waiting_for_bootstrap() {
  const auto runtime = host_runtime();
  runtime->pending_video_bootstrap = true;
  const auto refresh = std::make_shared<HostRefreshObservations>();
  ProductionPair pair("host-bootstrap", vds::media_agent::make_peer_video_sender_keyframe_request_handler(runtime),
    [refresh](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
      refresh->observe(snapshot, logical_state);
    });
  refresh->bind(pair.publisher);

  for (std::uint64_t sequence = 1; sequence <= 2; ++sequence) {
    if (sequence > 1) std::this_thread::sleep_for(600ms);
    pair.request("waiting-for-random-access");
    pair.wait([&] { return refresh->control_publication_sequence.load(std::memory_order_acquire) == sequence; },
              "warming host request was not processed over the real DC");
    const auto snapshot = get_peer_transport_snapshot(pair.publisher);
    require(snapshot.keyframe_requests_received == sequence,
            "warming host did not receive the request after the throttle interval");
    require(snapshot.keyframe_requests_throttled == 0,
            "warming bootstrap guard was hidden by receive throttling");
    require(snapshot.keyframe_request_action == "host-encoder-awaiting-bootstrap",
            "warming host did not report its pending bootstrap");
    require(!runtime->soft_refresh_requested.load(), "warming host request restarted the encoder");
    require(refresh->wakes.load() == 0, "warming host request emitted a restart wake");
  }

  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->pending_video_bootstrap = false;
  }
  std::this_thread::sleep_for(600ms);
  pair.request("decoder-recovery");
  pair.wait([&] { return refresh->control_publication_sequence.load(std::memory_order_acquire) == 3 &&
      refresh->wakes.load(std::memory_order_acquire) == 1 && runtime->soft_refresh_requested.load(); },
            "active host did not accept recovery after bootstrap completed");
  require(get_peer_transport_snapshot(pair.publisher).keyframe_request_action == "host-encoder-refresh-requested",
          "active host did not report an actual encoder refresh");
  require(refresh->wakes.load() == 1, "active host request emitted a wrong number of wakes");
  require(refresh->snapshots_checked.load() == 1 && refresh->invalid_snapshots.load() == 0,
          "active host wake did not expose an unlocked consistent snapshot");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == 3,
          "warming/active scenario did not send all three actual DC requests");
  std::cout << "bootstrap: two warming requests do not restart; active host accepts the next real DC request and wakes once passed\n";
}

void test_receiver_validation() {
  auto runtime = host_runtime();
  std::atomic<unsigned> invoked{0};
  const auto actual_handler = vds::media_agent::make_peer_video_sender_keyframe_request_handler(runtime);
  const auto refresh = std::make_shared<HostRefreshObservations>();
  RawControlPair pair([&](const std::string& reason) {
    ++invoked;
    return actual_handler(reason);
  }, [refresh](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
    refresh->observe(snapshot, logical_state);
  });
  refresh->bind(pair.receiver);
  const auto valid = control_message("keyframe-request", "raw-session");
  const auto changed = [&](const std::string& from, const std::string& to) {
    auto result = valid;
    const auto position = result.find(from);
    if (position == std::string::npos) throw std::runtime_error("invalid test mutation");
    result.replace(position, from.size(), to);
    return result;
  };
  const std::vector<std::string> invalid = {
    control_message("keyframe-request", "other-session"),
    control_message("keyframe-request", "raw-session", 2),
    control_message("keyframe-request", ""),
    control_message("keyframe-request", "raw-session", 0),
    control_message("keyframe-request", std::string(129, 's')),
    control_message("keyframe-request", "raw-session", 1, 2),
    "{\"protocol\":\"vds-media-encoded-v1\",\"type\":\"keyframe-request\"}",
    changed("\"protocolVersion\":1", "\"protocolVersion\":1.9"),
    changed("\"protocolVersion\":1", "\"protocolVersion\":\"1\""),
    changed("\"manifestVersion\":1", "\"manifestVersion\":1.9"),
    changed("\"manifestVersion\":1", "\"manifestVersion\":\"1\""),
    changed("\"protocolVersion\":1", "\"protocolVersion\":1,\"protocolVersion\":1"),
    changed("raw-fixture-recovery", std::string("bad") + static_cast<char>(1)),
    changed(",\"reason\"", "\"reason\""),
    valid.substr(0, valid.size() - 1) + ",}",
    valid + "{}",
    valid.substr(0, valid.size() - 1) + ",\"extra\":{}}",
    valid.substr(0, valid.size() - 1) + ",\"extra\":\"" + std::string(4096, 'x') + "\"}"
  };
  for (const auto& message : invalid) {
    const auto previous_errors = pair.errors->load();
    const auto previous_publications = refresh->control_publications.load(std::memory_order_acquire);
    pair.send(message);
    pair.wait([&] { return pair.errors->load() > previous_errors &&
        refresh->control_publications.load(std::memory_order_acquire) > previous_publications; },
              "invalid keyframe control did not receive an error response");
    require(invoked.load() == 0, "invalid session/version/control reached the host handler");
    require(!runtime->soft_refresh_requested.load(), "invalid control refreshed the encoder");
    require(get_peer_transport_snapshot(pair.receiver).keyframe_requests_received == 0,
            "invalid controls were counted as accepted requests");
    require(refresh->wakes.load() == 0, "invalid raw control emitted a host wake");
  }

  pair.send(valid.substr(0, valid.size() - 1) +
            ",\"unknownFlag\":true,\"unknownNumber\":1.9,\"unknownNull\":null,\"unknownText\":\"compatible\"}");
  for (unsigned index = 1; index < 20; ++index) pair.send(valid);
  pair.wait([&] { const auto state = get_peer_transport_snapshot(pair.receiver);
      return state.keyframe_requests_throttled >= 19 && runtime->soft_refresh_requested.load() &&
        state.keyframe_request_action == "host-encoder-refresh-requested" &&
        refresh->control_publication_sequence.load(std::memory_order_acquire) == 20; },
            "incoming raw request storm did not reach receive throttle");
  require(invoked.load() == 1, "receive throttle did not limit callback execution");
  require(get_peer_transport_snapshot(pair.receiver).keyframe_requests_received == 20,
          "real raw messages were not all counted on receive");
  require(runtime->soft_refresh_requested.load(), "accepted raw request did not refresh host");
  require(refresh->wakes.load() == 1, "20 raw requests did not emit exactly one accepted host wake");
  require(get_peer_transport_snapshot(pair.receiver).keyframe_request_action ==
          "host-encoder-refresh-requested", "accepted raw request action not recorded");
  std::this_thread::sleep_for(600ms);
  runtime->soft_refresh_requested = false;
  pair.send(control_message("keyframe-request", "raw-session"));
  pair.wait([&] { return invoked.load() == 2 && runtime->soft_refresh_requested.load() &&
      refresh->control_publication_sequence.load(std::memory_order_acquire) == 21; },
            "receive throttle did not reopen after 600 ms");
  require(runtime->soft_refresh_requested.load(), "resumed raw request did not refresh host");
  require(refresh->wakes.load() == 2, "raw request after 600 ms did not emit the second host wake");
  require(refresh->snapshots_checked.load() == 2 && refresh->invalid_snapshots.load() == 0,
          "raw host wake callback did not read the unlocked transport snapshot");
  std::cout << "receiver: wrong/missing session or manifest, wrong protocol, bounded/invalid control, raw receive throttle passed\n";
}

struct BlockedHandlerState {
  std::atomic<bool> entered{false};
  std::atomic<bool> released{false};
  std::atomic<bool> returned{false};
  std::atomic<bool> published{false};
};

struct ReleaseBlockedHandler {
  std::shared_ptr<BlockedHandlerState> state;
  ~ReleaseBlockedHandler() { state->released.store(true, std::memory_order_release); }
};

void test_handler_rebind_race() {
  const auto blocked = std::make_shared<BlockedHandlerState>();
  const auto refresh = std::make_shared<HostRefreshObservations>();
  ProductionPair pair("handler-rebind", [blocked](const std::string&) {
    blocked->entered.store(true, std::memory_order_release);
    while (!blocked->released.load(std::memory_order_acquire)) std::this_thread::sleep_for(1ms);
    blocked->returned.store(true, std::memory_order_release);
    return std::string("handler-a-finished");
  }, [blocked, refresh](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
    refresh->observe(snapshot, logical_state);
    // onMessage publishes this state after handle_keyframe_request returns and
    // commits (or rejects) the callback result. ICE/signaling state callbacks
    // use different logical states and cannot satisfy this completion fence.
    if (blocked->returned.load(std::memory_order_acquire) && snapshot.keyframe_requests_received == 1 &&
        logical_state == snapshot.encoded_media_data_channel_state)
      blocked->published.store(true, std::memory_order_release);
  });
  // Declared after pair so unwinding always releases A before closing the DC.
  const ReleaseBlockedHandler release_on_exit{blocked};
  refresh->bind(pair.publisher);
  pair.request("decoder-recovery");
  pair.wait([&] { return blocked->entered.load(std::memory_order_acquire); },
            "blocking handler A never received the real DC request");
  const auto replacement_invoked = std::make_shared<std::atomic<unsigned>>(0);
  set_peer_transport_keyframe_request_handler(pair.publisher,
    [replacement_invoked](const std::string&) {
      ++*replacement_invoked;
      return std::string("handler-b-finished");
    });
  require(get_peer_transport_snapshot(pair.publisher).keyframe_request_action == "keyframe-handler-ready",
          "replacement handler B was not installed while A was blocked");
  blocked->released.store(true, std::memory_order_release);
  pair.wait([&] { return blocked->published.load(std::memory_order_acquire); },
            "handler A completion was not published after release");
  require(get_peer_transport_snapshot(pair.publisher).keyframe_request_action == "keyframe-handler-ready",
          "old handler A overwrote replacement handler B diagnostics");
  require(replacement_invoked->load() == 0, "handler B ran without a new request");
  require(refresh->wakes.load() == 0, "retired handler A emitted a host wake");

  std::this_thread::sleep_for(600ms);
  pair.request("decoder-recovery");
  pair.wait([&] { return replacement_invoked->load() == 1 &&
      get_peer_transport_snapshot(pair.publisher).keyframe_request_action == "handler-b-finished" &&
      refresh->control_publication_sequence.load(std::memory_order_acquire) == 2; },
            "next real DC request did not invoke replacement handler B");
  require(get_peer_transport_snapshot(pair.publisher).keyframe_requests_received == 2,
          "handler rebind received count does not match the two real requests");
  require(get_peer_transport_snapshot(pair.viewer).keyframe_requests_sent == 2,
          "handler rebind send count does not match the two real requests");
  require(refresh->wakes.load() == 0, "non-host replacement handler B emitted a host wake");
  std::cout << "rebind: blocked A -> install B -> release A keeps B ready; next real DC request invokes B passed\n";
}

void test_relay_forwarding() {
  auto runtime = host_runtime();
  std::atomic<unsigned> host_invoked{0};
  const auto host_handler = vds::media_agent::make_peer_video_sender_keyframe_request_handler(runtime);
  ProductionPair upstream("upstream-session", [&](const std::string& reason) {
    ++host_invoked;
    return host_handler(reason);
  });
  std::atomic<unsigned> relay_invoked{0};
  const auto weak_upstream = std::weak_ptr<PeerTransportSession>(upstream.viewer);
  ProductionPair downstream("downstream-session", [&, weak_upstream](const std::string& reason) {
    ++relay_invoked;
    const auto source = weak_upstream.lock();
    if (!source) return std::string("relay-upstream-unavailable");
    std::string error;
    return request_peer_transport_keyframe(source, reason, &error)
      ? std::string("relay-upstream-keyframe-requested")
      : std::string("relay-upstream-keyframe-failed");
  });
  downstream.request("decoder-recovery");
  wait_until([&] { return runtime->soft_refresh_requested.load() &&
      get_peer_transport_snapshot(downstream.publisher).keyframe_request_action ==
        "relay-upstream-keyframe-requested" &&
      get_peer_transport_snapshot(upstream.publisher).keyframe_request_action ==
        "host-encoder-refresh-requested"; }, [&] {
      downstream.bridge->pump();
      upstream.bridge->pump();
    }, "viewer -> relay -> host request did not complete");
  require(relay_invoked.load() == 1, "relay callback count differs from actual request count");
  require(host_invoked.load() == 1, "relay did not reach upstream host exactly once");
  require(get_peer_transport_snapshot(downstream.viewer).keyframe_requests_sent == 1,
          "downstream actual request not counted");
  require(get_peer_transport_snapshot(upstream.viewer).keyframe_requests_sent == 1,
          "upstream forwarded request not counted");
  std::cout << "relay: four production sessions, independent manifests, viewer -> relay -> host real SCTP callback passed\n";
}

}  // namespace

int main() {
  try {
    rtc::InitLogger(rtc::LogLevel::Error);
    std::string error;
    require(!request_peer_transport_keyframe(nullptr, "decoder-recovery", &error),
            "missing session accepted a keyframe request");
    test_host_control();
    test_host_waiting_for_bootstrap();
    test_handler_rebind_race();
    test_receiver_validation();
    test_relay_forwarding();
    std::cout << "peer-keyframe-control-e2e: " << checks << " checks passed\n";
    return 0;
  } catch (const std::exception& ex) {
    std::cerr << "peer-keyframe-control-e2e failed after " << checks << " checks: " << ex.what() << '\n';
    return 1;
  }
}
