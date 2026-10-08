#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <array>
#include <cstddef>

namespace vds::media_agent {

// The job owns only the child lifetime. It imposes no CPU, memory, priority,
// process-count, or network limits on the encoder or its descendants.
inline bool create_owned_child_process(
    const wchar_t* application_name,
    wchar_t* command_line,
    HANDLE stdin_handle,
    HANDLE stdout_handle,
    HANDLE stderr_handle,
    PROCESS_INFORMATION& process_info,
    HANDLE& job_handle,
    DWORD& error_code) {
  process_info = {};
  job_handle = nullptr;
  error_code = ERROR_SUCCESS;

  std::array<HANDLE, 3> inherited_handles {};
  std::size_t inherited_count = 0;
  for (const HANDLE handle : {stdin_handle, stdout_handle, stderr_handle}) {
    if (!handle || handle == INVALID_HANDLE_VALUE) {
      error_code = ERROR_INVALID_HANDLE;
      return false;
    }
    bool duplicate = false;
    for (std::size_t index = 0; index < inherited_count; ++index) {
      duplicate = duplicate || inherited_handles[index] == handle;
    }
    if (!duplicate) inherited_handles[inherited_count++] = handle;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    error_code = GetLastError();
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    error_code = GetLastError();
    CloseHandle(job);
    return false;
  }

  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attribute_bytes);
  auto* attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      HeapAlloc(GetProcessHeap(), 0, attribute_bytes));
  if (!attributes) {
    error_code = ERROR_NOT_ENOUGH_MEMORY;
    CloseHandle(job);
    return false;
  }
  const bool attributes_initialized =
      InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_bytes) != FALSE;
  if (!attributes_initialized || !UpdateProcThreadAttribute(attributes, 0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles.data(),
      inherited_count * sizeof(HANDLE), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
          &job, sizeof(job), nullptr, nullptr)) {
    error_code = GetLastError();
    if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    return false;
  }

  STARTUPINFOEXW startup_info {};
  startup_info.StartupInfo.cb = sizeof(startup_info);
  startup_info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup_info.StartupInfo.hStdInput = stdin_handle;
  startup_info.StartupInfo.hStdOutput = stdout_handle;
  startup_info.StartupInfo.hStdError = stderr_handle;
  startup_info.lpAttributeList = attributes;
  // Windows 10+ associates the child with this job as part of creation. Even
  // owner death before CreateProcess returns cannot strand a suspended child.
  const BOOL created = CreateProcessW(application_name, command_line, nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
      &startup_info.StartupInfo, &process_info);
  if (!created) error_code = GetLastError();
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  if (!created) {
    CloseHandle(job);
    return false;
  }

  // The encoder cannot execute or spawn descendants until it belongs to the
  // job. The job handle is not inheritable and is absent from the handle list.
  if (ResumeThread(process_info.hThread) == static_cast<DWORD>(-1)) {
    error_code = GetLastError();
    TerminateProcess(process_info.hProcess, error_code);
    WaitForSingleObject(process_info.hProcess, 2000);
    CloseHandle(job);
    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    process_info = {};
    return false;
  }

  job_handle = job;
  return true;
}

inline void terminate_owned_process_tree(HANDLE job_handle, HANDLE process_handle) {
  if (job_handle) {
    if (!TerminateJobObject(job_handle, 0) && process_handle) {
      TerminateProcess(process_handle, 0);
    }
  } else if (process_handle) {
    TerminateProcess(process_handle, 0);
  }
  if (process_handle) WaitForSingleObject(process_handle, 2000);
}

}  // namespace vds::media_agent
#endif
