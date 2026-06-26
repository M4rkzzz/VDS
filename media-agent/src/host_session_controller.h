#pragma once

#include "host_session_command.h"

struct AgentRuntimeState;
struct HostSessionState;
struct ObsIngestState;

class HostSessionController {
 public:
  explicit HostSessionController(AgentRuntimeState& state);

  HostSessionCommandResult start_from_request(
    const std::string& request_json,
    const HostSessionControllerCallbacks& callbacks);
  HostSessionCommandResult stop(const HostSessionControllerCallbacks& callbacks);

 private:
  AgentRuntimeState& state_;
  HostSessionState& session_;
  ObsIngestState& obs_ingest_;
};
