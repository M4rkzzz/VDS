#include "platform_utils.h"

#include <cstdint>
#include <iomanip>
#include <sstream>

#include "json_protocol.h"
#include "string_utils.h"

namespace vds::media_agent {

std::string quote_command_path(const std::string& path) {
  if (path.find(' ') == std::string::npos && path.find('&') == std::string::npos) {
    return path;
  }

  return "\"" + path + "\"";
}

std::string build_gdigrab_hwnd_target(const std::string& hwnd_value) {
  const std::string trimmed = trim_copy(hwnd_value);
  if (trimmed.empty()) {
    return {};
  }

  try {
    std::size_t parsed_length = 0;
    const unsigned long long handle = std::stoull(trimmed, &parsed_length, 0);
    if (parsed_length == trimmed.size()) {
      std::ostringstream target;
      target << "hwnd=0x" << std::uppercase << std::hex << handle;
      return target.str();
    }
  } catch (...) {
  }

  return "hwnd=" + trimmed;
}

#ifdef _WIN32
namespace {

struct WindowTitleSearchContext {
  std::string wanted_title;
  std::string wanted_title_lower;
  HWND exact_match = nullptr;
  HWND partial_match = nullptr;
};

BOOL CALLBACK enum_windows_for_title_proc(HWND hwnd, LPARAM lparam) {
  auto* context = reinterpret_cast<WindowTitleSearchContext*>(lparam);
  if (!context || !IsWindow(hwnd) || !IsWindowVisible(hwnd)) {
    return TRUE;
  }

  const int title_length = GetWindowTextLengthW(hwnd);
  if (title_length <= 0) {
    return TRUE;
  }

  std::wstring title_wide(static_cast<std::size_t>(title_length), L'\0');
  const int copied = GetWindowTextW(hwnd, title_wide.data(), title_length + 1);
  if (copied <= 0) {
    return TRUE;
  }
  title_wide.resize(static_cast<std::size_t>(copied));
  const int required = WideCharToMultiByte(CP_UTF8, 0, title_wide.c_str(), copied, nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return TRUE;
  }
  std::string title(static_cast<std::size_t>(required), '\0');
  const int converted = WideCharToMultiByte(CP_UTF8, 0, title_wide.c_str(), copied, title.data(), required, nullptr, nullptr);
  if (converted <= 0) {
    return TRUE;
  }
  const std::string lowered = to_lower_copy(trim_copy(title));
  if (lowered.empty()) {
    return TRUE;
  }

  if (lowered == context->wanted_title_lower) {
    context->exact_match = hwnd;
    return FALSE;
  }

  if (!context->partial_match && lowered.find(context->wanted_title_lower) != std::string::npos) {
    context->partial_match = hwnd;
  }
  return TRUE;
}

}  // namespace

std::string resolve_window_handle_from_title(const std::string& window_title) {
  const std::string trimmed = trim_copy(window_title);
  if (trimmed.empty()) {
    return {};
  }

  WindowTitleSearchContext context;
  context.wanted_title = trimmed;
  context.wanted_title_lower = to_lower_copy(trimmed);
  EnumWindows(&enum_windows_for_title_proc, reinterpret_cast<LPARAM>(&context));

  const HWND resolved = context.exact_match ? context.exact_match : context.partial_match;
  if (!resolved) {
    return {};
  }

  std::ostringstream handle;
  handle << "0x" << std::uppercase << std::hex << reinterpret_cast<std::uintptr_t>(resolved);
  return handle.str();
}

std::wstring utf8_to_wide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (required <= 0) {
    return {};
  }

  std::wstring wide(static_cast<std::size_t>(required), L'\0');
  if (MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), required) <= 0) {
    return {};
  }
  if (!wide.empty() && wide.back() == L'\0') {
    wide.pop_back();
  }
  return wide;
}

std::string wide_to_utf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }

  const int required = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return {};
  }

  std::string narrow(static_cast<std::size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, narrow.data(), required, nullptr, nullptr) <= 0) {
    return {};
  }
  if (!narrow.empty() && narrow.back() == '\0') {
    narrow.pop_back();
  }
  return narrow;
}

std::string format_windows_error(DWORD error_code) {
  LPWSTR message_buffer = nullptr;
  const DWORD message_length = FormatMessageW(
    FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    nullptr,
    error_code,
    0,
    reinterpret_cast<LPWSTR>(&message_buffer),
    0,
    nullptr
  );

  std::wstring message = message_length && message_buffer
    ? std::wstring(message_buffer, message_length)
    : L"Unknown Windows error";

  if (message_buffer) {
    LocalFree(message_buffer);
  }

  return trim_copy(wide_to_utf8(message));
}
#else
std::string resolve_window_handle_from_title(const std::string&) {
  return {};
}
#endif

}  // namespace vds::media_agent
