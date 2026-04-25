#include "surface_attachment_runtime.h"

#include <chrono>
#include <filesystem>
#include <limits>
#include <mutex>
#include <sstream>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "native_artifact_preview.h"
#include "native_live_preview.h"
#include "native_video_surface.h"
#include "json_protocol.h"
#include "peer_receiver_runtime.h"
#include "platform_utils.h"
#include "surface_target.h"
#include "string_utils.h"
#include "time_utils.h"

namespace fs = std::filesystem;

namespace {

bool wait_for_path_to_exist(const std::string& path, int timeout_ms = 2000) {
  if (path.empty()) {
    return false;
  }

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    try {
      if (fs::exists(path)) {
        return true;
      }
    } catch (...) {
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  try {
    return fs::exists(path);
  } catch (...) {
    return false;
  }
}

#ifdef _WIN32
void close_surface_attachment_handles(SurfaceAttachmentState& state) {
  if (state.thread_handle) {
    CloseHandle(state.thread_handle);
    state.thread_handle = nullptr;
  }
  if (state.process_handle) {
    CloseHandle(state.process_handle);
    state.process_handle = nullptr;
  }
}
#endif

}  // namespace

#ifdef _WIN32
bool start_peer_video_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  PeerState::PeerVideoReceiverRuntime& runtime,
  std::string* error) {
  (void)ffmpeg;
  refresh_peer_video_receiver_runtime(runtime);

  std::string window_title;
  std::string codec_path;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    window_title = "VDS Native Viewer - " + (runtime.surface_id.empty() ? "peer-video" : runtime.surface_id);
    codec_path = runtime.codec_path.empty() ? "h264" : runtime.codec_path;
    runtime.window_title = window_title;
    runtime.command_line.clear();
    runtime.closing = false;
    runtime.pending_video_annexb_bytes.clear();
    runtime.startup_video_decoder_config_au.clear();
    runtime.startup_waiting_for_random_access = true;
    runtime.launch_attempted = true;
    runtime.last_start_attempt_at_unix_ms = vds::media_agent::current_time_millis();
    runtime.last_error.clear();
    runtime.reason = "peer-video-surface-starting";
  }

  NativeVideoSurfaceConfig config;
  config.surface_id = runtime.surface_id;
  config.window_title = window_title;
  config.codec = codec_path;
  config.layout = runtime.surface_layout;

  std::string create_error;
  auto surface = create_native_video_surface(config, &create_error);
  if (!surface) {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface_attached = false;
    runtime.running = false;
    runtime.decoder_ready = false;
    runtime.last_error = create_error;
    runtime.reason = "peer-video-surface-start-failed";
    if (error) {
      *error = create_error;
    }
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface = surface;
    runtime.last_start_success_at_unix_ms = vds::media_agent::current_time_millis();
  }

  refresh_peer_video_receiver_runtime(runtime);
  if (error) {
    error->clear();
  }
  return true;
}

bool is_peer_video_surface_shutdown_reason(const std::string& reason) {
  return reason == "peer-closed" ||
    reason == "surface-detached" ||
    reason == "surface-reattach" ||
    reason == "surface-destroyed" ||
    reason == "surface-window-closed" ||
    reason == "native-surface-stopped";
}

bool restart_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, std::string* error) {
  stop_peer_video_surface_attachment(runtime, "peer-video-surface-auto-restart");
  const FfmpegProbeResult unused_ffmpeg;
  return start_peer_video_surface_attachment(unused_ffmpeg, runtime, error);
}

void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = std::move(runtime.surface);
  }

  if (surface) {
    surface->close(reason);
  }

  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.surface_attached = false;
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.process_id = 0;
  runtime.pending_video_annexb_bytes.clear();
  runtime.startup_video_decoder_config_au.clear();
  runtime.startup_waiting_for_random_access = true;
  runtime.reason = reason;
  runtime.last_stop_at_unix_ms = vds::media_agent::current_time_millis();
}

bool update_peer_video_surface_layout(
  PeerState::PeerVideoReceiverRuntime& runtime,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface_layout = layout;
    surface = runtime.surface;
  }

  if (!surface) {
    if (error) {
      error->clear();
    }
    return true;
  }

  return surface->update_layout(layout, error);
}

