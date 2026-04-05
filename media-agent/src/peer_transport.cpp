#include "peer_transport.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
#ifdef RTC_ENABLE_MEDIA
#undef RTC_ENABLE_MEDIA
#endif
#define RTC_ENABLE_MEDIA 1
#include <rtc/rtc.hpp>
#include <rtc/h264rtpdepacketizer.hpp>
#include <rtc/h264rtppacketizer.hpp>
#include <rtc/h265rtpdepacketizer.hpp>
#include <rtc/h265rtppacketizer.hpp>
#include <rtc/nalunit.hpp>
#include <rtc/rtpdepacketizer.hpp>
#include <rtc/rtcpreceivingsession.hpp>
#include <rtc/rtppacketizationconfig.hpp>
#include <rtc/rtcpsrreporter.hpp>
#endif

namespace {

std::atomic<std::uint32_t> g_next_video_ssrc { 0x24500000u };
std::atomic<std::uint32_t> g_next_audio_ssrc { 0x24600000u };

std::int64_t current_time_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

std::vector<std::string> default_ice_servers() {
  return {
    "stun:stun.cloudflare.com:3478",
    "stun:stun.linphone.org:3478"
  };
}

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string normalize_video_codec_name(const std::string& codec) {
  const std::string normalized = to_lower_ascii(codec);
  if (normalized == "h265" || normalized == "hevc") {
    return "h265";
  }
  return "h264";
}

#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL

std::once_flag g_rtc_logger_once;

void ensure_rtc_logger() {
  std::call_once(g_rtc_logger_once, []() {
    rtc::InitLogger(rtc::LogLevel::None);
  });
}

class PcmuRtpDepacketizerCompat final : public rtc::RtpDepacketizer {
 public:
  explicit PcmuRtpDepacketizerCompat(std::uint32_t clock_rate = 8000)
    : rtc::RtpDepacketizer(clock_rate) {}
  ~PcmuRtpDepacketizerCompat() override = default;
};

class OpusRtpDepacketizerCompat final : public rtc::RtpDepacketizer {
 public:
  explicit OpusRtpDepacketizerCompat(std::uint32_t clock_rate = 48000)
    : rtc::RtpDepacketizer(clock_rate) {}
  ~OpusRtpDepacketizerCompat() override = default;
};

std::string to_description_type_string(rtc::Description::Type type) {
  switch (type) {
    case rtc::Description::Type::Offer:
      return "offer";
    case rtc::Description::Type::Answer:
      return "answer";
    case rtc::Description::Type::Pranswer:
      return "pranswer";
    case rtc::Description::Type::Rollback:
      return "rollback";
    case rtc::Description::Type::Unspec:
    default:
      return "unspec";
  }
}

std::string to_connection_state_string(rtc::PeerConnection::State state) {
  switch (state) {
    case rtc::PeerConnection::State::New:
      return "new";
    case rtc::PeerConnection::State::Connecting:
      return "connecting";
    case rtc::PeerConnection::State::Connected:
      return "connected";
    case rtc::PeerConnection::State::Disconnected:
      return "disconnected";
    case rtc::PeerConnection::State::Failed:
      return "failed";
    case rtc::PeerConnection::State::Closed:
      return "closed";
    default:
      return "unknown";
  }
}

std::string to_ice_state_string(rtc::PeerConnection::IceState state) {
  switch (state) {
    case rtc::PeerConnection::IceState::New:
      return "new";
    case rtc::PeerConnection::IceState::Checking:
      return "checking";
    case rtc::PeerConnection::IceState::Connected:
      return "connected";
    case rtc::PeerConnection::IceState::Completed:
      return "completed";
    case rtc::PeerConnection::IceState::Failed:
      return "failed";
    case rtc::PeerConnection::IceState::Disconnected:
      return "disconnected";
    case rtc::PeerConnection::IceState::Closed:
      return "closed";
    default:
      return "unknown";
  }
}

std::string to_gathering_state_string(rtc::PeerConnection::GatheringState state) {
  switch (state) {
    case rtc::PeerConnection::GatheringState::New:
      return "new";
    case rtc::PeerConnection::GatheringState::InProgress:
      return "in-progress";
    case rtc::PeerConnection::GatheringState::Complete:
      return "complete";
    default:
      return "unknown";
  }
}

std::string to_signaling_state_string(rtc::PeerConnection::SignalingState state) {
  switch (state) {
    case rtc::PeerConnection::SignalingState::Stable:
      return "stable";
    case rtc::PeerConnection::SignalingState::HaveLocalOffer:
      return "have-local-offer";
    case rtc::PeerConnection::SignalingState::HaveRemoteOffer:
      return "have-remote-offer";
    case rtc::PeerConnection::SignalingState::HaveLocalPranswer:
      return "have-local-pranswer";
    case rtc::PeerConnection::SignalingState::HaveRemotePranswer:
      return "have-remote-pranswer";
    default:
      return "unknown";
  }
}

std::string to_logical_peer_state(rtc::PeerConnection::State state) {
  switch (state) {
    case rtc::PeerConnection::State::New:
      return "created";
    case rtc::PeerConnection::State::Connecting:
      return "connecting";
    case rtc::PeerConnection::State::Connected:
      return "connected";
    case rtc::PeerConnection::State::Disconnected:
      return "disconnected";
    case rtc::PeerConnection::State::Failed:
      return "failed";
    case rtc::PeerConnection::State::Closed:
      return "closed";
    default:
      return "connecting";
  }
}

}  // namespace

