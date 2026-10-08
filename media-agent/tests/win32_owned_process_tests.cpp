#include "win32_owned_process.h"

#include <iostream>
#include <string>

#ifdef _WIN32
#include <cstdint>
#include <sstream>
#include <vector>

namespace {
int failures = 0;
int checks = 0;

void expect(bool result, const std::string& message) {
  ++checks;
  if (!result) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

class Handle {
public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  void reset(HANDLE value = nullptr) {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }
private:
  HANDLE value_;
};

struct Process {
  Handle process;
  Handle thread;
  Handle job;
  ~Process() {
    if (process.get() && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT) {
      vds::media_agent::terminate_owned_process_tree(job.get(), process.get());
    }
  }
};

struct Stdio {
  Handle input;
  Handle output_read;
  Handle output_write;
  bool initialize() {
    SECURITY_ATTRIBUTES security {sizeof(security), nullptr, TRUE};
    input.reset(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    HANDLE read = nullptr;
    HANDLE write = nullptr;
    const bool created = CreatePipe(&read, &write, &security, 0) != FALSE;
    output_read.reset(read);
    output_write.reset(write);
    return input.get() != INVALID_HANDLE_VALUE && created &&
        SetHandleInformation(output_read.get(), HANDLE_FLAG_INHERIT, 0);
  }
};

std::wstring executable_path() {
  std::vector<wchar_t> path(32768);
  const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  return length > 0 && length < path.size() ? std::wstring(path.data(), length) : std::wstring{};
}

bool spawn_owned(const std::wstring& arguments, HANDLE input, HANDLE output,
    HANDLE error, Process& result, DWORD& launch_error) {
  const std::wstring executable = executable_path();
  const std::wstring command = L"\"" + executable + L"\" " + arguments;
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  PROCESS_INFORMATION info {};
  HANDLE job = nullptr;
  if (!vds::media_agent::create_owned_child_process(executable.c_str(), mutable_command.data(),
      input, output, error, info, job, launch_error)) return false;
  result.process.reset(info.hProcess);
  result.thread.reset(info.hThread);
  result.job.reset(job);
  return true;
}

bool write_line(const std::string& value) {
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value.data(),
      static_cast<DWORD>(value.size()), &written, nullptr) && written == value.size();
}

std::string read_line(HANDLE pipe) {
  const ULONGLONG deadline = GetTickCount64() + 5000;
  std::string line;
  while (GetTickCount64() < deadline) {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) return {};
    if (available == 0) {
      Sleep(5);
      continue;
    }
    char byte = 0;
    DWORD received = 0;
    if (!ReadFile(pipe, &byte, 1, &received, nullptr) || received != 1) return {};
    if (byte == '\n') return line;
    line.push_back(byte);
    if (line.size() > 128) return {};
  }
  return {};
}

int tree_child(std::uintptr_t excluded_handle) {
  // Do this before opening any further handles in the child. A foreign event
  // intentionally marked inheritable in the parent must still be absent here.
  const bool inherited_foreign_event = excluded_handle != 0 &&
      SetEvent(reinterpret_cast<HANDLE>(excluded_handle)) != FALSE;
  const std::wstring executable = executable_path();
  const std::wstring command = L"\"" + executable + L"\" --idle";
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION descendant {};
  if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
      CREATE_NO_WINDOW, nullptr, nullptr, &startup, &descendant)) return 2;
  CloseHandle(descendant.hThread);
  CloseHandle(descendant.hProcess);
  if (!write_line(std::to_string(GetCurrentProcessId()) + " " +
      std::to_string(descendant.dwProcessId) + " " + (inherited_foreign_event ? "1\n" : "0\n"))) return 3;
  Sleep(INFINITE);
  return 0;
}

int job_owner() {
  Process child;
  DWORD error = ERROR_SUCCESS;
  if (!spawn_owned(L"--tree-child 0", GetStdHandle(STD_INPUT_HANDLE),
      GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE), child, error)) return 4;
  Sleep(INFINITE);
  return 0;
}

void test_failed_creation() {
  Stdio stdio;
  expect(stdio.initialize(), "failure fixture opens standard handles");
  PROCESS_INFORMATION info {};
  HANDLE job = nullptr;
  DWORD error = ERROR_SUCCESS;
  wchar_t command[] = L"vds-nonexistent-owned-process.exe";
  const bool created = vds::media_agent::create_owned_child_process(
      L"Z:\\vds-nonexistent-owned-process.exe", command, stdio.input.get(),
      stdio.output_write.get(), stdio.input.get(), info, job, error);
  expect(!created && error != ERROR_SUCCESS, "missing executable returns its launch error");
  expect(!info.hProcess && !info.hThread && !job, "failed creation returns no owned handles");
  // Windows can lazily cache its first CreateProcess support handles. Measure
  // repeated failures after that initialization rather than the one-time cache.
  DWORD before = 0;
  DWORD after = 0;
  GetProcessHandleCount(GetCurrentProcess(), &before);
  for (int index = 0; index < 8; ++index) {
    expect(!vds::media_agent::create_owned_child_process(
        L"Z:\\vds-nonexistent-owned-process.exe", command, stdio.input.get(),
        stdio.output_write.get(), stdio.input.get(), info, job, error) &&
        !info.hProcess && !info.hThread && !job,
        "repeated failed creation leaves no child handles");
  }
  GetProcessHandleCount(GetCurrentProcess(), &after);
  expect(before == after, "failed creation releases job and attribute resources");
}

