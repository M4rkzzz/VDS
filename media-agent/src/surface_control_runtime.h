#pragma once

#include <string>

struct AgentRuntimeState;

struct SurfaceControlCommandResult {
  bool ok = false;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

SurfaceControlCommandResult attach_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
SurfaceControlCommandResult update_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
SurfaceControlCommandResult detach_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