void refresh_surface_attachment_state(SurfaceAttachmentState& state) {
  if (state.live_preview_runtime) {
    const NativeLivePreviewSnapshot snapshot = state.live_preview_runtime->snapshot();
    state.attached = snapshot.attached;
    state.launch_attempted = snapshot.launch_attempted;
    state.running = snapshot.running;
    state.waiting_for_artifact = snapshot.waiting_for_artifact;
    state.decoder_ready = snapshot.decoder_ready;
    state.decoded_frames_rendered = snapshot.decoded_frames_rendered;
    state.frame_interval_stddev_ms = snapshot.frame_interval_stddev_ms;
    state.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
    state.process_id = snapshot.process_id;
    state.preview_surface_backend = snapshot.preview_surface_backend;
    state.decoder_backend = snapshot.decoder_backend;
    state.codec_path = snapshot.codec_path;
    state.implementation = snapshot.implementation;
    state.media_path = snapshot.media_path;
    state.window_title = snapshot.window_title;
    state.embedded_parent_debug = snapshot.embedded_parent_debug;
    state.surface_window_debug = snapshot.surface_window_debug;
    state.reason = snapshot.reason;
    state.last_error = snapshot.last_error;
    state.command_line.clear();
    return;
  }

  if (state.preview_runtime) {
    const NativeArtifactPreviewSnapshot snapshot = state.preview_runtime->snapshot();
    state.attached = snapshot.attached;
    state.launch_attempted = snapshot.launch_attempted;
    state.running = snapshot.running;
    state.waiting_for_artifact = snapshot.waiting_for_artifact;
    state.decoder_ready = snapshot.decoder_ready;
    state.decoded_frames_rendered = snapshot.decoded_frames_rendered;
    state.frame_interval_stddev_ms = 0.0;
    state.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
    state.process_id = snapshot.process_id;
    state.preview_surface_backend = snapshot.preview_surface_backend;
    state.decoder_backend = snapshot.decoder_backend;
    state.codec_path = snapshot.codec_path;
    state.implementation = snapshot.implementation;
    state.media_path = snapshot.media_path;
    state.window_title = snapshot.window_title;
    state.reason = snapshot.reason;
    state.last_error = snapshot.last_error;
    state.command_line.clear();
    return;
  }

  if (!state.process_handle) {
    return;
  }

  DWORD exit_code = STILL_ACTIVE;
  if (!GetExitCodeProcess(state.process_handle, &exit_code)) {
    state.running = false;
    state.last_error = vds::media_agent::format_windows_error(GetLastError());
    state.reason = "surface-process-state-read-failed";
    close_surface_attachment_handles(state);
    state.process_id = 0;
    return;
  }

  if (exit_code == STILL_ACTIVE) {
    state.running = true;
    return;
  }

  state.running = false;
  state.last_exit_code = static_cast<int>(exit_code);
  state.reason = "surface-process-exited";
  close_surface_attachment_handles(state);
  state.process_id = 0;
}

void sync_surface_attachment_from_peer_runtime(
  SurfaceAttachmentState& state,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime) {
  if (!runtime) {
    return;
  }

  refresh_peer_video_receiver_runtime(*runtime);

  std::lock_guard<std::mutex> lock(runtime->mutex);
  state.attached = runtime->surface_attached;
  state.launch_attempted = runtime->launch_attempted;
  state.running = runtime->running;
  state.waiting_for_artifact = false;
  state.decoder_ready = runtime->decoder_ready;
  state.decoded_frames_rendered = runtime->decoded_frames_rendered;
  state.frame_interval_stddev_ms = runtime->frame_interval_stddev_ms;
  state.last_decoded_frame_at_unix_ms = runtime->last_decoded_frame_at_unix_ms;
  state.process_id = runtime->process_id;
  state.last_exit_code = runtime->last_exit_code;
  state.preview_surface_backend = runtime->preview_surface_backend;
  state.decoder_backend = runtime->decoder_backend;
  state.codec_path = runtime->codec_path;
  state.implementation = runtime->implementation;
  state.window_title = runtime->window_title;
  state.embedded_parent_debug = runtime->embedded_parent_debug;
  state.surface_window_debug = runtime->surface_window_debug;
  state.reason = runtime->reason;
  state.last_error = runtime->last_error;
  state.command_line = runtime->command_line;
  state.surface_layout = runtime->surface_layout;
  state.last_start_attempt_at_unix_ms = runtime->last_start_attempt_at_unix_ms;
  state.last_start_success_at_unix_ms = runtime->last_start_success_at_unix_ms;
  state.last_stop_at_unix_ms = runtime->last_stop_at_unix_ms;
}

