#include "native_live_preview.h"

#include "wgc_capture.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "native_surface_layout.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

long long current_time_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

#ifdef _WIN32
HWND parse_window_handle(const std::string& value) {
  if (value.empty()) {
    return nullptr;
  }

  try {
    std::size_t consumed = 0;
    const auto numeric = static_cast<std::uintptr_t>(std::stoull(value, &consumed, 0));
    if (consumed != value.size()) {
      return nullptr;
    }
    return reinterpret_cast<HWND>(numeric);
  } catch (...) {
    return nullptr;
  }
}

std::string narrow_ascii(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (wchar_t ch : value) {
    result.push_back(ch >= 0 && ch <= 0x7F ? static_cast<char>(ch) : '?');
  }
  return result;
}

std::string window_class_name(HWND hwnd) {
  wchar_t buffer[256] = {};
  const int copied = GetClassNameW(hwnd, buffer, static_cast<int>(std::size(buffer)));
  if (copied <= 0) {
    return {};
  }
  return narrow_ascii(std::wstring(buffer, buffer + copied));
}

bool screen_client_rect(HWND hwnd, RECT* rect);

std::string format_hwnd(HWND hwnd) {
  std::ostringstream stream;
  stream << "0x" << std::hex << reinterpret_cast<std::uintptr_t>(hwnd);
  return stream.str();
}

std::string rect_to_string(const RECT& rect) {
  std::ostringstream stream;
  stream
    << "{left:" << rect.left
    << ",top:" << rect.top
    << ",right:" << rect.right
    << ",bottom:" << rect.bottom
    << ",width:" << std::max<LONG>(0, rect.right - rect.left)
    << ",height:" << std::max<LONG>(0, rect.bottom - rect.top)
    << "}";
  return stream.str();
}

std::string format_window_style_flags(DWORD style, DWORD ex_style) {
  std::ostringstream stream;
  stream
    << "style=0x" << std::hex << style
    << ",exStyle=0x" << ex_style << std::dec
    << ",flags=[";

  bool first = true;
  auto append_flag = [&](bool enabled, const char* name) {
    if (!enabled) {
      return;
    }
    if (!first) {
      stream << ",";
    }
    first = false;
    stream << name;
  };

  append_flag((style & WS_CHILD) != 0, "WS_CHILD");
  append_flag((style & WS_VISIBLE) != 0, "WS_VISIBLE");
  append_flag((style & WS_CLIPCHILDREN) != 0, "WS_CLIPCHILDREN");
  append_flag((style & WS_CLIPSIBLINGS) != 0, "WS_CLIPSIBLINGS");
  append_flag((style & WS_OVERLAPPEDWINDOW) == WS_OVERLAPPEDWINDOW, "WS_OVERLAPPEDWINDOW");
  append_flag((ex_style & WS_EX_NOPARENTNOTIFY) != 0, "WS_EX_NOPARENTNOTIFY");
  stream << "]";
  return stream.str();
}

std::string describe_window_debug(
  const char* phase,
  HWND hwnd,
  HWND parent_window,
  int requested_x,
  int requested_y,
  int requested_width,
  int requested_height,
  DWORD style,
  DWORD ex_style,
  DWORD last_error
) {
  std::ostringstream stream;
  stream
    << "phase=" << (phase ? phase : "unknown")
    << ",hwnd=" << format_hwnd(hwnd)
    << ",class=" << window_class_name(hwnd)
    << ",parent=" << format_hwnd(parent_window)
    << ",parentClass=" << window_class_name(parent_window)
    << ",requested={x:" << requested_x
    << ",y:" << requested_y
    << ",width:" << requested_width
    << ",height:" << requested_height
    << "}"
    << "," << format_window_style_flags(style, ex_style);

  RECT window_rect{};
  if (hwnd && IsWindow(hwnd) && GetWindowRect(hwnd, &window_rect)) {
    stream << ",windowRect=" << rect_to_string(window_rect);
  }

  RECT client_rect{};
  if (screen_client_rect(hwnd, &client_rect)) {
    stream << ",clientRect=" << rect_to_string(client_rect);
  }

  if (last_error != ERROR_SUCCESS) {
    stream << ",lastErrorCode=" << last_error;
  }
  return stream.str();
}

RECT fit_rect_with_aspect(int source_width, int source_height, int target_width, int target_height) {
  RECT rect{0, 0, std::max(0, target_width), std::max(0, target_height)};
  if (source_width <= 0 || source_height <= 0 || target_width <= 0 || target_height <= 0) {
    return rect;
  }

  const double source_aspect = static_cast<double>(source_width) / static_cast<double>(source_height);
  const double target_aspect = static_cast<double>(target_width) / static_cast<double>(target_height);

  int draw_width = target_width;
  int draw_height = target_height;
  if (source_aspect > target_aspect) {
    draw_height = std::max(1, static_cast<int>(std::llround(target_width / source_aspect)));
  } else {
    draw_width = std::max(1, static_cast<int>(std::llround(target_height * source_aspect)));
  }

  rect.left = (target_width - draw_width) / 2;
  rect.top = (target_height - draw_height) / 2;
  rect.right = rect.left + draw_width;
  rect.bottom = rect.top + draw_height;
  return rect;
}

