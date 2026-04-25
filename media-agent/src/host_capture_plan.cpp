#include "host_capture_plan.h"

#include <algorithm>
#include <cstdlib>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "agent_diagnostics.h"
#include "host_pipeline.h"
#include "json_protocol.h"
#include "platform_utils.h"
#include "string_utils.h"
#include "time_utils.h"

namespace {

void emit_host_capture_plan_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

}  // namespace

#ifdef _WIN32
namespace {

struct DisplayDimensionLookupContext {
  int target_index = 0;
  int current_index = 0;
  RECT bounds {};
  std::wstring device_name;
  bool found = false;
};

BOOL CALLBACK enum_display_dimension_proc(HMONITOR monitor, HDC, LPRECT, LPARAM context_value) {
  auto* context = reinterpret_cast<DisplayDimensionLookupContext*>(context_value);
  if (!context || context->found) {
    return TRUE;
  }

  if (context->current_index == context->target_index) {
    MONITORINFOEXW monitor_info {};
    monitor_info.cbSize = sizeof(monitor_info);
    if (GetMonitorInfoW(monitor, &monitor_info)) {
      context->bounds = monitor_info.rcMonitor;
      context->device_name = monitor_info.szDevice;
      context->found = true;
    }
    return FALSE;
  }

  context->current_index += 1;
  return TRUE;
}

bool get_window_capture_rect(HWND hwnd, RECT* rect) {
  if (!hwnd || !rect || !IsWindow(hwnd)) {
    return false;
  }

  if (IsIconic(hwnd)) {
    WINDOWPLACEMENT placement {};
    placement.length = sizeof(placement);
    if (GetWindowPlacement(hwnd, &placement)) {
      const RECT normal_rect = placement.rcNormalPosition;
      if (normal_rect.right > normal_rect.left &&
          normal_rect.bottom > normal_rect.top) {
        *rect = normal_rect;
        return true;
      }
    }
  }

  using DwmGetWindowAttributeFn = HRESULT (WINAPI*)(HWND, DWORD, PVOID, DWORD);
  static const auto dwm_get_window_attribute = reinterpret_cast<DwmGetWindowAttributeFn>(
    []() -> FARPROC {
      HMODULE module = LoadLibraryW(L"dwmapi.dll");
      return module ? GetProcAddress(module, "DwmGetWindowAttribute") : nullptr;
    }()
  );

  constexpr DWORD kDwmwaExtendedFrameBounds = 9;
  if (dwm_get_window_attribute) {
    RECT extended_rect {};
    if (SUCCEEDED(dwm_get_window_attribute(
          hwnd,
          kDwmwaExtendedFrameBounds,
          &extended_rect,
          static_cast<DWORD>(sizeof(extended_rect)))) &&
        extended_rect.right > extended_rect.left &&
        extended_rect.bottom > extended_rect.top) {
      *rect = extended_rect;
      return true;
    }
  }

  RECT window_rect {};
  if (GetWindowRect(hwnd, &window_rect) &&
      window_rect.right > window_rect.left &&
      window_rect.bottom > window_rect.top) {
    *rect = window_rect;
    return true;
  }

  return false;
}

}  // namespace
#endif

bool resolve_wgc_display_dimensions(const std::string& display_id, int* width, int* height, std::string* error) {
#ifdef _WIN32
  if (!width || !height) {
    if (error) {
      *error = "wgc-display-dimension-output-missing";
    }
    return false;
  }

  char* parse_end = nullptr;
  const unsigned long monitor_index = std::strtoul(display_id.c_str(), &parse_end, 10);
  if (!parse_end || *parse_end != '\0') {
    if (error) {
      *error = "wgc-display-id-must-be-a-numeric-monitor-index";
    }
    return false;
  }

  DisplayDimensionLookupContext context;
  context.target_index = static_cast<int>(monitor_index);
  EnumDisplayMonitors(nullptr, nullptr, &enum_display_dimension_proc, reinterpret_cast<LPARAM>(&context));
  if (!context.found) {
    if (error) {
      *error = "wgc-display-monitor-not-found";
    }
    return false;
  }

  DEVMODEW display_mode {};
  display_mode.dmSize = sizeof(display_mode);
  if (!context.device_name.empty() &&
      EnumDisplaySettingsW(context.device_name.c_str(), ENUM_CURRENT_SETTINGS, &display_mode) &&
      display_mode.dmPelsWidth > 0 &&
      display_mode.dmPelsHeight > 0) {
    *width = static_cast<int>(display_mode.dmPelsWidth);
    *height = static_cast<int>(display_mode.dmPelsHeight);
  } else {
    *width = std::max(0, static_cast<int>(context.bounds.right - context.bounds.left));
    *height = std::max(0, static_cast<int>(context.bounds.bottom - context.bounds.top));
  }

  if (*width <= 0 || *height <= 0) {
    if (error) {
      *error = "wgc-display-monitor-bounds-empty";
    }
    return false;
  }

  return true;
#else
  (void)display_id;
  (void)width;
  (void)height;
  if (error) {
    *error = "wgc-display-dimension-resolution-requires-windows";
  }
  return false;
#endif
}

