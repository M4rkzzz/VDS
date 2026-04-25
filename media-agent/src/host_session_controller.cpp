#include "host_session_controller.h"

#include <thread>
#include <utility>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "agent_status_json.h"
#include "ffmpeg_probe.h"
#include "host_capture_plan.h"
#include "host_capture_process.h"
#include "host_pipeline.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "obs_ingest_runtime.h"
#include "obs_ingest_state.h"
#include "peer_transport.h"
#include "string_utils.h"
#include "time_utils.h"
#include "video_access_unit.h"

namespace {

using vds::media_agent::extract_bool_value;
using vds::media_agent::extract_int_value;
using vds::media_agent::extract_string_value;
using vds::media_agent::current_time_millis;
using vds::media_agent::json_escape;
using vds::media_agent::normalize_video_codec;
using vds::media_agent::normalize_video_encoder_preference;
using vds::media_agent::to_lower_copy;

void emit_host_session_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

HostSessionCommandResult ok_result(std::string result_json) {
  HostSessionCommandResult result;
  result.ok = true;
  result.result_json = std::move(result_json);
  return result;
}

HostSessionCommandResult error_result(const std::string& code, const std::string& message) {
  HostSessionCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

void refresh_default_native_host_plan(AgentRuntimeState& state) {
  state.host_pipeline = select_and_validate_host_pipeline(
    state.ffmpeg,
    state.host_codec,
    state.host_hardware_acceleration,
    state.host_video_encoder_preference,
    state.host_encoder_preset,
    state.host_encoder_tune
  );
  state.host_pipeline.requested_keyframe_policy = state.host_keyframe_policy;
  state.host_capture_plan = build_host_capture_plan(
    state.ffmpeg,
    state.wgc_capture_backend,
    state.host_pipeline,
    state.host_capture_process,
    state.host_capture_kind,
    state.host_capture_state,
    state.host_capture_title,
    state.host_capture_hwnd,
    state.host_capture_display_id,
    state.host_width,
    state.host_height,
    state.host_frame_rate,
    state.host_bitrate_kbps
  );
  state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
}

void emit_host_downstream_peer_attach_events(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream") {
      continue;
    }

    std::string attach_error;
    if (!callbacks.attach_host_video_media_binding ||
        !callbacks.attach_host_video_media_binding(peer, &attach_error)) {
      peer.media_binding.attached = false;
      peer.media_binding.sender_configured = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-attach-failed";
      peer.media_binding.last_error = attach_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
    } else if (peer.initiator && peer.transport_session) {
      std::string negotiate_error;
      if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
        peer.transport = get_peer_transport_snapshot(peer.transport_session);
        peer.transport.last_error = negotiate_error;
        peer.transport.reason = "peer-local-description-failed";
        peer.media_binding.reason = "peer-local-description-failed";
        peer.media_binding.last_error = negotiate_error;
        peer.media_binding.updated_at_unix_ms = current_time_millis();
      }
    } else {
      emit_event("peer-state", build_peer_state_json(peer, "media-source-attached"));
    }
  }
}

void detach_host_downstream_peers(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream") {
      continue;
    }

    std::string detach_error;
    if (!callbacks.detach_peer_media_binding ||
        !callbacks.detach_peer_media_binding(peer, &detach_error)) {
      peer.media_binding.reason = "peer-media-detach-failed";
      peer.media_binding.last_error = detach_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
    } else if (peer.initiator && peer.transport_session) {
      std::string negotiate_error;
      if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
        peer.transport = get_peer_transport_snapshot(peer.transport_session);
        peer.transport.last_error = negotiate_error;
        peer.transport.reason = "peer-local-description-failed";
        peer.media_binding.reason = "peer-local-description-failed";
        peer.media_binding.last_error = negotiate_error;
        peer.media_binding.updated_at_unix_ms = current_time_millis();
      }
    }
  }
}

}  // namespace