bool should_use_overlay_popup(const NativeEmbeddedSurfaceLayout& layout) {
  return layout.embedded;
}

void activate_owner_window_for_popup(HWND hwnd) {
  if (!hwnd || !IsWindow(hwnd)) {
    return;
  }

  HWND owner = GetWindow(hwnd, GW_OWNER);
  if (!owner) {
    owner = reinterpret_cast<HWND>(GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT));
  }
  if (!owner || !IsWindow(owner)) {
    return;
  }

  if (IsIconic(owner)) {
    ShowWindow(owner, SW_RESTORE);
  } else {
    ShowWindow(owner, SW_SHOW);
  }
  BringWindowToTop(owner);
  SetActiveWindow(owner);
  SetForegroundWindow(owner);
}

bool is_embedded_content_window_class(const std::string& class_name) {
  const std::string normalized = to_lower_ascii(class_name);
  return normalized.rfind("chrome_renderwidgethosthwnd", 0) == 0;
}

bool is_render_widget_window_class(const std::string& class_name) {
  const std::string normalized = to_lower_ascii(class_name);
  return normalized.rfind("chrome_renderwidgethosthwnd", 0) == 0;
}

bool screen_client_rect(HWND hwnd, RECT* rect) {
  if (!rect || !hwnd || !IsWindow(hwnd)) {
    return false;
  }

  RECT client_rect{};
  if (!GetClientRect(hwnd, &client_rect)) {
    return false;
  }

  POINT top_left{client_rect.left, client_rect.top};
  POINT bottom_right{client_rect.right, client_rect.bottom};
  if (!ClientToScreen(hwnd, &top_left) || !ClientToScreen(hwnd, &bottom_right)) {
    return false;
  }

  rect->left = top_left.x;
  rect->top = top_left.y;
  rect->right = bottom_right.x;
  rect->bottom = bottom_right.y;
  return true;
}

long long rect_area(const RECT& rect) {
  const long long width = std::max<LONG>(0, rect.right - rect.left);
  const long long height = std::max<LONG>(0, rect.bottom - rect.top);
  return width * height;
}

bool rect_contains_point(const RECT& rect, LONG x, LONG y) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

long long rect_intersection_area(const RECT& a, const RECT& b) {
  RECT intersection{};
  intersection.left = std::max(a.left, b.left);
  intersection.top = std::max(a.top, b.top);
  intersection.right = std::min(a.right, b.right);
  intersection.bottom = std::min(a.bottom, b.bottom);
  return rect_area(intersection);
}

struct EmbeddedParentCandidate {
  HWND hwnd = nullptr;
  long long score = std::numeric_limits<long long>::min();
  bool overlaps_target = false;
  bool contains_target_center = false;
  long long overlap_area = 0;
  long long area = 0;
};

struct EmbeddedParentSearchContext {
  HWND requested_parent = nullptr;
  RECT target_rect{};
  LONG target_center_x = 0;
  LONG target_center_y = 0;
  long long target_area = 0;
  bool has_target_rect = false;
  EmbeddedParentCandidate best{};
  std::ostringstream debug;
  bool first_candidate = true;
};

BOOL CALLBACK enum_embedded_parent_proc(HWND hwnd, LPARAM l_param) {
  auto* context = reinterpret_cast<EmbeddedParentSearchContext*>(l_param);
  if (!context || !hwnd || !IsWindow(hwnd) || !IsWindowVisible(hwnd)) {
    return TRUE;
  }

  const std::string class_name = to_lower_ascii(window_class_name(hwnd));
  if (!is_render_widget_window_class(class_name)) {
    return TRUE;
  }

  RECT client_rect{};
  if (!screen_client_rect(hwnd, &client_rect)) {
    return TRUE;
  }

  const long long area = rect_area(client_rect);
  if (area <= 0) {
    return TRUE;
  }

  const bool contains_target_center = context->has_target_rect
    && rect_contains_point(client_rect, context->target_center_x, context->target_center_y);
  const long long overlap_area = context->has_target_rect
    ? rect_intersection_area(client_rect, context->target_rect)
    : 0;
  const bool overlaps_target = overlap_area > 0;
  const bool direct_parent = GetParent(hwnd) == context->requested_parent;
  const bool fully_contains_target = context->has_target_rect && context->target_area > 0 && overlap_area >= context->target_area;

  long long score = 0;
  if (direct_parent) {
    score += 1'000'000'000'000LL;
  }
  score += overlap_area * 1'000LL;
  if (contains_target_center) {
    score += 2'000'000'000'000LL;
  }
  if (fully_contains_target) {
    score += 500'000'000'000LL;
  }
  score -= area;

  if (score > context->best.score) {
    context->best.hwnd = hwnd;
    context->best.score = score;
    context->best.overlaps_target = overlaps_target;
    context->best.contains_target_center = contains_target_center;
    context->best.overlap_area = overlap_area;
    context->best.area = area;
  }

  if (context->first_candidate) {
    context->debug << "candidates=[";
    context->first_candidate = false;
  } else {
    context->debug << ",";
  }
  context->debug
    << "{hwnd:" << format_hwnd(hwnd)
    << ",class:" << class_name
    << ",parent:" << format_hwnd(GetParent(hwnd))
    << ",directParent:" << (direct_parent ? "true" : "false")
    << ",rect:" << rect_to_string(client_rect)
    << ",containsCenter:" << (contains_target_center ? "true" : "false")
    << ",fullyContainsTarget:" << (fully_contains_target ? "true" : "false")
    << ",overlapArea:" << overlap_area
    << ",area:" << area
    << ",score:" << score
    << "}";
  return TRUE;
}

