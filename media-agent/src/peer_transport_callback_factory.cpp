#include "peer_transport_callback_factory.h"

#include <cstdint>
#include <mutex>
#include <vector>

#include "agent_events.h"
#include "json_protocol.h"
#include "peer_media_manifest.h"
#include "peer_session_state.h"
#include "peer_state_json.h"
#include "viewer_audio_session.h"
#include "viewer_video_pipeline.h"

namespace vds::media_agent {
namespace {

std::uint32_t datachannel_timestamp_to_rtp(
  std::uint64_t timestamp_us,
  const std::string& stream_type,
  const std::string& codec) {
  const std::uint64_t clock_rate =
    stream_type == "audio"
      ? (codec == "pcmu" ? 8000ull : 48000ull)
      : 90000ull;
  return static_cast<std::uint32_t>((timestamp_us * clock_rate) / 1000000ull);
}

}  // namespace

PeerTransportCallbacks create_peer_transport_callbacks(const PeerTransportCallbackContext& context) {
  PeerTransportCallbacks callbacks;
  callbacks.on_local_description = [peer_id = context.peer_id](const std::string& type, const std::string& sdp) {
    emit_event(
      "signal",
      std::string("{\"peerId\":\"") + json_escape(peer_id) +
        "\",\"targetId\":\"" + json_escape(peer_id) +
        "\",\"type\":\"" + json_escape(type) +
        "\",\"sdp\":{\"type\":\"" + json_escape(type) +
        "\",\"sdp\":\"" + json_escape(sdp) +
        "\"},\"transportReady\":true,\"trickleIce\":true}"
    );
  };
  callbacks.on_local_candidate = [peer_id = context.peer_id](const std::string& candidate, const std::string& sdp_mid) {
    emit_event(
      "signal",
      std::string("{\"peerId\":\"") + json_escape(peer_id) +
        "\",\"targetId\":\"" + json_escape(peer_id) +
        "\",\"type\":\"candidate\",\"candidate\":{\"candidate\":\"" + json_escape(candidate) +
        "\",\"sdpMid\":\"" + json_escape(sdp_mid) +
        "\",\"sdpMLineIndex\":0},\"transportReady\":true,\"trickleIce\":true}"
    );
  };
  callbacks.on_state_change = [
    peer_id = context.peer_id,
    role = context.role,
    initiator = context.initiator
  ](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
    PeerState event_peer;
    event_peer.peer_id = peer_id;
    event_peer.role = role;
    event_peer.initiator = initiator;
    event_peer.transport = snapshot;
    emit_event("peer-state", build_peer_state_json(event_peer, logical_state));
  };
  callbacks.on_warning = [peer_id = context.peer_id](const std::string& message) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer_id) +
        "\",\"message\":\"" + json_escape(message) + "\"}"
    );
  };
  callbacks.on_remote_video_frame = [
    peer_id = context.peer_id,
    receiver_runtime = context.receiver_runtime,
    transport_session_holder = context.transport_session_holder
  ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
    consume_remote_peer_video_frame(
      peer_id,
      receiver_runtime,
      transport_session_holder->lock(),
      frame,
      codec,
      rtp_timestamp
    );
  };  
  callbacks.on_remote_audio_frame = [
    peer_id = context.peer_id,
    receiver_runtime = context.receiver_runtime
  ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
    ViewerAudioSession viewer_audio;
    viewer_audio.consume_remote_peer_frame(peer_id, receiver_runtime, frame, codec, rtp_timestamp);
  };  
  callbacks.on_encoded_media_data_channel_frame = [
    peer_id = context.peer_id,
    expected_video_codec = context.expected_video_codec,
    expected_audio_codec = context.expected_audio_codec,
    receiver_runtime = context.receiver_runtime,
    transport_session_holder = context.transport_session_holder
  ](const PeerEncodedMediaDataChannelFrame& encoded_frame) {
    const std::string default_codec = encoded_frame.stream_type == "audio" ? "opus" : "h264";
    const std::string frame_codec = normalize_manifest_codec(encoded_frame.codec.empty() ? default_codec : encoded_frame.codec);
    std::string manifest_error;
    if (encoded_frame.stream_type == "video" && !expected_video_codec.empty() && frame_codec != expected_video_codec) {
      manifest_error = "media-manifest-video-codec-mismatch";
    } else if (encoded_frame.stream_type == "audio" && !expected_audio_codec.empty() && frame_codec != expected_audio_codec) {
      manifest_error = "media-manifest-audio-codec-mismatch";
    }
    if (!manifest_error.empty()) {
      {
        std::lock_guard<std::mutex> lock(receiver_runtime->mutex);
        receiver_runtime->last_error = manifest_error;
        receiver_runtime->reason = manifest_error;
        if (encoded_frame.stream_type == "video") {
          receiver_runtime->dropped_video_units += 1;
        } else if (encoded_frame.stream_type == "audio") {
          receiver_runtime->dropped_audio_blocks += 1;
        }
      }
      emit_event(
        "warning",
        std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer_id) +
          "\",\"message\":\"" + json_escape(manifest_error) + "\"}"
      );
      return;
    }
    const std::string codec = encoded_frame.codec.empty()
      ? (encoded_frame.stream_type == "audio" ? "opus" : "h264")
      : encoded_frame.codec;
    const std::uint32_t rtp_timestamp = datachannel_timestamp_to_rtp(
      encoded_frame.timestamp_us,
      encoded_frame.stream_type,
      codec
    );
    if (encoded_frame.stream_type == "audio") {
      ViewerAudioSession viewer_audio;
      viewer_audio.consume_remote_peer_frame(
        peer_id,
        receiver_runtime,
        encoded_frame.payload,
        codec,
        rtp_timestamp
      );
      return;
    }

    consume_remote_peer_video_frame(
      peer_id,
      receiver_runtime,
      transport_session_holder->lock(),
      encoded_frame.payload,
      codec,
      rtp_timestamp
    );
  };  
  return callbacks;
}

}  // namespace vds::media_agent
