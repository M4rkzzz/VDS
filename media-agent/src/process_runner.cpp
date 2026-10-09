#include "process_runner.h"

#include <cstdio>
#include <algorithm>
#include <vector>

#ifdef _WIN32
#include "win32_owned_process.h"
#endif

#include "string_utils.h"

namespace vds::media_agent {

#ifdef _WIN32
namespace {
class ProbeHandle {
 public:
  explicit ProbeHandle(HANDLE value = nullptr) : value_(value) {}
  ~ProbeHandle() { reset(); }
  ProbeHandle(const ProbeHandle&) = delete;
  ProbeHandle& operator=(const ProbeHandle&) = delete;
  HANDLE get() const { return value_; }
  void reset(HANDLE value = nullptr) {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }
 private:
  HANDLE value_;
};

std::wstring probe_argument_to_wide(const std::string& argument) {
  if (argument.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      argument.data(), static_cast<int>(argument.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      argument.data(), static_cast<int>(argument.size()), result.data(), size);
  return result;
}

std::wstring quote_probe_argument(const std::wstring& argument) {
  std::wstring quoted = L"\"";
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
    } else {
      quoted.append(backslashes * (character == L'"' ? 2 : 1), L'\\');
      backslashes = 0;
      if (character == L'"') quoted.push_back(L'\\');
      quoted.push_back(character);
    }
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}
}  // namespace
#endif

CommandResult run_probe_process_capture(
    const std::string& executable,
    const std::vector<std::string>& arguments,
    unsigned long timeout_ms) {
  CommandResult result;
#ifdef _WIN32
  const std::wstring executable_wide = probe_argument_to_wide(executable);
  if (executable_wide.empty() || timeout_ms == 0) return result;
  std::wstring command = quote_probe_argument(executable_wide);
  for (const std::string& argument : arguments) {
    command.push_back(L' ');
    command += quote_probe_argument(probe_argument_to_wide(argument));
  }
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');

  SECURITY_ATTRIBUTES security {sizeof(security), nullptr, TRUE};
  ProbeHandle input(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  HANDLE read_handle = nullptr;
  HANDLE write_handle = nullptr;
  const bool pipe_created = CreatePipe(&read_handle, &write_handle, &security, 0) != FALSE;
  ProbeHandle output_read(read_handle);
  ProbeHandle output_write(write_handle);
  if (!input.get() || input.get() == INVALID_HANDLE_VALUE || !pipe_created ||
      !SetHandleInformation(output_read.get(), HANDLE_FLAG_INHERIT, 0)) return result;

  PROCESS_INFORMATION info {};
  HANDLE job_handle = nullptr;
  DWORD launch_error = ERROR_SUCCESS;
  // A bare fallback such as "ffmpeg" retains normal CreateProcess PATH
  // resolution. Full paths remain explicit; neither form invokes a shell.
  const bool executable_is_path = executable_wide.find_first_of(L"\\/:") != std::wstring::npos;
  if (!create_owned_child_process(executable_is_path ? executable_wide.c_str() : nullptr, mutable_command.data(),
      input.get(), output_write.get(), output_write.get(), info, job_handle, launch_error)) {
    result.output = "probe-process-launch-error:" + std::to_string(launch_error);
    return result;
  }
  ProbeHandle process(info.hProcess);
  ProbeHandle thread(info.hThread);
  ProbeHandle job(job_handle);
  output_write.reset();
  result.launched = true;

  // Pipe reads never wait for EOF: a hung driver, descendant, or full stderr
  // pipe must not turn a short diagnostic into an unbounded startup wait.
  const ULONGLONG deadline = GetTickCount64() + timeout_ms;
  constexpr std::size_t kMaxProbeDiagnosticBytes = 1024 * 1024;
  char buffer[4096];
  while (true) {
    DWORD available = 0;
    if (PeekNamedPipe(output_read.get(), nullptr, 0, nullptr, &available, nullptr) && available > 0) {
      DWORD received = 0;
      if (ReadFile(output_read.get(), buffer, std::min<DWORD>(available, sizeof(buffer)), &received, nullptr)) {
        if (result.output.size() < kMaxProbeDiagnosticBytes) {
          result.output.append(buffer, std::min<std::size_t>(received,
              kMaxProbeDiagnosticBytes - result.output.size()));
        }
      }
    } else if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) {
      break;
    } else {
      Sleep(5);
    }
    if (GetTickCount64() >= deadline) {
      result.timed_out = true;
      terminate_owned_process_tree(job.get(), process.get());
      result.exit_code = ERROR_TIMEOUT;
      return result;
    }
  }
  DWORD exit_code = 0;
  if (GetExitCodeProcess(process.get(), &exit_code)) result.exit_code = static_cast<int>(exit_code);
#else
  (void)timeout_ms;
  std::string command = "'";
  for (const char ch : executable) command += ch == '\'' ? "'\\''" : std::string(1, ch);
  command += "'";
  for (const std::string& argument : arguments) {
    command += " '";
    for (const char ch : argument) command += ch == '\'' ? "'\\''" : std::string(1, ch);
    command += "'";
  }
  result = run_command_capture(command + " 2>&1");
#endif
  return result;
}

CommandResult run_command_capture(const std::string& command) {
  CommandResult result;

#ifdef _WIN32
  FILE* pipe = _popen(command.c_str(), "r");
#else
  FILE* pipe = popen(command.c_str(), "r");
#endif

  if (!pipe) {
    return result;
  }

  result.launched = true;
  char buffer[4096];
  while (std::fgets(buffer, static_cast<int>(sizeof(buffer)), pipe) != nullptr) {
    result.output += buffer;
  }

#ifdef _WIN32
  result.exit_code = _pclose(pipe);
#else
  result.exit_code = pclose(pipe);
#endif

  return result;
}

bool command_failed_to_resolve(const CommandResult& result) {
  if (!result.launched) {
    return true;
  }

  const std::string output = to_lower_copy(result.output);
  return output.find("is not recognized") != std::string::npos ||
    output.find("not found") != std::string::npos ||
    output.find("no such file") != std::string::npos;
}

}  // namespace vds::media_agent