HWND resolve_embedded_parent_window(
  HWND requested_parent,
  int target_x,
  int target_y,
  int target_width,
  int target_height,
  std::string* debug_out
) {
  std::ostringstream debug;
  debug
    << "requestedParent=" << format_hwnd(requested_parent)
    << ",targetRect={left:" << target_x
    << ",top:" << target_y
    << ",width:" << target_width
    << ",height:" << target_height
    << "}";

  if (!requested_parent || !IsWindow(requested_parent)) {
    if (debug_out) {
      *debug_out = debug.str() + ",failure=invalid-requested-parent";
    }
    return nullptr;
  }

  const std::string requested_class = window_class_name(requested_parent);
  debug << ",requestedClass=" << requested_class;
  if (is_render_widget_window_class(requested_class)) {
    if (target_width > 0 && target_height > 0) {
      RECT requested_rect{};
      if (!screen_client_rect(requested_parent, &requested_rect)) {
        if (debug_out) {
          *debug_out = debug.str() + ",failure=requested-parent-rect-unavailable";
        }
        return nullptr;
      }
      RECT target_rect{
        target_x,
        target_y,
        target_x + std::max(1, target_width),
        target_y + std::max(1, target_height),
      };
      if (rect_intersection_area(requested_rect, target_rect) <= 0) {
        if (debug_out) {
          *debug_out = debug.str() + ",requestedRect=" + rect_to_string(requested_rect) + ",failure=requested-parent-does-not-overlap-target";
        }
        return nullptr;
      }
      debug << ",requestedRect=" << rect_to_string(requested_rect);
    }
    if (debug_out) {
      *debug_out = debug.str() + ",selected=" + format_hwnd(requested_parent) + ",selectedClass=" + requested_class;
    }
    return requested_parent;
  }

  EmbeddedParentSearchContext context;
  context.requested_parent = requested_parent;
  context.has_target_rect = target_width > 0 && target_height > 0;
  if (context.has_target_rect) {
    context.target_rect = RECT{
      target_x,
      target_y,
      target_x + std::max(1, target_width),
      target_y + std::max(1, target_height),
    };
    context.target_area = rect_area(context.target_rect);
    context.target_center_x = context.target_rect.left + ((context.target_rect.right - context.target_rect.left) / 2);
    context.target_center_y = context.target_rect.top + ((context.target_rect.bottom - context.target_rect.top) / 2);
  }

  EnumChildWindows(requested_parent, &enum_embedded_parent_proc, reinterpret_cast<LPARAM>(&context));
  if (!context.first_candidate) {
    context.debug << "]";
    debug << "," << context.debug.str();
  } else {
    debug << ",candidates=[]";
  }
  if (!context.best.hwnd) {
    if (debug_out) {
      *debug_out = debug.str() + ",failure=no-render-widget-host-candidate";
    }
    return nullptr;
  }
  if (context.has_target_rect && !context.best.overlaps_target) {
    if (debug_out) {
      *debug_out = debug.str() + ",failure=best-candidate-does-not-overlap-target";
    }
    return nullptr;
  }
  RECT selected_rect{};
  if (screen_client_rect(context.best.hwnd, &selected_rect)) {
    debug << ",selectedRect=" << rect_to_string(selected_rect);
  }
  debug
    << ",selected=" << format_hwnd(context.best.hwnd)
    << ",selectedClass=" << window_class_name(context.best.hwnd)
    << ",selectedContainsCenter=" << (context.best.contains_target_center ? "true" : "false")
    << ",selectedOverlapArea=" << context.best.overlap_area
    << ",selectedArea=" << context.best.area;
  if (debug_out) {
    *debug_out = debug.str();
  }
  return context.best.hwnd;
}

POINT screen_to_parent_client(HWND parent_window, int x, int y) {
  POINT point { x, y };
  if (parent_window && IsWindow(parent_window)) {
    ScreenToClient(parent_window, &point);
  }
  return point;
}

std::wstring utf8_to_wide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (size <= 1) {
    return {};
  }

  std::vector<wchar_t> buffer(static_cast<std::size_t>(size), L'\0');
  const int converted = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, buffer.data(), size);
  if (converted <= 1) {
    return {};
  }
  return std::wstring(buffer.data());
}
#endif

}  // namespace

