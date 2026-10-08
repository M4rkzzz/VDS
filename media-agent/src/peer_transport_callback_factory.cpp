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
#include "viewer_audio_playback.h"
#include "viewer_video_pipeline.h"
#include "media_timestamp_helpers.h"

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
  return media_timestamp_us_to_rtp(timestamp_us, static_cast<std::uint32_t>(clock_rate));
}

}  // namespace

PeerTransportCallbacks create_peer_transport_callbacks(const PeerTransportCallbackContext& context) {
  if (context.receiver_runtime) {
    std::lock_guard<std::mutex> lock(context.receiver_runtime->mutex);
    context.receiver_runtime->on_keyframe_needed =
      [holder = context.transport_session_holder](const std::string& reason) {
        if (holder) {
          if (auto transport = holder->lock()) {
            request_peer_transport_keyframe(transport, reason, nullptr);
          }
        }
      };
  }
  PeerTransportCallbacks callbacks;
  callbacks.allow_remote_media = context.role != "host-downstream" && context.role != "relay-downstream";
  callbacks.on_local_description = [peer_id = context.peer_id](const std::string& type, const std::string& sdp, const std::string& generation) {
    emit_event(
      "signal",
      std::string("{\"peerId\":\"") + json_escape(peer_id) +
        "\",\"targetId\":\"" + json_escape(peer_id) +
        "\",\"type\":\"" + json_escape(type) +
        "\",\"sdp\":{\"type\":\"" + json_escape(type) +
        "\",\"sdp\":\"" + json_escape(sdp) +
        "\"},\"transportGeneration\":\"" + json_escape(generation) + "\",\"transportReady\":true,\"trickleIce\":true}"
    );
  };
  callbacks.on_local_candidate = [peer_id = context.peer_id](const std::string& candidate, const std::string& sdp_mid, const std::string& generation) {
    emit_event(
      "signal",
      std::string("{\"peerId\":\"") + json_escape(peer_id) +
        "\",\"targetId\":\"" + json_escape(peer_id) +
        "\",\"type\":\"candidate\",\"candidate\":{\"candidate\":\"" + json_escape(candidate) +
        "\",\"sdpMid\":\"" + json_escape(sdp_mid) +
        "\",\"sdpMLineIndex\":0},\"transportGeneration\":\"" + json_escape(generation) + "\",\"transportReady\":true,\"trickleIce\":true}"
    );
  };
  callbacks.on_state_change = [
    peer_id = context.peer_id,
    role = context.role,
    initiator = context.initiator
  ](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
    if (logical_state == "host-video-refresh-requested") {
      if (role == "host-downstream") {
        emit_event("host-video-refresh-requested",
          std::string("{\"peerId\":\"") + json_escape(peer_id) +
          "\",\"transportGeneration\":\"" + json_escape(snapshot.transport_generation) +
          "\",\"requestSequence\":" + std::to_string(snapshot.keyframe_requests_received) + "}");
      }
      return;
    }
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
    std::lock_guard<std::mutex> dispatch_lock(receiver_runtime->media_dispatch_mutex);
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
    std::lock_guard<std::mutex> dispatch_lock(receiver_runtime->media_dispatch_mutex);
    ViewerAudioSession viewer_audio;
    MediaFrameTiming timing;
    timing.source_id = peer_id + "/" + receiver_runtime->source_generation + "/rtp-audio";
    viewer_audio.consume_remote_peer_frame(peer_id, receiver_runtime, frame, codec, rtp_timestamp, timing);
  };  
  callbacks.on_encoded_media_data_channel_frame = [
    peer_id = context.peer_id,
    expected_video_codec = context.expected_video_codec,
    expected_audio_codec = context.expected_audio_codec,
    receiver_runtime = context.receiver_runtime,
    transport_session_holder = context.transport_session_holder
  ](const PeerEncodedMediaDataChannelFrame& encoded_frame) {
    std::lock_guard<std::mutex> dispatch_lock(receiver_runtime->media_dispatch_mutex);
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
    MediaSourceEpochGate::Result epoch_result;
    bool epoch_changed = false;
    {
      std::lock_guard<std::mutex> lock(receiver_runtime->mutex);
      if (receiver_runtime->closing) return;
      const auto previous_epoch = receiver_runtime->source_epochs.current();
      epoch_result = receiver_runtime->source_epochs.accept(encoded_frame.source_epoch);
      epoch_changed = epoch_result == MediaSourceEpochGate::Result::accepted &&
        previous_epoch != receiver_runtime->source_epochs.current();
      if (epoch_changed) {
        receiver_runtime->pending_video_annexb_bytes.clear();
        receiver_runtime->startup_video_decoder_config_au.clear();
        receiver_runtime->startup_waiting_for_random_access = true;
      }
      if (epoch_result != MediaSourceEpochGate::Result::accepted) {
        ++receiver_runtime->retired_epoch_frames_dropped;
        if (encoded_frame.stream_type == "audio") ++receiver_runtime->dropped_audio_blocks;
        else ++receiver_runtime->dropped_video_units;
      }
    }
    if (epoch_result != MediaSourceEpochGate::Result::accepted) {
      if (epoch_result == MediaSourceEpochGate::Result::invalid) {
        emit_event("warning", std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer_id) +
          "\",\"message\":\"datachannel-source-epoch-rejected\"}");
      }
      return;
    }
    if (epoch_changed) {
      const auto previous_source_base = peer_id + "/" + receiver_runtime->source_generation;
      stop_viewer_audio_playback_source(previous_source_base);
      stop_viewer_audio_playback_source(previous_source_base + "/rtp-audio");
      if (encoded_frame.stream_type == "audio") {
        request_peer_transport_keyframe(transport_session_holder->lock(), "source-epoch-changed", nullptr);
      }
    }
    MediaFrameTiming timing;
    timing.timestamp_us = encoded_frame.timestamp_us;
    timing.sequence = encoded_frame.sequence;
    timing.timestamp_valid = true;
    timing.sequence_valid = true;
    timing.keyframe = encoded_frame.keyframe;
    timing.config = encoded_frame.config;
    timing.source_epoch = encoded_frame.source_epoch;
    timing.source_id = peer_id + "/" + receiver_runtime->source_generation +
      (timing.source_epoch.empty() ? std::string{} : "/epoch=" + timing.source_epoch);
    if (encoded_frame.stream_type == "audio") {
      ViewerAudioSession viewer_audio;
      viewer_audio.consume_remote_peer_frame(
        peer_id,
        receiver_runtime,
        encoded_frame.payload,
        codec,
        rtp_timestamp,
        timing
      );
      return;
    }

    consume_remote_peer_video_frame(
      peer_id,
      receiver_runtime,
      transport_session_holder->lock(),
      encoded_frame.payload,
      codec,
      rtp_timestamp,
      timing
    );
  };  
  return callbacks;
}

}  // namespace vds::media_agent
