#include "wgc_capability_probe.h"

#include <sstream>
#include <exception>
#include "json_protocol.h"
#include "agent_events.h"
#include "process_runner.h"
#include "string_utils.h"
#include "wgc_capture.h"

#ifdef _WIN32
#include "win32_owned_process.h"
#endif

int run_wgc_capture_probe_child() {
#ifdef _WIN32
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#endif
  WgcCaptureProbe probe;
  try {
    probe = probe_wgc_capture_backend();
  } catch (const std::exception& error) {
    probe.reason = "wgc-capability-probe-failed";
    probe.last_error = error.what();
  } catch (...) {
    probe.reason = "wgc-capability-probe-failed";
    probe.last_error = "unexpected-wgc-capability-exception";
  }
  std::ostringstream payload;
  payload << "{\"probe\":\"wgc\",\"available\":" << (probe.available ? "true" : "false")
    << ",\"implemented\":" << (probe.implemented ? "true" : "false")
    << ",\"platformSupported\":" << (probe.platform_supported ? "true" : "false")
    << ",\"displayCaptureSupported\":" << (probe.display_capture_supported ? "true" : "false")
    << ",\"windowCaptureSupported\":" << (probe.window_capture_supported ? "true" : "false")
    << ",\"reason\":\"" << vds::media_agent::json_escape(probe.reason)
    << "\",\"lastError\":\"" << vds::media_agent::json_escape(probe.last_error) << "\"}";
  write_json_line(payload.str());
  return 0;
}

WgcCaptureProbe probe_wgc_capture_backend_isolated(const std::string& agent_binary_path) {
#ifdef _WIN32
  WgcCaptureProbe probe;
  probe.implemented = true;
  probe.platform_supported = true;
  const CommandResult child = vds::media_agent::run_probe_process_capture(agent_binary_path,
      {"--probe-wgc-capability"}, 5000);
  if (child.timed_out || !child.launched || child.exit_code != 0) {
    probe.reason = child.timed_out ? "wgc-capability-probe-timeout" : "wgc-capability-probe-process-failed";
    probe.last_error = child.launched
      ? "isolated-wgc-probe-exit:" + std::to_string(child.exit_code)
      : child.output;
    return probe;
  }
  for (const std::string& line : vds::media_agent::split_lines(child.output)) {
    if (line.empty() || line.front() != '{' ||
        vds::media_agent::extract_string_value(line, "probe") != "wgc") continue;
    probe.available = vds::media_agent::extract_bool_value(line, "available", false);
    probe.implemented = vds::media_agent::extract_bool_value(line, "implemented", false);
    probe.platform_supported = vds::media_agent::extract_bool_value(line, "platformSupported", false);
    probe.display_capture_supported = vds::media_agent::extract_bool_value(line, "displayCaptureSupported", false);
    probe.window_capture_supported = vds::media_agent::extract_bool_value(line, "windowCaptureSupported", false);
    probe.reason = vds::media_agent::extract_string_value(line, "reason");
    probe.last_error = vds::media_agent::extract_string_value(line, "lastError");
    return probe;
  }
  probe.reason = "wgc-capability-probe-invalid-result";
  probe.last_error = "isolated-wgc-probe-result-missing";
  return probe;
#else
  (void)agent_binary_path;
  return probe_wgc_capture_backend();
#endif
}