class PeerTransportSession final : public std::enable_shared_from_this<PeerTransportSession> {
 public:
  PeerTransportSession(
    std::string peer_id_value,
    bool initiator_value,
    PeerTransportCallbacks callbacks_value
  ) : peer_id(std::move(peer_id_value)),
      initiator(initiator_value),
      callbacks(std::move(callbacks_value)) {
    snapshot.available = true;
    snapshot.transport_ready = true;
    snapshot.video_track_support = true;
    snapshot.audio_track_support = true;
    snapshot.data_channel_requested = initiator;
    snapshot.created_at_unix_ms = current_time_millis();
    snapshot.updated_at_unix_ms = snapshot.created_at_unix_ms;
    snapshot.reason = initiator ? "awaiting-local-offer" : "awaiting-remote-offer";
  }

  void initialize() {
    ensure_rtc_logger();

    rtc::Configuration config;
    config.enableIceTcp = true;
    config.disableAutoNegotiation = true;
    for (const auto& server : default_ice_servers()) {
      config.iceServers.emplace_back(server);
    }

    pc = std::make_shared<rtc::PeerConnection>(config);
    install_callbacks();

    if (initiator) {
      data_channel = pc->createDataChannel(snapshot.data_channel_label);
      install_data_channel_callbacks(data_channel);
    }

    refresh_from_peer_connection();
  }

  void set_remote_description(const std::string& type, const std::string& sdp) {
    if (!pc) {
      throw std::runtime_error("peer-transport-not-initialized");
    }

    const rtc::Description remote_description(sdp, type);
    if (to_lower_ascii(type) == "offer") {
      ensure_video_receiver_for_offer(remote_description);
      ensure_audio_receiver_for_offer(remote_description);
    }

    pc->setRemoteDescription(remote_description);
    if (to_lower_ascii(type) == "offer") {
      pc->setLocalDescription();
    }

    PeerTransportSnapshot snapshot_copy;
    {
      std::lock_guard<std::mutex> lock(mutex);
      snapshot.remote_description_set = true;
      snapshot.reason = "remote-description-set";
      snapshot.last_error.clear();
      refresh_from_peer_connection_locked();
      snapshot_copy = snapshot;
    }

    if (callbacks.on_state_change) {
      callbacks.on_state_change(snapshot_copy, "remote-description-set");
    }
  }

  void ensure_local_description() {
    if (!pc) {
      throw std::runtime_error("peer-transport-not-initialized");
    }
    pc->setLocalDescription();
  }

  void add_remote_candidate(const std::string& candidate, const std::string& sdp_mid) {
    if (!pc) {
      throw std::runtime_error("peer-transport-not-initialized");
    }

    if (!sdp_mid.empty()) {
      pc->addRemoteCandidate(rtc::Candidate(candidate, sdp_mid));
    } else {
      pc->addRemoteCandidate(rtc::Candidate(candidate));
    }

    PeerTransportSnapshot snapshot_copy;
    {
      std::lock_guard<std::mutex> lock(mutex);
      snapshot.remote_candidate_count += 1;
      snapshot.reason = "remote-candidate-added";
      snapshot.last_error.clear();
      refresh_from_peer_connection_locked();
      snapshot_copy = snapshot;
    }

    if (callbacks.on_state_change) {
      callbacks.on_state_change(snapshot_copy, "remote-candidate-added");
    }
  }

  void close() {
    std::shared_ptr<rtc::PeerConnection> local_pc;
    std::shared_ptr<rtc::DataChannel> local_data_channel;
    std::shared_ptr<rtc::Track> local_video_track;
    std::shared_ptr<rtc::Track> local_audio_track;
    std::shared_ptr<rtc::Track> local_inbound_video_track;
    std::shared_ptr<rtc::Track> local_inbound_audio_track;

    {
      std::lock_guard<std::mutex> lock(mutex);
      if (closed) {
        return;
      }

      closed = true;
      snapshot.closed = true;
      snapshot.data_channel_open = false;
      snapshot.connection_state = "closed";
      snapshot.ice_state = "closed";
      snapshot.signaling_state = "closed";
      snapshot.reason = "peer-closed";
      snapshot.updated_at_unix_ms = current_time_millis();

      local_pc = std::move(pc);
      local_data_channel = std::move(data_channel);
      local_video_track = std::move(video_track);
      local_audio_track = std::move(audio_track);
      local_inbound_video_track = std::move(inbound_video_track);
      local_inbound_audio_track = std::move(inbound_audio_track);
      inbound_video_depacketizer.reset();
      inbound_video_rtcp_session.reset();
      inbound_audio_depacketizer.reset();
      inbound_audio_rtcp_session.reset();
    }

    if (local_data_channel) {
      local_data_channel->close();
    }
    if (local_pc) {
      local_pc->resetCallbacks();
      local_pc->close();
    } else {
      if (local_video_track) {
        local_video_track->close();
      }
      if (local_audio_track) {
        local_audio_track->close();
      }
      if (local_inbound_video_track) {
        local_inbound_video_track->close();
      }
      if (local_inbound_audio_track) {
        local_inbound_audio_track->close();
      }
    }
  }

