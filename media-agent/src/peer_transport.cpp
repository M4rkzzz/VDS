#include "peer_transport.h"
#include "time_utils.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <variant>

#include "json_protocol.h"

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
#include <rtc/plihandler.hpp>
#include <rtc/rtpdepacketizer.hpp>
#include <rtc/rtcpnackresponder.hpp>
#include <rtc/rtcpreceivingsession.hpp>
#include <rtc/rtppacketizationconfig.hpp>
#include <rtc/rtcpsrreporter.hpp>
#endif

namespace {

using vds::media_agent::current_time_millis;

std::atomic<std::uint32_t> g_next_video_ssrc { 0x24500000u };
std::atomic<std::uint32_t> g_next_audio_ssrc { 0x24600000u };

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

bool is_aac_audio_format_name(const std::string& format) {
  return format == "aac" || format == "mpeg4-generic" || format == "mp4a-latm";
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

class AacRtpDepacketizerCompat final : public rtc::RtpDepacketizer {
 public:
  explicit AacRtpDepacketizerCompat(std::uint32_t clock_rate = 48000)
    : rtc::RtpDepacketizer(clock_rate) {}
  ~AacRtpDepacketizerCompat() override = default;
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

std::string ensure_video_rtcp_feedback_lines(std::string sdp) {
  if (sdp.find("a=rtcp-fb:") != std::string::npos &&
      sdp.find(" nack") != std::string::npos &&
      sdp.find("nack pli") != std::string::npos) {
    return sdp;
  }

  std::size_t video_pos = sdp.find("m=video ");
  if (video_pos == std::string::npos) {
    return sdp;
  }
  std::size_t video_end = sdp.find("\r\nm=", video_pos + 1);
  const std::size_t insert_pos = video_end == std::string::npos ? sdp.size() : video_end + 2;
  const std::string video_section = sdp.substr(video_pos, insert_pos - video_pos);
  if (video_section.find("a=rtcp-fb:* nack") != std::string::npos &&
      video_section.find("a=rtcp-fb:* nack pli") != std::string::npos) {
    return sdp;
  }
  const std::string feedback = "a=rtcp-fb:* nack\r\na=rtcp-fb:* nack pli\r\n";
  sdp.insert(insert_pos, feedback);
  return sdp;
}

std::uint64_t count_nack_requested_packets(const rtc::message_vector& messages) {
  std::uint64_t requested = 0;
  for (const auto& message : messages) {
    if (!message || message->size() < 16) {
      continue;
    }
    std::size_t offset = 0;
    while (offset + 4 <= message->size()) {
      const auto byte_at = [&](std::size_t index) -> std::uint8_t {
        return std::to_integer<std::uint8_t>((*message)[index]);
      };
      const std::uint8_t fmt = byte_at(offset) & 0x1fu;
      const std::uint8_t packet_type = byte_at(offset + 1);
      const std::uint16_t length_words =
        static_cast<std::uint16_t>((byte_at(offset + 2) << 8u) | byte_at(offset + 3));
      const std::size_t packet_size = (static_cast<std::size_t>(length_words) + 1u) * 4u;
      if (packet_size < 4 || offset + packet_size > message->size()) {
        break;
      }
      if (packet_type == 205 && fmt == 1 && packet_size >= 16) {
        for (std::size_t part = offset + 12; part + 4 <= offset + packet_size; part += 4) {
          const std::uint16_t blp =
            static_cast<std::uint16_t>((byte_at(part + 2) << 8u) | byte_at(part + 3));
          requested += 1;
          for (int bit = 0; bit < 16; ++bit) {
            if ((blp & (1u << bit)) != 0) {
              requested += 1;
            }
          }
        }
      }
      offset += packet_size;
    }
  }
  return requested;
}

constexpr const char* kEncodedMediaDataChannelLabel = "vds-media-encoded-v1";
constexpr const char* kEncodedMediaProtocol = "vds-media-encoded-v1";
constexpr std::size_t kEncodedMediaFrameHeaderLimit = 16 * 1024;
constexpr std::size_t kEncodedMediaChunkPayloadBytes = 12 * 1024;

bool string_contains(const std::string& value, const std::string& needle) {
  return value.find(needle) != std::string::npos;
}

bool is_encoded_media_data_channel_label(const std::string& label) {
  return label == kEncodedMediaDataChannelLabel;
}

std::uint64_t extract_uint64_json_value(const std::string& json, const std::string& key, std::uint64_t fallback = 0) {
  const std::string pattern = "\"" + key + "\"";
  const std::size_t key_pos = json.find(pattern);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const std::size_t colon_pos = json.find(':', key_pos + pattern.size());
  if (colon_pos == std::string::npos) {
    return fallback;
  }
  std::size_t value_pos = colon_pos + 1;
  while (value_pos < json.size() && std::isspace(static_cast<unsigned char>(json[value_pos]))) {
    value_pos += 1;
  }
  std::size_t end_pos = value_pos;
  while (end_pos < json.size() && std::isdigit(static_cast<unsigned char>(json[end_pos]))) {
    end_pos += 1;
  }
  if (end_pos == value_pos) {
    return fallback;
  }
  try {
    return static_cast<std::uint64_t>(std::stoull(json.substr(value_pos, end_pos - value_pos)));
  } catch (...) {
    return fallback;
  }
}

std::string build_encoded_media_session_fields(const PeerTransportSnapshot& snapshot) {
  std::ostringstream fields;
  if (!snapshot.media_session_id.empty()) {
    fields << ",\"mediaSessionId\":\"" << vds::media_agent::json_escape(snapshot.media_session_id) << "\"";
  }
  if (snapshot.media_manifest_version > 0) {
    fields << ",\"manifestVersion\":" << snapshot.media_manifest_version;
  }
  return fields.str();
}

std::string build_encoded_media_hello(const PeerTransportSnapshot& snapshot) {
  return std::string("{\"protocol\":\"") + kEncodedMediaProtocol +
    "\",\"type\":\"hello\",\"protocolVersion\":1,\"role\":\"relay\",\"supportedVideoCodecs\":[\"h264\",\"h265\"],\"supportedAudioCodecs\":[\"opus\",\"aac\",\"pcmu\"],\"maxFrameBytes\":2097152,\"bootstrapRequired\":true" +
    build_encoded_media_session_fields(snapshot) + "}";
}

std::string build_encoded_media_hello_ack(const PeerTransportSnapshot& snapshot) {
  return std::string("{\"protocol\":\"") + kEncodedMediaProtocol +
    "\",\"type\":\"hello-ack\",\"protocolVersion\":1" +
    build_encoded_media_session_fields(snapshot) + "}";
}

std::string build_encoded_media_error(const std::string& reason) {
  return std::string("{\"protocol\":\"") + kEncodedMediaProtocol +
    "\",\"type\":\"error\",\"protocolVersion\":1,\"reason\":\"" +
    vds::media_agent::json_escape(reason) + "\"}";
}

bool decode_encoded_media_frame_message(
  const rtc::binary& payload,
  PeerEncodedMediaDataChannelFrame* decoded_frame,
  std::string* reason) {
  if (payload.size() < 8) {
    if (reason) {
      *reason = "datachannel-frame-invalid";
    }
    return false;
  }

  const auto byte_at = [&](std::size_t index) -> std::uint8_t {
    return std::to_integer<std::uint8_t>(payload[index]);
  };
  if (byte_at(0) != 'V' || byte_at(1) != 'D' || byte_at(2) != 'S' || byte_at(3) != '1') {
    if (reason) {
      *reason = "datachannel-frame-invalid-magic";
    }
    return false;
  }

  const std::uint32_t header_size =
    (static_cast<std::uint32_t>(byte_at(4)) << 24) |
    (static_cast<std::uint32_t>(byte_at(5)) << 16) |
    (static_cast<std::uint32_t>(byte_at(6)) << 8) |
    static_cast<std::uint32_t>(byte_at(7));
  if (header_size == 0 || header_size > kEncodedMediaFrameHeaderLimit || 8ull + header_size > payload.size()) {
    if (reason) {
      *reason = "datachannel-frame-invalid-header";
    }
    return false;
  }

  const std::string header(
    reinterpret_cast<const char*>(payload.data() + 8),
    reinterpret_cast<const char*>(payload.data() + 8 + header_size)
  );
  const std::string message_type = vds::media_agent::extract_string_value(header, "type");
  if (!string_contains(header, "\"protocol\":\"vds-media-encoded-v1\"") ||
      (message_type != "frame" && message_type != "chunk") ||
      !string_contains(header, "\"codec\"")) {
    if (reason) {
      *reason = "datachannel-frame-invalid-header";
    }
    return false;
  }

  if (decoded_frame) {
    decoded_frame->message_type = message_type;
    decoded_frame->stream_type = vds::media_agent::extract_string_value(header, "streamType");
    decoded_frame->codec = to_lower_ascii(vds::media_agent::extract_string_value(header, "codec"));
    decoded_frame->timestamp_us = extract_uint64_json_value(header, "timestampUs", 0);
    decoded_frame->sequence = extract_uint64_json_value(header, "sequence", 0);
    decoded_frame->keyframe = vds::media_agent::extract_bool_value(header, "keyframe", false);
    decoded_frame->config = vds::media_agent::extract_bool_value(header, "config", false);
    decoded_frame->frame_id = vds::media_agent::extract_string_value(header, "frameId");
    decoded_frame->chunk_index = extract_uint64_json_value(header, "chunkIndex", 0);
    decoded_frame->chunk_count = extract_uint64_json_value(header, "chunkCount", 0);
    decoded_frame->frame_payload_bytes = extract_uint64_json_value(header, "framePayloadBytes", 0);
    decoded_frame->payload.clear();
    decoded_frame->payload.reserve(payload.size() - 8 - header_size);
    for (std::size_t index = 8 + header_size; index < payload.size(); index += 1) {
      decoded_frame->payload.push_back(std::to_integer<std::uint8_t>(payload[index]));
    }
  }

  return true;
}

class CountingRtcpNackResponder final : public rtc::MediaHandler {
 public:
  CountingRtcpNackResponder(
    std::size_t max_size,
    std::function<void(std::uint64_t)> on_nack_retransmission_value
  ) : responder(std::make_shared<rtc::RtcpNackResponder>(max_size)),
      on_nack_retransmission(std::move(on_nack_retransmission_value)) {}

  void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
    const std::uint64_t requested = count_nack_requested_packets(messages);
    responder->incoming(messages, send);
    if (requested > 0 && on_nack_retransmission) {
      on_nack_retransmission(requested);
    }
  }

  void outgoing(rtc::message_vector& messages, const rtc::message_callback& send) override {
    responder->outgoing(messages, send);
  }

 private:
  std::shared_ptr<rtc::RtcpNackResponder> responder;
  std::function<void(std::uint64_t)> on_nack_retransmission;
};

}  // namespace

class PeerTransportSession final : public std::enable_shared_from_this<PeerTransportSession> {
 public:
  PeerTransportSession(
    std::string peer_id_value,
    bool initiator_value,
    PeerTransportCallbacks callbacks_value,
    bool encoded_media_data_channel_value
  ) : peer_id(std::move(peer_id_value)),
      initiator(initiator_value),
      callbacks(std::move(callbacks_value)),
      encoded_media_data_channel_requested(encoded_media_data_channel_value) {
    snapshot.available = true;
    snapshot.transport_ready = true;
    snapshot.video_track_support = true;
    snapshot.audio_track_support = true;
    snapshot.data_channel_requested = initiator;
    snapshot.encoded_media_data_channel_requested = encoded_media_data_channel_requested;
    if (encoded_media_data_channel_requested) {
      snapshot.data_channel_label = kEncodedMediaDataChannelLabel;
      snapshot.encoded_media_data_channel_supported = true;
      snapshot.encoded_media_data_channel_state = "requested";
    }
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

    if (initiator || encoded_media_data_channel_requested) {
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

    auto weak_self = weak_from_this();
    auto sender_reporter = std::make_shared<rtc::RtcpSrReporter>(rtp_config);
    auto nack_responder = std::make_shared<CountingRtcpNackResponder>(256, [weak_self](std::uint64_t count) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }
      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.nack_retransmissions += count;
      self->snapshot.reason = "nack-retransmit";
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });
    auto pli_handler = std::make_shared<rtc::PliHandler>([weak_self]() {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }
      std::lock_guard<std::mutex> lock(self->mutex);
      self->snapshot.pli_requests_received += 1;
      self->snapshot.reason = "pli-received";
      self->snapshot.updated_at_unix_ms = current_time_millis();
    });
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
    new_track->chainMediaHandler(nack_responder);
    new_track->chainMediaHandler(pli_handler);

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
    const bool use_aac = audio_codec == "aac";
    if (!use_opus && !use_pcmu && !use_aac) {
      throw std::runtime_error("only-opus-pcmu-and-aac-audio-sender-are-currently-supported");
    }