HostSessionCommandResult start_host_session_from_request(
  AgentRuntimeState& state,
  const std::string& request_json,
  const HostSessionControllerCallbacks& callbacks) {
  emit_host_session_breadcrumb("startHostSession:begin");
  if (callbacks.stop_all_surface_attachments) {
    callbacks.stop_all_surface_attachments("host-session-restart");
  }
  emit_host_session_breadcrumb("startHostSession:after-stop-all-surfaces");
  stop_host_capture_process(
    state.host_capture_process,
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_artifact,
    "host-session-restart"
  );
  emit_host_session_breadcrumb("startHostSession:after-stop-host-capture-process");
  stop_obs_ingest_runtime(state, "host-session-restart");
  emit_host_session_breadcrumb("startHostSession:after-stop-obs-ingest-runtime");

  state.host_session_running = true;
  state.host_backend =
    to_lower_copy(extract_string_value(request_json, "backend")) == "obs-ingest"
      ? "obs-ingest"
      : "native";
  state.host_capture_target_id = extract_string_value(request_json, "captureTargetId");
  state.host_capture_source_id = extract_string_value(request_json, "sourceId");
  state.host_capture_kind = extract_string_value(request_json, "captureKind");
  state.host_capture_state = extract_string_value(request_json, "captureState");
  state.host_capture_title = extract_string_value(request_json, "captureTitle");
  state.host_capture_hwnd = extract_string_value(request_json, "captureHwnd");
  state.host_capture_display_id = extract_string_value(request_json, "displayId");
  state.host_window_restore_placeholder_active = false;
  state.host_video_sender_refresh_requested = false;
  state.host_video_sender_refresh_reason.clear();
  state.host_requested_codec = normalize_video_codec(
    extract_string_value(request_json, "requestedCodec"),
    normalize_video_codec(extract_string_value(request_json, "codec"))
  );
  const int requested_obs_port = extract_int_value(request_json, "port", 0);
  state.host_codec = state.host_requested_codec;
  state.host_hardware_acceleration = extract_bool_value(request_json, "hardwareAcceleration", true);
  state.host_video_encoder_preference = normalize_video_encoder_preference(
    extract_string_value(request_json, "videoEncoderPreference")
  );
  state.host_encoder_preset = normalize_host_encoder_preset(extract_string_value(request_json, "encoderPreset"));
  state.host_encoder_tune = normalize_host_encoder_tune(extract_string_value(request_json, "encoderTune"));
  state.host_keyframe_policy = normalize_host_keyframe_policy(extract_string_value(request_json, "keyframePolicy"));
  state.host_width = normalize_host_output_dimension(extract_int_value(request_json, "width", 1920), 1920);
  state.host_height = normalize_host_output_dimension(extract_int_value(request_json, "height", 1080), 1080);
  state.host_frame_rate = extract_int_value(request_json, "frameRate", 60);
  state.host_bitrate_kbps = extract_int_value(request_json, "bitrateKbps", 10000);

  if (is_obs_ingest_backend(state)) {
    state.host_capture_target_id = "obs-ingest";
    state.host_capture_source_id.clear();
    state.host_capture_kind = "obs-ingest";
    state.host_capture_state = "waiting-for-obs-ingest";
    state.host_capture_title = "OBS ingest";
    state.host_capture_hwnd.clear();
    state.host_capture_display_id.clear();
    state.host_window_restore_placeholder_active = false;
  } else {
    if (state.host_capture_kind.empty()) {
      state.host_capture_kind =
        state.host_capture_target_id.rfind("screen:", 0) == 0 ? "display" : "window";
    }
    if (state.host_capture_state.empty()) {
      state.host_capture_state = state.host_capture_kind == "display" ? "display" : "normal";
    }
    state.host_window_restore_placeholder_active =
      state.host_capture_kind == "window" &&
      state.host_capture_state == "minimized";
  }

  if (state.host_codec.empty()) {
    state.host_codec = "h264";
  }
  if (state.host_requested_codec.empty()) {
    state.host_requested_codec = state.host_codec;
  }
  state.host_capture_process = build_host_capture_process_state();
  emit_host_session_breadcrumb(
    std::string("startHostSession:config-applied target=") +
    state.host_capture_target_id +
    " backend=" + state.host_backend +
    " codec=" + state.host_codec +
    " size=" + std::to_string(state.host_width) + "x" + std::to_string(state.host_height) +
    " fps=" + std::to_string(state.host_frame_rate)
  );

  if (is_obs_ingest_backend(state)) {
    state.host_pipeline = HostPipelineState{};
    state.host_capture_plan = HostCapturePlan{};
    state.host_capture_artifact = HostCaptureArtifactProbe{};
    if (callbacks.refresh_host_capture_runtime) {
      callbacks.refresh_host_capture_runtime();
    }
    if (callbacks.restart_host_capture_surface_attachments) {
      callbacks.restart_host_capture_surface_attachments();
    }

    std::string prepare_error;
    if (!prepare_obs_ingest_session(state, false, requested_obs_port, &prepare_error)) {
      state.host_session_running = false;
      state.host_backend = "native";
      clear_obs_ingest_prepared_session(state);
      return error_result("OBS_INGEST_PREPARE_FAILED", prepare_error);
    }

    state.obs_ingest.stop_requested.store(false);
    state.obs_ingest.worker = std::thread(obs_ingest_worker, &state);
    emit_host_session_breadcrumb("startHostSession:after-start-obs-ingest-worker");
    emit_host_session_breadcrumb("startHostSession:before-result");
    return ok_result(build_host_session_json(state));
  }

  clear_obs_ingest_prepared_session(state);
  state.host_pipeline = select_and_validate_host_pipeline(
    state.ffmpeg,
    state.host_codec,
    state.host_hardware_acceleration,
    state.host_video_encoder_preference,
    state.host_encoder_preset,
    state.host_encoder_tune
  );
  emit_host_session_breadcrumb("startHostSession:after-select-pipeline");
  state.host_capture_plan = build_host_capture_plan(
    state.ffmpeg,
    state.wgc_capture_backend,
    state.host_pipeline,
    state.host_capture_process,
    state.host_capture_kind,
    state.host_capture_state,
    state.host_capture_title,
    state.host_capture_hwnd,
    state.host_capture_display_id,
    state.host_width,
    state.host_height,
    state.host_frame_rate,
    state.host_bitrate_kbps
  );
  emit_host_session_breadcrumb("startHostSession:after-build-capture-plan");
  state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
  emit_host_session_breadcrumb("startHostSession:after-validate-capture-plan");
  state.host_capture_process = start_host_capture_process(
    state.ffmpeg,
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_process
  );
  emit_host_session_breadcrumb("startHostSession:after-start-host-capture-process");
  if (callbacks.refresh_host_capture_runtime) {
    callbacks.refresh_host_capture_runtime();
  }
  emit_host_session_breadcrumb("startHostSession:after-refresh-host-capture-runtime");
  if (callbacks.restart_host_capture_surface_attachments) {
    callbacks.restart_host_capture_surface_attachments();
  }
  emit_host_session_breadcrumb("startHostSession:after-restart-surface-attachments");
  emit_host_downstream_peer_attach_events(state, callbacks);
  emit_host_session_breadcrumb("startHostSession:before-result");

  emit_event(
    "media-state",
    std::string("{\"state\":\"host-session-started\",\"captureTargetId\":\"") +
      json_escape(state.host_capture_target_id) +
      "\",\"requestedCodec\":\"" + json_escape(state.host_requested_codec) +
      "\",\"codec\":\"" + json_escape(state.host_codec) +
      "\",\"effectiveCodec\":\"" + json_escape(state.host_codec) +
      "\",\"downgradeReason\":\"" +
      "\",\"pipeline\":" + host_pipeline_json(state.host_pipeline) +
      ",\"capturePlan\":" + host_capture_plan_json(state.host_capture_plan) +
      ",\"captureProcess\":" + host_capture_process_json(state.host_capture_process) +
      ",\"implementation\":\"stub\",\"transportReady\":" +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );

  if ((!state.host_capture_plan.ready || !state.host_capture_plan.validated) &&
      !state.host_capture_plan.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"host-capture\",\"message\":\"") +
        json_escape(state.host_capture_plan.last_error) +
        "\",\"reason\":\"" + json_escape(state.host_capture_plan.reason) + "\"}"
    );
  }
  if (state.host_capture_process.enabled &&
      !state.host_capture_process.running &&
      !state.host_capture_process.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"host-capture-process\",\"message\":\"") +
        json_escape(state.host_capture_process.last_error) +
        "\",\"reason\":\"" + json_escape(state.host_capture_process.reason) + "\"}"
    );
  }
  return ok_result(build_host_session_json(state));
}