  PeerTransportSnapshot get_snapshot() {
    std::lock_guard<std::mutex> lock(mutex);
    refresh_from_peer_connection_locked();
    return snapshot;
  }

  void configure_video_sender(const PeerVideoTrackConfig& config) {
    if (!pc) {
      throw std::runtime_error("peer-transport-not-initialized");
    }

    const std::string normalized_codec = normalize_video_codec_name(config.codec);
    const bool use_h265 = normalized_codec == "h265";

    auto description = rtc::Description::Video(
      config.mid.empty() ? "video" : config.mid,
      rtc::Description::Direction::SendRecv
    );
    if (use_h265) {
      description.addH265Codec(config.payload_type > 0 ? config.payload_type : 96);
    } else {
      description.addH264Codec(config.payload_type > 0 ? config.payload_type : 96);
    }

    const std::uint32_t ssrc = config.ssrc != 0 ? config.ssrc : g_next_video_ssrc.fetch_add(1);
    const std::string cname = peer_id + "-video";
    description.addSSRC(
      ssrc,
      cname,
      config.stream_id.empty() ? "vds-stream" : config.stream_id,
      config.track_id.empty() ? "vds-video" : config.track_id
    );
    if (config.bitrate_kbps > 0) {
      description.setBitrate(config.bitrate_kbps * 1000);
    }

    auto new_track = pc->addTrack(description);
    auto rtp_config = std::make_shared<rtc::RtpPacketizationConfig>(
      ssrc,
      cname,
      static_cast<std::uint8_t>(config.payload_type > 0 ? config.payload_type : 96),
      use_h265 ? rtc::H265RtpPacketizer::ClockRate : rtc::H264RtpPacketizer::ClockRate
    );
    rtp_config->mid = config.mid.empty() ? "video" : config.mid;

    auto sender_reporter = std::make_shared<rtc::RtcpSrReporter>(rtp_config);
    if (use_h265) {
      auto packetizer = std::make_shared<rtc::H265RtpPacketizer>(
        rtc::NalUnit::Separator::StartSequence,
        rtp_config
      );
      new_track->setMediaHandler(packetizer);
    } else {
      auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(
        rtc::NalUnit::Separator::StartSequence,
        rtp_config
      );
      new_track->setMediaHandler(packetizer);
    }
    new_track->chainMediaHandler(sender_reporter);

    auto weak_self = weak_from_this();
    new_track->onOpen([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.video_track_open = true;
      self->snapshot.reason = "video-track-open";
      self->snapshot.updated_at_unix_ms = current_time_millis();
      self->snapshot.media_plane_ready = self->snapshot.decoder_ready && self->snapshot.decoded_frames_rendered > 0;
    });
    new_track->onClosed([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.video_track_open = false;
      self->snapshot.updated_at_unix_ms = current_time_millis();
      self->snapshot.media_plane_ready = self->snapshot.decoder_ready && self->snapshot.decoded_frames_rendered > 0;
    });

    std::lock_guard<std::mutex> lock(mutex);
    if (video_track) {
      video_track->close();
    }
    video_track = std::move(new_track);
    video_rtp_config = std::move(rtp_config);
    snapshot.video_track_configured = true;
    snapshot.video_mid = config.mid.empty() ? "video" : config.mid;
    snapshot.video_codec = normalized_codec;
    snapshot.codec_path = normalized_codec;
    snapshot.video_decoder_backend = "none";
    snapshot.video_source = config.source;
    snapshot.reason = "video-track-configured";
    snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
    refresh_from_peer_connection_locked();
  }

  void clear_video_sender() {
    std::shared_ptr<rtc::Track> local_video_track;

    {
      std::lock_guard<std::mutex> lock(mutex);
      local_video_track = std::move(video_track);
      video_rtp_config.reset();
      snapshot.video_track_configured = false;
      snapshot.video_track_open = false;
      snapshot.video_source.clear();
      snapshot.reason = "video-track-cleared";
      snapshot.updated_at_unix_ms = current_time_millis();
      snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
    }

    if (local_video_track) {
      local_video_track->close();
    }
  }

