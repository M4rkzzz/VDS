#include "native_video_surface.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "native_surface_layout.h"
#include "time_utils.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace {

using vds::media_agent::current_time_micros_steady;
using vds::media_agent::current_time_millis;

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string ffmpeg_error_string(int error_code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(error_code, buffer, sizeof(buffer));
  return std::string(buffer);
}

HWND parse_window_handle(const std::string& value) {
  const std::string trimmed = to_lower_ascii(value);
  if (trimmed.empty()) {
    return nullptr;
  }

  try {
    std::size_t consumed = 0;
    const auto numeric = static_cast<std::uintptr_t>(std::stoull(trimmed, &consumed, 0));
    if (consumed != trimmed.size()) {
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

void get_display_aspect_dimensions(
  int coded_width,
  int coded_height,
  AVRational sample_aspect_ratio,
  int* display_width,
  int* display_height
) {
  if (!display_width || !display_height) {
    return;
  }

  *display_width = std::max(1, coded_width);
  *display_height = std::max(1, coded_height);

  if (coded_width <= 0 || coded_height <= 0) {
    return;
  }

  if (sample_aspect_ratio.num <= 0 || sample_aspect_ratio.den <= 0) {
    return;
  }

  const long long scaled_width = static_cast<long long>(coded_width) * static_cast<long long>(sample_aspect_ratio.num);
  const long long scaled_height = static_cast<long long>(coded_height) * static_cast<long long>(sample_aspect_ratio.den);
  if (scaled_width <= 0 || scaled_height <= 0) {
    return;
  }

  if (scaled_width > static_cast<long long>(std::numeric_limits<int>::max())) {
    *display_width = std::numeric_limits<int>::max();
  } else {
    *display_width = static_cast<int>(scaled_width);
  }

  if (scaled_height > static_cast<long long>(std::numeric_limits<int>::max())) {
    *display_height = std::numeric_limits<int>::max();
  } else {
    *display_height = static_cast<int>(scaled_height);
  }
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

  HWND root_owner = GetAncestor(owner, GA_ROOTOWNER);
  if (root_owner && IsWindow(root_owner)) {
    owner = root_owner;
  }

  const DWORD current_thread_id = GetCurrentThreadId();
  const DWORD owner_thread_id = GetWindowThreadProcessId(owner, nullptr);
  HWND foreground_window = GetForegroundWindow();
  const DWORD foreground_thread_id = foreground_window
    ? GetWindowThreadProcessId(foreground_window, nullptr)
    : 0;
  const bool attached_owner_thread =
    owner_thread_id != 0 &&
    owner_thread_id != current_thread_id &&
    AttachThreadInput(current_thread_id, owner_thread_id, TRUE) != FALSE;
  const bool attached_foreground_thread =
    foreground_thread_id != 0 &&
    foreground_thread_id != current_thread_id &&
    foreground_thread_id != owner_thread_id &&
    AttachThreadInput(current_thread_id, foreground_thread_id, TRUE) != FALSE;

  if (IsIconic(owner)) {
    ShowWindowAsync(owner, SW_RESTORE);
  } else {
    ShowWindowAsync(owner, SW_SHOW);
  }
  SetWindowPos(owner, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  BringWindowToTop(owner);
  SetForegroundWindow(owner);
  SetActiveWindow(owner);
  SetFocus(owner);

  if (attached_foreground_thread) {
    AttachThreadInput(current_thread_id, foreground_thread_id, FALSE);
  }
  if (attached_owner_thread) {
    AttachThreadInput(current_thread_id, owner_thread_id, FALSE);
  }
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

  const std::string class_name = window_class_name(requested_parent);
  debug << ",requestedClass=" << class_name;
  if (is_render_widget_window_class(class_name)) {
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
      *debug_out = debug.str() + ",selected=" + format_hwnd(requested_parent) + ",selectedClass=" + class_name;
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
  const int converted = MultiByteToWideChar(
    CP_UTF8,
    0,
    value.c_str(),
    -1,
    buffer.data(),
    size
  );
  if (converted <= 1) {
    return {};
  }
  return std::wstring(buffer.data());
}

AVCodecID codec_id_from_name(const std::string& codec) {
  const std::string normalized = to_lower_ascii(codec);
  if (normalized == "h265" || normalized == "hevc") {
    return AV_CODEC_ID_HEVC;
  }
  return AV_CODEC_ID_H264;
}

}  // namespace

class NativeVideoSurface::Impl {
 public:
  explicit Impl(NativeVideoSurfaceConfig config)
      : config_(std::move(config)) {
    snapshot_.launch_attempted = true;
    snapshot_.codec_path = to_lower_ascii(config_.codec.empty() ? "h264" : config_.codec);
    snapshot_.window_title = config_.window_title;
  }

  ~Impl() {
    stop("surface-destroyed");
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
    worker_ = std::thread([this]() { thread_main(); });
    started_condition_.wait(lock, [this]() {
      return start_complete_;
    });

    if (!start_succeeded_) {
      const std::string failure = start_error_.empty() ? "native-video-surface-start-failed" : start_error_;
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

  bool submit_encoded_frame(const std::vector<std::uint8_t>& frame, const std::string& codec, std::string* error) {
    if (frame.empty()) {
      if (error) {
        *error = "remote-video-frame-is-empty";
      }
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!snapshot_.running || stop_requested_) {
        if (error) {
          *error = "native-video-surface-not-running";
        }
        return false;
      }

      EncodedFrame queued_frame;
      queued_frame.codec = to_lower_ascii(codec.empty() ? snapshot_.codec_path : codec);
      queued_frame.bytes.resize(frame.size() + AV_INPUT_BUFFER_PADDING_SIZE, 0);
      std::memcpy(queued_frame.bytes.data(), frame.data(), frame.size());

      if (frame_queue_.size() >= kMaxQueuedFrames) {
        frame_queue_.pop_front();
        snapshot_.reason = "native-frame-queue-trimmed";
      }

      frame_queue_.push_back(std::move(queued_frame));
    }

    if (error) {
      error->clear();
    }
#ifdef _WIN32
    request_frame_drain();
#endif
    return true;
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
      *error = "native-video-surface-layout-update-is-only-implemented-on-windows";
    }
    return false;
#endif
  }

  NativeVideoSurfaceSnapshot snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshot_;
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
      frame_available_.notify_one();
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
  struct EncodedFrame {
    std::string codec;
    std::vector<std::uint8_t> bytes;
  };

  static constexpr std::size_t kMaxQueuedFrames = 8;
#ifdef _WIN32
  static constexpr UINT kFrameAvailableMessage = WM_APP + 1;
  static constexpr UINT kRefreshOwnerMoveHookMessage = WM_APP + 2;
#endif

#ifdef _WIN32
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
#endif

#ifdef _WIN32
  void mark_surface_window_closed() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stop_reason_.empty() && !stop_requested_) {
      stop_reason_ = "surface-window-closed";
    }
  }

  static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
    NativeVideoSurface::Impl* self = nullptr;
    if (message == WM_NCCREATE) {
      const auto* create_struct = reinterpret_cast<const CREATESTRUCTW*>(l_param);
      self = static_cast<NativeVideoSurface::Impl*>(create_struct->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    } else {
      self = reinterpret_cast<NativeVideoSurface::Impl*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }

    if (!self) {
      return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    switch (message) {
      case WM_ERASEBKGND:
        return 1;
      case WM_NCHITTEST:
        return HTCLIENT;
      case WM_MOUSEACTIVATE:
        activate_owner_window_for_popup(hwnd);
        return MA_NOACTIVATEANDEAT;
      case WM_LBUTTONDOWN:
      case WM_MBUTTONDOWN:
      case WM_RBUTTONDOWN:
      case WM_XBUTTONDOWN:
        activate_owner_window_for_popup(hwnd);
        return 0;
      case kFrameAvailableMessage:
        self->drain_queued_frames();
        return 0;
      case kRefreshOwnerMoveHookMessage:
        self->refresh_owner_move_hook();
        return 0;
      case WM_SIZE:
      case WM_WINDOWPOSCHANGED:
        InvalidateRect(hwnd, nullptr, FALSE);
        return DefWindowProcW(hwnd, message, w_param, l_param);
      case WM_PAINT:
        self->paint();
        return 0;
      case WM_CLOSE:
        self->mark_surface_window_closed();
        DestroyWindow(hwnd);
        return 0;
      case WM_DESTROY:
        self->mark_surface_window_closed();
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
      snapshot_.thread_id = 0;
    }

    const std::string initial_codec = snapshot().codec_path;
    if (!register_window_class()) {
      fail_start("native-video-window-class-registration-failed");
      return;
    }

    if (!create_window()) {
      return;
    }

    if (!open_decoder(initial_codec)) {
      return;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.attached = true;
      snapshot_.running = true;
      snapshot_.decoder_ready = true;
      snapshot_.preview_surface_backend = "native-win32-gdi";
      snapshot_.implementation = "ffmpeg-native-video-surface";
      snapshot_.reason = "native-surface-running";
      start_complete_ = true;
      start_succeeded_ = true;
    }
    started_condition_.notify_all();

    bool should_stop = false;
    MSG msg{};
    while (!should_stop) {
      const BOOL message_result = GetMessageW(&msg, nullptr, 0, 0);
      if (message_result <= 0) {
        break;
      }

      TranslateMessage(&msg);
      DispatchMessageW(&msg);

      std::lock_guard<std::mutex> lock(mutex_);
      should_stop = stop_requested_;
    }

    cleanup_decoder();
    destroy_window();

    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.attached = false;
      snapshot_.running = false;
      snapshot_.decoder_ready = false;
      snapshot_.reason = stop_reason_.empty() ? "native-surface-stopped" : stop_reason_;
    }
    return;
#else
    fail_start("native-video-surface-is-only-implemented-on-windows");
#endif
  }

  void fail_start(const std::string& error_message) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.attached = false;
    snapshot_.running = false;
    snapshot_.decoder_ready = false;
    snapshot_.last_error = error_message;
    snapshot_.reason = "native-surface-start-failed";
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
      window_class.lpfnWndProc = &NativeVideoSurface::Impl::window_proc;
      window_class.hInstance = GetModuleHandleW(nullptr);
      window_class.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
      window_class.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
      window_class.lpszClassName = L"VDSNativeVideoSurfaceWindow";
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
    const std::wstring title = utf8_to_wide(config_.window_title.empty() ? "VDS Native Viewer" : config_.window_title);
    if (title.empty()) {
      fail_start("native-video-window-title-conversion-failed");
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
        fail_start("native-video-window-parent-handle-invalid");
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
      L"VDSNativeVideoSurfaceWindow",
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
      fail_start("native-video-window-creation-failed");
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
    snapshot_.thread_id = static_cast<unsigned long>(GetCurrentThreadId());
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
          ? "native-video-window-parent-handle-invalid"
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
        *error = "native-video-window-layout-apply-failed";
      }
      return false;
    }

    InvalidateRect(hwnd, nullptr, FALSE);
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

  void request_frame_drain() {
    const HWND hwnd = window_handle_.load();
    if (hwnd) {
      if (!frame_drain_pending_.exchange(true, std::memory_order_acq_rel)) {
        PostMessageW(hwnd, kFrameAvailableMessage, 0, 0);
      }
    }
  }

  void drain_queued_frames() {
    frame_drain_pending_.store(false, std::memory_order_release);

    while (true) {
      EncodedFrame frame;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stop_requested_ || frame_queue_.empty()) {
          return;
        }

        frame = std::move(frame_queue_.front());
        frame_queue_.pop_front();
      }

      if (!frame.bytes.empty()) {
        if (!frame.codec.empty() && frame.codec != active_codec_) {
          open_decoder(frame.codec);
        }
        decode_and_present(frame);
      }
    }
  }

  void paint() {
    PAINTSTRUCT paint_struct{};
    const HWND hwnd = window_handle_.load();
    if (!hwnd) {
      return;
    }
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

      int display_aspect_width = local_width;
      int display_aspect_height = local_height;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        get_display_aspect_dimensions(
          frame_width_,
          frame_height_,
          frame_sample_aspect_ratio_,
          &display_aspect_width,
          &display_aspect_height
        );
      }
      const RECT draw_rect = fit_rect_with_aspect(
        display_aspect_width,
        display_aspect_height,
        client_width,
        client_height
      );
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

  static AVPixelFormat ffmpeg_get_format(AVCodecContext* codec_context, const AVPixelFormat* pixel_formats) {
    const auto* self = static_cast<const NativeVideoSurface::Impl*>(codec_context->opaque);
    if (self) {
      for (const AVPixelFormat* current = pixel_formats; *current != AV_PIX_FMT_NONE; ++current) {
        if (*current == self->hw_pixel_format_) {
          return *current;
        }
      }
    }
    return pixel_formats[0];
  }

  bool codec_supports_hw_device(const AVCodec* codec, AVHWDeviceType device_type, AVPixelFormat* hw_pixel_format) const {
    for (int index = 0;; ++index) {
      const AVCodecHWConfig* config = avcodec_get_hw_config(codec, index);
      if (!config) {
        return false;
      }
      if ((config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) == 0) {
        continue;
      }
      if (config->device_type != device_type) {
        continue;
      }
      *hw_pixel_format = config->pix_fmt;
      return true;
    }
  }

  bool open_decoder(const std::string& codec_name) {
    cleanup_decoder();

    const std::string normalized_codec = to_lower_ascii(codec_name.empty() ? "h264" : codec_name);
    const AVCodecID codec_id = codec_id_from_name(normalized_codec);
    const AVCodec* codec = avcodec_find_decoder(codec_id);
    if (!codec) {
      fail_or_update("native-decoder-codec-unavailable", normalized_codec);
      return false;
    }

    AVCodecContext* context = avcodec_alloc_context3(codec);
    if (!context) {
      fail_or_update("native-decoder-context-allocation-failed", normalized_codec);
      return false;
    }

    codec_context_ = context;
    codec_context_->opaque = this;
    codec_context_->thread_count = 0;
    codec_context_->thread_type = FF_THREAD_FRAME;

    decoder_backend_ = "software";
    hw_pixel_format_ = AV_PIX_FMT_NONE;

    static constexpr AVHWDeviceType preferred_hw_types[] = {
      AV_HWDEVICE_TYPE_D3D11VA,
      AV_HWDEVICE_TYPE_DXVA2
    };

    for (const AVHWDeviceType device_type : preferred_hw_types) {
      AVPixelFormat hw_pixel_format = AV_PIX_FMT_NONE;
      if (!codec_supports_hw_device(codec, device_type, &hw_pixel_format)) {
        continue;
      }

      AVBufferRef* device_ref = nullptr;
      const int hw_result = av_hwdevice_ctx_create(&device_ref, device_type, nullptr, nullptr, 0);
      if (hw_result < 0 || !device_ref) {
        continue;
      }

      codec_context_->hw_device_ctx = av_buffer_ref(device_ref);
      av_buffer_unref(&device_ref);
      codec_context_->get_format = &NativeVideoSurface::Impl::ffmpeg_get_format;
      hw_pixel_format_ = hw_pixel_format;
      decoder_backend_ = av_hwdevice_get_type_name(device_type);
      break;
    }

    int open_result = avcodec_open2(codec_context_, codec, nullptr);
    if (open_result < 0 && hw_pixel_format_ != AV_PIX_FMT_NONE) {
      av_buffer_unref(&codec_context_->hw_device_ctx);
      codec_context_->get_format = nullptr;
      hw_pixel_format_ = AV_PIX_FMT_NONE;
      decoder_backend_ = "software";
      open_result = avcodec_open2(codec_context_, codec, nullptr);
    }

    if (open_result < 0) {
      cleanup_decoder();
      fail_or_update(ffmpeg_error_string(open_result), normalized_codec);
      return false;
    }

    decoded_frame_ = av_frame_alloc();
    transfer_frame_ = av_frame_alloc();
    if (!decoded_frame_ || !transfer_frame_) {
      cleanup_decoder();
      fail_or_update("native-decoder-frame-allocation-failed", normalized_codec);
      return false;
    }

    active_codec_ = normalized_codec;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.codec_path = normalized_codec;
      snapshot_.decoder_ready = true;
      snapshot_.decoder_backend = decoder_backend_;
      snapshot_.last_error.clear();
      snapshot_.reason = "native-decoder-ready";
    }
    return true;
  }

  void cleanup_decoder() {
    if (sws_context_) {
      sws_freeContext(sws_context_);
      sws_context_ = nullptr;
    }
    if (decoded_frame_) {
      av_frame_free(&decoded_frame_);
    }
    if (transfer_frame_) {
      av_frame_free(&transfer_frame_);
    }
    if (codec_context_) {
      avcodec_free_context(&codec_context_);
    }
    bgra_buffer_.clear();
    frame_width_ = 0;
    frame_height_ = 0;
    frame_sample_aspect_ratio_ = AVRational{1, 1};
    active_codec_.clear();
    decoder_backend_ = "none";
    hw_pixel_format_ = AV_PIX_FMT_NONE;
  }

  void fail_or_update(const std::string& error_message, const std::string& codec_name) {
    const std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.codec_path = codec_name;
    snapshot_.decoder_ready = false;
    snapshot_.decoder_backend = "none";
    snapshot_.last_error = error_message;
    snapshot_.reason = "native-decoder-open-failed";
    if (!start_complete_) {
      start_error_ = error_message;
      start_complete_ = true;
      start_succeeded_ = false;
      started_condition_.notify_all();
    }
  }

  void decode_and_present(const EncodedFrame& frame) {
    if (!codec_context_) {
      return;
    }

    AVPacket packet{};
    packet.data = const_cast<std::uint8_t*>(frame.bytes.data());
    packet.size = static_cast<int>(frame.bytes.size() - AV_INPUT_BUFFER_PADDING_SIZE);

    const int send_result = avcodec_send_packet(codec_context_, &packet);
    if (send_result < 0) {
      const std::string active_codec = active_codec_;
      cleanup_decoder();
      if (!active_codec.empty()) {
        open_decoder(active_codec);
      }
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.last_error = ffmpeg_error_string(send_result);
      snapshot_.reason = "native-decoder-send-failed";
      return;
    }

    while (true) {
      const int receive_result = avcodec_receive_frame(codec_context_, decoded_frame_);
      if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
        return;
      }
      if (receive_result < 0) {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot_.last_error = ffmpeg_error_string(receive_result);
        snapshot_.reason = "native-decoder-receive-failed";
        return;
      }

      AVFrame* frame_to_present = decoded_frame_;
      if (hw_pixel_format_ != AV_PIX_FMT_NONE && decoded_frame_->format == hw_pixel_format_) {
        av_frame_unref(transfer_frame_);
        const int transfer_result = av_hwframe_transfer_data(transfer_frame_, decoded_frame_, 0);
        if (transfer_result < 0) {
          std::lock_guard<std::mutex> lock(mutex_);
          snapshot_.last_error = ffmpeg_error_string(transfer_result);
          snapshot_.reason = "native-decoder-transfer-failed";
          av_frame_unref(decoded_frame_);
          return;
        }
        frame_to_present = transfer_frame_;
      }

      present_frame(frame_to_present);
      av_frame_unref(decoded_frame_);
      av_frame_unref(transfer_frame_);
    }
  }

  void present_frame(AVFrame* frame) {
    if (!frame || frame->width <= 0 || frame->height <= 0) {
      return;
    }

    const int buffer_size = av_image_get_buffer_size(AV_PIX_FMT_BGRA, frame->width, frame->height, 1);
    if (buffer_size <= 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "native-render-buffer-allocation-failed";
      snapshot_.last_error = "Unable to size BGRA render buffer.";
      return;
    }

    render_buffer_.resize(static_cast<std::size_t>(buffer_size));

    std::uint8_t* destination_data[4] = { nullptr, nullptr, nullptr, nullptr };
    int destination_linesize[4] = { 0, 0, 0, 0 };
    const int fill_result = av_image_fill_arrays(
      destination_data,
      destination_linesize,
      render_buffer_.data(),
      AV_PIX_FMT_BGRA,
      frame->width,
      frame->height,
      1
    );
    if (fill_result < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "native-render-buffer-fill-failed";
      snapshot_.last_error = ffmpeg_error_string(fill_result);
      return;
    }

    sws_context_ = sws_getCachedContext(
      sws_context_,
      frame->width,
      frame->height,
      static_cast<AVPixelFormat>(frame->format),
      frame->width,
      frame->height,
      AV_PIX_FMT_BGRA,
      SWS_BILINEAR,
      nullptr,
      nullptr,
      nullptr
    );
    if (!sws_context_) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "native-render-sws-init-failed";
      snapshot_.last_error = "Unable to initialize swscale context.";
      return;
    }

    sws_scale(
      sws_context_,
      frame->data,
      frame->linesize,
      0,
      frame->height,
      destination_data,
      destination_linesize
    );

    const long long now_steady_us = current_time_micros_steady();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      frame_width_ = frame->width;
      frame_height_ = frame->height;
      frame_sample_aspect_ratio_ =
        (frame->sample_aspect_ratio.num > 0 && frame->sample_aspect_ratio.den > 0)
          ? frame->sample_aspect_ratio
          : codec_context_->sample_aspect_ratio;
      bgra_buffer_.swap(render_buffer_);
      if (last_frame_present_at_steady_us_ > 0 && now_steady_us > last_frame_present_at_steady_us_) {
        const double interval_us = static_cast<double>(now_steady_us - last_frame_present_at_steady_us_);
        frame_interval_sample_count_ += 1;
        const double delta = interval_us - frame_interval_mean_us_;
        frame_interval_mean_us_ += delta / static_cast<double>(frame_interval_sample_count_);
        const double delta2 = interval_us - frame_interval_mean_us_;
        frame_interval_m2_us_ += delta * delta2;
        snapshot_.frame_interval_stddev_ms = frame_interval_sample_count_ > 1
          ? std::sqrt(frame_interval_m2_us_ / static_cast<double>(frame_interval_sample_count_ - 1)) / 1000.0
          : 0.0;
      }
      last_frame_present_at_steady_us_ = now_steady_us;
      snapshot_.decoded_frames_rendered += 1;
      snapshot_.last_decoded_frame_at_unix_ms = current_time_millis();
      snapshot_.decoder_ready = true;
      snapshot_.decoder_backend = decoder_backend_;
      snapshot_.last_error.clear();
      snapshot_.reason = "native-frame-rendered";
    }