class NativeLivePreview::Impl {
 public:
  explicit Impl(NativeLivePreviewConfig config)
      : config_(std::move(config)) {
    snapshot_.launch_attempted = true;
    snapshot_.window_title = config_.window_title;
    snapshot_.media_path =
      config_.target_kind == "window"
        ? "wgc-window:" + config_.window_handle
        : "wgc-display:" + (config_.display_id.empty() ? "0" : config_.display_id);
  }

  ~Impl() {
    stop("live-preview-destroyed");
  }

  bool start(std::string* error) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (worker_.joinable()) {
      return true;
    }

    stop_requested_ = false;
    start_complete_ = false;
    start_succeeded_ = false;
    start_error_.clear();
    capture_start_complete_ = false;
    capture_start_succeeded_ = false;
    capture_start_error_.clear();
    worker_ = std::thread([this]() { thread_main(); });
    started_condition_.wait(lock, [this]() {
      return start_complete_;
    });

    if (!start_succeeded_) {
      const std::string failure = start_error_.empty() ? "native-live-preview-start-failed" : start_error_;
      lock.unlock();
      if (worker_.joinable()) {
        worker_.join();
      }
      if (error) {
        *error = failure;
      }
      return false;
    }

    if (error) {
      error->clear();
    }
    return true;
  }

  NativeLivePreviewSnapshot snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshot_;
  }

  bool update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
#ifdef _WIN32
    HWND hwnd = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      config_.layout = layout;
      hwnd = window_handle_.load();
    }

    if (!hwnd) {
      if (error) {
        error->clear();
      }
      return true;
    }

    return apply_window_layout(hwnd, layout, error);
#else
    (void)layout;
    if (error) {
      *error = "native-live-preview-layout-update-is-only-implemented-on-windows";
    }
    return false;
#endif
  }

  void stop(const std::string& reason) {
    std::thread worker_to_join;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!worker_.joinable()) {
        snapshot_.attached = false;
        snapshot_.running = false;
        snapshot_.decoder_ready = false;
        if (!reason.empty()) {
          snapshot_.reason = reason;
        }
        return;
      }
      stop_requested_ = true;
      if (!reason.empty()) {
        stop_reason_ = reason;
      }
      worker_to_join = std::move(worker_);
    }

#ifdef _WIN32
    const HWND local_window = window_handle_.load();
    if (local_window) {
      PostMessageW(local_window, WM_CLOSE, 0, 0);
    }
#endif

    if (worker_to_join.joinable()) {
      worker_to_join.join();
    }
  }

 private:
#ifdef _WIN32
  static constexpr UINT kRefreshOwnerMoveHookMessage = WM_APP + 1;

  struct OverlayAnchorState {
    HWND owner_window = nullptr;
    RECT owner_rect{};
    int offset_x = 0;
    int offset_y = 0;
    int width = 0;
    int height = 0;
    bool visible = true;
    bool initialized = false;
  };

  static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
    NativeLivePreview::Impl* self = nullptr;
    if (message == WM_NCCREATE) {
      const auto* create_struct = reinterpret_cast<const CREATESTRUCTW*>(l_param);
      self = static_cast<NativeLivePreview::Impl*>(create_struct->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    } else {
      self = reinterpret_cast<NativeLivePreview::Impl*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }

    if (!self) {
      return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    switch (message) {
      case WM_ERASEBKGND:
        return 1;
      case WM_NCHITTEST:
        return HTTRANSPARENT;
      case WM_MOUSEACTIVATE:
        activate_owner_window_for_popup(hwnd);
        return MA_NOACTIVATE;
      case WM_LBUTTONDOWN:
      case WM_MBUTTONDOWN:
      case WM_RBUTTONDOWN:
      case WM_XBUTTONDOWN:
        activate_owner_window_for_popup(hwnd);
        return 0;
      case kRefreshOwnerMoveHookMessage:
        self->refresh_owner_move_hook();
        return 0;
      case WM_PAINT:
        self->paint();
        return 0;
      case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
      case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
      default:
        return DefWindowProcW(hwnd, message, w_param, l_param);
    }
  }
#endif

  void thread_main() {
#ifdef _WIN32
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.process_id = static_cast<unsigned long>(GetCurrentProcessId());
    }

    if (!register_window_class()) {
      fail_start("native-live-preview-window-class-registration-failed");
      return;
    }

    if (!create_window()) {
      return;
    }

    capture_worker_ = std::thread([this]() { capture_loop(); });
    {
      std::unique_lock<std::mutex> lock(mutex_);
      capture_started_condition_.wait(lock, [this]() {
        return capture_start_complete_;
      });
      if (!capture_start_succeeded_) {
        start_error_ = capture_start_error_.empty()
          ? "native-live-preview-source-create-failed"
          : capture_start_error_;
        start_complete_ = true;
        start_succeeded_ = false;
        started_condition_.notify_all();
      } else {
        snapshot_.attached = true;
        snapshot_.running = true;
        snapshot_.decoder_ready = true;
        snapshot_.waiting_for_artifact = false;
        snapshot_.reason = "live-preview-running";
        snapshot_.last_error.clear();
        start_complete_ = true;
        start_succeeded_ = true;
        started_condition_.notify_all();
      }
    }

    if (!capture_start_succeeded_) {
      if (capture_worker_.joinable()) {
        capture_worker_.join();
      }
      destroy_window();
      return;
    }

    bool should_stop = false;
    while (!should_stop) {
      pump_messages(&should_stop);
      if (should_stop || stop_requested_) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    stop_requested_ = true;
    if (capture_worker_.joinable()) {
      capture_worker_.join();
    }
    destroy_window();

    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.attached = false;
      snapshot_.running = false;
      snapshot_.decoder_ready = false;
      snapshot_.reason = stop_reason_.empty() ? "live-preview-stopped" : stop_reason_;
    }
    return;
#else
    fail_start("native-live-preview-is-only-implemented-on-windows");
#endif
  }

  void capture_loop() {
    WgcFrameSourceConfig source_config;
    source_config.target_kind = config_.target_kind;
    source_config.display_id = config_.display_id.empty() ? "0" : config_.display_id;
    source_config.window_handle = config_.window_handle;

    std::string source_error;
    source_ = create_wgc_frame_source(source_config, &source_error);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      capture_start_complete_ = true;
      capture_start_succeeded_ = static_cast<bool>(source_);
      capture_start_error_ = source_error.empty() ? "native-live-preview-source-create-failed" : source_error;
      capture_started_condition_.notify_all();
    }
    if (!source_) {
      return;
    }

    while (!stop_requested_) {
      WgcFrameCpuBuffer frame;
      std::string frame_error;
      if (!source_->wait_for_frame_bgra(250, &frame, &frame_error)) {
        if (stop_requested_) {
          break;
        }
        if (frame_error == "wgc-frame-timeout") {
          continue;
        }
        {
          std::lock_guard<std::mutex> lock(mutex_);
          snapshot_.reason = "live-preview-frame-failed";
          snapshot_.last_error = frame_error;
          snapshot_.decoder_ready = false;
        }
        continue;
      }
      present_frame(frame);
    }

    source_->close();
    source_.reset();
  }

  void fail_start(const std::string& error_message) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.attached = false;
    snapshot_.running = false;
    snapshot_.decoder_ready = false;
    snapshot_.last_error = error_message;
    snapshot_.reason = "live-preview-start-failed";
    start_error_ = error_message;
    start_complete_ = true;
    start_succeeded_ = false;
    started_condition_.notify_all();
  }

