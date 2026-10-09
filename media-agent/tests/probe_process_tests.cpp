#include "process_runner.h"
#include "capability_probe_budget.h"
#include "json_protocol.h"

#include <iostream>
#include <sstream>
#include <string>

#ifdef _WIN32
#include "win32_owned_process.h"
#include <vector>

namespace {
int failures = 0;
int checks = 0;

void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

std::string utf8(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
      result.data(), size, nullptr, nullptr);
  return result;
}

std::string fixture_newlines(const std::string& raw) {
  // Windows CRT text stdout expands LF to CRLF. The runner deliberately
  // preserves raw bytes; only textual fixture expectations normalize them.
  std::string normalized;
  normalized.reserve(raw.size());
  for (std::size_t index = 0; index < raw.size(); ++index) {
    if (raw[index] == '\r' && index + 1 < raw.size() && raw[index + 1] == '\n') continue;
    normalized.push_back(raw[index]);
  }
  return normalized;
}

std::wstring executable_path() {
  std::vector<wchar_t> path(32768);
  const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  return size > 0 && size < path.size() ? std::wstring(path.data(), size) : std::wstring{};
}

int hang_with_descendant() {
  const std::wstring executable = executable_path();
  const std::wstring command = L"\"" + executable + L"\" --idle";
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION descendant {};
  if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr,
      FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &descendant)) return 4;
  CloseHandle(descendant.hThread);
  CloseHandle(descendant.hProcess);
  std::cout << GetCurrentProcessId() << " " << descendant.dwProcessId << std::endl;
  Sleep(INFINITE);
  return 0;
}

bool process_has_stopped(DWORD pid) {
  if (!pid) return false;
  const HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!process) return GetLastError() == ERROR_INVALID_PARAMETER;
  const bool stopped = WaitForSingleObject(process, 2000) == WAIT_OBJECT_0;
  CloseHandle(process);
  return stopped;
}