SurfaceAttachmentState start_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  const HostCapturePlan& host_capture_plan,
  const HostCaptureProcessState& host_capture_process,
  const HostCaptureArtifactProbe& host_capture_artifact,
  SurfaceAttachmentState state) {
  (void)ffmpeg;
  state.attached = true;
  state.preview_runtime.reset();
  state.live_preview_runtime.reset();
  state.preview_surface_backend = "native-win32-gdi";
  state.decoder_backend = "none";
  state.decoder_ready = false;
  state.decoded_frames_rendered = 0;
  state.frame_interval_stddev_ms = 0.0;
  state.last_decoded_frame_at_unix_ms = -1;
  state.codec_path = host_capture_artifact.video_codec.empty()
    ? "h264"
    : vds::media_agent::to_lower_copy(host_capture_artifact.video_codec);
  state.implementation = host_capture_plan.capture_backend == "wgc"
    ? "wgc-live-preview"
    : "ffmpeg-native-artifact-preview";
  state.media_path = host_capture_plan.capture_backend == "wgc"
    ? host_capture_plan.input_target
    : host_capture_process.output_path;
  state.manifest_path = host_capture_process.manifest_path;
  state.window_title = "VDS Native Preview - " + (state.surface_id.empty() ? "surface" : state.surface_id);
  state.command_line.clear();
  state.last_start_attempt_at_unix_ms = vds::media_agent::current_time_millis();
  state.waiting_for_artifact = false;

  if (!is_host_capture_surface_target(state.target)) {
    state.reason = "surface-target-not-supported";
    state.last_error = "Only the host-capture artifact target is implemented for native surface attachment.";
    return state;
  }

  if (host_capture_plan.capture_backend == "wgc") {
    state.launch_attempted = true;
    NativeLivePreviewConfig config;
    config.surface_id = state.surface_id;
    config.window_title = state.window_title;
    config.target_kind = host_capture_plan.capture_kind == "display" ? "display" : "window";
    config.display_id = host_capture_plan.capture_display_id.empty() ? "0" : host_capture_plan.capture_display_id;
    config.window_handle = host_capture_plan.capture_handle;
    config.capture_state = host_capture_plan.capture_state;
    config.layout = state.surface_layout;

    std::string preview_error;
    state.live_preview_runtime = create_native_live_preview(config, &preview_error);
    if (!state.live_preview_runtime) {
      state.reason = "surface-live-preview-start-failed";
      state.last_error = preview_error;
      return state;
    }

    state.running = true;
    state.waiting_for_artifact = false;
    state.last_start_success_at_unix_ms = vds::media_agent::current_time_millis();
    refresh_surface_attachment_state(state);
    return state;
  }

  if (host_capture_process.output_path.empty()) {
    state.waiting_for_artifact = true;
    state.reason = "surface-waiting-for-artifact-path";
    state.last_error = "Host capture artifact path is not available yet.";
    return state;
  }

  if (!host_capture_artifact.ready) {
    state.waiting_for_artifact = true;
    state.reason = "surface-waiting-for-artifact-ready";
    state.last_error = host_capture_artifact.last_error.empty()
      ? "Host capture artifact is not decodable yet."
      : host_capture_artifact.last_error;
    return state;
  }

  state.launch_attempted = true;
  wait_for_path_to_exist(host_capture_process.output_path, 2000);
  NativeArtifactPreviewConfig config;
  config.surface_id = state.surface_id;
  config.window_title = state.window_title;
  config.media_path = state.media_path;
  config.codec = state.codec_path;
  config.layout = state.surface_layout;

  std::string preview_error;
  state.preview_runtime = create_native_artifact_preview(config, &preview_error);
  if (!state.preview_runtime) {
    state.reason = "surface-preview-start-failed";
    state.last_error = preview_error;
    return state;
  }

  state.running = true;
  state.waiting_for_artifact = false;
  state.last_start_success_at_unix_ms = vds::media_agent::current_time_millis();
  refresh_surface_attachment_state(state);
  return state;
}