    if (use_opus) {
      description.addOpusCodec(config.payload_type > 0 ? config.payload_type : 111);
    } else if (use_aac) {
      description.addAACCodec(config.payload_type > 0 ? config.payload_type : 97);
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
      static_cast<std::uint8_t>(
        use_opus
          ? (config.payload_type > 0 ? config.payload_type : 111)
          : (use_aac ? (config.payload_type > 0 ? config.payload_type : 97) : (config.payload_type >= 0 ? config.payload_type : 0))
      ),
      use_opus
        ? rtc::OpusRtpPacketizer::DefaultClockRate
        : (use_aac ? static_cast<std::uint32_t>(config.sample_rate > 0 ? config.sample_rate : 48000) : rtc::PCMURtpPacketizer::DefaultClockRate)
    );
    rtp_config->mid = config.mid.empty() ? "audio" : config.mid;

    std::shared_ptr<rtc::MediaHandler> packetizer;
    if (use_opus) {
      packetizer = std::static_pointer_cast<rtc::MediaHandler>(std::make_shared<rtc::OpusRtpPacketizer>(rtp_config));
    } else if (use_aac) {
      packetizer = std::static_pointer_cast<rtc::MediaHandler>(std::make_shared<rtc::AACRtpPacketizer>(rtp_config));
    } else {
      packetizer = std::static_pointer_cast<rtc::MediaHandler>(std::make_shared<rtc::PCMURtpPacketizer>(rtp_config));
    }
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

