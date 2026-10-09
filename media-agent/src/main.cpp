#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include <iostream>
#include <exception>
#include <string>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "agent_lifecycle.h"
#include "agent_rpc_router.h"
#include "agent_runtime.h"
#include "agent_status_json.h"
#include "ffmpeg_probe.h"
#include "wgc_capability_probe.h"

namespace {
void report_agent_failure(const char* stage, const char* message) noexcept {
  try {
    emit_agent_breadcrumb(std::string(stage) + message);
  } catch (...) {
    // A diagnostic failure must not interrupt final resource cleanup.
  }
}
}  // namespace

int main(int argc, char* argv[]) {
  std::ios::sync_with_stdio(false);

  if (argc > 1 && argv[1] && std::string(argv[1]) == "--probe-video-encoder") {
    return argc == 3 && argv[2]
      ? vds::media_agent::run_ffmpeg_encoder_probe_child(argv[2])
      : 1;
  }
  if (argc > 1 && argv[1] && std::string(argv[1]) == "--probe-wgc-capability") {
    return argc == 2 ? run_wgc_capture_probe_child() : 1;
  }

  AgentRuntimeState runtime_state;
  int result = 0;
  try {
    const std::string agent_binary_path = argc > 0 && argv[0] ? argv[0] : "";
    initialize_agent_runtime(runtime_state, agent_binary_path);
    emit_event("agent-ready", build_agent_ready_json(runtime_state));
    run_agent_rpc_loop(runtime_state);
  } catch (const std::exception& error) {
    report_agent_failure("agent-runtime-failed: ", error.what());
    result = 1;
  } catch (...) {
    report_agent_failure("agent-runtime-failed: ", "unexpected exception");
    result = 1;
  }

  // Initialization and RPC failures must also release active native producers.
  try {
    shutdown_agent_runtime(runtime_state);
  } catch (const std::exception& error) {
    report_agent_failure("agent-shutdown-failed: ", error.what());
    result = 1;
  } catch (...) {
    report_agent_failure("agent-shutdown-failed: ", "unexpected exception");
    result = 1;
  }
  return result;
}