void stop_surface_attachment(SurfaceAttachmentState& state, const std::string& reason) {
  refresh_surface_attachment_state(state);
  if (state.live_preview_runtime) {
    state.live_preview_runtime->close(reason);
    state.live_preview_runtime.reset();
    state.running = false;
    state.waiting_for_artifact = false;
    state.process_id = 0;
    state.reason = reason;
    state.last_stop_at_unix_ms = vds::media_agent::current_time_millis();
    return;
  }
  if (state.preview_runtime) {
    state.preview_runtime->close(reason);
    state.preview_runtime.reset();
    state.running = false;
    state.waiting_for_artifact = false;
    state.process_id = 0;
    state.reason = reason;
    state.last_stop_at_unix_ms = vds::media_agent::current_time_millis();
    return;
  }

  if (state.process_handle && state.running) {
    TerminateProcess(state.process_handle, 0);
    WaitForSingleObject(state.process_handle, 2000);
  }

  close_surface_attachment_handles(state);
  state.running = false;
  state.waiting_for_artifact = false;
  state.process_id = 0;
  state.reason = reason;
  state.last_stop_at_unix_ms = vds::media_agent::current_time_millis();
}

bool update_surface_attachment_layout(
  SurfaceAttachmentState& state,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  state.surface_layout = layout;

  if (state.peer_runtime) {
    const bool updated = update_peer_video_surface_layout(*state.peer_runtime, layout, error);
    sync_surface_attachment_from_peer_runtime(state, state.peer_runtime);
    return updated;
  }

  if (state.live_preview_runtime) {
    const bool updated = state.live_preview_runtime->update_layout(layout, error);
    refresh_surface_attachment_state(state);
    return updated;
  }

  if (state.preview_runtime) {
    const bool updated = state.preview_runtime->update_layout(layout, error);
    refresh_surface_attachment_state(state);
    return updated;
  }

  if (error) {
    error->clear();
  }
  return true;
}

#else
void refresh_surface_attachment_state(SurfaceAttachmentState&) {}

SurfaceAttachmentState start_surface_attachment(
  const FfmpegProbeResult&,
  const HostCapturePlan&,
  const HostCaptureProcessState&,
  const HostCaptureArtifactProbe&,
  SurfaceAttachmentState state) {
  state.attached = true;
  state.preview_surface_backend = "native-window-embedding";
  state.decoder_backend = "none";
  state.decoder_ready = false;
  state.decoded_frames_rendered = 0;
  state.last_decoded_frame_at_unix_ms = -1;
  state.reason = "surface-unsupported-platform";
  state.last_error = "Native preview surfaces are only implemented on Windows.";
  return state;
}

void stop_surface_attachment(SurfaceAttachmentState& state, const std::string& reason) {
  state.running = false;
  state.process_id = 0;
  state.reason = reason;
}

bool update_surface_attachment_layout(
  SurfaceAttachmentState& state,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  state.surface_layout = layout;
  if (error) {
    error->clear();
  }
  return true;
}

bool start_peer_video_surface_attachment(
  const FfmpegProbeResult&,
  PeerState::PeerVideoReceiverRuntime&,
  std::string* error) {
  if (error) {
    *error = "peer-video-surface-is-only-implemented-on-windows";
  }
  return false;
}

bool restart_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, std::string* error) {
  stop_peer_video_surface_attachment(runtime, "peer-video-surface-auto-restart");
  const FfmpegProbeResult unused_ffmpeg;
  return start_peer_video_surface_attachment(unused_ffmpeg, runtime, error);
}

void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason) {
  runtime.surface_attached = false;
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.reason = reason;
}

bool update_peer_video_surface_layout(
  PeerState::PeerVideoReceiverRuntime& runtime,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  runtime.surface_layout = layout;
  if (error) {
    error->clear();
  }
  return true;
}

