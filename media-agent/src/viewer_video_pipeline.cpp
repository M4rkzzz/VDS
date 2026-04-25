#include "viewer_video_pipeline.h"

#include <mutex>

#include "agent_events.h"
#include "json_protocol.h"
#include "native_video_surface.h"
#include "peer_receiver_runtime.h"
#include "relay_dispatch.h"
#include "surface_attachment_runtime.h"
#include "time_utils.h"
#include "video_access_unit.h"

bool submit_scheduled_video_unit_to_surface(
  const std::string& peer_id,
  PeerState::PeerVideoReceiverRuntime& runtime,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec_path,
  std::string* warning_message) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = runtime.surface;
  }

  if (!surface) {
    if (warning_message) {
      *warning_message = "peer-video-surface-missing";
    }
    return false;
  }

  const NativeVideoSurfaceSnapshot snapshot = surface->snapshot();
  if (snapshot.reason == "native-decoder-send-failed" ||
      snapshot.reason == "native-decoder-receive-failed" ||
      snapshot.reason == "native-decoder-transfer-failed") {
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      runtime.running = false;
      runtime.decoder_ready = false;
      runtime.pending_video_annexb_bytes.clear();
      runtime.startup_video_decoder_config_au.clear();
      runtime.startup_waiting_for_random_access = true;
      runtime.reason = "peer-video-surface-decoder-recovering";
      runtime.last_error = snapshot.last_error;
    }

    std::string restart_error;
    if (!restart_peer_video_surface_attachment(runtime, &restart_error)) {
      if (warning_message) {
        *warning_message = restart_error.empty() ? snapshot.last_error : restart_error;
      }
      return false;
    }

    refresh_peer_video_receiver_runtime(runtime);
    if (warning_message) {
      *warning_message = snapshot.last_error.empty()
        ? "peer-video-surface-decoder-restarted"
        : snapshot.last_error;
    }
    return false;
  }

  std::string submit_error;
  if (surface->submit_encoded_frame(frame, codec_path, &submit_error)) {
    return true;
  }

  if (submit_error == "native-video-surface-not-running") {
    std::string runtime_reason;
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      runtime_reason = runtime.reason;
    }

    if (is_peer_video_surface_shutdown_reason(runtime_reason)) {
      if (warning_message) {
        *warning_message = runtime_reason;
      }
      return false;
    }

    std::string restart_error;
    if (restart_peer_video_surface_attachment(runtime, &restart_error)) {
      std::shared_ptr<NativeVideoSurface> restarted_surface;
      {
        std::lock_guard<std::mutex> lock(runtime.mutex);
        restarted_surface = runtime.surface;
        runtime.reason = "peer-video-surface-running";
        runtime.last_error.clear();
      }

      if (restarted_surface && restarted_surface->submit_encoded_frame(frame, codec_path, &submit_error)) {
        return true;
      }
    }

    if (!restart_error.empty()) {
      submit_error = restart_error;
    }
  }

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.running = false;
    runtime.decoder_ready = false;
    runtime.pending_video_annexb_bytes.clear();
    runtime.startup_video_decoder_config_au.clear();
    runtime.startup_waiting_for_random_access = true;
    runtime.reason = "peer-video-surface-submit-failed";
    runtime.last_error = submit_error;
  }
  if (warning_message) {
    *warning_message = submit_error;
  }
  emit_event(
    "warning",
    std::string("{\"scope\":\"surface\",\"peerId\":\"") + vds::media_agent::json_escape(peer_id) +
      "\",\"message\":\"" + vds::media_agent::json_escape(submit_error) +
      "\",\"reason\":\"peer-video-surface-submit-failed\"}"
  );
  return false;
}