bool resolve_wgc_window_dimensions(const std::string& capture_handle, int* width, int* height, std::string* error) {
#ifdef _WIN32
  if (!width || !height) {
    if (error) {
      *error = "wgc-window-dimension-output-missing";
    }
    return false;
  }

  char* parse_end = nullptr;
  const unsigned long long hwnd_value = std::strtoull(capture_handle.c_str(), &parse_end, 10);
  if (!parse_end || *parse_end != '\0' || hwnd_value == 0) {
    if (error) {
      *error = "wgc-window-handle-invalid";
    }
    return false;
  }

  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd_value));
  if (!IsWindow(hwnd)) {
    if (error) {
      *error = "wgc-window-handle-not-found";
    }
    return false;
  }

  RECT capture_rect {};
  if (!get_window_capture_rect(hwnd, &capture_rect)) {
    if (error) {
      *error = vds::media_agent::format_windows_error(GetLastError());
    }
    return false;
  }

  *width = std::max(0, static_cast<int>(capture_rect.right - capture_rect.left));
  *height = std::max(0, static_cast<int>(capture_rect.bottom - capture_rect.top));
  if (*width <= 0 || *height <= 0) {
    if (error) {
      *error = "wgc-window-capture-rect-empty";
    }
    return false;
  }

  return true;
#else
  (void)capture_handle;
  (void)width;
  (void)height;
  if (error) {
    *error = "wgc-window-dimension-resolution-requires-windows";
  }
  return false;
#endif
}

WgcFrameSourceConfig build_wgc_frame_source_config(const HostCapturePlan& plan) {
  WgcFrameSourceConfig config;
  const std::string capture_kind = vds::media_agent::to_lower_copy(plan.capture_kind);
  if (capture_kind == "window" && !vds::media_agent::trim_copy(plan.capture_handle).empty()) {
    config.target_kind = "window";
    config.window_handle = vds::media_agent::trim_copy(plan.capture_handle);
  } else {
    config.target_kind = "display";
    config.display_id = plan.capture_display_id.empty() ? "0" : plan.capture_display_id;
  }
  return config;
}

HostCapturePlan build_host_capture_plan(
  const FfmpegProbeResult& ffmpeg,
  const WgcCaptureProbe& wgc_capture,
  const HostPipelineState& pipeline,
  const HostCaptureProcessState& process_state,
  const std::string& capture_kind,
  const std::string& capture_state,
  const std::string& capture_title,
  const std::string& capture_hwnd,
  const std::string& capture_display_id,
  int width,
  int height,
  int frame_rate,
  int bitrate_kbps) {
  HostCapturePlan plan;
  plan.capture_kind = capture_kind.empty() ? "window" : vds::media_agent::to_lower_copy(capture_kind);
  plan.capture_state = capture_state.empty() ? "normal" : vds::media_agent::to_lower_copy(capture_state);
  plan.preferred_capture_backend = "wgc";
  plan.capture_backend = "wgc";
  plan.capture_fallback_reason.clear();
  plan.capture_handle = vds::media_agent::trim_copy(capture_hwnd);
  if (plan.capture_handle.empty()) {
    plan.capture_handle = vds::media_agent::resolve_window_handle_from_title(capture_title);
  }
  plan.capture_display_id = vds::media_agent::trim_copy(capture_display_id);
  if (plan.capture_display_id.empty()) {
    plan.capture_display_id = "0";
  }
  plan.width = normalize_host_output_dimension(width, 1920);
  plan.height = normalize_host_output_dimension(height, 1080);
  plan.frame_rate = frame_rate > 0 ? frame_rate : 60;
  plan.bitrate_kbps = bitrate_kbps > 0 ? bitrate_kbps : 10000;
  plan.codec_path = pipeline.requested_video_codec.empty()
    ? "h264"
    : vds::media_agent::to_lower_copy(pipeline.requested_video_codec);

  if (!ffmpeg.available) {
    plan.reason = "ffmpeg-unavailable";
    plan.last_error = ffmpeg.error;
    return plan;
  }

  if (!pipeline.ready || !pipeline.validated || pipeline.selected_video_encoder.empty()) {
    plan.reason = "host-pipeline-not-ready";
    plan.last_error = pipeline.last_error;
    return plan;
  }

  if (!wgc_capture.available) {
    plan.reason = "wgc-backend-unavailable";
    plan.last_error = wgc_capture.last_error.empty()
      ? (wgc_capture.reason.empty() ? "WGC capture backend is not available." : wgc_capture.reason)
      : wgc_capture.last_error;
    return plan;
  }

  const bool is_display_like =
    plan.capture_kind == "display" ||
    plan.capture_state == "display";
  const bool has_capture_hwnd = !plan.capture_handle.empty();
  const bool can_use_wgc_window = !is_display_like && has_capture_hwnd && wgc_capture.window_capture_supported;

  if (is_display_like) {
    if (wgc_capture.display_capture_supported) {
      plan.input_format = "rawvideo";
      plan.input_target = "wgc-display:" + plan.capture_display_id;
      plan.implementation = "windows-graphics-capture";
      plan.reason = "display-wgc-capture-planned";
      plan.ready = true;
      return plan;
    }

    plan.reason = "wgc-display-capture-not-supported";
    plan.last_error = "Selected display target requires WGC, but display capture is not supported on this system.";
    return plan;
  } else if (can_use_wgc_window) {
    plan.input_format = "rawvideo";
    plan.input_target = "wgc-window:" + plan.capture_handle;
    plan.implementation = "windows-graphics-capture";
    plan.reason = plan.capture_state == "minimized"
      ? "minimized-window-wgc-capture-planned"
      : "window-wgc-capture-planned";
  } else if (!has_capture_hwnd) {
    plan.reason = "wgc-window-handle-missing";
    plan.last_error = capture_title.empty()
      ? "Window capture now requires a real HWND for the WGC authority path."
      : "Window capture title could not be resolved to a real HWND for the WGC authority path.";
    return plan;
  } else {
    plan.reason = "wgc-window-capture-not-supported";
    plan.last_error = "Selected window target requires WGC, but window capture is not supported on this system.";
    return plan;
  }

  plan.ready = true;
  plan.command_preview = build_ffmpeg_host_capture_command(ffmpeg, pipeline, plan, process_state);
  return plan;
}

