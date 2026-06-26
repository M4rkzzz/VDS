#pragma once

struct AgentRuntimeState;
struct HostSessionState;
struct HostSessionControllerCallbacks;
struct HostSessionCommandResult;
struct ObsIngestState;

namespace vds::media_agent {

bool is_obs_ingest_backend_state(const HostSessionState& session);

HostSessionCommandResult start_obs_ingest_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  int requested_obs_port,
  const HostSessionControllerCallbacks& callbacks);

HostSessionCommandResult start_native_capture_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks);

}  // namespace vds::media_agent
