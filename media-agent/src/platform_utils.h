#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace vds::media_agent {

std::string quote_command_path(const std::string& path);
std::string build_gdigrab_hwnd_target(const std::string& hwnd_value);
std::string resolve_window_handle_from_title(const std::string& window_title);

#ifdef _WIN32
std::wstring utf8_to_wide(const std::string& value);
std::string wide_to_utf8(const std::wstring& value);
std::string format_windows_error(DWORD error_code);
#endif

}  // namespace vds::media_agent
