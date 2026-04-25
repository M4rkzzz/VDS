#pragma once

#include <string>

#include "agent_runtime.h"
#include "host_session_controller.h"

struct AgentLifecycleCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

void refresh_host_capture_runtime(AgentRuntimeState& state);
void refresh_agent_runtime_state(AgentRuntimeState& state);
void initialize_agent_runtime(AgentRuntimeState& state, const std::string& agent_binary_path);
void stop_all_surface_attachments(AgentRuntimeState& state, const std::string& reason);
void restart_host_capture_surface_attachments(AgentRuntimeState& state);
void shutdown_agent_runtime(AgentRuntimeState& state);

AgentLifecycleCommandResult get_status_result(AgentRuntimeState& state);
AgentLifecycleCommandResult get_capabilities_result(AgentRuntimeState& state);
AgentLifecycleCommandResult get_stats_result(AgentRuntimeState& state);
AgentLifecycleCommandResult get_audio_backend_status_result(AgentRuntimeState& state);

HostSessionControllerCallbacks make_start_host_session_callbacks(AgentRuntimeState& state);
HostSessionControllerCallbacks make_stop_host_session_callbacks(AgentRuntimeState& state);
