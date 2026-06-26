#pragma once

#include <string>

struct AgentRuntimeState;
struct HostSessionState;
struct HostSessionControllerCallbacks;
struct HostSessionCommandResult;
struct ObsIngestState;

namespace vds::media_agent {

void drain_running_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks,
  const std::string& reason);

HostSessionCommandResult stop_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks);

}  // namespace vds::media_agent
