#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "agent_runtime.h"

struct SurfaceControlCommandResult {
  bool ok = false;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

SurfaceControlCommandResult attach_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
SurfaceControlCommandResult update_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
SurfaceControlCommandResult detach_surface_from_request(AgentRuntimeState& state, const std::string& request_json);