HostCapturePlan validate_host_capture_plan(const FfmpegProbeResult& ffmpeg, HostCapturePlan plan) {
  (void)ffmpeg;
  if (!plan.ready) {
    plan.validation_reason = plan.reason;
    return plan;
  }

  if (plan.capture_backend == "wgc") {
    emit_host_capture_plan_breadcrumb(
      "validateHostCapturePlan:wgc:before-resolve-dimensions target=" + plan.input_target +
      " codec=" + plan.codec_path +
      " size=" + std::to_string(plan.width) + "x" + std::to_string(plan.height) +
      " fps=" + std::to_string(plan.frame_rate));
#ifdef _WIN32
    const bool is_display_like =
      plan.capture_kind == "display" ||
      plan.capture_state == "display" ||
      plan.input_target.rfind("wgc-display:", 0) == 0;
    int resolved_width = 0;
    int resolved_height = 0;
    std::string resolve_error;
    const bool resolved = is_display_like
      ? resolve_wgc_display_dimensions(
          plan.capture_display_id.empty() ? "0" : plan.capture_display_id,
          &resolved_width,
          &resolved_height,
          &resolve_error)
      : resolve_wgc_window_dimensions(plan.capture_handle, &resolved_width, &resolved_height, &resolve_error);
    if (!resolved) {
      plan.validated = false;
      plan.validation_reason = "wgc-capture-dimensions-unavailable";
      plan.last_error = resolve_error.empty()
        ? "WGC capture validation could not resolve input dimensions."
        : resolve_error;
      emit_host_capture_plan_breadcrumb(
        "validateHostCapturePlan:wgc:resolve-dimensions-failed reason=" +
        plan.validation_reason + " error=" + plan.last_error);
      return plan;
    }

    plan.input_width = resolved_width;
    plan.input_height = resolved_height;
    plan.validated = true;
    plan.validation_reason = "wgc-capture-dimensions-resolved";
    plan.command_preview =
      (is_display_like
        ? "wgc-display:" + (plan.capture_display_id.empty() ? "0" : plan.capture_display_id)
        : "wgc-window:" + plan.capture_handle) +
      " -> ffmpeg-stdin";
    plan.last_error.clear();
    emit_host_capture_plan_breadcrumb(
      "validateHostCapturePlan:wgc:after-resolve-dimensions size=" +
      std::to_string(plan.input_width) + "x" + std::to_string(plan.input_height));
    return plan;
#else
    plan.validated = false;
    plan.validation_reason = "wgc-capture-validation-unsupported";
    plan.last_error = "WGC capture validation requires Windows.";
    return plan;
#endif
  }

  plan.validated = false;
  plan.validation_reason = "capture-self-test-not-supported";
  plan.last_error = "Only WGC-backed host capture plans are valid in the current rewrite path.";
  return plan;
}
