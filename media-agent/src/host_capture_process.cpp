#include "host_capture_process.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "host_pipeline.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "platform_utils.h"
#include "process_runner.h"
#include "string_utils.h"
#include "time_utils.h"

namespace fs = std::filesystem;

namespace {

std::string build_host_capture_session_id() {
  std::ostringstream session_id;
  session_id << vds::media_agent::current_time_millis();
#ifdef _WIN32
  session_id << "-" << GetCurrentProcessId();
#endif
  return session_id.str();
}

bool is_native_host_capture_process_enabled() {
  static const bool enabled = []() {
#ifdef _WIN32
    char* raw_value = nullptr;
    std::size_t raw_length = 0;
    const errno_t env_result = _dupenv_s(&raw_value, &raw_length, "VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS");
    const bool is_enabled = env_result == 0 && raw_value && std::string(raw_value) == "1";
    if (raw_value) {
      std::free(raw_value);
    }
    return is_enabled;
#else
    const char* raw_value = std::getenv("VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS");
    return raw_value && std::string(raw_value) == "1";
#endif
  }();
  return enabled;
}

bool should_preserve_host_capture_output() {
  static const bool preserve = []() {
#ifdef _WIN32
    char* raw_value = nullptr;
    std::size_t raw_length = 0;
    const errno_t env_result = _dupenv_s(&raw_value, &raw_length, "VDS_PRESERVE_AGENT_HOST_CAPTURE_OUTPUT");
    const bool should_preserve = env_result == 0 && raw_value && std::string(raw_value) == "1";
    if (raw_value) {
      std::free(raw_value);
    }
    return should_preserve;
#else
    const char* raw_value = std::getenv("VDS_PRESERVE_AGENT_HOST_CAPTURE_OUTPUT");
    return raw_value && std::string(raw_value) == "1";
#endif
  }();
  return preserve;
}

bool initialize_host_capture_artifact_paths(HostCaptureProcessState& state) {
  try {
    state.session_id = build_host_capture_session_id();
    const fs::path output_dir = fs::temp_directory_path() / "vds-media-agent" / ("host-session-" + state.session_id);
    fs::create_directories(output_dir);
    state.output_directory = output_dir.string();
    state.output_path = (output_dir / "capture.ts").string();
    state.manifest_path = (output_dir / "capture-manifest.json").string();
    state.updated_at_unix_ms = vds::media_agent::current_time_millis();
    return true;
  } catch (...) {
    state.session_id.clear();
    state.output_directory.clear();
    state.output_path.clear();
    state.manifest_path.clear();
    return false;
  }
}

#ifdef _WIN32
void close_host_capture_process_handles(HostCaptureProcessState& state) {
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

std::string resolve_ffprobe_path(const FfmpegProbeResult& ffmpeg) {
  if (ffmpeg.path.empty()) {
    return {};
  }

  try {
    const fs::path ffprobe_path = fs::path(ffmpeg.path).parent_path() / "ffprobe.exe";
    return fs::exists(ffprobe_path) ? ffprobe_path.string() : std::string{};
  } catch (...) {
    return {};
  }
}

std::string build_host_capture_manifest_json(
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState& state,
  const HostCaptureArtifactProbe& artifact_probe) {
  std::ostringstream payload;
  payload
    << "{\"sessionId\":\"" << vds::media_agent::json_escape(state.session_id) << "\""
    << ",\"container\":\"" << vds::media_agent::json_escape(state.container) << "\""
    << ",\"outputMode\":\"" << vds::media_agent::json_escape(state.output_mode) << "\""
    << ",\"preserveOutput\":" << (state.preserve_output ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"outputBytes\":" << state.output_bytes
    << ",\"outputDirectory\":\"" << vds::media_agent::json_escape(state.output_directory) << "\""
    << ",\"mediaPath\":\"" << vds::media_agent::json_escape(state.output_path) << "\""
    << ",\"manifestPath\":\"" << vds::media_agent::json_escape(state.manifest_path) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << ",\"startedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.started_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"stoppedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.stopped_at_unix_ms);
  payload
    << ",\"pipeline\":" << host_pipeline_json(pipeline)
    << ",\"capturePlan\":" << host_capture_plan_json(plan)
    << ",\"captureProcess\":" << host_capture_process_json(state)
    << ",\"captureArtifact\":" << host_capture_artifact_json(artifact_probe)
    << "}";
  return payload.str();
}

}  // namespace

HostCaptureProcessState build_host_capture_process_state() {
  HostCaptureProcessState state;
  state.enabled = is_native_host_capture_process_enabled();
  state.preserve_output = should_preserve_host_capture_output();
  state.output_mode = state.enabled ? "mpegts-session-artifact" : "disabled";
  if (state.enabled) {
    if (initialize_host_capture_artifact_paths(state)) {
      state.reason = "host-capture-process-idle";
    } else {
      state.reason = "host-capture-artifact-path-init-failed";
      state.last_error = "Failed to initialize the native host capture artifact directory.";
    }
  } else {
    state.reason = "host-capture-process-disabled";
  }
  return state;
}

std::string host_capture_process_json(HostCaptureProcessState& state) {
  refresh_host_capture_process_state(state);

  std::ostringstream payload;
  payload
    << "{\"enabled\":" << (state.enabled ? "true" : "false")
    << ",\"launchAttempted\":" << (state.launch_attempted ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"preserveOutput\":" << (state.preserve_output ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"outputBytes\":" << state.output_bytes
    << ",\"lastExitCode\":";

  if (state.last_exit_code == std::numeric_limits<int>::min()) {
    payload << "null";
  } else {
    payload << state.last_exit_code;
  }

  payload
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\""
    << ",\"outputMode\":\"" << vds::media_agent::json_escape(state.output_mode) << "\""
    << ",\"container\":\"" << vds::media_agent::json_escape(state.container) << "\""
    << ",\"sessionId\":\"" << vds::media_agent::json_escape(state.session_id) << "\""
    << ",\"outputDirectory\":\"" << vds::media_agent::json_escape(state.output_directory) << "\""
    << ",\"outputPath\":\"" << vds::media_agent::json_escape(state.output_path) << "\""
    << ",\"manifestPath\":\"" << vds::media_agent::json_escape(state.manifest_path) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << vds::media_agent::json_escape(state.command_line) << "\""
    << ",\"startedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.started_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"stoppedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.stopped_at_unix_ms);
  payload << "}";
  return payload.str();
}

void persist_host_capture_process_manifest(
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState& state,
  const HostCaptureArtifactProbe& artifact_probe) {
  if (state.manifest_path.empty()) {
    return;
  }

  state.updated_at_unix_ms = vds::media_agent::current_time_millis();
  try {
    std::ofstream output(state.manifest_path, std::ios::binary | std::ios::trunc);
    if (!output.is_open()) {
      return;
    }
    output << build_host_capture_manifest_json(pipeline, plan, state, artifact_probe);
    output.flush();
  } catch (...) {
  }
}

HostCaptureArtifactProbe probe_host_capture_artifact(
  const FfmpegProbeResult& ffmpeg,
  const HostCaptureProcessState& host_capture_process,
  HostCaptureArtifactProbe previous_probe) {
  HostCaptureArtifactProbe probe = previous_probe;
  probe.media_path = host_capture_process.output_path;
  probe.last_probe_at_unix_ms = vds::media_agent::current_time_millis();

#ifndef _WIN32
  probe.available = false;
  probe.ready = false;
  probe.reason = "artifact-probe-unsupported-platform";
  probe.last_error = "Host capture artifact probing is only implemented on Windows.";
  return probe;
#else
  if (host_capture_process.output_path.empty()) {
    probe.available = false;
    probe.ready = false;
    probe.reason = "artifact-path-missing";
    probe.last_error = "Host capture artifact path is not available.";
    return probe;
  }

  try {
    if (!fs::exists(host_capture_process.output_path)) {
      probe.available = false;
      probe.ready = false;
      probe.file_size_bytes = 0;
      probe.reason = host_capture_process.running ? "artifact-pending" : "artifact-file-missing";
      probe.last_error = host_capture_process.running
        ? "Host capture artifact file has not been materialized yet."
        : "Host capture artifact file does not exist.";
      return probe;
    }

    probe.file_size_bytes = static_cast<unsigned long long>(fs::file_size(host_capture_process.output_path));
    probe.available = probe.file_size_bytes > 0;
  } catch (...) {
    probe.available = false;
    probe.ready = false;
    probe.reason = "artifact-file-stat-failed";
    probe.last_error = "Failed to read host capture artifact file metadata.";
    return probe;
  }

  const std::string ffprobe_path = resolve_ffprobe_path(ffmpeg);
  if (ffprobe_path.empty()) {
    probe.ready = false;
    probe.reason = "ffprobe-unavailable";
    probe.last_error = "Bundled FFprobe runtime is not available for host capture artifact validation.";
    return probe;
  }

  if (!probe.available) {
    probe.ready = false;
    probe.reason = host_capture_process.running ? "artifact-growing" : "artifact-empty";
    probe.last_error = host_capture_process.running
      ? "Host capture artifact exists but has not emitted decodable payload yet."
      : "Host capture artifact is empty.";
    return probe;
  }

  const std::string command =
    vds::media_agent::quote_command_path(ffprobe_path) +
    " -v error -select_streams v:0 -show_entries stream=codec_name,width,height,avg_frame_rate,pix_fmt -show_entries format=format_name,size"
    " -of default=noprint_wrappers=1:nokey=0 " + vds::media_agent::quote_command_path(host_capture_process.output_path) +
    " 2>&1";

  const CommandResult result = vds::media_agent::run_command_capture(command);
  if (!result.launched || result.exit_code != 0) {
    probe.ready = false;
    probe.reason = "artifact-probe-failed";
    probe.last_error = vds::media_agent::trim_copy(result.output);
    if (probe.last_error.empty()) {
      probe.last_error = "FFprobe failed to inspect the host capture artifact.";
    }
    return probe;
  }

  for (const std::string& raw_line : vds::media_agent::split_lines(result.output)) {
    const std::string line = vds::media_agent::trim_copy(raw_line);
    const std::size_t equals_index = line.find('=');
    if (equals_index == std::string::npos) {
      continue;
    }

    const std::string key = vds::media_agent::trim_copy(line.substr(0, equals_index));
    const std::string value = vds::media_agent::trim_copy(line.substr(equals_index + 1));
    if (key == "codec_name") {
      probe.video_codec = value;
    } else if (key == "width") {
      try { probe.width = std::stoi(value); } catch (...) {}
    } else if (key == "height") {
      try { probe.height = std::stoi(value); } catch (...) {}
    } else if (key == "pix_fmt") {
      probe.pixel_format = value;
    } else if (key == "format_name") {
      probe.format_name = value;
    } else if (key == "size") {
      try { probe.file_size_bytes = static_cast<unsigned long long>(std::stoull(value)); } catch (...) {}
    } else if (key == "avg_frame_rate") {
      const std::size_t slash_index = value.find('/');
      try {
        if (slash_index != std::string::npos) {
          const double numerator = std::stod(value.substr(0, slash_index));
          const double denominator = std::stod(value.substr(slash_index + 1));
          if (denominator > 0.0) {
            probe.frame_rate = numerator / denominator;
          }
        } else {
          probe.frame_rate = std::stod(value);
        }
      } catch (...) {
      }
    }
  }

  probe.ready =
    !probe.video_codec.empty() &&
    probe.width > 0 &&
    probe.height > 0 &&
    probe.file_size_bytes > 0;
  probe.reason = probe.ready ? "artifact-probed" : "artifact-probe-incomplete";
  probe.last_error.clear();
  return probe;
#endif
}

void refresh_host_capture_process_state(HostCaptureProcessState& state) {
  if (!state.output_path.empty()) {
    try {
      if (fs::exists(state.output_path)) {
        state.output_bytes = static_cast<unsigned long long>(fs::file_size(state.output_path));
      } else {
        state.output_bytes = 0;
      }
    } catch (...) {
    }
  }

  state.updated_at_unix_ms = vds::media_agent::current_time_millis();

#ifdef _WIN32
  if (!state.process_handle) {
    return;
  }

  DWORD exit_code = STILL_ACTIVE;
  if (!GetExitCodeProcess(state.process_handle, &exit_code)) {
    state.running = false;
    state.last_error = vds::media_agent::format_windows_error(GetLastError());
    state.reason = "host-capture-process-state-read-failed";
    close_host_capture_process_handles(state);
    state.process_id = 0;
    return;
  }

  if (exit_code == STILL_ACTIVE) {
    state.running = true;
    return;
  }

  state.running = false;
  state.last_exit_code = static_cast<int>(exit_code);
  state.reason = "host-capture-process-exited";
  state.stopped_at_unix_ms = vds::media_agent::current_time_millis();
  close_host_capture_process_handles(state);
  state.process_id = 0;
#endif
}

void stop_host_capture_process(
  HostCaptureProcessState& state,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureArtifactProbe& artifact_probe,
  const std::string& reason) {
  refresh_host_capture_process_state(state);
  const bool already_stopped =
    !state.running &&
#ifdef _WIN32
    !state.process_handle &&
#endif
    state.stopped_at_unix_ms > 0;

#ifdef _WIN32
  if (state.process_handle && state.running) {
    TerminateProcess(state.process_handle, 0);
    WaitForSingleObject(state.process_handle, 2000);
  }

  close_host_capture_process_handles(state);
#endif
  state.running = false;
  state.process_id = 0;
  if (!(already_stopped && reason == "agent-shutdown")) {
    state.reason = reason;
    state.stopped_at_unix_ms = vds::media_agent::current_time_millis();
    state.updated_at_unix_ms = state.stopped_at_unix_ms;
  }
  if (state.preserve_output && !(already_stopped && reason == "agent-shutdown")) {
    persist_host_capture_process_manifest(pipeline, plan, state, artifact_probe);
  }
  if (!state.preserve_output && !state.output_path.empty()) {
    try {
      if (!state.output_directory.empty()) {
        fs::remove_all(state.output_directory);
      } else {
        fs::remove(state.output_path);
      }
      state.output_directory.clear();
      state.output_path.clear();
      state.manifest_path.clear();
      state.output_bytes = 0;
    } catch (...) {
    }
  }
}

HostCaptureProcessState start_host_capture_process(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState state) {
  const auto finish = [&](HostCaptureProcessState final_state) {
    const HostCaptureArtifactProbe artifact_probe = probe_host_capture_artifact(ffmpeg, final_state);
    persist_host_capture_process_manifest(pipeline, plan, final_state, artifact_probe);
    return final_state;
  };
  state.command_line = build_ffmpeg_host_capture_command(ffmpeg, pipeline, plan, state);

  if (!state.enabled) {
    return finish(state);
  }

  if (plan.capture_backend == "wgc") {
    state.launch_attempted = true;
    state.running = false;
    state.reason = "host-capture-process-skipped-for-wgc";
    state.last_error.clear();
    state.command_line.clear();
    return finish(state);
  }

  state.launch_attempted = true;

  if (!plan.ready || !plan.validated || state.command_line.empty()) {
    state.reason = "host-capture-process-plan-not-ready";
    state.last_error = !plan.last_error.empty()
      ? plan.last_error
      : "Host capture plan is not validated yet, so the FFmpeg host capture process was not started.";
    return finish(state);
  }

#ifdef _WIN32
  SECURITY_ATTRIBUTES security_attributes {};
  security_attributes.nLength = sizeof(security_attributes);
  security_attributes.bInheritHandle = TRUE;

  HANDLE nul_handle = CreateFileW(
    L"NUL",
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security_attributes,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr
  );

  if (nul_handle == INVALID_HANDLE_VALUE) {
    state.reason = "host-capture-process-stdio-open-failed";
    state.last_error = vds::media_agent::format_windows_error(GetLastError());
    return finish(state);
  }

  STARTUPINFOW startup_info {};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = nul_handle;
  startup_info.hStdOutput = nul_handle;
  startup_info.hStdError = nul_handle;

  PROCESS_INFORMATION process_info {};
  std::wstring command_line = vds::media_agent::utf8_to_wide(state.command_line);
  if (command_line.empty()) {
    CloseHandle(nul_handle);
    state.reason = "host-capture-process-command-conversion-failed";
    state.last_error = "Failed to convert FFmpeg host capture command line to UTF-16.";
    return finish(state);
  }

  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  const BOOL created = CreateProcessW(
    nullptr,
    mutable_command.data(),
    nullptr,
    nullptr,
    TRUE,
    CREATE_NO_WINDOW,
    nullptr,
    nullptr,
    &startup_info,
    &process_info
  );

  CloseHandle(nul_handle);

  if (!created) {
    state.reason = "host-capture-process-launch-failed";
    state.last_error = vds::media_agent::format_windows_error(GetLastError());
    return finish(state);
  }

  state.running = true;
  state.process_id = static_cast<unsigned long>(process_info.dwProcessId);
  state.process_handle = process_info.hProcess;
  state.thread_handle = process_info.hThread;
  state.started_at_unix_ms = vds::media_agent::current_time_millis();
  state.updated_at_unix_ms = state.started_at_unix_ms;
  state.stopped_at_unix_ms = 0;
  state.reason = "host-capture-process-running";
  return finish(state);
#else
  state.reason = "host-capture-process-unsupported-platform";
  state.last_error = "Native FFmpeg host capture process lifecycle is only implemented on Windows.";
  return finish(state);
#endif
}