  void configure_audio_sender(const PeerAudioTrackConfig& config) {
    if (!pc) {
      throw std::runtime_error("peer-transport-not-initialized");
    }

    auto description = rtc::Description::Audio(
      config.mid.empty() ? "audio" : config.mid,
      rtc::Description::Direction::SendRecv
    );
    const std::string audio_codec = to_lower_ascii(config.codec);
    const bool use_opus = audio_codec == "opus";
    const bool use_pcmu = audio_codec == "pcmu";
    if (!use_opus && !use_pcmu) {
      throw std::runtime_error("only-opus-and-pcmu-audio-sender-are-currently-supported");
    }

    if (use_opus) {
      description.addOpusCodec(config.payload_type > 0 ? config.payload_type : 111);
    } else {
      description.addPCMUCodec(config.payload_type >= 0 ? config.payload_type : 0);
    }

    const std::uint32_t ssrc = config.ssrc != 0 ? config.ssrc : g_next_audio_ssrc.fetch_add(1);
    const std::string cname = peer_id + "-audio";
    description.addSSRC(
      ssrc,
      cname,
      config.stream_id.empty() ? "vds-stream" : config.stream_id,
      config.track_id.empty() ? "vds-audio" : config.track_id
    );
    if (config.bitrate_kbps > 0) {
      description.setBitrate(config.bitrate_kbps * 1000);
    }

    auto new_track = pc->addTrack(description);
    auto rtp_config = std::make_shared<rtc::RtpPacketizationConfig>(
      ssrc,
      cname,
      static_cast<std::uint8_t>(use_opus ? (config.payload_type > 0 ? config.payload_type : 111) : (config.payload_type >= 0 ? config.payload_type : 0)),
      use_opus ? rtc::OpusRtpPacketizer::DefaultClockRate : rtc::PCMURtpPacketizer::DefaultClockRate
    );
    rtp_config->mid = config.mid.empty() ? "audio" : config.mid;

    std::shared_ptr<rtc::MediaHandler> packetizer = use_opus
      ? std::static_pointer_cast<rtc::MediaHandler>(std::make_shared<rtc::OpusRtpPacketizer>(rtp_config))
      : std::static_pointer_cast<rtc::MediaHandler>(std::make_shared<rtc::PCMURtpPacketizer>(rtp_config));
    auto sender_reporter = std::make_shared<rtc::RtcpSrReporter>(rtp_config);
    new_track->setMediaHandler(packetizer);
    new_track->chainMediaHandler(sender_reporter);

    auto weak_self = weak_from_this();
    new_track->onOpen([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.audio_track_open = true;
      self->snapshot.reason = "audio-track-open";
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });
    new_track->onClosed([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.audio_track_open = false;
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });

    std::lock_guard<std::mutex> lock(mutex);
    if (audio_track) {
      audio_track->close();
    }
    audio_track = std::move(new_track);
    audio_rtp_config = std::move(rtp_config);
    snapshot.audio_track_configured = true;
    snapshot.audio_mid = config.mid.empty() ? "audio" : config.mid;
    snapshot.audio_codec = config.codec;
    snapshot.reason = "audio-track-configured";
    refresh_from_peer_connection_locked();
  }

  void clear_audio_sender() {
    std::shared_ptr<rtc::Track> local_audio_track;

    {
      std::lock_guard<std::mutex> lock(mutex);
      local_audio_track = std::move(audio_track);
      audio_rtp_config.reset();
      snapshot.audio_track_configured = false;
      snapshot.audio_track_open = false;
      snapshot.reason = "audio-track-cleared";
      snapshot.updated_at_unix_ms = current_time_millis();
    }

    if (local_audio_track) {
      local_audio_track->close();
    }
  }