  void send_encoded_media_frame(const PeerEncodedMediaDataChannelFrame& frame) {
    std::shared_ptr<rtc::DataChannel> local_data_channel;

    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!data_channel || !data_channel->isOpen()) {
        throw std::runtime_error("encoded-media-datachannel-not-open");
      }
      if (!snapshot.encoded_media_data_channel_ready) {
        throw std::runtime_error("encoded-media-datachannel-not-ready");
      }
      local_data_channel = data_channel;
    }

    const auto send_payload = [&local_data_channel, &frame](const std::string& message_type,
                                                            const std::vector<std::uint8_t>& bytes,
                                                            std::uint64_t sequence,
                                                            const std::string& frame_id,
                                                            std::size_t chunk_index,
                                                            std::size_t chunk_count,
                                                            std::size_t frame_payload_bytes) {
      std::string header =
      std::string("{\"protocol\":\"") + kEncodedMediaProtocol +
      "\",\"type\":\"" + message_type +
      "\",\"streamType\":\"" + vds::media_agent::json_escape(frame.stream_type) +
      "\",\"codec\":\"" + vds::media_agent::json_escape(frame.codec) +
      "\",\"payloadFormat\":\"annexb\",\"timestampUs\":" + std::to_string(frame.timestamp_us) +
      ",\"sequence\":" + std::to_string(sequence) +
      ",\"keyframe\":" + (frame.keyframe ? "true" : "false") +
      ",\"config\":" + (frame.config ? "true" : "false");
      if (message_type == "chunk") {
        header +=
          ",\"frameId\":\"" + vds::media_agent::json_escape(frame_id) +
          "\",\"chunkIndex\":" + std::to_string(chunk_index) +
          ",\"chunkCount\":" + std::to_string(chunk_count) +
          ",\"framePayloadBytes\":" + std::to_string(frame_payload_bytes);
      }
      header += "}";
      const std::uint32_t header_size = static_cast<std::uint32_t>(header.size());
      rtc::binary payload;
      payload.reserve(8 + header.size() + bytes.size());
      payload.push_back(static_cast<std::byte>('V'));
      payload.push_back(static_cast<std::byte>('D'));
      payload.push_back(static_cast<std::byte>('S'));
      payload.push_back(static_cast<std::byte>('1'));
      payload.push_back(static_cast<std::byte>((header_size >> 24) & 0xff));
      payload.push_back(static_cast<std::byte>((header_size >> 16) & 0xff));
      payload.push_back(static_cast<std::byte>((header_size >> 8) & 0xff));
      payload.push_back(static_cast<std::byte>(header_size & 0xff));
      for (const char ch : header) {
        payload.push_back(static_cast<std::byte>(static_cast<unsigned char>(ch)));
      }
      for (const std::uint8_t byte_value : bytes) {
        payload.push_back(static_cast<std::byte>(byte_value));
      }
      local_data_channel->send(std::move(payload));
    };

    if (frame.payload.size() <= kEncodedMediaChunkPayloadBytes) {
      send_payload("frame", frame.payload, frame.sequence, "", 0, 0, frame.payload.size());
    } else {
      const std::size_t chunk_count =
        (frame.payload.size() + kEncodedMediaChunkPayloadBytes - 1) / kEncodedMediaChunkPayloadBytes;
      const std::string frame_id =
        frame.stream_type + ":" + std::to_string(frame.timestamp_us) + ":" +
        std::to_string(frame.sequence) + ":" + std::to_string(frame.payload.size());
      for (std::size_t chunk_index = 0; chunk_index < chunk_count; ++chunk_index) {
        const std::size_t start = chunk_index * kEncodedMediaChunkPayloadBytes;
        const std::size_t end = std::min(frame.payload.size(), start + kEncodedMediaChunkPayloadBytes);
        std::vector<std::uint8_t> chunk(frame.payload.begin() + start, frame.payload.begin() + end);
        send_payload(
          "chunk",
          chunk,
          frame.sequence,
          frame_id,
          chunk_index,
          chunk_count,
          frame.payload.size()
        );
      }
    }

    std::lock_guard<std::mutex> lock(mutex);
    snapshot.encoded_media_data_channel_frames_sent += 1;
    snapshot.encoded_media_data_channel_bytes_sent += static_cast<std::uint64_t>(frame.payload.size());
    snapshot.encoded_media_data_channel_state = "frame-sent";
    snapshot.reason = "encoded-media-datachannel-frame-sent";
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

  void set_media_manifest(std::string media_session_id, int manifest_version) {
    std::lock_guard<std::mutex> lock(mutex);
    snapshot.media_session_id = std::move(media_session_id);
    snapshot.media_manifest_version = manifest_version;
    snapshot.updated_at_unix_ms = current_time_millis();
  }

  void request_keyframe(const std::string& reason) {
    std::shared_ptr<rtc::Track> local_inbound_video_track;
    {
      std::lock_guard<std::mutex> lock(mutex);
      local_inbound_video_track = inbound_video_track;
      snapshot.keyframe_requests_sent += 1;
      if (reason == "decoder-recovery" || reason == "waiting-for-random-access") {
        snapshot.decoder_recovery_count += 1;
      }
      snapshot.reason = reason.empty() ? "keyframe-requested" : reason;
      snapshot.updated_at_unix_ms = current_time_millis();
    }
    if (local_inbound_video_track) {
      local_inbound_video_track->requestKeyframe();
    }
  }

  void add_dropped_video_units(std::uint64_t count) {
    if (count == 0) {
      return;
    }
    std::lock_guard<std::mutex> lock(mutex);
    snapshot.dropped_video_units += count;
    snapshot.updated_at_unix_ms = current_time_millis();
  }

 private:
  struct PendingEncodedMediaChunkFrame {
    PeerEncodedMediaDataChannelFrame header;
    std::vector<std::vector<std::uint8_t>> chunks;
    std::size_t received_count = 0;
    std::size_t payload_bytes = 0;
    std::int64_t created_at_unix_ms = 0;
  };

  bool decode_or_reassemble_encoded_media_frame(
    const rtc::binary& payload,
    PeerEncodedMediaDataChannelFrame* decoded_frame,
    std::string* reason) {
    PeerEncodedMediaDataChannelFrame parsed;
    if (!decode_encoded_media_frame_message(payload, &parsed, reason)) {
      return false;
    }
    if (parsed.message_type == "frame") {
      if (decoded_frame) {
        *decoded_frame = std::move(parsed);
      }
      return true;
    }
    if (parsed.frame_id.empty() ||
        parsed.chunk_count == 0 ||
        parsed.chunk_index >= parsed.chunk_count ||
        parsed.frame_payload_bytes == 0 ||
        parsed.frame_payload_bytes > 2ull * 1024ull * 1024ull) {
      if (reason) {
        *reason = "datachannel-chunk-invalid-header";
      }
      return false;
    }

    const std::int64_t now_ms = current_time_millis();
    for (auto it = pending_encoded_media_chunks.begin(); it != pending_encoded_media_chunks.end();) {
      if (now_ms - it->second.created_at_unix_ms > 10000) {
        it = pending_encoded_media_chunks.erase(it);
      } else {
        ++it;
      }
    }

    auto& entry = pending_encoded_media_chunks[parsed.frame_id];
    if (entry.chunks.empty()) {
      entry.header = parsed;
      entry.header.message_type = "frame";
      entry.header.frame_id.clear();
      entry.header.chunk_index = 0;
      entry.header.chunk_count = 0;
      entry.header.frame_payload_bytes = 0;
      entry.header.payload.clear();
      entry.chunks.resize(static_cast<std::size_t>(parsed.chunk_count));
      entry.payload_bytes = static_cast<std::size_t>(parsed.frame_payload_bytes);
      entry.created_at_unix_ms = now_ms;
    }
    if (entry.chunks.size() != static_cast<std::size_t>(parsed.chunk_count) ||
        entry.payload_bytes != static_cast<std::size_t>(parsed.frame_payload_bytes)) {
      pending_encoded_media_chunks.erase(parsed.frame_id);
      if (reason) {
        *reason = "datachannel-chunk-mismatch";
      }
      return false;
    }

    const std::size_t chunk_index = static_cast<std::size_t>(parsed.chunk_index);
    if (entry.chunks[chunk_index].empty()) {
      entry.chunks[chunk_index] = std::move(parsed.payload);
      entry.received_count += 1;
    }
    if (entry.received_count != entry.chunks.size()) {
      if (reason) {
        *reason = "datachannel-chunk-pending";
      }
      return false;
    }

    entry.header.payload.clear();
    entry.header.payload.reserve(entry.payload_bytes);
    for (const auto& chunk : entry.chunks) {
      entry.header.payload.insert(entry.header.payload.end(), chunk.begin(), chunk.end());
    }
    if (entry.header.payload.size() != entry.payload_bytes) {
      pending_encoded_media_chunks.erase(parsed.frame_id);
      if (reason) {
        *reason = "datachannel-chunk-size-mismatch";
      }
      return false;
    }

    if (decoded_frame) {
      *decoded_frame = std::move(entry.header);
    }
    pending_encoded_media_chunks.erase(parsed.frame_id);
    return true;
  }

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
        if (is_aac_audio_format_name(format)) {
          receiver_description.addAACCodec(payload_type, codec_profile_from_rtp_map(*rtp_map));
          negotiated_codec = "aac";
          depacketizer = std::make_shared<AacRtpDepacketizerCompat>(
            rtp_map->clockRate > 0 ? static_cast<std::uint32_t>(rtp_map->clockRate) : 48000
          );
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
          callbacks.on_warning("Remote offer included an audio m-line, but it did not advertise a native Opus/PCMU/AAC codec path that the receiver can bind yet.");
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
        self->callbacks.on_local_description(
          snapshot_copy.local_description_type,
          ensure_video_rtcp_feedback_lines(std::string(description))
        );
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
        if (data_channel_value && is_encoded_media_data_channel_label(data_channel_value->label())) {
          self->snapshot.encoded_media_data_channel_supported = true;
          self->snapshot.encoded_media_data_channel_state = "attached";
        }
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

    data_channel_value->onOpen([weak_self, data_channel_value]() {
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
        if (is_encoded_media_data_channel_label(self->snapshot.data_channel_label)) {
          self->snapshot.encoded_media_data_channel_open = true;
          self->snapshot.encoded_media_data_channel_supported = true;
          self->snapshot.encoded_media_data_channel_state = "open";
        }
        self->snapshot.reason = "data-channel-open";
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, "connected");
      }
      if (is_encoded_media_data_channel_label(snapshot_copy.data_channel_label) && data_channel_value && data_channel_value->isOpen()) {
        data_channel_value->send(build_encoded_media_hello(snapshot_copy));
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
        if (is_encoded_media_data_channel_label(self->snapshot.data_channel_label)) {
          self->snapshot.encoded_media_data_channel_open = false;
          self->snapshot.encoded_media_data_channel_ready = false;
          self->snapshot.encoded_media_data_channel_state = "closed";
        }
        self->snapshot.reason = "data-channel-closed";
        self->refresh_from_peer_connection_locked();
        snapshot_copy = self->snapshot;
      }

      if (self->callbacks.on_state_change) {
        self->callbacks.on_state_change(snapshot_copy, "disconnected");
      }
    });

    data_channel_value->onMessage([weak_self, data_channel_value](rtc::message_variant message) {
      auto self = weak_self.lock();
      if (!self) {
        return;
      }

      const std::string label = data_channel_value ? data_channel_value->label() : "";
      if (!is_encoded_media_data_channel_label(label)) {
        return;
      }

      if (std::holds_alternative<std::string>(message)) {
        const std::string text = std::get<std::string>(message);
        bool send_ack = false;
        bool send_version_error = false;
        bool send_session_error = false;
        std::string session_error;
        PeerTransportSnapshot snapshot_copy;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->closed) {
            return;
          }
          self->snapshot.encoded_media_data_channel_messages_received += 1;
          self->snapshot.encoded_media_data_channel_supported = true;
          self->snapshot.encoded_media_data_channel_open = true;
          if (string_contains(text, "\"protocol\":\"vds-media-encoded-v1\"") &&
              string_contains(text, "\"type\":\"hello\"")) {
            if (string_contains(text, "\"protocolVersion\":1")) {
              const std::string remote_session_id = vds::media_agent::extract_string_value(text, "mediaSessionId");
              const int remote_manifest_version = vds::media_agent::extract_int_value(text, "manifestVersion", 0);
              if (!self->snapshot.media_session_id.empty() &&
                  !remote_session_id.empty() &&
                  remote_session_id != self->snapshot.media_session_id) {
                session_error = "datachannel-media-session-mismatch";
                send_session_error = true;
              } else if (self->snapshot.media_manifest_version > 0 &&
                         remote_manifest_version > 0 &&
                         remote_manifest_version != self->snapshot.media_manifest_version) {
                session_error = "datachannel-media-manifest-version-mismatch";
                send_session_error = true;
              }
              if (send_session_error) {
                self->snapshot.encoded_media_data_channel_ready = false;
                self->snapshot.encoded_media_data_channel_state = session_error;
                self->snapshot.last_error = session_error;
              } else {
                self->snapshot.encoded_media_data_channel_ready = true;
                self->snapshot.encoded_media_data_channel_state = "hello-ack";
                self->snapshot.reason = "encoded-media-datachannel-ready";
                send_ack = true;
              }
            } else {
              self->snapshot.encoded_media_data_channel_state = "version-mismatch";
              self->snapshot.last_error = "datachannel-version-mismatch";
              send_version_error = true;
            }
          } else if (string_contains(text, "\"type\":\"hello-ack\"")) {
            const std::string remote_session_id = vds::media_agent::extract_string_value(text, "mediaSessionId");
            const int remote_manifest_version = vds::media_agent::extract_int_value(text, "manifestVersion", 0);
            if (!self->snapshot.media_session_id.empty() &&
                !remote_session_id.empty() &&
                remote_session_id != self->snapshot.media_session_id) {
              session_error = "datachannel-media-session-mismatch";
              send_session_error = true;
            } else if (self->snapshot.media_manifest_version > 0 &&
                       remote_manifest_version > 0 &&
                       remote_manifest_version != self->snapshot.media_manifest_version) {
              session_error = "datachannel-media-manifest-version-mismatch";
              send_session_error = true;
            }
            if (send_session_error) {
              self->snapshot.encoded_media_data_channel_ready = false;
              self->snapshot.encoded_media_data_channel_state = session_error;
              self->snapshot.last_error = session_error;
            } else {
              self->snapshot.encoded_media_data_channel_ready = true;
              self->snapshot.encoded_media_data_channel_state = "ready";
              self->snapshot.reason = "encoded-media-datachannel-ready";
            }
          } else if (string_contains(text, "\"type\":\"error\"")) {
            self->snapshot.encoded_media_data_channel_state = "remote-error";
            self->snapshot.last_error = "datachannel-remote-error";
          }
          self->snapshot.updated_at_unix_ms = current_time_millis();
          snapshot_copy = self->snapshot;
        }

        if (send_ack && data_channel_value && data_channel_value->isOpen()) {
          data_channel_value->send(build_encoded_media_hello_ack(snapshot_copy));
        } else if (send_version_error && data_channel_value && data_channel_value->isOpen()) {
          data_channel_value->send(build_encoded_media_error("datachannel-version-mismatch"));
        } else if (send_session_error && data_channel_value && data_channel_value->isOpen()) {
          data_channel_value->send(build_encoded_media_error(session_error));
        }
        if (self->callbacks.on_state_change) {
          self->callbacks.on_state_change(snapshot_copy, snapshot_copy.encoded_media_data_channel_state);
        }
        return;
      }

      if (std::holds_alternative<rtc::binary>(message)) {
        const rtc::binary& payload = std::get<rtc::binary>(message);
        std::string invalid_reason;
        PeerEncodedMediaDataChannelFrame decoded_frame;
        const bool valid_frame = self->decode_or_reassemble_encoded_media_frame(payload, &decoded_frame, &invalid_reason);
        const bool chunk_pending = invalid_reason == "datachannel-chunk-pending";
        PeerTransportSnapshot snapshot_copy;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->closed) {
            return;
          }
          self->snapshot.encoded_media_data_channel_messages_received += 1;
          self->snapshot.encoded_media_data_channel_bytes_received += static_cast<std::uint64_t>(payload.size());
          self->snapshot.encoded_media_data_channel_supported = true;
          self->snapshot.encoded_media_data_channel_open = true;
          if (valid_frame) {
            self->snapshot.encoded_media_data_channel_frames_received += 1;
            if (decoded_frame.stream_type == "video") {
              self->snapshot.remote_video_frames_received += 1;
              self->snapshot.remote_video_bytes_received += static_cast<std::uint64_t>(decoded_frame.payload.size());
            } else if (decoded_frame.stream_type == "audio") {
              self->snapshot.remote_audio_frames_received += 1;
              self->snapshot.remote_audio_bytes_received += static_cast<std::uint64_t>(decoded_frame.payload.size());
            }
            self->snapshot.encoded_media_data_channel_state = "frame-received";
            self->snapshot.reason = "encoded-media-datachannel-frame-received";
          } else if (chunk_pending) {
            self->snapshot.encoded_media_data_channel_state = "chunk-received";
            self->snapshot.reason = "encoded-media-datachannel-chunk-received";
          } else {
            self->snapshot.encoded_media_data_channel_invalid_frames += 1;
            self->snapshot.encoded_media_data_channel_state = invalid_reason;
            self->snapshot.last_error = invalid_reason;
          }
          self->snapshot.updated_at_unix_ms = current_time_millis();
          snapshot_copy = self->snapshot;
        }

        if (!valid_frame && !chunk_pending && data_channel_value && data_channel_value->isOpen()) {
          data_channel_value->send(build_encoded_media_error(invalid_reason));
        }
        if (valid_frame && self->callbacks.on_encoded_media_data_channel_frame) {
          self->callbacks.on_encoded_media_data_channel_frame(decoded_frame);
        }
        if (self->callbacks.on_state_change) {
          self->callbacks.on_state_change(snapshot_copy, snapshot_copy.encoded_media_data_channel_state);
        }
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
      if (is_encoded_media_data_channel_label(snapshot.data_channel_label)) {
        snapshot.encoded_media_data_channel_supported = true;
        snapshot.encoded_media_data_channel_open = data_channel->isOpen();
      }
    }
    snapshot.media_plane_ready = snapshot.decoder_ready && snapshot.decoded_frames_rendered > 0;
  }

  std::string peer_id;
  bool initiator = false;
  bool encoded_media_data_channel_requested = false;
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
  std::map<std::string, PendingEncodedMediaChunkFrame> pending_encoded_media_chunks;
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
  info.mode = "manual-negotiation+h264-h265-sendrecv+opus-aac-sendrecv+pcmu-fallback-recv+native-viewer-surface+native-preview-surface";
  info.reason = "libdatachannel-transport-ready-native-viewer-render-preview-and-opus-aac-audio-available";
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
  bool encoded_media_data_channel,
  std::string* error
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  try {
    auto session = std::make_shared<PeerTransportSession>(peer_id, initiator, callbacks, encoded_media_data_channel);
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
  (void)encoded_media_data_channel;
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

bool send_peer_transport_encoded_media_frame(
  const std::shared_ptr<PeerTransportSession>& session,
  const PeerEncodedMediaDataChannelFrame& frame,
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
    session->send_encoded_media_frame(frame);
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

bool request_peer_transport_keyframe(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& reason,
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
    session->request_keyframe(reason);
    return true;
  } catch (const std::exception& ex) {
    if (error) {
      *error = ex.what();
    }
    return false;
  }
#else
  (void)session;
  (void)reason;
  if (error) {
    *error = "libdatachannel backend is not compiled into this media-agent build";
  }
  return false;
#endif
}

void set_peer_transport_media_manifest(
  const std::shared_ptr<PeerTransportSession>& session,
  const std::string& media_session_id,
  int manifest_version
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (session) {
    session->set_media_manifest(media_session_id, manifest_version);
  }
#else
  (void)session;
  (void)media_session_id;
  (void)manifest_version;
#endif
}

void add_peer_transport_dropped_video_units(
  const std::shared_ptr<PeerTransportSession>& session,
  std::uint64_t count
) {
#ifdef VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL
  if (session) {
    session->add_dropped_video_units(count);
  }
#else
  (void)session;
  (void)count;
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

std::string peer_transport_backend_json(const PeerTransportBackendInfo& backend) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (backend.available ? "true" : "false")
    << ",\"transportReady\":" << (backend.transport_ready ? "true" : "false")
    << ",\"mediaPlaneReady\":" << (backend.media_plane_ready ? "true" : "false")
    << ",\"videoTrackSupport\":" << (backend.video_track_support ? "true" : "false")
    << ",\"audioTrackSupport\":" << (backend.audio_track_support ? "true" : "false")
    << ",\"backend\":\"" << vds::media_agent::json_escape(backend.backend) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(backend.implementation) << "\""
    << ",\"mode\":\"" << vds::media_agent::json_escape(backend.mode) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(backend.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(backend.last_error) << "\""
    << ",\"iceServers\":" << vds::media_agent::json_array_from_strings(backend.ice_servers)
    << "}";
  return payload.str();
}

std::string peer_transport_snapshot_json(const PeerTransportSnapshot& snapshot) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (snapshot.available ? "true" : "false")
    << ",\"transportReady\":" << (snapshot.transport_ready ? "true" : "false")
    << ",\"mediaPlaneReady\":" << (snapshot.media_plane_ready ? "true" : "false")
    << ",\"videoTrackSupport\":" << (snapshot.video_track_support ? "true" : "false")
    << ",\"audioTrackSupport\":" << (snapshot.audio_track_support ? "true" : "false")
    << ",\"videoTrackConfigured\":" << (snapshot.video_track_configured ? "true" : "false")
    << ",\"audioTrackConfigured\":" << (snapshot.audio_track_configured ? "true" : "false")
    << ",\"videoReceiverConfigured\":" << (snapshot.video_receiver_configured ? "true" : "false")
    << ",\"audioReceiverConfigured\":" << (snapshot.audio_receiver_configured ? "true" : "false")
    << ",\"videoTrackOpen\":" << (snapshot.video_track_open ? "true" : "false")
    << ",\"audioTrackOpen\":" << (snapshot.audio_track_open ? "true" : "false")
    << ",\"decoderReady\":" << (snapshot.decoder_ready ? "true" : "false")
    << ",\"remoteVideoTrackAttached\":" << (snapshot.remote_video_track_attached ? "true" : "false")
    << ",\"remoteAudioTrackAttached\":" << (snapshot.remote_audio_track_attached ? "true" : "false")
    << ",\"localDescriptionCreated\":" << (snapshot.local_description_created ? "true" : "false")
    << ",\"remoteDescriptionSet\":" << (snapshot.remote_description_set ? "true" : "false")
    << ",\"dataChannelRequested\":" << (snapshot.data_channel_requested ? "true" : "false")
    << ",\"dataChannelOpen\":" << (snapshot.data_channel_open ? "true" : "false")
    << ",\"encodedMediaDataChannelRequested\":" << (snapshot.encoded_media_data_channel_requested ? "true" : "false")
    << ",\"encodedMediaDataChannelSupported\":" << (snapshot.encoded_media_data_channel_supported ? "true" : "false")
    << ",\"encodedMediaDataChannelOpen\":" << (snapshot.encoded_media_data_channel_open ? "true" : "false")
    << ",\"encodedMediaDataChannelReady\":" << (snapshot.encoded_media_data_channel_ready ? "true" : "false")
    << ",\"closed\":" << (snapshot.closed ? "true" : "false")
    << ",\"localCandidateCount\":" << snapshot.local_candidate_count
    << ",\"remoteCandidateCount\":" << snapshot.remote_candidate_count
    << ",\"remoteTrackCount\":" << snapshot.remote_track_count
    << ",\"bytesSent\":" << snapshot.bytes_sent
    << ",\"bytesReceived\":" << snapshot.bytes_received
    << ",\"videoFramesSent\":" << snapshot.video_frames_sent
    << ",\"videoBytesSent\":" << snapshot.video_bytes_sent
    << ",\"audioFramesSent\":" << snapshot.audio_frames_sent
    << ",\"audioBytesSent\":" << snapshot.audio_bytes_sent
    << ",\"remoteVideoFramesReceived\":" << snapshot.remote_video_frames_received
    << ",\"remoteVideoBytesReceived\":" << snapshot.remote_video_bytes_received
    << ",\"remoteAudioFramesReceived\":" << snapshot.remote_audio_frames_received
    << ",\"remoteAudioBytesReceived\":" << snapshot.remote_audio_bytes_received
    << ",\"encodedMediaDataChannelMessagesReceived\":" << snapshot.encoded_media_data_channel_messages_received
    << ",\"encodedMediaDataChannelFramesSent\":" << snapshot.encoded_media_data_channel_frames_sent
    << ",\"encodedMediaDataChannelBytesSent\":" << snapshot.encoded_media_data_channel_bytes_sent
    << ",\"encodedMediaDataChannelFramesReceived\":" << snapshot.encoded_media_data_channel_frames_received
    << ",\"encodedMediaDataChannelBytesReceived\":" << snapshot.encoded_media_data_channel_bytes_received
    << ",\"encodedMediaDataChannelInvalidFrames\":" << snapshot.encoded_media_data_channel_invalid_frames
    << ",\"decodedFramesRendered\":" << snapshot.decoded_frames_rendered
    << ",\"nackRetransmissions\":" << snapshot.nack_retransmissions
    << ",\"pliRequestsReceived\":" << snapshot.pli_requests_received
    << ",\"keyframeRequestsSent\":" << snapshot.keyframe_requests_sent
    << ",\"decoderRecoveryCount\":" << snapshot.decoder_recovery_count
    << ",\"droppedVideoUnits\":" << snapshot.dropped_video_units
    << ",\"connectionState\":\"" << vds::media_agent::json_escape(snapshot.connection_state) << "\""
    << ",\"iceState\":\"" << vds::media_agent::json_escape(snapshot.ice_state) << "\""
    << ",\"gatheringState\":\"" << vds::media_agent::json_escape(snapshot.gathering_state) << "\""
    << ",\"signalingState\":\"" << vds::media_agent::json_escape(snapshot.signaling_state) << "\""
    << ",\"localDescriptionType\":\"" << vds::media_agent::json_escape(snapshot.local_description_type) << "\""
    << ",\"dataChannelLabel\":\"" << vds::media_agent::json_escape(snapshot.data_channel_label) << "\""
    << ",\"encodedMediaDataChannelProtocol\":\"" << vds::media_agent::json_escape(snapshot.encoded_media_data_channel_protocol) << "\""
    << ",\"encodedMediaDataChannelState\":\"" << vds::media_agent::json_escape(snapshot.encoded_media_data_channel_state) << "\""
    << ",\"mediaSessionId\":\"" << vds::media_agent::json_escape(snapshot.media_session_id) << "\""
    << ",\"mediaManifestVersion\":" << snapshot.media_manifest_version
    << ",\"videoMid\":\"" << vds::media_agent::json_escape(snapshot.video_mid) << "\""
    << ",\"audioMid\":\"" << vds::media_agent::json_escape(snapshot.audio_mid) << "\""
    << ",\"videoCodec\":\"" << vds::media_agent::json_escape(snapshot.video_codec) << "\""
    << ",\"audioCodec\":\"" << vds::media_agent::json_escape(snapshot.audio_codec) << "\""
    << ",\"codecPath\":\"" << vds::media_agent::json_escape(snapshot.codec_path) << "\""
    << ",\"videoDecoderBackend\":\"" << vds::media_agent::json_escape(snapshot.video_decoder_backend) << "\""
    << ",\"videoSource\":\"" << vds::media_agent::json_escape(snapshot.video_source) << "\""
    << ",\"selectedLocalCandidate\":\"" << vds::media_agent::json_escape(snapshot.selected_local_candidate) << "\""
    << ",\"selectedRemoteCandidate\":\"" << vds::media_agent::json_escape(snapshot.selected_remote_candidate) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(snapshot.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(snapshot.last_error) << "\""
    << ",\"roundTripTimeMs\":";

  vds::media_agent::append_nullable_int64(payload, snapshot.round_trip_time_ms);
  payload << ",\"createdAtMs\":";
  vds::media_agent::append_nullable_int64(payload, snapshot.created_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, snapshot.updated_at_unix_ms);
  payload << ",\"lastVideoFrameAtMs\":";
  vds::media_agent::append_nullable_int64(payload, snapshot.last_video_frame_at_unix_ms);
  payload << ",\"lastRemoteVideoFrameAtMs\":";
  vds::media_agent::append_nullable_int64(payload, snapshot.last_remote_video_frame_at_unix_ms);
  payload << ",\"lastDecodedFrameAtMs\":";
  vds::media_agent::append_nullable_int64(payload, snapshot.last_decoded_frame_at_unix_ms);
  payload << "}";
  return payload.str();
}