void test_basename_path_resolution() {
  using vds::media_agent::run_probe_process_capture;
  std::vector<wchar_t> temporary_path(32768);
  const DWORD path_size = GetTempPathW(static_cast<DWORD>(temporary_path.size()), temporary_path.data());
  expect(path_size > 0 && path_size < temporary_path.size(), "PATH fixture resolves its own temporary directory");
  if (path_size == 0 || path_size >= temporary_path.size()) return;
  const std::wstring fixture_directory = std::wstring(temporary_path.data(), path_size) +
      L"vds-probe-path-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  const std::wstring fixture_executable = fixture_directory + L"\\vds-probe-path-child.exe";
  if (!CreateDirectoryW(fixture_directory.c_str(), nullptr)) {
    expect(false, "PATH fixture creates its own directory");
    return;
  }
  const bool copied = CopyFileW(executable_path().c_str(), fixture_executable.c_str(), TRUE) != FALSE;
  expect(copied, "PATH fixture copies only its owned test executable");
  if (copied) {
    const DWORD environment_size = GetEnvironmentVariableW(L"PATH", nullptr, 0);
    std::vector<wchar_t> previous_path(environment_size);
    if (environment_size > 0) GetEnvironmentVariableW(L"PATH", previous_path.data(), environment_size);
    const std::wstring old_path = environment_size > 0 ? std::wstring(previous_path.data()) : std::wstring{};
    const std::wstring fixture_path = fixture_directory + L";" + old_path;
    const bool configured = SetEnvironmentVariableW(L"PATH", fixture_path.c_str()) != FALSE;
    expect(configured, "PATH fixture changes only its own process environment");
    if (configured) {
      const CommandResult from_path = run_probe_process_capture("vds-probe-path-child.exe",
          {"--arguments", "resolved-from-path"}, 5000);
      expect(from_path.launched && !from_path.timed_out && from_path.exit_code == 0 &&
          fixture_newlines(from_path.output) == "[resolved-from-path]\n", "bare probe executable resolves safely from PATH without a shell");
    }
    SetEnvironmentVariableW(L"PATH", environment_size > 0 ? old_path.c_str() : nullptr);
    DeleteFileW(fixture_executable.c_str());
  }
  RemoveDirectoryW(fixture_directory.c_str());
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc > 2 && std::wstring(argv[1]) == L"--agent-path") {
    using vds::media_agent::run_probe_process_capture;
    using vds::media_agent::extract_string_value;
    using vds::media_agent::extract_bool_value;
    const std::string agent_path = utf8(argv[2]);
    const CommandResult encoder = run_probe_process_capture(agent_path,
        {"--probe-video-encoder", "libx264"}, 5000);
    expect(encoder.launched && !encoder.timed_out && encoder.exit_code == 0 &&
        extract_string_value(encoder.output, "name") == "libx264" &&
        extract_bool_value(encoder.output, "exists", false) &&
        extract_bool_value(encoder.output, "validated", false),
        "standalone software encoder probe produces a validated structured result");
    expect(encoder.output.find("agent-ready") == std::string::npos,
        "encoder child does not initialize capture, audio, peers, or RPC");
    const CommandResult missing = run_probe_process_capture(agent_path,
        {"--probe-video-encoder", "vds_missing_encoder_fixture"}, 5000);
    expect(missing.launched && !missing.timed_out && missing.exit_code == 0 &&
        extract_string_value(missing.output, "reason") == "encoder-missing" &&
        !extract_bool_value(missing.output, "exists", true) &&
        !extract_bool_value(missing.output, "validated", true),
        "standalone missing encoder returns a diagnostic without opening a driver");
    const CommandResult wgc = run_probe_process_capture(agent_path,
        {"--probe-wgc-capability"}, 5000);
    expect(wgc.launched && !wgc.timed_out && wgc.exit_code == 0 &&
        extract_string_value(wgc.output, "probe") == "wgc" &&
        extract_bool_value(wgc.output, "implemented", false) &&
        extract_bool_value(wgc.output, "platformSupported", false) &&
        !extract_string_value(wgc.output, "reason").empty(),
        "standalone WGC reports capability metadata without creating a source");
    expect(wgc.output.find("agent-ready") == std::string::npos,
        "WGC probe does not start the agent RPC runtime");
    std::cout << "standalone capability checks: " << checks - failures << "/" << checks << '\n';
    return failures == 0 ? 0 : 1;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--idle") {
    Sleep(INFINITE);
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--hang-tree") return hang_with_descendant();
  if (argc > 1 && std::wstring(argv[1]) == L"--fail") {
    std::cout << "probe-result\n";
    std::cerr << "probe-diagnostic\n";
    return 37;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--crash") {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    RaiseException(EXCEPTION_ACCESS_VIOLATION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
    return 5;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--arguments") {
    for (int index = 2; index < argc; ++index) std::cout << "[" << utf8(argv[index]) << "]\n";
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--large-output") {
    for (int index = 0; index < 128; ++index) std::cout << std::string(2048, 'x');
    std::cout << "tail" << std::endl;
    return 0;
  }

  using vds::media_agent::run_probe_process_capture;
  const std::string executable = utf8(executable_path());
  test_basename_path_resolution();
  const CommandResult arguments = run_probe_process_capture(executable,
      {"--arguments", "space separated", "literal&|%()", "embedded\"quote", "trailing\\", "", utf8(L"\x7a97\x53e3")}, 5000);
  expect(arguments.launched && !arguments.timed_out && arguments.exit_code == 0,
      "direct child accepts argument array without a shell");
  expect(fixture_newlines(arguments.output) == "[space separated]\n[literal&|%()]\n[embedded\"quote]\n[trailing\\]\n[]\n[" + utf8(L"\x7a97\x53e3") + "]\n",
      "spaces, shell metacharacters, quotes, backslashes, empty and Unicode arguments round-trip");

  const CommandResult failed = run_probe_process_capture(executable, {"--fail"}, 5000);
  expect(failed.launched && failed.exit_code == 37 && !failed.timed_out,
      "nonzero child exit is returned to the owner");
  expect(failed.output.find("probe-result") != std::string::npos &&
      failed.output.find("probe-diagnostic") != std::string::npos,
      "both stdout and stderr are drained");
  const CommandResult crash = run_probe_process_capture(executable, {"--crash"}, 5000);
  expect(crash.launched && !crash.timed_out && crash.exit_code == static_cast<int>(EXCEPTION_ACCESS_VIOLATION),
      "driver-style access violation remains isolated in the child");

  const CommandResult large = run_probe_process_capture(executable, {"--large-output"}, 5000);
  expect(large.exit_code == 0 && !large.timed_out && large.output.size() > 256 * 1024 &&
      large.output.find("tail") != std::string::npos, "output larger than a pipe is drained without deadlock");

  const ULONGLONG started = GetTickCount64();
  const CommandResult hung = run_probe_process_capture(executable, {"--hang-tree"}, 200);
  const ULONGLONG elapsed = GetTickCount64() - started;
  expect(hung.launched && hung.timed_out && hung.exit_code == ERROR_TIMEOUT && elapsed < 3000,
      "unresponsive capability child ends within its diagnostic deadline");
  DWORD child_pid = 0;
  DWORD descendant_pid = 0;
  std::istringstream(hung.output) >> child_pid >> descendant_pid;
  expect(process_has_stopped(child_pid) && process_has_stopped(descendant_pid),
      "timed-out probe and its descendant are both reclaimed");

  using vds::media_agent::CapabilityProbeBudget;
  const auto epoch = CapabilityProbeBudget::Clock::time_point{};
  const CapabilityProbeBudget synthetic_budget(10000, epoch);
  expect(synthetic_budget.next_timeout_ms(5000, epoch) == 5000 &&
      synthetic_budget.next_timeout_ms(5000, epoch + std::chrono::milliseconds(4000)) == 4000,
      "shared diagnostic deadline shortens later probes and reserves retirement time");
  expect(synthetic_budget.next_timeout_ms(5000, epoch + std::chrono::milliseconds(7999)) == 1 &&
      synthetic_budget.next_timeout_ms(5000, epoch + std::chrono::milliseconds(8000)) == 0 &&
      synthetic_budget.next_timeout_ms(5000, epoch + std::chrono::milliseconds(12000)) == 0,
      "exhausted budget never wraps or launches another optional probe");
  const CapabilityProbeBudget short_budget(2400);
  const ULONGLONG budget_started = GetTickCount64();
  int budgeted_launches = 0;
  for (int index = 0; index < 13; ++index) {
    const unsigned long timeout = short_budget.next_timeout_ms(5000);
    if (timeout == 0) break;
    const CommandResult budgeted = run_probe_process_capture(executable, {"--hang-tree"}, timeout);
    ++budgeted_launches;
    expect(budgeted.timed_out, "budgeted unhealthy probe is retired");
    DWORD budgeted_child = 0;
    DWORD budgeted_descendant = 0;
    std::istringstream(budgeted.output) >> budgeted_child >> budgeted_descendant;
    expect(process_has_stopped(budgeted_child) && process_has_stopped(budgeted_descendant),
        "budgeted probe retirement leaves no process tree");
  }
  expect(budgeted_launches == 1 && GetTickCount64() - budget_started <= 2400,
      "shared startup budget stops thirteen unhealthy optional probes after the first shortened child");

  const CommandResult missing = run_probe_process_capture("Z:\\vds-probe-does-not-exist.exe", {}, 100);
  expect(!missing.launched && !missing.timed_out && missing.output.find("launch-error") != std::string::npos,
      "launch failure returns immediately with no child");
  DWORD handles_before = 0;
  DWORD handles_after = 0;
  GetProcessHandleCount(GetCurrentProcess(), &handles_before);
  for (int index = 0; index < 8; ++index) {
    const CommandResult repeat = run_probe_process_capture(executable, {"--fail"}, 5000);
    expect(repeat.exit_code == 37, "failed probe can be retried with a fresh child");
  }
  GetProcessHandleCount(GetCurrentProcess(), &handles_after);
  expect(handles_before == handles_after, "repeated probes do not leak process, job, or pipe handles");
  std::cout << "probe process checks: " << checks - failures << "/" << checks << '\n';
  return failures == 0 ? 0 : 1;
}
#else
int main() {
  std::cout << "Windows capability process tests skipped\n";
  return 0;
}
#endif