  void send_video_frame(
    const std::vector<std::uint8_t>& frame,
    const std::string& codec,
    std::uint64_t timestamp_us) {
    std::shared_ptr<rtc::Track> local_video_track;
    std::string configured_codec;

    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!video_track) {
        throw std::runtime_error("video-track-not-configured");
      }
      local_video_track = video_track;
      configured_codec = normalize_video_codec_name(snapshot.video_codec);
    }

    if (normalize_video_codec_name(codec) != configured_codec) {
      throw std::runtime_error("video-track-codec-mismatch");
    }

    rtc::binary payload;
    payload.reserve(frame.size());
    for (const std::uint8_t byte_value : frame) {
      payload.push_back(static_cast<std::byte>(byte_value));
    }

    local_video_track->sendFrame(
      std::move(payload),
      rtc::FrameInfo(std::chrono::duration<double>(static_cast<double>(timestamp_us) / 1000000.0))
    );

    std::lock_guard<std::mutex> lock(mutex);
    snapshot.video_frames_sent += 1;
    snapshot.video_bytes_sent += static_cast<std::uint64_t>(frame.size());
    snapshot.last_video_frame_at_unix_ms = current_time_millis();
    snapshot.reason = "video-frame-sent";
    refresh_from_peer_connection_locked();
  }

  void send_audio_frame(const std::vector<std::uint8_t>& frame, std::uint64_t timestamp_us) {
    std::shared_ptr<rtc::Track> local_audio_track;

    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!audio_track) {
        throw std::runtime_error("audio-track-not-configured");
      }
      local_audio_track = audio_track;
    }

    rtc::binary payload;
    payload.reserve(frame.size());
    for (const std::uint8_t byte_value : frame) {
      payload.push_back(static_cast<std::byte>(byte_value));
    }

    local_audio_track->sendFrame(
      std::move(payload),
      rtc::FrameInfo(std::chrono::duration<double>(static_cast<double>(timestamp_us) / 1000000.0))
    );

    std::lock_guard<std::mutex> lock(mutex);
    snapshot.audio_frames_sent += 1;
    snapshot.audio_bytes_sent += static_cast<std::uint64_t>(frame.size());
    snapshot.reason = "audio-frame-sent";
    refresh_from_peer_connection_locked();
  }

  void set_decoder_state(
    bool decoder_ready,
    std::uint64_t decoded_frames_rendered,
    std::int64_t last_decoded_frame_at_unix_ms,
    const std::string& video_decoder_backend) {
    std::lock_guard<std::mutex> lock(mutex);
    snapshot.decoder_ready = decoder_ready;
    snapshot.decoded_frames_rendered = decoded_frames_rendered;
    snapshot.last_decoded_frame_at_unix_ms = last_decoded_frame_at_unix_ms;
    snapshot.video_decoder_backend = video_decoder_backend;
    snapshot.updated_at_unix_ms = current_time_millis();
    snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
    if (snapshot.media_plane_ready) {
      snapshot.reason = "native-render-active";
    }
  }

 private:
  std::optional<std::string> codec_profile_from_rtp_map(const rtc::Description::Media::RtpMap& rtp_map) const {
    if (!rtp_map.fmtps.empty()) {
      return rtp_map.fmtps.front();
    }
    return std::nullopt;
  }

  void install_inbound_video_track_callbacks(const std::shared_ptr<rtc::Track>& track) {
    if (!track) {
      return;
    }

    auto weak_self = weak_from_this();
    track->onOpen([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.remote_video_track_attached = true;
      if (self->snapshot.remote_track_count < 1) {
        self->snapshot.remote_track_count = 1;
      }
      self->snapshot.reason = "remote-video-track-open";
      self->snapshot.updated_at_unix_ms = current_time_millis();
      self->snapshot.media_plane_ready = self->snapshot.decoder_ready && self->snapshot.decoded_frames_rendered > 0;
    });
    track->onClosed([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.remote_video_track_attached = false;
      self->snapshot.updated_at_unix_ms = current_time_millis();
      self->snapshot.media_plane_ready = self->snapshot.decoder_ready && self->snapshot.decoded_frames_rendered > 0;
    });
    track->onFrame([weak_self](rtc::binary frame, rtc::FrameInfo info) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::vector<std::uint8_t> frame_copy;
      frame_copy.reserve(frame.size());
      for (const std::byte value : frame) {
        frame_copy.push_back(static_cast<std::uint8_t>(value));
      }

      std::string codec_copy;
      std::uint32_t timestamp = info.timestamp;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.remote_video_track_attached = true;
        if (self->snapshot.remote_track_count < 1) {
          self->snapshot.remote_track_count = 1;
        }
        self->snapshot.remote_video_frames_received += 1;
        self->snapshot.remote_video_bytes_received += static_cast<std::uint64_t>(frame.size());
        self->snapshot.last_remote_video_frame_at_unix_ms = current_time_millis();
        self->snapshot.reason = "remote-video-frame-received";
        self->snapshot.updated_at_unix_ms = self->snapshot.last_remote_video_frame_at_unix_ms;
        self->snapshot.media_plane_ready = self->snapshot.decoder_ready && self->snapshot.decoded_frames_rendered > 0;
        codec_copy = self->snapshot.video_codec;
      }

      if (self->callbacks.on_remote_video_frame) {
        self->callbacks.on_remote_video_frame(frame_copy, codec_copy, timestamp);
      }
    });
  }

  void install_inbound_audio_track_callbacks(const std::shared_ptr<rtc::Track>& track) {
    if (!track) {
      return;
    }

    auto weak_self = weak_from_this();
    track->onOpen([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.remote_audio_track_attached = true;
      self->snapshot.reason = "remote-audio-track-open";
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });
    track->onClosed([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.remote_audio_track_attached = false;
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });
    track->onFrame([weak_self](rtc::binary frame, rtc::FrameInfo info) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::vector<std::uint8_t> frame_copy;
      frame_copy.reserve(frame.size());
      for (const std::byte value : frame) {
        frame_copy.push_back(static_cast<std::uint8_t>(value));
      }

      std::string codec_copy;
      std::uint32_t timestamp = info.timestamp;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.remote_audio_track_attached = true;
        self->snapshot.remote_audio_frames_received += 1;
        self->snapshot.remote_audio_bytes_received += static_cast<std::uint64_t>(frame.size());
        self->snapshot.reason = "remote-audio-frame-received";
        self->snapshot.updated_at_unix_ms = current_time_millis();
        codec_copy = self->snapshot.audio_codec;
      }

      if (self->callbacks.on_remote_audio_frame) {
        self->callbacks.on_remote_audio_frame(frame_copy, codec_copy, timestamp);
      }
    });
  }

  void ensure_video_receiver_for_offer(const rtc::Description& remote_description) {
    if (!pc || inbound_video_track) {
      return;
    }

    for (int media_index = 0; media_index < remote_description.mediaCount(); ++media_index) {
      auto entry = remote_description.media(media_index);
      const auto* media_ptr = std::get_if<const rtc::Description::Media*>(&entry);
      if (!media_ptr || !*media_ptr) {
        continue;
      }

      const rtc::Description::Media& media = **media_ptr;
      if (media.type() != "video") {
        continue;
      }

      rtc::Description::Video receiver_description(
        media.mid().empty() ? "video" : media.mid(),
        rtc::Description::Direction::RecvOnly
      );

      bool codec_supported = false;
      std::string negotiated_codec;
      std::shared_ptr<rtc::MediaHandler> depacketizer;
      for (const int payload_type : media.payloadTypes()) {
        const auto* rtp_map = media.rtpMap(payload_type);
        if (!rtp_map) {
          continue;
        }

        const std::string format = to_lower_ascii(rtp_map->format);
        if (format == "h264") {
          receiver_description.addH264Codec(payload_type, codec_profile_from_rtp_map(*rtp_map));
          negotiated_codec = "h264";
          depacketizer = std::make_shared<rtc::H264RtpDepacketizer>(rtc::NalUnit::Separator::StartSequence);
          codec_supported = true;
          break;
        }
        if (format == "h265" || format == "hevc") {
          receiver_description.addH265Codec(payload_type, codec_profile_from_rtp_map(*rtp_map));
          negotiated_codec = "h265";
          depacketizer = std::make_shared<rtc::H265RtpDepacketizer>(rtc::NalUnit::Separator::StartSequence);
          codec_supported = true;
          break;
        }
      }

      if (!codec_supported) {
        if (callbacks.on_warning) {
          callbacks.on_warning("Remote offer included a video m-line, but it did not advertise an H.264/H.265 codec that the native receiver track can bind yet.");
        }
        return;
      }

      auto receiver_track = pc->addTrack(receiver_description);
      auto receiver_rtcp_session = std::make_shared<rtc::RtcpReceivingSession>();
      receiver_track->setMediaHandler(depacketizer);
      receiver_track->chainMediaHandler(receiver_rtcp_session);
      install_inbound_video_track_callbacks(receiver_track);

      std::lock_guard<std::mutex> lock(mutex);
      inbound_video_track = std::move(receiver_track);
      inbound_video_depacketizer = std::move(depacketizer);
      inbound_video_rtcp_session = std::move(receiver_rtcp_session);
      snapshot.video_receiver_configured = true;
      snapshot.remote_video_track_attached = true;
      if (snapshot.remote_track_count < 1) {
        snapshot.remote_track_count = 1;
      }
      snapshot.video_mid = media.mid().empty() ? "video" : media.mid();
      snapshot.video_codec = negotiated_codec;
      snapshot.codec_path = negotiated_codec;
      snapshot.video_decoder_backend = "none";
      snapshot.reason = "remote-video-track-configured";
      snapshot.updated_at_unix_ms = current_time_millis();
      snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
      return;
    }
  }

  void ensure_audio_receiver_for_offer(const rtc::Description& remote_description) {
    if (!pc || inbound_audio_track) {
      return;
    }

    for (int media_index = 0; media_index < remote_description.mediaCount(); ++media_index) {
      auto entry = remote_description.media(media_index);
      const auto* media_ptr = std::get_if<const rtc::Description::Media*>(&entry);
      if (!media_ptr || !*media_ptr) {
        continue;
      }

      const rtc::Description::Media& media = **media_ptr;
      if (media.type() != "audio") {
        continue;
      }

      rtc::Description::Audio receiver_description(
        media.mid().empty() ? "audio" : media.mid(),
        rtc::Description::Direction::RecvOnly
      );

      bool codec_supported = false;
      std::string negotiated_codec;
      std::shared_ptr<rtc::MediaHandler> depacketizer;
      for (const int payload_type : media.payloadTypes()) {
        const auto* rtp_map = media.rtpMap(payload_type);
        if (!rtp_map) {
          continue;
        }

        const std::string format = to_lower_ascii(rtp_map->format);
        if (format == "opus") {
          receiver_description.addOpusCodec(payload_type, codec_profile_from_rtp_map(*rtp_map));
          negotiated_codec = "opus";
          depacketizer = std::make_shared<OpusRtpDepacketizerCompat>(48000);
          codec_supported = true;
          break;
        }
        if (format == "pcmu") {
          receiver_description.addPCMUCodec(payload_type);
          negotiated_codec = "pcmu";
          depacketizer = std::make_shared<PcmuRtpDepacketizerCompat>(8000);
          codec_supported = true;
          break;
        }
      }

      if (!codec_supported) {
        if (callbacks.on_warning) {
          callbacks.on_warning("Remote offer included an audio m-line, but it did not advertise a native Opus-compatible codec path that the receiver can bind yet.");
        }
        return;
      }

      auto receiver_track = pc->addTrack(receiver_description);
      auto receiver_rtcp_session = std::make_shared<rtc::RtcpReceivingSession>();
      receiver_track->setMediaHandler(depacketizer);
      receiver_track->chainMediaHandler(receiver_rtcp_session);
      install_inbound_audio_track_callbacks(receiver_track);

      std::lock_guard<std::mutex> lock(mutex);
      inbound_audio_track = std::move(receiver_track);
      inbound_audio_depacketizer = std::move(depacketizer);
      inbound_audio_rtcp_session = std::move(receiver_rtcp_session);
      snapshot.audio_receiver_configured = true;
      snapshot.remote_audio_track_attached = true;
      snapshot.audio_mid = media.mid().empty() ? "audio" : media.mid();
      snapshot.audio_codec = negotiated_codec;
      snapshot.reason = "remote-audio-track-configured";
      snapshot.updated_at_unix_ms = current_time_millis();
      return;
    }
  }

  void install_callbacks() {
    auto weak_self = weak_from_this();

    pc->onLocalDescription([weak_self](rtc::Description description) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      PeerTransportSnapshot snapshot_copy;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.local_description_created = true;
        self->snapshot.local_description_type = to_description_type_string(description.type());
        self->snapshot.reason = "local-description-created";
        self->snapshot.last_error.clear();
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_local_description) {
        self->callbacks.on_local_description(snapshot_copy.local_description_type, std::string(description));
      }
      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, "local-description-created");
      }
    });

    pc->onLocalCandidate([weak_self](rtc::Candidate candidate) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::string candidate_mid;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.local_candidate_count += 1;
        self->snapshot.reason = "local-candidate-gathered";
        self->refresh_from_peer_connection_locked();
        candidate_mid = candidate.mid();
      }

      if (self->callbacks.on_local_candidate) {
        self->callbacks.on_local_candidate(candidate.candidate(), candidate_mid);
      }
    });

    pc->onStateChange([weak_self](rtc::PeerConnection::State state) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      PeerTransportSnapshot snapshot_copy;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.connection_state = to_connection_state_string(state);
        self->snapshot.reason = self->snapshot.connection_state;
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, to_logical_peer_state(state));
      }
    });

    pc->onIceStateChange([weak_self](rtc::PeerConnection::IceState state) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.ice_state = to_ice_state_string(state);
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });

    pc->onGatheringStateChange([weak_self](rtc::PeerConnection::GatheringState state) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.gathering_state = to_gathering_state_string(state);
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });

    pc->onSignalingStateChange([weak_self](rtc::PeerConnection::SignalingState state) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      std::lock_guard<std::mutex> lock(self->mutex);
      if (self->closed) {
        return;
      }
      self->snapshot.signaling_state = to_signaling_state_string(state);
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });

    pc->onDataChannel([weak_self](std::shared_ptr<rtc::DataChannel> data_channel_value) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->data_channel = data_channel_value;
        self->snapshot.data_channel_requested = true;
        self->snapshot.data_channel_label = data_channel_value ? data_channel_value->label() : "vds-control";
        self->snapshot.reason = "data-channel-attached";
        self->snapshot.updated_at_unix_ms = current_time_millis();
      }

      self->install_data_channel_callbacks(data_channel_value);
    });

    pc->onTrack([weak_self](std::shared_ptr<rtc::Track> track) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      bool install_video_callbacks = false;
      bool install_audio_callbacks = false;
      std::string track_type;
      std::string track_mid;
      if (track) {
        const auto description = track->description();
        track_type = to_lower_ascii(description.type());
        track_mid = description.mid();
      }
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.remote_track_count += 1;
        if (track) {
          if (track_type == "audio") {
            self->inbound_audio_track = track;
            self->snapshot.remote_audio_track_attached = true;
            self->snapshot.audio_receiver_configured = true;
            if (!track_mid.empty()) {
              self->snapshot.audio_mid = track_mid;
            }
            install_audio_callbacks = true;
          } else {
            self->inbound_video_track = track;
            self->snapshot.remote_video_track_attached = true;
            self->snapshot.video_receiver_configured = true;
            if (!track_mid.empty()) {
              self->snapshot.video_mid = track_mid;
            }
            install_video_callbacks = true;
          }
        }
        self->snapshot.reason = "remote-track-attached";
        self->snapshot.updated_at_unix_ms = current_time_millis();
      }

      if (install_video_callbacks) {
        self->install_inbound_video_track_callbacks(track);
      }
      if (install_audio_callbacks) {
        self->install_inbound_audio_track_callbacks(track);
      }
    });
  }

  void install_data_channel_callbacks(const std::shared_ptr<rtc::DataChannel>& data_channel_value) {
    if (!data_channel_value) {
      return;
    }

    auto weak_self = weak_from_this();

    data_channel_value->onOpen([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      PeerTransportSnapshot snapshot_copy;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.data_channel_open = true;
        self->snapshot.reason = "data-channel-open";
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, "connected");
      }
    });

    data_channel_value->onClosed([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      PeerTransportSnapshot snapshot_copy;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->closed) {
          return;
        }
        self->snapshot.data_channel_open = false;
        self->snapshot.reason = "data-channel-closed";
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, "disconnected");
      }
    });
  }

  void refresh_from_peer_connection() {
    std::lock_guard<std::mutex> lock(mutex);
    refresh_from_peer_connection_locked();
  }

  void refresh_from_peer_connection_locked() {
    snapshot.updated_at_unix_ms = current_time_millis();
    if (!pc) {
      return;
    }

    snapshot.connection_state = to_connection_state_string(pc->state());
    snapshot.ice_state = to_ice_state_string(pc->iceState());
    snapshot.gathering_state = to_gathering_state_string(pc->gatheringState());
    snapshot.signaling_state = to_signaling_state_string(pc->signalingState());
    snapshot.bytes_sent = static_cast<std::uint64_t>(pc->bytesSent());
    snapshot.bytes_received = static_cast<std::uint64_t>(pc->bytesReceived());

    const auto round_trip_time = pc->rtt();
    snapshot.round_trip_time_ms = round_trip_time.has_value()
      ? round_trip_time->count()
      : -1;

    rtc::Candidate local_candidate;
    rtc::Candidate remote_candidate;
    if (pc->getSelectedCandidatePair(&local_candidate, &remote_candidate)) {
      snapshot.selected_local_candidate = std::string(local_candidate);
      snapshot.selected_remote_candidate = std::string(remote_candidate);
    }

    if (data_channel) {
      snapshot.data_channel_open = data_channel->isOpen();
      snapshot.data_channel_label = data_channel->label();
    }
    snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
  }

  std::string peer_id;
  bool initiator = false;
  PeerTransportCallbacks callbacks;
  std::mutex mutex;
  PeerTransportSnapshot snapshot;
  bool closed = false;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::DataChannel> data_channel;
  std::shared_ptr<rtc::Track> video_track;
  std::shared_ptr<rtc::Track> audio_track;
  std::shared_ptr<rtc::Track> inbound_video_track;
  std::shared_ptr<rtc::Track> inbound_audio_track;
  std::shared_ptr<rtc::MediaHandler> inbound_video_depacketizer;
  std::shared_ptr<rtc::MediaHandler> inbound_audio_depacketizer;
  std::shared_ptr<rtc::RtcpReceivingSession> inbound_video_rtcp_session;
  std::shared_ptr<rtc::RtcpReceivingSession> inbound_audio_rtcp_session;
  std::shared_ptr<rtc::RtpPacketizationConfig> video_rtp_config;
  std::shared_ptr<rtc::RtpPacketizationConfig> audio_rtp_config;
};