#ifdef _WIN32
  static bool register_window_class() {
    static std::once_flag once;
    static bool registered = false;
    std::call_once(once, []() {
      WNDCLASSEXW window_class{};
      window_class.cbSize = sizeof(window_class);
      window_class.lpfnWndProc = &NativeLivePreview::Impl::window_proc;
      window_class.hInstance = GetModuleHandleW(nullptr);
      window_class.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
      window_class.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
      window_class.lpszClassName = L"VDSNativeLivePreviewWindow";
      registered = RegisterClassExW(&window_class) != 0;
    });
    return registered;
  }

  static void CALLBACK owner_move_hook_proc(
    HWINEVENTHOOK hook,
    DWORD event,
    HWND hwnd,
    LONG object_id,
    LONG child_id,
    DWORD event_thread,
    DWORD event_time
  ) {
    (void)event_thread;
    (void)event_time;
    if (event != EVENT_OBJECT_LOCATIONCHANGE || object_id != OBJID_WINDOW || child_id != CHILDID_SELF || !hwnd) {
      return;
    }

    Impl* self = nullptr;
    {
      std::lock_guard<std::mutex> registry_lock(owner_move_hook_registry_mutex_);
      const auto it = owner_move_hook_registry_.find(hook);
      if (it != owner_move_hook_registry_.end()) {
        self = it->second;
      }
    }

    if (self) {
      self->sync_overlay_popup_to_owner(hwnd);
    }
  }

  void refresh_overlay_anchor(HWND owner_window, const NativeEmbeddedSurfaceLayout& layout) {
    OverlayAnchorState next_anchor{};
    next_anchor.owner_window = owner_window;
    next_anchor.width = std::max(2, layout.width);
    next_anchor.height = std::max(2, layout.height);
    next_anchor.visible = layout.visible;

    if (owner_window && IsWindow(owner_window) && GetWindowRect(owner_window, &next_anchor.owner_rect)) {
      next_anchor.offset_x = layout.x - next_anchor.owner_rect.left;
      next_anchor.offset_y = layout.y - next_anchor.owner_rect.top;
      next_anchor.initialized = true;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    overlay_anchor_ = next_anchor;
  }

  void unregister_owner_move_hook() {
    if (!owner_move_hook_) {
      owner_move_hook_owner_ = nullptr;
      return;
    }

    {
      std::lock_guard<std::mutex> registry_lock(owner_move_hook_registry_mutex_);
      owner_move_hook_registry_.erase(owner_move_hook_);
    }
    UnhookWinEvent(owner_move_hook_);
    owner_move_hook_ = nullptr;
    owner_move_hook_owner_ = nullptr;
  }

  void refresh_owner_move_hook() {
    NativeEmbeddedSurfaceLayout layout;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      layout = config_.layout;
    }

    if (!layout.embedded || !should_use_overlay_popup(layout)) {
      unregister_owner_move_hook();
      return;
    }

    const HWND owner_window = parse_window_handle(layout.parent_window_handle);
    if (!owner_window || !IsWindow(owner_window)) {
      unregister_owner_move_hook();
      return;
    }

    if (owner_move_hook_ && owner_move_hook_owner_ == owner_window) {
      return;
    }

    unregister_owner_move_hook();

    DWORD owner_process_id = 0;
    const DWORD owner_thread_id = GetWindowThreadProcessId(owner_window, &owner_process_id);
    if (!owner_thread_id) {
      return;
    }

    owner_move_hook_ = SetWinEventHook(
      EVENT_OBJECT_LOCATIONCHANGE,
      EVENT_OBJECT_LOCATIONCHANGE,
      nullptr,
      &Impl::owner_move_hook_proc,
      owner_process_id,
      owner_thread_id,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    );
    if (!owner_move_hook_) {
      owner_move_hook_owner_ = nullptr;
      return;
    }

    owner_move_hook_owner_ = owner_window;
    {
      std::lock_guard<std::mutex> registry_lock(owner_move_hook_registry_mutex_);
      owner_move_hook_registry_[owner_move_hook_] = this;
    }
  }

  void sync_overlay_popup_to_owner(HWND owner_window) {
    const HWND hwnd = window_handle_.load();
    if (!hwnd || !owner_window || !IsWindow(hwnd) || !IsWindow(owner_window)) {
      return;
    }

    OverlayAnchorState anchor;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      anchor = overlay_anchor_;
    }

    if (!anchor.initialized || anchor.owner_window != owner_window) {
      return;
    }

    RECT owner_rect{};
    if (!GetWindowRect(owner_window, &owner_rect)) {
      return;
    }

    const int target_x = owner_rect.left + anchor.offset_x;
    const int target_y = owner_rect.top + anchor.offset_y;
    const UINT flags = SWP_NOACTIVATE | SWP_NOZORDER | (anchor.visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
    SetWindowPos(
      hwnd,
      nullptr,
      target_x,
      target_y,
      anchor.width,
      anchor.height,
      flags
    );

    std::lock_guard<std::mutex> lock(mutex_);
    overlay_anchor_.owner_rect = owner_rect;
  }

  bool create_window() {
    const std::wstring title = utf8_to_wide(config_.window_title.empty() ? "VDS Native Preview" : config_.window_title);
    if (title.empty()) {
      fail_start("native-live-preview-window-title-conversion-failed");
      return false;
    }

    const bool embedded = config_.layout.embedded;
    const bool overlay_popup = should_use_overlay_popup(config_.layout);
    const DWORD window_style = embedded
      ? (overlay_popup ? (WS_POPUP | WS_VISIBLE) : (WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS))
      : (WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const DWORD window_ex_style = embedded
      ? (overlay_popup ? (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) : WS_EX_NOPARENTNOTIFY)
      : 0;
    HWND parent_window = nullptr;
    HWND owner_window = nullptr;
    int x = CW_USEDEFAULT;
    int y = CW_USEDEFAULT;
    int width = 960;
    int height = 540;
    if (embedded) {
      owner_window = parse_window_handle(config_.layout.parent_window_handle);
      if (!owner_window || !IsWindow(owner_window)) {
        snapshot_.last_error = "overlay-owner-invalid";
        snapshot_.surface_window_debug = "phase=create-window-owner-invalid";
        fail_start("native-live-preview-parent-handle-invalid");
        return false;
      }
      snapshot_.embedded_parent_debug =
        std::string("overlay-popup=true,owner=") + format_hwnd(owner_window) +
        ",ownerClass=" + window_class_name(owner_window);
      x = config_.layout.x;
      y = config_.layout.y;
      width = std::max(2, config_.layout.width);
      height = std::max(2, config_.layout.height);
    }

    HWND hwnd = CreateWindowExW(
      window_ex_style,
      L"VDSNativeLivePreviewWindow",
      title.c_str(),
      window_style,
      x,
      y,
      width,
      height,
      embedded ? owner_window : parent_window,
      nullptr,
      GetModuleHandleW(nullptr),
      this
    );
    if (!hwnd) {
      snapshot_.surface_window_debug = describe_window_debug(
        "create-window-failed",
        hwnd,
        embedded ? owner_window : parent_window,
        x,
        y,
        width,
        height,
        window_style,
        window_ex_style,
        GetLastError()
      );
      fail_start("native-live-preview-window-creation-failed");
      return false;
    }

    window_handle_.store(hwnd);
    if (embedded && overlay_popup) {
      refresh_overlay_anchor(owner_window, config_.layout);
      if (config_.layout.visible) {
        SetWindowPos(hwnd, HWND_TOP, x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
      } else {
        ShowWindow(hwnd, SW_HIDE);
      }
      refresh_owner_move_hook();
    } else {
      ShowWindow(hwnd, embedded && config_.layout.visible ? SW_SHOWNA : SW_SHOW);
      if (embedded && !config_.layout.visible) {
        ShowWindow(hwnd, SW_HIDE);
      }
    }
    UpdateWindow(hwnd);

    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.window_title = config_.window_title;
    snapshot_.surface_window_debug = describe_window_debug(
      "create-window-succeeded",
      hwnd,
      embedded ? owner_window : parent_window,
      x,
      y,
      width,
      height,
      window_style,
      window_ex_style,
      ERROR_SUCCESS
    );
    return true;
  }

  void destroy_window() {
    unregister_owner_move_hook();
    HWND hwnd = window_handle_.exchange(nullptr);
    if (hwnd && IsWindow(hwnd)) {
      DestroyWindow(hwnd);
    }
  }

  bool apply_window_layout(HWND hwnd, const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
    if (!layout.embedded) {
      if (error) {
        error->clear();
      }
      return true;
    }

    const bool overlay_popup = should_use_overlay_popup(layout);
    HWND parent_window = parse_window_handle(layout.parent_window_handle);
    std::string embedded_parent_debug =
      std::string("overlay-popup=") + (overlay_popup ? "true" : "false") +
      ",visible=" + (layout.visible ? std::string("true") : std::string("false")) +
      ",owner=" + format_hwnd(parent_window) +
      ",ownerClass=" + window_class_name(parent_window);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.embedded_parent_debug = embedded_parent_debug;
    }
    if (!parent_window || !IsWindow(parent_window)) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot_.surface_window_debug =
          "phase=update-layout-parent-resolution-failed," + embedded_parent_debug;
      }
      if (error) {
        *error = embedded_parent_debug.empty()
          ? "native-live-preview-parent-handle-invalid"
          : embedded_parent_debug;
      }
      return false;
    }

    if (overlay_popup) {
      SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(parent_window));
      refresh_overlay_anchor(parent_window, layout);
      PostMessageW(hwnd, kRefreshOwnerMoveHookMessage, 0, 0);
    } else if (GetParent(hwnd) != parent_window) {
      SetParent(hwnd, parent_window);
    }

    if (!layout.visible) {
      ShowWindow(hwnd, SW_HIDE);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot_.surface_window_debug = describe_window_debug(
          "update-layout-hidden",
          hwnd,
          parent_window,
          layout.x,
          layout.y,
          std::max(2, layout.width),
          std::max(2, layout.height),
          static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE)),
          static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
          ERROR_SUCCESS
        );
      }
      if (error) {
        error->clear();
      }
      return true;
    }

    const int target_x = overlay_popup ? layout.x : screen_to_parent_client(parent_window, layout.x, layout.y).x;
    const int target_y = overlay_popup ? layout.y : screen_to_parent_client(parent_window, layout.x, layout.y).y;
    const BOOL positioned = SetWindowPos(
      hwnd,
      HWND_TOP,
      target_x,
      target_y,
      std::max(2, layout.width),
      std::max(2, layout.height),
      SWP_SHOWWINDOW | SWP_NOACTIVATE
    );
    if (!positioned) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot_.surface_window_debug = describe_window_debug(
        "update-layout-failed",
        hwnd,
        parent_window,
        target_x,
        target_y,
        std::max(2, layout.width),
        std::max(2, layout.height),
          static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE)),
          static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
          GetLastError()
        );
      }
      if (error) {
        *error = "native-live-preview-layout-apply-failed";
      }
      return false;
    }

    InvalidateRect(hwnd, nullptr, FALSE);
    UpdateWindow(hwnd);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.surface_window_debug = describe_window_debug(
        "update-layout-succeeded",
        hwnd,
        parent_window,
        target_x,
        target_y,
        std::max(2, layout.width),
        std::max(2, layout.height),
        static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE)),
        static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        ERROR_SUCCESS
      );
    }
    if (error) {
      error->clear();
    }
    return true;
  }

  void pump_messages(bool* should_stop) {
    MSG msg{};
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) {
        *should_stop = true;
        return;
      }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }

  void paint() {
    const HWND hwnd = window_handle_.load();
    if (!hwnd) {
      return;
    }

    PAINTSTRUCT paint_struct{};
    HDC hdc = BeginPaint(hwnd, &paint_struct);
    RECT client_rect{};
    GetClientRect(hwnd, &client_rect);

    const int client_width = client_rect.right - client_rect.left;
    const int client_height = client_rect.bottom - client_rect.top;
    HDC back_buffer_dc = CreateCompatibleDC(hdc);
    HBITMAP back_buffer_bitmap = nullptr;
    HGDIOBJ previous_bitmap = nullptr;
    if (back_buffer_dc && client_width > 0 && client_height > 0) {
      back_buffer_bitmap = CreateCompatibleBitmap(hdc, client_width, client_height);
      if (back_buffer_bitmap) {
        previous_bitmap = SelectObject(back_buffer_dc, back_buffer_bitmap);
      }
    }

    HDC target_dc = back_buffer_dc && back_buffer_bitmap ? back_buffer_dc : hdc;
    FillRect(target_dc, &client_rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

    std::vector<std::uint8_t> local_bgra;
    int local_width = 0;
    int local_height = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      local_bgra = bgra_buffer_;
      local_width = frame_width_;
      local_height = frame_height_;
    }

    if (!local_bgra.empty() && local_width > 0 && local_height > 0 && client_width > 0 && client_height > 0) {
      BITMAPINFO bitmap_info{};
      bitmap_info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      bitmap_info.bmiHeader.biWidth = local_width;
      bitmap_info.bmiHeader.biHeight = -local_height;
      bitmap_info.bmiHeader.biPlanes = 1;
      bitmap_info.bmiHeader.biBitCount = 32;
      bitmap_info.bmiHeader.biCompression = BI_RGB;

      SetStretchBltMode(target_dc, HALFTONE);
      SetBrushOrgEx(target_dc, 0, 0, nullptr);

      const RECT draw_rect = fit_rect_with_aspect(local_width, local_height, client_width, client_height);
      StretchDIBits(
        target_dc,
        draw_rect.left,
        draw_rect.top,
        draw_rect.right - draw_rect.left,
        draw_rect.bottom - draw_rect.top,
        0,
        0,
        local_width,
        local_height,
        local_bgra.data(),
        &bitmap_info,
        DIB_RGB_COLORS,
        SRCCOPY
      );
    }

    if (back_buffer_dc && back_buffer_bitmap) {
      BitBlt(hdc, 0, 0, client_width, client_height, back_buffer_dc, 0, 0, SRCCOPY);
    }

    if (previous_bitmap) {
      SelectObject(back_buffer_dc, previous_bitmap);
    }
    if (back_buffer_bitmap) {
      DeleteObject(back_buffer_bitmap);
    }
    if (back_buffer_dc) {
      DeleteDC(back_buffer_dc);
    }

    EndPaint(hwnd, &paint_struct);
  }