#ifdef _WIN32
    const HWND hwnd = window_handle_.load();
    if (hwnd) {
      InvalidateRect(hwnd, nullptr, FALSE);
    }
#endif
  }

  NativeVideoSurfaceConfig config_;
  mutable std::mutex mutex_;
  std::condition_variable frame_available_;
  std::condition_variable started_condition_;
  std::deque<EncodedFrame> frame_queue_;
  std::thread worker_;
  bool stop_requested_ = false;
  bool start_complete_ = false;
  bool start_succeeded_ = false;
  std::string start_error_;
  std::string stop_reason_;
  NativeVideoSurfaceSnapshot snapshot_;

#ifdef _WIN32
  std::atomic<HWND> window_handle_ { nullptr };
  std::atomic<bool> frame_drain_pending_ { false };
  OverlayAnchorState overlay_anchor_{};
  HWINEVENTHOOK owner_move_hook_ = nullptr;
  HWND owner_move_hook_owner_ = nullptr;
  static std::mutex owner_move_hook_registry_mutex_;
  static std::unordered_map<HWINEVENTHOOK, Impl*> owner_move_hook_registry_;
#endif

  AVCodecContext* codec_context_ = nullptr;
  AVFrame* decoded_frame_ = nullptr;
  AVFrame* transfer_frame_ = nullptr;
  SwsContext* sws_context_ = nullptr;
  AVPixelFormat hw_pixel_format_ = AV_PIX_FMT_NONE;
  std::string active_codec_;
  std::string decoder_backend_ = "none";
  int frame_width_ = 0;
  int frame_height_ = 0;
  AVRational frame_sample_aspect_ratio_ { 1, 1 };
  std::vector<std::uint8_t> bgra_buffer_;
  std::vector<std::uint8_t> render_buffer_;
  long long last_frame_present_at_steady_us_ = -1;
  std::uint64_t frame_interval_sample_count_ = 0;
  double frame_interval_mean_us_ = 0.0;
  double frame_interval_m2_us_ = 0.0;
};

#ifdef _WIN32
std::mutex NativeVideoSurface::Impl::owner_move_hook_registry_mutex_;
std::unordered_map<HWINEVENTHOOK, NativeVideoSurface::Impl*> NativeVideoSurface::Impl::owner_move_hook_registry_;
#endif

NativeVideoSurface::NativeVideoSurface(NativeVideoSurfaceConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {}

NativeVideoSurface::~NativeVideoSurface() = default;

bool NativeVideoSurface::submit_encoded_frame(
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::string* error
) {
  return impl_->submit_encoded_frame(frame, codec, error);
}

NativeVideoSurfaceSnapshot NativeVideoSurface::snapshot() const {
  return impl_->snapshot();
}

bool NativeVideoSurface::update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
  return impl_->update_layout(layout, error);
}

void NativeVideoSurface::close(const std::string& reason) {
  impl_->stop(reason);
}

std::shared_ptr<NativeVideoSurface> create_native_video_surface(
  const NativeVideoSurfaceConfig& config,
  std::string* error
) {
  auto surface = std::shared_ptr<NativeVideoSurface>(new NativeVideoSurface(config));
  if (!surface->impl_->start(error)) {
    return nullptr;
  }
  return surface;
}