#endif

PeerTransportBackendInfo get_peer_transport_backend_info() {
  PeerTransportBackendInfo info;
  info.ice_servers = default_ice_servers();
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  info.available = true;
  info.transport_ready = true;
  info.media_plane_ready = false;
  info.video_track_support = true;
  info.audio_track_support = true;
  info.backend = "libdatachannel";
  info.implementation = "libdatachannel-native-webrtc";
  info.mode = "manual-negotiation+h264-h265-sendrecv+opus-sendrecv+pcmu-fallback-recv+native-viewer-surface+native-preview-surface";
  info.reason = "libdatachannel-transport-ready-native-viewer-render-preview-and-opus-audio-available";
#else
  info.available = false;
  info.transport_ready = false;
  info.media_plane_ready = false;
  info.video_track_support = false;
  info.audio_track_support = false;
  info.backend = "stub";
  info.implementation = "stub-native-media-agent";
  info.mode = "disabled";
  info.reason = "libdatachannel-not-compiled";
#endif
  return info;
}

std::shared_ptr<PeerTransportSession> create_peer_transport_session(
  const std::string& peer_id,
  bool initiator,
  const PeerTransportCallbacks& callbacks,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  try {
    auto session = std::make_shared<PeerTransportSession>(peer_id, initiator, callbacks);
    session->initialize();
    return session;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return nullptr;
  }
#else
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  (void)peer_id;
  (void)initiator;
  (void)callbacks;
  return nullptr;
#endif
}

