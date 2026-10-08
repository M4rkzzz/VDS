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
