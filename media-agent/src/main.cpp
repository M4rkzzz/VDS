#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include <iostream>
#include <string>

#include "agent_events.h"
#include "agent_lifecycle.h"
#include "agent_rpc_router.h"
#include "agent_runtime.h"
#include "agent_status_json.h"

int main(int argc, char* argv[]) {
  std::ios::sync_with_stdio(false);

  AgentRuntimeState runtime_state;
  const std::string agent_binary_path = argc > 0 && argv[0] ? argv[0] : "";
  initialize_agent_runtime(runtime_state, agent_binary_path);

  emit_event("agent-ready", build_agent_ready_json(runtime_state));
  run_agent_rpc_loop(runtime_state);

  shutdown_agent_runtime(runtime_state);
  return 0;
}