bool set_peer_transport_remote_description(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& type,
  const std::string& sdp,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->set_remote_description(type, sdp);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)type;
  (void)sdp;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool add_peer_transport_remote_candidate(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& candidate,
  const std::string& sdp_mid,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->add_remote_candidate(candidate, sdp_mid);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)candidate;
  (void)sdp_mid;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool ensure_peer_transport_local_description(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->ensure_local_description();
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool configure_peer_transport_video_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerVideoTrackConfig& config,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->configure_video_sender(config);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)config;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool configure_peer_transport_audio_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerAudioTrackConfig& config,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->configure_audio_sender(config);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)config;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool clear_peer_transport_video_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->clear_video_sender();
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool clear_peer_transport_audio_sender(
  const std::shared_ptr<PeerTransportSession>& session,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->clear_audio_sender();
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool send_peer_transport_video_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint64_t timestamp_us,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->send_video_frame(frame, codec, timestamp_us);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)frame;
  (void)codec;
  (void)timestamp_us;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool send_peer_transport_audio_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::vector<std::uint8_t>& frame,
  std::uint64_t timestamp_us,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->send_audio_frame(frame, timestamp_us);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)frame;
  (void)timestamp_us;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

bool set_peer_transport_decoder_state(
  const std::shared_ptr<PeerTransportSession>& session,
  bool decoder_ready,
  std::uint64_t decoded_frames_rendered,
  std::int64_t last_decoded_frame_at_unix_ms,
  const std::string& video_decoder_backend,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (!session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  try {
    session->set_decoder_state(
      decoder_ready,
      decoded_frames_rendered,
      last_decoded_frame_at_unix_ms,
      video_decoder_backend
    );
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)decoder_ready;
  (void)decoded_frames_rendered;
  (void)last_decoded_frame_at_unix_ms;
  (void)video_decoder_backend;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

void close_peer_transport_session(const std::shared_ptr<PeerTransportSession>& session) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (session) {
    session->close();
  }
#else
  (void)session;
#endif
}

PeerTransportSnapshot get_peer_transport_snapshot(const std::shared_ptr<PeerTransportSession>& session) {
  if (!session) {
    return {};
  }

#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  return session->get_snapshot();
#else
  return {};
#endif
}
