#include "peer_video_sender.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdint>
#include <mutex>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "agent_diagnostics.h"
#include "host_capture_plan.h"
#include "host_pipeline.h"
#include "platform_utils.h"
#include "peer_transport.h"
#include "relay_dispatch.h"
#include "time_utils.h"
#include "video_access_unit.h"
#include "win32_placeholder_frame.h"
#include "wgc_capture.h"

namespace {

using vds::media_agent::current_time_micros_steady;
using vds::media_agent::current_time_millis;
using vds::media_agent::extract_annexb_video_access_units;
using vds::media_agent::normalize_video_codec;
using vds::media_agent::sleep_until_steady_us;
using vds::media_agent::video_access_unit_has_decoder_config_nal;
using vds::media_agent::video_access_unit_has_random_access_nal;
using vds::media_agent::video_bootstrap_is_complete;

#ifdef _WIN32
using vds::media_agent::format_windows_error;
using vds::media_agent::utf8_to_wide;

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
  HWND hwnd = parse_runtime_window_handle(window_handle);
  if (!hwnd || !IsWindow(hwnd)) {
    return WindowCaptureAvailability::unavailable;
  }
  if (IsIconic(hwnd)) {
    return WindowCaptureAvailability::minimized;
  }
  return WindowCaptureAvailability::normal;
}

std::vector<std::uint8_t> build_window_restore_placeholder_frame_bgra(int width, int height) {
  return build_placeholder_frame_bgra(
    width,
    height,
    L"\u7b49\u5f85\u623f\u4e3b\u7a97\u53e3\u6062\u590d"
  );
}
#endif

void emit_peer_video_sender_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

void reset_peer_media_binding_sender_metrics(PeerState::MediaBindingState& binding) {
  binding.process_id = 0;
  binding.source_frames_captured = 0;
  binding.source_bytes_captured = 0;
  binding.avg_source_copy_resource_us = 0;
  binding.avg_source_map_us = 0;
  binding.avg_source_memcpy_us = 0;
  binding.avg_source_total_readback_us = 0;
}

}  // namespace

#ifdef _WIN32
void close_peer_video_sender_handles(PeerState::PeerVideoSenderRuntime& runtime) {
  if (runtime.thread_handle) {
    CloseHandle(runtime.thread_handle);
    runtime.thread_handle = nullptr;
  }
  if (runtime.process_handle) {
    CloseHandle(runtime.process_handle);
    runtime.process_handle = nullptr;
  }
  if (runtime.stdin_write_handle) {
    CloseHandle(runtime.stdin_write_handle);
    runtime.stdin_write_handle = nullptr;
  }
  if (runtime.stdout_read_handle) {
    CloseHandle(runtime.stdout_read_handle);
    runtime.stdout_read_handle = nullptr;
  }
}
#endif

