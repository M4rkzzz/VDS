#include "host_session_runtime.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <algorithm>
#include <cctype>
#include <cstdint>

#include "host_capture_plan.h"
#include "host_capture_process.h"
#include "ffmpeg_probe.h"
#include "host_pipeline.h"
#include "host_session_state.h"
#include "json_protocol.h"
#include "obs_ingest_session.h"
#include "platform_utils.h"
#include "runtime_registry.h"
#include "string_utils.h"
#include "video_access_unit.h"

namespace vds::media_agent {
namespace {

ObsIngestSession bind_obs_ingest_session(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest) {
  return ObsIngestSession(
    obs_ingest,
    make_obs_ingest_runtime_access(runtime_state, session));
}

#ifdef _WIN32
enum class WindowCaptureAvailability {
  normal,
  minimized,
  unavailable
};

HWND parse_runtime_window_handle(const std::string& value) {
  std::string trimmed = value;
  trimmed.erase(trimmed.begin(), std::find_if(trimmed.begin(), trimmed.end(), [](unsigned char ch) {
    return !std::isspace(ch);
  }));
  trimmed.erase(std::find_if(trimmed.rbegin(), trimmed.rend(), [](unsigned char ch) {
    return !std::isspace(ch);
  }).base(), trimmed.end());
  if (trimmed.empty()) {
    return nullptr;
  }

  try {
    std::size_t parsed_length = 0;
    const auto numeric = static_cast<std::uintptr_t>(std::stoull(trimmed, &parsed_length, 0));
    if (parsed_length != trimmed.size()) {
      return nullptr;
    }
    return reinterpret_cast<HWND>(numeric);
  } catch (...) {
    return nullptr;
  }
}

WindowCaptureAvailability query_window_capture_availability(const std::string& window_handle) {
  const HWND hwnd = parse_runtime_window_handle(window_handle);
  if (!hwnd || !IsWindow(hwnd)) {
    return WindowCaptureAvailability::unavailable;
  }
  if (IsIconic(hwnd)) {
    return WindowCaptureAvailability::minimized;
  }
  return WindowCaptureAvailability::normal;
}

bool try_resolve_restored_window_handle(const std::string& capture_title, std::string* window_handle) {
  if (!window_handle) {
    return false;
  }
  const std::string resolved = resolve_window_handle_from_title(capture_title);
  if (resolved.empty() || resolved == *window_handle) {
    return false;
  }
  if (query_window_capture_availability(resolved) != WindowCaptureAvailability::normal) {
    return false;
  }
  *window_handle = resolved;
  return true;
}
#endif

}  // namespace

void refresh_default_native_host_plan(AgentRuntimeState& runtime_state, HostSessionState& session) {
  session.pipeline = select_and_validate_host_pipeline(
    ffmpeg_probe_result(runtime_state),
    session.codec,
    session.hardware_acceleration,
    session.video_encoder_preference,
    session.encoder_preset,
    session.encoder_tune
  );
  session.pipeline.requested_keyframe_policy = session.keyframe_policy;
  session.capture_plan = build_host_capture_plan(
    ffmpeg_probe_result(runtime_state),
    wgc_capture_backend(runtime_state),
    session.pipeline,
    session.capture_kind,
    session.capture_state,
    session.capture_title,
    session.capture_hwnd,
    session.capture_display_id,
    session.width,
    session.height,
    session.frame_rate,
    session.bitrate_kbps
  );
  session.capture_plan = validate_host_capture_plan(ffmpeg_probe_result(runtime_state), session.capture_plan);
}

int apply_host_session_start_request(HostSessionState& session, const std::string& request_json) {
  session.running = true;
  session.backend =
    to_lower_copy(extract_string_value(request_json, "backend")) == "obs-ingest"
      ? "obs-ingest"
      : "native";
  session.capture_target_id = extract_string_value(request_json, "captureTargetId");
  session.capture_kind = extract_string_value(request_json, "captureKind");
  session.capture_state = extract_string_value(request_json, "captureState");
  session.capture_title = extract_string_value(request_json, "captureTitle");
  session.capture_hwnd = extract_string_value(request_json, "captureHwnd");
  session.capture_display_id = extract_string_value(request_json, "displayId");
  session.window_restore_placeholder_active = false;
  session.requested_codec = normalize_video_codec(
    extract_string_value(request_json, "requestedCodec"),
    normalize_video_codec(extract_string_value(request_json, "codec"))
  );
  const int requested_obs_port = extract_int_value(request_json, "port", 0);
  session.codec = session.requested_codec;
  session.hardware_acceleration = extract_bool_value(request_json, "hardwareAcceleration", true);
  session.video_encoder_preference = normalize_video_encoder_preference(
    extract_string_value(request_json, "videoEncoderPreference")
  );
  session.encoder_preset = normalize_host_encoder_preset(extract_string_value(request_json, "encoderPreset"));
  session.encoder_tune = normalize_host_encoder_tune(extract_string_value(request_json, "encoderTune"));
  session.keyframe_policy = normalize_host_keyframe_policy(extract_string_value(request_json, "keyframePolicy"));
  session.width = normalize_host_output_dimension(extract_int_value(request_json, "width", 1920), 1920);
  session.height = normalize_host_output_dimension(extract_int_value(request_json, "height", 1080), 1080);
  session.frame_rate = extract_int_value(request_json, "frameRate", 60);
  session.bitrate_kbps = extract_int_value(request_json, "bitrateKbps", 10000);

  if (to_lower_copy(session.backend) == "obs-ingest") {
    session.capture_target_id = "obs-ingest";
    session.capture_kind = "obs-ingest";
    session.capture_state = "waiting-for-obs-ingest";
    session.capture_title = "OBS ingest";
    session.capture_hwnd.clear();
    session.capture_display_id.clear();
    session.window_restore_placeholder_active = false;
  } else {
    if (session.capture_kind.empty()) {
      session.capture_kind =
        session.capture_target_id.rfind("screen:", 0) == 0 ? "display" : "window";
    }
    if (session.capture_state.empty()) {
      session.capture_state = session.capture_kind == "display" ? "display" : "normal";
    }
    session.window_restore_placeholder_active =
      session.capture_kind == "window" &&
      session.capture_state == "minimized";
  }

  if (session.codec.empty()) {
    session.codec = "h264";
  }
  if (session.requested_codec.empty()) {
    session.requested_codec = session.codec;
  }
  session.capture_process = build_host_capture_process_state();
  return requested_obs_port;
}

void reset_host_session_to_default_native(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest_state) {
  session.running = false;
  session.backend = "native";
  session.capture_target_id.clear();
  session.capture_title.clear();
  session.capture_hwnd.clear();
  session.capture_display_id.clear();
  session.window_restore_placeholder_active = false;
  session.requested_codec = "h264";
  session.codec = "h264";
  session.hardware_acceleration = true;
  session.encoder_preset = "balanced";
  session.encoder_tune.clear();
  session.capture_kind = "window";
  session.capture_state = "normal";
  session.width = 1920;
  session.height = 1080;
  session.frame_rate = 60;
  session.bitrate_kbps = 10000;
  ObsIngestSession obs_ingest = bind_obs_ingest_session(runtime_state, session, obs_ingest_state);
  obs_ingest.clear_prepared();
  refresh_default_native_host_plan(runtime_state, session);
}

const HostCapturePlan& revalidate_host_capture_plan(
  AgentRuntimeState& runtime_state,
  HostSessionState& session) {
  session.capture_plan = validate_host_capture_plan(ffmpeg_probe_result(runtime_state), session.capture_plan);
  return session.capture_plan;
}

void initialize_default_capture_runtime(
  AgentRuntimeState& runtime_state,
  HostSessionState& session) {
  session.capture_process = build_host_capture_process_state();
  refresh_default_native_host_plan(runtime_state, session);
}

void refresh_host_capture_runtime(
  AgentRuntimeState& runtime_state,
  HostSessionState& session) {
#ifdef _WIN32
  if (session.running &&
      session.window_restore_placeholder_active &&
      session.capture_plan.capture_backend == "wgc" &&
      to_lower_copy(session.capture_plan.capture_kind) == "window" &&
      !session.capture_plan.capture_handle.empty()) {
    const WindowCaptureAvailability availability =
      query_window_capture_availability(session.capture_plan.capture_handle);
    if (availability == WindowCaptureAvailability::minimized) {
      std::string resolved_handle = session.capture_plan.capture_handle;
      if (try_resolve_restored_window_handle(session.capture_title, &resolved_handle)) {
        session.capture_hwnd = resolved_handle;
        session.capture_plan.capture_handle = resolved_handle;
        session.capture_state = "normal";
        session.capture_plan.capture_state = "normal";
        session.window_restore_placeholder_active = false;
        session.capture_plan.reason = "window-wgc-capture-planned";
        session.capture_plan.last_error.clear();
        session.capture_plan = validate_host_capture_plan(ffmpeg_probe_result(runtime_state), session.capture_plan);
      } else {
        session.capture_state = "minimized";
        session.capture_plan.capture_state = "minimized";
        session.capture_plan.reason = "minimized-window-wgc-capture-planned";
        session.capture_plan.last_error.clear();
      }
    } else if (availability == WindowCaptureAvailability::normal) {
      session.capture_state = "normal";
      session.capture_plan.capture_state = "normal";
      session.window_restore_placeholder_active = false;
      if (session.capture_plan.reason == "minimized-window-wgc-capture-planned" ||
          session.capture_plan.reason == "window-capture-target-unavailable") {
        session.capture_plan.reason = "window-wgc-capture-planned";
      }
      session.capture_plan.last_error.clear();
      session.capture_plan = validate_host_capture_plan(ffmpeg_probe_result(runtime_state), session.capture_plan);
    } else {
      session.capture_plan.reason = "window-capture-target-unavailable";
      session.capture_plan.last_error = "Selected window is no longer available.";
    }
  }
#endif
  refresh_host_capture_process_state(session.capture_process);
  session.capture_artifact = probe_host_capture_artifact(
    ffmpeg_probe_result(runtime_state),
    session.capture_process,
    session.capture_artifact
  );
  persist_host_capture_process_manifest(
    session.pipeline,
    session.capture_plan,
    session.capture_process,
    session.capture_artifact
  );
}

const HostCaptureProcessState& start_host_capture_process(
  AgentRuntimeState& runtime_state,
  HostSessionState& session) {
  session.capture_process = ::start_host_capture_process(
    ffmpeg_probe_result(runtime_state),
    session.pipeline,
    session.capture_plan,
    session.capture_process
  );
  return session.capture_process;
}

void stop_host_capture_process(HostSessionState& session, const std::string& reason) {
  ::stop_host_capture_process(
    session.capture_process,
    session.pipeline,
    session.capture_plan,
    session.capture_artifact,
    reason
  );
}

bool prepare_obs_ingest_session(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  bool wait_for_stream,
  int requested_port,
  std::string* error) {
  return bind_obs_ingest_session(runtime_state, session, obs_ingest).prepare(wait_for_stream, requested_port, error);
}

void clear_obs_ingest_prepared(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest) {
  bind_obs_ingest_session(runtime_state, session, obs_ingest).clear_prepared();
}

void start_obs_ingest_worker(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest) {
  bind_obs_ingest_session(runtime_state, session, obs_ingest).start_worker();
}

void stop_obs_ingest_session(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest) {
  bind_obs_ingest_session(runtime_state, session, obs_ingest).stop();
}

void set_host_video_codec(HostSessionState& session, const std::string& codec) {
  session.codec = codec;
}

}  // namespace vds::media_agent