#endif

  void present_frame(const WgcFrameCpuBuffer& frame) {
    if (frame.width <= 0 || frame.height <= 0 || frame.bgra.empty()) {
      return;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      frame_width_ = frame.width;
      frame_height_ = frame.height;
      bgra_buffer_ = frame.bgra;
      snapshot_.decoded_frames_rendered += 1;
      snapshot_.last_decoded_frame_at_unix_ms = current_time_millis();
      snapshot_.decoder_ready = true;
      snapshot_.reason = "live-preview-frame-rendered";
      snapshot_.last_error.clear();
    }

#ifdef _WIN32
    const HWND hwnd = window_handle_.load();
    if (hwnd) {
      InvalidateRect(hwnd, nullptr, FALSE);
    }
#endif
  }

  NativeLivePreviewConfig config_;
  mutable std::mutex mutex_;
  std::condition_variable started_condition_;
  std::condition_variable capture_started_condition_;
  std::thread worker_;
  std::thread capture_worker_;
  bool stop_requested_ = false;
  bool start_complete_ = false;
  bool start_succeeded_ = false;
  std::string start_error_;
  bool capture_start_complete_ = false;
  bool capture_start_succeeded_ = false;
  std::string capture_start_error_;
  std::string stop_reason_;
  NativeLivePreviewSnapshot snapshot_;
  std::shared_ptr<WgcFrameSource> source_;
  int frame_width_ = 0;
  int frame_height_ = 0;
  std::vector<std::uint8_t> bgra_buffer_;