#ifdef _WIN32
bool start_peer_video_sender(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  PeerState& peer,
  std::string* error) {
  emit_peer_video_sender_breadcrumb(
    std::string("startPeerVideoSender:start peer=") + peer.peer_id +
    " codec=" + normalize_video_codec(plan.codec_path, normalize_video_codec(pipeline.requested_video_codec)) +
    " backend=" + plan.capture_backend);
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  const std::string command_line = build_ffmpeg_peer_video_sender_command(ffmpeg, pipeline, plan);
  if (command_line.empty()) {
    if (error) {
      *error = "ffmpeg-peer-video-sender-command-unavailable";
    }
    return false;
  }
  emit_peer_video_sender_breadcrumb(std::string("startPeerVideoSender:after-build-command peer=") + peer.peer_id);

  auto runtime = std::make_shared<PeerState::PeerVideoSenderRuntime>();
  runtime->launch_attempted = true;
  runtime->command_line = command_line;
  runtime->codec_path = normalize_video_codec(plan.codec_path, normalize_video_codec(pipeline.requested_video_codec));
  runtime->frame_interval_us = static_cast<unsigned long long>(
    std::max(1, 1000000 / std::max(1, plan.frame_rate > 0 ? plan.frame_rate : 60))
  );
  runtime->next_frame_timestamp_us = 0;
  runtime->source_backend = plan.capture_backend;

  const bool use_wgc_source = plan.capture_backend == "wgc";
  const WgcFrameSourceConfig wgc_source_config = build_wgc_frame_source_config(plan);
  const bool use_window_restore_placeholder =
    use_wgc_source &&
    wgc_source_config.target_kind == "window" &&
    plan.capture_state == "minimized" &&
    !wgc_source_config.window_handle.empty();
  const int source_frame_width = std::max(1, plan.input_width);
  const int source_frame_height = std::max(1, plan.input_height);

  SECURITY_ATTRIBUTES security_attributes{};
  security_attributes.nLength = sizeof(security_attributes);
  security_attributes.bInheritHandle = TRUE;

  HANDLE stdin_read = nullptr;
  HANDLE stdin_write = nullptr;
  HANDLE stdout_read = nullptr;
  HANDLE stdout_write = nullptr;
  if (use_wgc_source) {
    if (!CreatePipe(&stdin_read, &stdin_write, &security_attributes, 0)) {
      if (error) {
        *error = format_windows_error(GetLastError());
      }
      return false;
    }
    SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0);
  }

  if (!CreatePipe(&stdout_read, &stdout_write, &security_attributes, 0)) {
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);

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
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    CloseHandle(stdout_write);
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  STARTUPINFOW startup_info{};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = stdin_read ? stdin_read : nul_handle;
  startup_info.hStdOutput = stdout_write;
  startup_info.hStdError = nul_handle;

  PROCESS_INFORMATION process_info{};
  std::wstring command_line_wide = utf8_to_wide(command_line);
  if (command_line_wide.empty()) {
    CloseHandle(nul_handle);
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    CloseHandle(stdout_write);
    if (error) {
      *error = "failed to convert peer video sender command line to UTF-16";
    }
    return false;
  }

  std::vector<wchar_t> mutable_command(command_line_wide.begin(), command_line_wide.end());
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
  if (stdin_read) {
    CloseHandle(stdin_read);
  }
  CloseHandle(stdout_write);

  if (!created) {
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  runtime->running = true;
  runtime->process_id = static_cast<unsigned long>(process_info.dwProcessId);
  runtime->process_handle = process_info.hProcess;
  runtime->thread_handle = process_info.hThread;
  runtime->stdin_write_handle = stdin_write;
  runtime->stdout_read_handle = stdout_read;
  runtime->started_at_unix_ms = current_time_millis();
  runtime->updated_at_unix_ms = runtime->started_at_unix_ms;
  runtime->reason = "peer-video-sender-running";
  emit_peer_video_sender_breadcrumb(
    std::string("startPeerVideoSender:after-create-process peer=") + peer.peer_id +
    " pid=" + std::to_string(runtime->process_id));

  if (use_wgc_source && runtime->stdin_write_handle) {
    struct SourceStartState {
      std::mutex mutex;
      std::condition_variable condition;
      bool complete = false;
      bool success = false;
      std::string error;
    };

    auto source_start_state = std::make_shared<SourceStartState>();
    HANDLE stdin_write_handle = runtime->stdin_write_handle;
    const std::string source_peer_id = peer.peer_id;
    runtime->source_thread = std::thread([
      runtime,
      wgc_source_config,
      source_start_state,
      stdin_write_handle,
      source_peer_id,
      use_window_restore_placeholder,
      source_frame_width,
      source_frame_height
    ]() {
      emit_peer_video_sender_breadcrumb(std::string("startPeerVideoSender:source-thread-begin peer=") + source_peer_id);

      auto finish_start = [&](bool success, const std::string& error_message) {
        std::lock_guard<std::mutex> lock(source_start_state->mutex);
        if (source_start_state->complete) {
          return;
        }
        source_start_state->complete = true;
        source_start_state->success = success;
        source_start_state->error = error_message;
        source_start_state->condition.notify_all();
      };

      const auto update_runtime_state = [&](const std::string& reason, const std::string& last_error, bool running) {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = reason;
        runtime->last_error = last_error;
        runtime->running = running;
        runtime->updated_at_unix_ms = current_time_millis();
      };

      const auto write_bgra_frame = [&](const std::vector<std::uint8_t>& bytes) -> bool {
        std::size_t total_written = 0;
        while (total_written < bytes.size() && !runtime->stop_requested.load()) {
          DWORD chunk_written = 0;
          const DWORD chunk_size = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - total_written, 1u << 20));
          const BOOL wrote = WriteFile(
            stdin_write_handle,
            bytes.data() + total_written,
            chunk_size,
            &chunk_written,
            nullptr
          );
          if (!wrote || chunk_written == 0) {
            update_runtime_state("peer-video-source-write-failed", format_windows_error(GetLastError()), false);
            return false;
          }
          total_written += static_cast<std::size_t>(chunk_written);
        }
        return !runtime->stop_requested.load();
      };

      const auto wait_for_next_placeholder_deadline = [&](std::int64_t* deadline_us) -> bool {
        const std::int64_t now_us = current_time_micros_steady();
        if (*deadline_us <= 0) {
          *deadline_us = now_us;
        }
        const bool slept = sleep_until_steady_us(*deadline_us, &runtime->stop_requested);
        *deadline_us += static_cast<std::int64_t>(runtime->frame_interval_us);
        return slept;
      };

      const auto try_create_wgc_source = [&]() -> std::shared_ptr<WgcFrameSource> {
        std::string source_error;
        emit_peer_video_sender_breadcrumb(std::string("startPeerVideoSender:source-before-create peer=") + source_peer_id);
        std::shared_ptr<WgcFrameSource> created = create_wgc_frame_source(wgc_source_config, &source_error);
        emit_peer_video_sender_breadcrumb(
          std::string("startPeerVideoSender:source-after-create peer=") + source_peer_id +
          " ok=" + (created ? "true" : "false"));
        if (!created) {
          update_runtime_state(
            "peer-video-source-start-failed",
            source_error.empty() ? "failed to create wgc frame source for peer video sender" : source_error,
            false
          );
        }
        return created;
      };

      std::shared_ptr<WgcFrameSource> wgc_source;
      bool placeholder_mode_active = use_window_restore_placeholder;
      bool refresh_pending = false;
      std::int64_t next_placeholder_deadline_us = -1;
      const int placeholder_width = std::max(1, source_frame_width);
      const int placeholder_height = std::max(1, source_frame_height);
      std::vector<std::uint8_t> placeholder_frame;
      const auto ensure_placeholder_frame = [&]() -> const std::vector<std::uint8_t>& {
        if (placeholder_frame.empty()) {
          placeholder_frame = build_window_restore_placeholder_frame_bgra(
            placeholder_width,
            placeholder_height
          );
        }
        return placeholder_frame;
      };
      const std::uint64_t min_frame_interval_100ns =
        std::max<std::uint64_t>(1, runtime->frame_interval_us) * 10;
      std::uint64_t next_source_timestamp_100ns = 0;
      auto next_source_time = std::chrono::steady_clock::time_point {};
      const auto source_frame_interval = std::chrono::microseconds(runtime->frame_interval_us);

      if (use_window_restore_placeholder) {
#ifdef _WIN32
        const WindowCaptureAvailability availability =
          query_window_capture_availability(wgc_source_config.window_handle);
        if (availability == WindowCaptureAvailability::minimized) {
          finish_start(true, "");
          update_runtime_state("peer-video-sender-waiting-for-window-restore", "", true);
        } else if (availability == WindowCaptureAvailability::unavailable) {
          const std::string missing_target_error = "Selected window is no longer available for capture.";
          finish_start(false, missing_target_error);
          update_runtime_state("peer-video-source-target-unavailable", missing_target_error, false);
          return;
        }
#endif
      }

      if (!source_start_state->complete) {
        wgc_source = try_create_wgc_source();
        if (!wgc_source) {
          finish_start(false, runtime->last_error.empty()
            ? "failed to create wgc frame source for peer video sender"
            : runtime->last_error);
          return;
        }
        finish_start(true, "");
      }

      while (!runtime->stop_requested.load()) {
        if (refresh_pending) {
          sleep_until_steady_us(
            current_time_micros_steady() + 100000,
            &runtime->stop_requested
          );
          continue;
        }
        if (placeholder_mode_active) {
#ifdef _WIN32
          const WindowCaptureAvailability availability =
            query_window_capture_availability(wgc_source_config.window_handle);
          if (availability == WindowCaptureAvailability::unavailable) {
            update_runtime_state(
              "peer-video-source-target-unavailable",
              "Selected window is no longer available for capture.",
              false
            );
            break;
          }
          if (availability == WindowCaptureAvailability::minimized) {
            if (wgc_source) {
              wgc_source->close();
              wgc_source.reset();
            }
            update_runtime_state("peer-video-sender-waiting-for-window-restore", "", true);
            if (!wait_for_next_placeholder_deadline(&next_placeholder_deadline_us)) {
              break;
            }
            const auto& current_placeholder_frame = ensure_placeholder_frame();
            if (!current_placeholder_frame.empty()) {
              {
                std::lock_guard<std::mutex> lock(runtime->mutex);
                runtime->source_frames_captured += 1;
                runtime->source_bytes_captured += static_cast<unsigned long long>(current_placeholder_frame.size());
                runtime->updated_at_unix_ms = current_time_millis();
              }
              if (!write_bgra_frame(current_placeholder_frame)) {
                break;
              }
            }
            continue;
          }
          if (availability == WindowCaptureAvailability::normal) {
            runtime->soft_refresh_requested.store(true);
            update_runtime_state("peer-video-sender-refresh-pending", "", false);
            refresh_pending = true;
            continue;
          }
#endif
        }

        if (!wgc_source) {
          wgc_source = try_create_wgc_source();
          if (!wgc_source) {
            if (placeholder_mode_active) {
              sleep_until_steady_us(
                current_time_micros_steady() + 250000,
                &runtime->stop_requested
              );
              continue;
            }
            break;
          }
          next_placeholder_deadline_us = -1;
          next_source_timestamp_100ns = 0;
          next_source_time = std::chrono::steady_clock::time_point {};
          placeholder_mode_active = false;
        }

        WgcFrameCpuBuffer frame;
        std::string frame_error;
        if (!wgc_source->wait_for_frame_bgra(250, &frame, &frame_error)) {
          if (runtime->stop_requested.load()) {
            break;
          }
          if (frame_error == "wgc-frame-timeout" || frame_error == "wgc-frame-pool-recreated") {
            continue;
          }
          update_runtime_state("peer-video-source-frame-failed", frame_error, false);
          break;
        }

        const bool frame_geometry_changed =
          frame.width != source_frame_width ||
          frame.height != source_frame_height ||
          frame.stride != (source_frame_width * 4);
        if (!placeholder_mode_active && frame_geometry_changed) {
          emit_peer_video_sender_breadcrumb(
            std::string("startPeerVideoSender:geometry-change-refresh peer=") + source_peer_id +
            " old=" + std::to_string(source_frame_width) + "x" + std::to_string(source_frame_height) +
            " new=" + std::to_string(frame.width) + "x" + std::to_string(frame.height) +
            " stride=" + std::to_string(frame.stride));
          runtime->soft_refresh_requested.store(true);
          update_runtime_state("peer-video-sender-refresh-pending", "", false);
          if (wgc_source) {
            wgc_source->close();
            wgc_source.reset();
          }
          refresh_pending = true;
          continue;
        }

        {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->source_frames_captured += 1;
          runtime->source_bytes_captured += static_cast<unsigned long long>(frame.bgra.size());
          runtime->source_copy_resource_us_total += frame.copy_resource_us;
          runtime->source_map_us_total += frame.map_us;
          runtime->source_memcpy_us_total += frame.memcpy_us;
          runtime->source_total_readback_us_total += frame.total_readback_us;
          runtime->updated_at_unix_ms = current_time_millis();
        }

        if (frame.timestamp_100ns > 0) {
          if (next_source_timestamp_100ns == 0) {
            next_source_timestamp_100ns = frame.timestamp_100ns;
          }
          if (frame.timestamp_100ns < next_source_timestamp_100ns) {
            continue;
          }
          do {
            next_source_timestamp_100ns += min_frame_interval_100ns;
          } while (next_source_timestamp_100ns <= frame.timestamp_100ns);
        } else {
          const auto now = std::chrono::steady_clock::now();
          if (next_source_time == std::chrono::steady_clock::time_point {}) {
            next_source_time = now;
          }
          if (now < next_source_time) {
            continue;
          }
          do {
            next_source_time += source_frame_interval;
          } while (next_source_time <= now);
        }

        if (!write_bgra_frame(frame.bgra)) {
          break;
        }
        update_runtime_state("peer-video-sender-running", "", true);
      }

      if (stdin_write_handle) {
        CloseHandle(stdin_write_handle);
        if (runtime->stdin_write_handle == stdin_write_handle) {
          runtime->stdin_write_handle = nullptr;
        }
      }
      if (wgc_source) {
        wgc_source->close();
      }
    });

    {
      std::unique_lock<std::mutex> lock(source_start_state->mutex);
      source_start_state->condition.wait(lock, [&source_start_state]() {
        return source_start_state->complete;
      });
      if (!source_start_state->success) {
        runtime->stop_requested.store(true);
        if (runtime->stdin_write_handle) {
          CloseHandle(runtime->stdin_write_handle);
          runtime->stdin_write_handle = nullptr;
        }
        if (runtime->process_handle) {
          TerminateProcess(runtime->process_handle, 0);
          WaitForSingleObject(runtime->process_handle, 2000);
        }
        if (runtime->source_thread.joinable()) {
          runtime->source_thread.join();
        }
        close_peer_video_sender_handles(*runtime);
        if (error) {
          *error = source_start_state->error;
        }
        return false;
      }
    }
    emit_peer_video_sender_breadcrumb(std::string("startPeerVideoSender:source-ready peer=") + peer.peer_id);
  }

  const std::shared_ptr<PeerTransportSession> transport_session = peer.transport_session;
  runtime->pump_thread = std::thread([runtime, transport_session]() {
    std::vector<std::uint8_t> read_buffer(64 * 1024);
    const std::string codec_path = normalize_video_codec(runtime->codec_path);

    const auto cache_video_bootstrap_access_unit = [&runtime, &codec_path](const std::vector<std::uint8_t>& access_unit) {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (video_access_unit_has_decoder_config_nal(codec_path, access_unit)) {
        runtime->cached_video_decoder_config_au = access_unit;
        runtime->pending_video_bootstrap = true;
      }
      if (video_access_unit_has_random_access_nal(codec_path, access_unit)) {
        runtime->cached_video_random_access_au = access_unit;
        runtime->pending_video_bootstrap = true;
      }
    };

    const auto send_video_access_unit = [&runtime, &transport_session, &codec_path](
      const std::vector<std::uint8_t>& access_unit,
      std::string* error) -> bool {
      std::int64_t target_send_us = -1;
      std::int64_t now_us = current_time_micros_steady();
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (runtime->next_frame_send_deadline_steady_us <= 0) {
          runtime->next_frame_send_deadline_steady_us = now_us;
        } else {
          runtime->next_frame_send_deadline_steady_us += static_cast<std::int64_t>(runtime->frame_interval_us);
          if (runtime->next_frame_send_deadline_steady_us < now_us) {
            runtime->next_frame_send_deadline_steady_us = now_us;
          }
        }
        target_send_us = runtime->next_frame_send_deadline_steady_us;
      }

      if (target_send_us > 0 && !sleep_until_steady_us(target_send_us, &runtime->stop_requested)) {
        if (error) {
          *error = "peer-video-sender-stopped";
        }
        return false;
      }

      now_us = current_time_micros_steady();
      std::uint64_t timestamp_us = 0;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (runtime->last_frame_sent_at_steady_us > 0 && now_us > runtime->last_frame_sent_at_steady_us) {
          runtime->next_frame_timestamp_us += static_cast<unsigned long long>(
            std::min<std::int64_t>(now_us - runtime->last_frame_sent_at_steady_us, 1000000)
          );
        }
        timestamp_us = runtime->next_frame_timestamp_us;
      }

      if (!send_peer_transport_video_frame(transport_session, access_unit, codec_path, timestamp_us, error)) {
        return false;
      }

      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->last_frame_sent_at_steady_us = now_us;
      runtime->frames_sent += 1;
      runtime->bytes_sent += static_cast<unsigned long long>(access_unit.size());
      runtime->reason = "peer-video-sender-running";
      runtime->last_error.clear();
      runtime->updated_at_unix_ms = current_time_millis();
      return true;
    };

    const auto flush_video_bootstrap_access_units = [&runtime, &send_video_access_unit, &codec_path](std::string* error) -> bool {
      std::vector<std::uint8_t> decoder_config_au;
      std::vector<std::uint8_t> random_access_au;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (!runtime->pending_video_bootstrap) {
          return true;
        }
        decoder_config_au = runtime->cached_video_decoder_config_au;
        random_access_au = runtime->cached_video_random_access_au;
      }

      if (!video_bootstrap_is_complete(codec_path, decoder_config_au, random_access_au)) {
        return true;
      }

      if (!decoder_config_au.empty()) {
        if (!send_video_access_unit(decoder_config_au, error)) {
          return false;
        }
      }

      if (!random_access_au.empty() && random_access_au != decoder_config_au) {
        if (!send_video_access_unit(random_access_au, error)) {
          return false;
        }
      }

      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->pending_video_bootstrap = false;
      return true;
    };

    while (true) {
      DWORD bytes_read = 0;
      const BOOL ok = ReadFile(
        runtime->stdout_read_handle,
        read_buffer.data(),
        static_cast<DWORD>(read_buffer.size()),
        &bytes_read,
        nullptr
      );

      if (!ok || bytes_read == 0) {
        break;
      }

      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->pending_video_annexb_bytes.insert(
          runtime->pending_video_annexb_bytes.end(),
          read_buffer.begin(),
          read_buffer.begin() + static_cast<std::ptrdiff_t>(bytes_read)
        );
      }

      std::vector<std::vector<std::uint8_t>> access_units;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        access_units = extract_annexb_video_access_units(codec_path, runtime->pending_video_annexb_bytes, false);
      }
      for (auto& access_unit : access_units) {
        const PeerTransportSnapshot transport_snapshot = get_peer_transport_snapshot(transport_session);
        const bool access_unit_has_decoder_config =
          video_access_unit_has_decoder_config_nal(codec_path, access_unit);
        const bool access_unit_has_random_access =
          video_access_unit_has_random_access_nal(codec_path, access_unit);
        if (!transport_snapshot.remote_description_set || transport_snapshot.connection_state != "connected") {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-peer-connected";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }
        if (!transport_snapshot.video_track_open) {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-video-track-open";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }

        if (access_unit_has_decoder_config || access_unit_has_random_access) {
          cache_video_bootstrap_access_unit(access_unit);
        }

        bool pending_bootstrap = false;
        bool bootstrap_complete = false;
        {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          pending_bootstrap = runtime->pending_video_bootstrap;
          bootstrap_complete = video_bootstrap_is_complete(
            codec_path,
            runtime->cached_video_decoder_config_au,
            runtime->cached_video_random_access_au
          );
        }
        if (pending_bootstrap && !bootstrap_complete) {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-bootstrap";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }

        std::string send_error;
        if (!flush_video_bootstrap_access_units(&send_error) ||
            (!(access_unit_has_decoder_config || access_unit_has_random_access) &&
             !send_video_access_unit(access_unit, &send_error))) {
          if (send_error.find("Track is closed") != std::string::npos) {
            cache_video_bootstrap_access_unit(access_unit);
            std::lock_guard<std::mutex> lock(runtime->mutex);
            runtime->last_error = send_error;
            runtime->reason = "peer-video-sender-waiting-for-video-track-open";
            runtime->updated_at_unix_ms = current_time_millis();
            continue;
          }
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->last_error = send_error;
          runtime->reason = "peer-video-frame-send-failed";
          runtime->running = false;
          runtime->updated_at_unix_ms = current_time_millis();
          return;
        }
      }
    }

    std::vector<std::vector<std::uint8_t>> remaining_access_units;
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      remaining_access_units = extract_annexb_video_access_units(codec_path, runtime->pending_video_annexb_bytes, true);
    }
    for (auto& access_unit : remaining_access_units) {
      const PeerTransportSnapshot transport_snapshot = get_peer_transport_snapshot(transport_session);
      const bool access_unit_has_decoder_config =
        video_access_unit_has_decoder_config_nal(codec_path, access_unit);
      const bool access_unit_has_random_access =
        video_access_unit_has_random_access_nal(codec_path, access_unit);
      if (!transport_snapshot.remote_description_set || transport_snapshot.connection_state != "connected") {
        cache_video_bootstrap_access_unit(access_unit);
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-peer-connected";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }
      if (!transport_snapshot.video_track_open) {
        cache_video_bootstrap_access_unit(access_unit);
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-video-track-open";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }

      if (access_unit_has_decoder_config || access_unit_has_random_access) {
        cache_video_bootstrap_access_unit(access_unit);
      }

      bool pending_bootstrap = false;
      bool bootstrap_complete = false;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        pending_bootstrap = runtime->pending_video_bootstrap;
        bootstrap_complete = video_bootstrap_is_complete(
          codec_path,
          runtime->cached_video_decoder_config_au,
          runtime->cached_video_random_access_au
        );
      }
      if (pending_bootstrap && !bootstrap_complete) {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-bootstrap";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }

      std::string send_error;
      if (!flush_video_bootstrap_access_units(&send_error) ||
          (!(access_unit_has_decoder_config || access_unit_has_random_access) &&
           !send_video_access_unit(access_unit, &send_error))) {
        if (send_error.find("Track is closed") != std::string::npos) {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->last_error = send_error;
          runtime->reason = "peer-video-sender-waiting-for-video-track-open";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->last_error = send_error;
        runtime->reason = "peer-video-frame-send-failed";
        runtime->running = false;
        runtime->updated_at_unix_ms = current_time_millis();
        return;
      }
    }

    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->running = false;
    runtime->updated_at_unix_ms = current_time_millis();
    if (runtime->reason == "peer-video-sender-running") {
      runtime->reason = "peer-video-sender-pipe-closed";
    }
  });

  peer.media_binding.runtime = runtime;
  peer.media_binding.process_id = runtime->process_id;
  peer.media_binding.command_line = runtime->command_line;
  peer.media_binding.source_frames_captured = 0;
  peer.media_binding.source_bytes_captured = 0;
  peer.media_binding.avg_source_copy_resource_us = 0;
  peer.media_binding.avg_source_map_us = 0;
  peer.media_binding.avg_source_memcpy_us = 0;
  peer.media_binding.avg_source_total_readback_us = 0;
  peer.media_binding.frames_sent = 0;
  peer.media_binding.bytes_sent = 0;
  emit_peer_video_sender_breadcrumb(std::string("startPeerVideoSender:done peer=") + peer.peer_id);
  return true;
}

#else
bool start_peer_video_sender(
  const FfmpegProbeResult&,
  const HostPipelineState&,
  const HostCapturePlan&,
  PeerState&,
  std::string* error) {
  if (error) {
    *error = "peer-video-sender-is-only-implemented-on-windows";
  }
  return false;
}

#endif

void refresh_peer_media_binding(PeerState& peer) {
  if (!peer.media_binding.runtime) {
    RelaySubscriberState relay_state;
    if (query_relay_subscriber_state(peer.peer_id, &relay_state)) {
      reset_peer_media_binding_sender_metrics(peer.media_binding);
      peer.media_binding.frames_sent = relay_state.frames_sent;
      peer.media_binding.bytes_sent = relay_state.bytes_sent;
      peer.media_binding.command_line.clear();
      peer.media_binding.active =
        peer.transport.connection_state == "connected" &&
        peer.transport.video_track_open;
      peer.media_binding.last_error = relay_state.last_error;
      if (!relay_state.reason.empty()) {
        peer.media_binding.reason = relay_state.reason;
      }
    }
    return;
  }

  auto& runtime = *peer.media_binding.runtime;
#ifdef _WIN32
  if (runtime.process_handle) {
    DWORD exit_code = STILL_ACTIVE;
    if (GetExitCodeProcess(runtime.process_handle, &exit_code)) {
      if (exit_code != STILL_ACTIVE) {
        runtime.running = false;
        runtime.last_exit_code = static_cast<int>(exit_code);
        runtime.stopped_at_unix_ms = vds::media_agent::current_time_millis();
        if (runtime.reason == "peer-video-sender-running") {
          runtime.reason = "peer-video-sender-exited";
        }
      }
    }
  }
#endif

  std::lock_guard<std::mutex> lock(runtime.mutex);
  peer.media_binding.process_id = runtime.process_id;
  peer.media_binding.source_frames_captured = runtime.source_frames_captured;
  peer.media_binding.source_bytes_captured = runtime.source_bytes_captured;
  if (runtime.source_frames_captured > 0) {
    peer.media_binding.avg_source_copy_resource_us =
      runtime.source_copy_resource_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_map_us =
      runtime.source_map_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_memcpy_us =
      runtime.source_memcpy_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_total_readback_us =
      runtime.source_total_readback_us_total / runtime.source_frames_captured;
  } else {
    peer.media_binding.avg_source_copy_resource_us = 0;
    peer.media_binding.avg_source_map_us = 0;
    peer.media_binding.avg_source_memcpy_us = 0;
    peer.media_binding.avg_source_total_readback_us = 0;
  }
  peer.media_binding.frames_sent = runtime.frames_sent;
  peer.media_binding.bytes_sent = runtime.bytes_sent;
  peer.media_binding.command_line = runtime.command_line;
  peer.media_binding.active =
    runtime.running &&
    peer.transport.connection_state == "connected" &&
    peer.transport.video_track_open;
  peer.media_binding.last_error = runtime.last_error;
  if (!runtime.reason.empty()) {
    peer.media_binding.reason = runtime.reason;
  }
}

bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error) {
  emit_peer_video_sender_breadcrumb(
    std::string("stopPeerVideoSender:start peer=") +
    peer.peer_id +
    " reason=" + reason +
    " hasRuntime=" + (peer.media_binding.runtime ? "true" : "false")
  );
  if (!peer.media_binding.runtime) {
    reset_peer_media_binding_sender_metrics(peer.media_binding);
    peer.media_binding.active = false;
    peer.media_binding.reason = reason;
    peer.media_binding.updated_at_unix_ms = vds::media_agent::current_time_millis();
    emit_peer_video_sender_breadcrumb(std::string("stopPeerVideoSender:done-no-runtime peer=") + peer.peer_id);
    return true;
  }

  auto runtime = peer.media_binding.runtime;

  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->reason = reason;
    runtime->updated_at_unix_ms = vds::media_agent::current_time_millis();
  }

  runtime->stop_requested.store(true);

#ifdef _WIN32
  if (runtime->process_handle) {
    TerminateProcess(runtime->process_handle, 0);
    WaitForSingleObject(runtime->process_handle, 2000);
  }
#endif

  if (runtime->source_thread.joinable()) {
    runtime->source_thread.join();
  }

  if (runtime->pump_thread.joinable()) {
    runtime->pump_thread.join();
  }

#ifdef _WIN32
  close_peer_video_sender_handles(*runtime);
#endif

  reset_peer_media_binding_sender_metrics(peer.media_binding);
  peer.media_binding.active = false;
  peer.media_binding.updated_at_unix_ms = vds::media_agent::current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  peer.media_binding.runtime.reset();
  emit_peer_video_sender_breadcrumb(std::string("stopPeerVideoSender:done peer=") + peer.peer_id);
  if (error) {
    error->clear();
  }
  return true;
}
