#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#endif

#include "agent_lifecycle.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <string>

#include "agent_status_json.h"
#include "ffmpeg_probe.h"
#include "host_capture_plan.h"
#include "host_capture_process.h"
#include "host_pipeline.h"
#include "media_audio.h"
#include "obs_ingest_runtime.h"
#include "peer_media_binding_runtime.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "surface_attachment_runtime.h"
#include "surface_target.h"
#include "string_utils.h"
#include "viewer_audio_playback.h"
#include "wasapi_backend.h"
#include "wgc_capture.h"

namespace {

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
#endif

}  // namespace

void refresh_host_capture_runtime(AgentRuntimeState& state) {
#ifdef _WIN32
  if (state.host_session_running &&
      state.host_window_restore_placeholder_active &&
      state.host_capture_plan.capture_backend == "wgc" &&
      vds::media_agent::to_lower_copy(state.host_capture_plan.capture_kind) == "window" &&
      !state.host_capture_plan.capture_handle.empty()) {
    const WindowCaptureAvailability availability =
      query_window_capture_availability(state.host_capture_plan.capture_handle);
    if (availability == WindowCaptureAvailability::minimized) {
      state.host_capture_state = "minimized";
      state.host_capture_plan.capture_state = "minimized";
      state.host_capture_plan.reason = "minimized-window-wgc-capture-planned";
      state.host_capture_plan.last_error.clear();
    } else if (availability == WindowCaptureAvailability::normal) {
      state.host_capture_state = "normal";
      state.host_capture_plan.capture_state = "normal";
      state.host_window_restore_placeholder_active = false;
      if (state.host_capture_plan.reason == "minimized-window-wgc-capture-planned" ||
          state.host_capture_plan.reason == "window-capture-target-unavailable") {
        state.host_capture_plan.reason = "window-wgc-capture-planned";
      }
      state.host_capture_plan.last_error.clear();
      state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
    } else {
      state.host_capture_plan.reason = "window-capture-target-unavailable";
      state.host_capture_plan.last_error = "Selected window is no longer available.";
    }
  }
#endif
  refresh_host_capture_process_state(state.host_capture_process);
  state.host_capture_artifact = probe_host_capture_artifact(
    state.ffmpeg,
    state.host_capture_process,
    state.host_capture_artifact
  );
  persist_host_capture_process_manifest(
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_process,
    state.host_capture_artifact
  );
  for (auto& entry : state.attached_surfaces) {
    refresh_surface_attachment_state(entry.second);
    SurfaceAttachmentState& surface = entry.second;
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      continue;
    }

    const bool should_wait_for_artifact =
      state.host_session_running &&
      !surface.running &&
      surface.waiting_for_artifact &&
      state.host_capture_artifact.ready;
    const bool should_restart_exited_surface =
      state.host_session_running &&
      !surface.running &&
      !surface.waiting_for_artifact &&
      state.host_capture_artifact.ready &&
      (surface.reason == "surface-process-exited" ||
        surface.reason == "artifact-preview-stopped");

    if (!should_wait_for_artifact && !should_restart_exited_surface) {
      continue;
    }

    if (surface.running) {
      stop_surface_attachment(surface, "surface-auto-restart");
    }
    surface.restart_count += 1;
    surface = start_surface_attachment(
      state.ffmpeg,
      state.host_capture_plan,
      state.host_capture_process,
      state.host_capture_artifact,
      surface
    );
  }
}

void refresh_agent_runtime_state(AgentRuntimeState& state) {
  state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
  refresh_host_capture_runtime(state);
  refresh_peer_transport_runtime(state);
  perform_host_video_sender_soft_refresh(state);
  refresh_peer_transport_runtime(state);
}

void initialize_agent_runtime(AgentRuntimeState& state, const std::string& agent_binary_path) {
  attach_wasapi_audio_callbacks(state);
  state.peer_transport_backend = get_peer_transport_backend_info();
  state.ffmpeg = vds::media_agent::probe_ffmpeg(agent_binary_path);
  state.wgc_capture_backend = probe_wgc_capture_backend();
  state.audio_backend_probe = build_audio_backend_probe(probe_wasapi_backend());
  state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
  state.host_capture_process = build_host_capture_process_state();
  state.host_pipeline = select_and_validate_host_pipeline(
    state.ffmpeg,
    state.host_codec,
    state.host_hardware_acceleration,
    state.host_video_encoder_preference,
    state.host_encoder_preset,
    state.host_encoder_tune
  );
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
  refresh_host_capture_runtime(state);
}

void stop_all_surface_attachments(AgentRuntimeState& state, const std::string& reason) {
  for (auto& entry : state.attached_surfaces) {
    if (entry.second.peer_runtime) {
      stop_peer_video_surface_attachment(*entry.second.peer_runtime, reason);
    } else {
      stop_surface_attachment(entry.second, reason);
    }
  }
}

void restart_host_capture_surface_attachments(AgentRuntimeState& state) {
  for (auto& entry : state.attached_surfaces) {
    SurfaceAttachmentState& surface = entry.second;
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      continue;
    }
    stop_surface_attachment(surface, "host-capture-surface-restart");
    surface.restart_count += 1;
    surface = start_surface_attachment(
      state.ffmpeg,
      state.host_capture_plan,
      state.host_capture_process,
      state.host_capture_artifact,
      surface
    );
  }
}

void shutdown_agent_runtime(AgentRuntimeState& state) {
  stop_all_surface_attachments(state, "agent-shutdown");
  for (auto& entry : state.peers) {
    if (entry.second.receiver_runtime) {
      close_peer_video_receiver_handles(*entry.second.receiver_runtime);
    }
  }
  reset_host_audio_transport_sessions();
  stop_viewer_audio_playback_runtime(state.viewer_audio_playback);
  for (auto& entry : state.peers) {
    close_peer_transport_session(entry.second.transport_session);
  }
  stop_obs_ingest_runtime(state, "agent-shutdown");
  stop_host_capture_process(
    state.host_capture_process,
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_artifact,
    "agent-shutdown"
  );
}

AgentLifecycleCommandResult get_status_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, build_status_json(state), {}, {}};
}

AgentLifecycleCommandResult get_capabilities_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, capabilities_json(state), {}, {}};
}

AgentLifecycleCommandResult get_stats_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, build_stats_json(state), {}, {}};
}

AgentLifecycleCommandResult get_audio_backend_status_result(AgentRuntimeState& state) {
  state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
  return {true, audio_session_json(state.audio_session), {}, {}};
}

HostSessionControllerCallbacks make_start_host_session_callbacks(AgentRuntimeState& state) {
  HostSessionControllerCallbacks callbacks;
  callbacks.stop_all_surface_attachments = [&state](const std::string& reason) {
    stop_all_surface_attachments(state, reason);
  };
  callbacks.refresh_host_capture_runtime = [&state]() {
    refresh_host_capture_runtime(state);
  };
  callbacks.restart_host_capture_surface_attachments = [&state]() {
    restart_host_capture_surface_attachments(state);
  };
  callbacks.attach_host_video_media_binding = [&state](PeerState& peer, std::string* error) {
    return attach_host_video_media_binding(state, peer, error);
  };
  return callbacks;
}

HostSessionControllerCallbacks make_stop_host_session_callbacks(AgentRuntimeState& state) {
  HostSessionControllerCallbacks callbacks;
  callbacks.stop_all_surface_attachments = [&state](const std::string& reason) {
    stop_all_surface_attachments(state, reason);
  };
  callbacks.detach_peer_media_binding = [](PeerState& peer, std::string* error) {
    return detach_peer_media_binding(peer, error);
  };
  return callbacks;
}