void consume_remote_peer_video_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::shared_ptr<PeerTransportSession>& transport_session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (!runtime_ptr) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
  }

  auto& runtime = *runtime_ptr;
  std::string codec_path;
  std::vector<std::vector<std::uint8_t>> decode_units;
  std::vector<std::vector<std::uint8_t>> relay_decode_units;

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.closing) {
      return;
    }
    runtime.codec_path = vds::media_agent::normalize_video_codec(codec);
    runtime.remote_frames_received += 1;
    runtime.remote_bytes_received += static_cast<unsigned long long>(frame.size());
    runtime.last_remote_frame_at_unix_ms = vds::media_agent::current_time_millis();
    codec_path = runtime.codec_path;

    if (codec_path == "h264" || codec_path == "h265") {
      const bool frame_has_annexb_start_code =
        vds::media_agent::find_next_annexb_start_code(frame, 0) != std::string::npos;
      if (runtime.pending_video_annexb_bytes.empty() && frame_has_annexb_start_code) {
        if (vds::media_agent::should_emit_video_access_unit(codec_path, frame)) {
          decode_units.push_back(frame);
        }
      } else {
        runtime.pending_video_annexb_bytes.insert(
          runtime.pending_video_annexb_bytes.end(),
          frame.begin(),
          frame.end()
        );
        decode_units = vds::media_agent::extract_annexb_video_access_units(
          codec_path,
          runtime.pending_video_annexb_bytes,
          false
        );
      }
    } else {
      decode_units.push_back(frame);
    }
  }
  relay_decode_units = decode_units;

  if (codec_path == "h264" || codec_path == "h265") {
    std::vector<std::vector<std::uint8_t>> startup_units;
    bool waiting_for_random_access = false;
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      if (runtime.closing) {
        return;
      }
      if (runtime.startup_waiting_for_random_access) {
        for (const auto& decode_unit : decode_units) {
          if (vds::media_agent::video_access_unit_has_decoder_config_nal(codec_path, decode_unit)) {
            runtime.startup_video_decoder_config_au = decode_unit;
          }
          if (!vds::media_agent::video_access_unit_has_random_access_nal(codec_path, decode_unit)) {
            continue;
          }
          if (!vds::media_agent::video_bootstrap_is_complete(
                codec_path,
                runtime.startup_video_decoder_config_au,
                decode_unit)) {
            continue;
          }

          runtime.startup_waiting_for_random_access = false;
          if (!runtime.startup_video_decoder_config_au.empty()) {
            startup_units.push_back(runtime.startup_video_decoder_config_au);
          }
          if (startup_units.empty() || startup_units.back() != decode_unit) {
            startup_units.push_back(decode_unit);
          }
          runtime.reason = "peer-video-bootstrap-random-access";
          break;
        }

        if (runtime.startup_waiting_for_random_access) {
          const auto dropped_count = static_cast<unsigned long long>(decode_units.size());
          runtime.dropped_video_units += dropped_count;
          runtime.reason = "peer-video-waiting-for-random-access";
          waiting_for_random_access = true;
          add_peer_transport_dropped_video_units(transport_session, dropped_count);
          request_peer_transport_keyframe(transport_session, "waiting-for-random-access", nullptr);
        }
      }
    }

    if (waiting_for_random_access) {
      fanout_relay_video_units(peer_id, codec_path, relay_decode_units, rtp_timestamp);
      refresh_peer_video_receiver_runtime(runtime);
      update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
      return;
    }

    if (!startup_units.empty()) {
      decode_units = std::move(startup_units);
    }
  }

  fanout_relay_video_units(peer_id, codec_path, relay_decode_units, rtp_timestamp);
  bool local_playback_enabled = false;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.closing) {
      return;
    }
    local_playback_enabled = runtime.local_playback_enabled;
  }

  if (!local_playback_enabled) {
    refresh_peer_video_receiver_runtime(runtime);
    update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
    return;
  }

  for (const auto& decode_unit : decode_units) {
    std::string warning_message;
    const bool submitted = submit_scheduled_video_unit_to_surface(
      peer_id,
      runtime,
      decode_unit,
      codec_path,
      &warning_message
    );
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.scheduled_video_units += 1;
    if (submitted) {
      runtime.submitted_video_units += 1;
      runtime.reason = "peer-video-passthrough-submitted";
    } else {
      runtime.dropped_video_units += 1;
      runtime.reason = "peer-video-passthrough-dropped";
      add_peer_transport_dropped_video_units(transport_session, 1);
      request_peer_transport_keyframe(transport_session, "decoder-recovery", nullptr);
      if (!warning_message.empty()) {
        runtime.last_error = warning_message;
      }
    }
  }

  refresh_peer_video_receiver_runtime(runtime);
  update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
}