bool is_peer_video_surface_shutdown_reason(const std::string& reason) {
  return reason == "peer-closed" ||
    reason == "surface-detached" ||
    reason == "surface-reattach" ||
    reason == "surface-destroyed" ||
    reason == "surface-window-closed" ||
    reason == "native-surface-stopped";
}

void sync_surface_attachment_from_peer_runtime(
  SurfaceAttachmentState&,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>&) {}
#endif

std::string surface_attachment_json(SurfaceAttachmentState& state) {
  if (is_peer_video_surface_target(state.target)) {
    sync_surface_attachment_from_peer_runtime(state, state.peer_runtime);
  } else {
    refresh_surface_attachment_state(state);
  }

  NativeLivePreviewSnapshot live_preview_snapshot;
  const bool has_live_preview_snapshot = static_cast<bool>(state.live_preview_runtime);
  if (has_live_preview_snapshot) {
    live_preview_snapshot = state.live_preview_runtime->snapshot();
  }

  std::ostringstream payload;
  payload
    << "{\"attached\":" << (state.attached ? "true" : "false")
    << ",\"launchAttempted\":" << (state.launch_attempted ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"waitingForArtifact\":" << (state.waiting_for_artifact ? "true" : "false")
    << ",\"decoderReady\":" << (state.decoder_ready ? "true" : "false")
    << ",\"restartCount\":" << state.restart_count
    << ",\"decodedFramesRendered\":" << state.decoded_frames_rendered
    << ",\"frameIntervalStddevMs\":" << state.frame_interval_stddev_ms
    << ",\"avgCopyResourceUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_copy_resource_us : 0)
    << ",\"avgMapUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_map_us : 0)
    << ",\"avgMemcpyUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_memcpy_us : 0)
    << ",\"avgTotalReadbackUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_total_readback_us : 0)
    << ",\"surface\":\"" << vds::media_agent::json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << vds::media_agent::json_escape(state.target) << "\""
    << ",\"processId\":" << state.process_id
    << ",\"lastExitCode\":";

  if (state.last_exit_code == std::numeric_limits<int>::min()) {
    payload << "null";
  } else {
    payload << state.last_exit_code;
  }

  payload
    << ",\"previewSurfaceBackend\":\"" << vds::media_agent::json_escape(state.preview_surface_backend) << "\""
    << ",\"decoderBackend\":\"" << vds::media_agent::json_escape(state.decoder_backend) << "\""
    << ",\"codecPath\":\"" << vds::media_agent::json_escape(state.codec_path) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\""
    << ",\"layout\":" << surface_layout_json(state.surface_layout)
    << ",\"mediaPath\":\"" << vds::media_agent::json_escape(state.media_path) << "\""
    << ",\"manifestPath\":\"" << vds::media_agent::json_escape(state.manifest_path) << "\""
    << ",\"windowTitle\":\"" << vds::media_agent::json_escape(state.window_title) << "\""
    << ",\"embeddedParentDebug\":\"" << vds::media_agent::json_escape(state.embedded_parent_debug) << "\""
    << ",\"surfaceWindowDebug\":\"" << vds::media_agent::json_escape(state.surface_window_debug) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << vds::media_agent::json_escape(state.command_line) << "\""
    << ",\"lastStartAttemptAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.last_start_attempt_at_unix_ms);
  payload << ",\"lastStartSuccessAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.last_start_success_at_unix_ms);
  payload << ",\"lastStopAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.last_stop_at_unix_ms);
  payload << ",\"lastDecodedFrameAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.last_decoded_frame_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string build_surface_result_json(SurfaceAttachmentState& state) {
  std::ostringstream payload;
  payload
    << "{\"surface\":\"" << vds::media_agent::json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << vds::media_agent::json_escape(state.target) << "\""
    << ",\"attachment\":" << surface_attachment_json(state)
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\"}";
  return payload.str();
}

std::string build_surface_attachments_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload << "[";
  bool first = true;
  for (auto& entry : state.attached_surfaces) {
    if (!first) {
      payload << ",";
    }
    first = false;
    payload << surface_attachment_json(entry.second);
  }
  payload << "]";
  return payload.str();
}