HostSessionCommandResult stop_host_session(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks) {
  emit_host_session_breadcrumb("stopHostSession:begin");
  if (callbacks.stop_all_surface_attachments) {
    callbacks.stop_all_surface_attachments("host-session-stopped");
  }
  emit_host_session_breadcrumb("stopHostSession:after-stop-all-surfaces");
  stop_obs_ingest_runtime(state, "host-session-stopped");
  emit_host_session_breadcrumb("stopHostSession:after-stop-obs-ingest-runtime");
  detach_host_downstream_peers(state, callbacks);
  emit_host_session_breadcrumb("stopHostSession:after-detach-host-downstream-peers");
  stop_host_capture_process(
    state.host_capture_process,
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_artifact,
    "host-session-stopped"
  );
  emit_host_session_breadcrumb("stopHostSession:after-stop-host-capture-process");

  state.host_session_running = false;
  state.host_backend = "native";
  state.host_capture_target_id.clear();
  state.host_capture_source_id.clear();
  state.host_capture_title.clear();
  state.host_capture_hwnd.clear();
  state.host_capture_display_id.clear();
  state.host_window_restore_placeholder_active = false;
  state.host_video_sender_refresh_requested = false;
  state.host_video_sender_refresh_reason.clear();
  state.host_requested_codec = "h264";
  state.host_codec = "h264";
  state.host_hardware_acceleration = true;
  state.host_encoder_preset = "balanced";
  state.host_encoder_tune.clear();
  state.host_capture_kind = "window";
  state.host_capture_state = "normal";
  state.host_width = 1920;
  state.host_height = 1080;
  state.host_frame_rate = 60;
  state.host_bitrate_kbps = 10000;
  clear_obs_ingest_prepared_session(state);
  refresh_default_native_host_plan(state);
  emit_host_session_breadcrumb("stopHostSession:before-result");
  emit_event(
    "media-state",
    std::string("{\"state\":\"host-session-stopped\",\"captureProcess\":") +
      host_capture_process_json(state.host_capture_process) +
      ",\"implementation\":\"stub\",\"transportReady\":" +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  return ok_result(build_host_session_json(state));
}