void test_process_tree(bool explicit_stop) {
  Stdio stdio;
  expect(stdio.initialize(), "tree fixture opens standard handles");
  SECURITY_ATTRIBUTES security {sizeof(security), nullptr, TRUE};
  Handle foreign_event(CreateEventW(&security, TRUE, FALSE, nullptr));
  Process child;
  DWORD error = ERROR_SUCCESS;
  const bool created = spawn_owned(L"--tree-child " +
      std::to_wstring(reinterpret_cast<std::uintptr_t>(foreign_event.get())),
      stdio.input.get(), stdio.output_write.get(), stdio.input.get(), child, error);
  expect(created, "child starts suspended, joins its job, then resumes");
  if (!created) return;
  stdio.output_write.reset();

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
  expect(QueryInformationJobObject(child.job.get(), JobObjectExtendedLimitInformation,
      &limits, sizeof(limits), nullptr) != FALSE, "job policy is queryable");
  expect(limits.BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE &&
      limits.BasicLimitInformation.ActiveProcessLimit == 0 && limits.ProcessMemoryLimit == 0 &&
      limits.JobMemoryLimit == 0,
      "job applies lifetime cleanup without resource or scheduling quotas");
  JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu {};
  expect(QueryInformationJobObject(child.job.get(), JobObjectCpuRateControlInformation,
      &cpu, sizeof(cpu), nullptr) && cpu.ControlFlags == 0, "job does not throttle CPU");
  DWORD job_flags = HANDLE_FLAG_INHERIT;
  expect(GetHandleInformation(child.job.get(), &job_flags) &&
      (job_flags & HANDLE_FLAG_INHERIT) == 0, "job handle cannot keep itself alive in the child");

  DWORD child_id = 0;
  DWORD descendant_id = 0;
  unsigned inherited = 1;
  std::istringstream ready(read_line(stdio.output_read.get()));
  ready >> child_id >> descendant_id >> inherited;
  expect(child_id != 0 && descendant_id != 0, "child and descendant execute and report readiness");
  expect(inherited == 0 && WaitForSingleObject(foreign_event.get(), 0) == WAIT_TIMEOUT,
      "standard-handle whitelist excludes other inheritable parent handles");
  Handle descendant(OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
      FALSE, descendant_id));
  BOOL in_job = FALSE;
  expect(descendant.get() && IsProcessInJob(descendant.get(), child.job.get(), &in_job) && in_job,
      "descendant automatically belongs to the encoder job");
  if (explicit_stop) {
    vds::media_agent::terminate_owned_process_tree(child.job.get(), child.process.get());
  } else {
    child.job.reset();
  }
  expect(WaitForSingleObject(child.process.get(), 5000) == WAIT_OBJECT_0,
      explicit_stop ? "explicit stop terminates child" : "closing job terminates child");
  const bool descendant_stopped = descendant.get() &&
      WaitForSingleObject(descendant.get(), 5000) == WAIT_OBJECT_0;
  expect(descendant_stopped,
      explicit_stop ? "explicit stop terminates descendant" : "closing job terminates descendant");
  if (descendant.get() && !descendant_stopped) TerminateProcess(descendant.get(), 1);
}

void test_owner_death() {
  Stdio stdio;
  expect(stdio.initialize(), "owner fixture opens standard handles");
  const std::wstring executable = executable_path();
  const std::wstring command = L"\"" + executable + L"\" --owner";
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup {};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = stdio.input.get();
  startup.hStdOutput = stdio.output_write.get();
  startup.hStdError = stdio.input.get();
  PROCESS_INFORMATION info {};
  const bool created = CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr,
      TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info) != FALSE;
  expect(created, "separate owner process starts");
  if (!created) return;
  Process owner;
  owner.process.reset(info.hProcess);
  owner.thread.reset(info.hThread);
  stdio.output_write.reset();
  DWORD child_id = 0;
  DWORD descendant_id = 0;
  unsigned inherited = 0;
  std::istringstream ready(read_line(stdio.output_read.get()));
  ready >> child_id >> descendant_id >> inherited;
  Handle child(OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, child_id));
  Handle descendant(OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, descendant_id));
  expect(child.get() && descendant.get(), "owner starts a child and grandchild before abrupt exit");
  TerminateProcess(owner.process.get(), 77);
  expect(WaitForSingleObject(owner.process.get(), 5000) == WAIT_OBJECT_0, "owner is forcibly terminated");
  const bool child_stopped = child.get() && WaitForSingleObject(child.get(), 5000) == WAIT_OBJECT_0;
  const bool descendant_stopped = descendant.get() &&
      WaitForSingleObject(descendant.get(), 5000) == WAIT_OBJECT_0;
  expect(child_stopped && descendant_stopped, "owner death leaves no running child or descendant");
  if (child.get() && !child_stopped) TerminateProcess(child.get(), 1);
  if (descendant.get() && !descendant_stopped) TerminateProcess(descendant.get(), 1);
}
}  // namespace
#endif

int main(int argc, char** argv) {
#ifdef _WIN32
  if (argc > 1 && std::string(argv[1]) == "--idle") {
    Sleep(INFINITE);
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--owner") return job_owner();
  if (argc > 2 && std::string(argv[1]) == "--tree-child") {
    return tree_child(static_cast<std::uintptr_t>(std::stoull(argv[2])));
  }
  test_failed_creation();
  test_process_tree(false);
  test_process_tree(true);
  test_owner_death();
  std::cout << "owned process checks: " << (checks - failures) << "/" << checks << '\n';
  return failures == 0 ? 0 : 1;
#else
  (void)argc;
  (void)argv;
  std::cout << "Windows owned process tests skipped on this platform\n";
  return 0;
#endif
}