#ifdef _WIN32
  std::atomic<HWND> window_handle_ { nullptr };
  OverlayAnchorState overlay_anchor_{};
  HWINEVENTHOOK owner_move_hook_ = nullptr;
  HWND owner_move_hook_owner_ = nullptr;
  static std::mutex owner_move_hook_registry_mutex_;
  static std::unordered_map<HWINEVENTHOOK, Impl*> owner_move_hook_registry_;
#endif
};

#ifdef _WIN32
std::mutex NativeLivePreview::Impl::owner_move_hook_registry_mutex_;
std::unordered_map<HWINEVENTHOOK, NativeLivePreview::Impl*> NativeLivePreview::Impl::owner_move_hook_registry_;
#endif

NativeLivePreview::NativeLivePreview(NativeLivePreviewConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {}

NativeLivePreview::~NativeLivePreview() = default;

NativeLivePreviewSnapshot NativeLivePreview::snapshot() const {
  return impl_->snapshot();
}

bool NativeLivePreview::update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
  return impl_->update_layout(layout, error);
}

void NativeLivePreview::close(const std::string& reason) {
  impl_->stop(reason);
}

std::shared_ptr<NativeLivePreview> create_native_live_preview(
  const NativeLivePreviewConfig& config,
  std::string* error
) {
  auto preview = std::shared_ptr<NativeLivePreview>(new NativeLivePreview(config));
  if (!preview->impl_->start(error)) {
    return nullptr;
  }
  return preview;
}
