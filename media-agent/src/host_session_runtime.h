#pragma once

#include <string>

struct AgentRuntimeState;
struct HostCapturePlan;
struct HostCaptureProcessState;
struct HostSessionState;
struct ObsIngestState;

namespace vds::media_agent {

void refresh_default_native_host_plan(AgentRuntimeState& runtime_state, HostSessionState& session);
int apply_host_session_start_request(HostSessionState& session, const std::string& request_json);
void reset_host_session_to_default_native(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest);
const HostCapturePlan& revalidate_host_capture_plan(
  AgentRuntimeState& runtime_state,
  HostSessionState& session);
void initialize_default_capture_runtime(
  AgentRuntimeState& runtime_state,
  HostSessionState& session);
void refresh_host_capture_runtime(
  AgentRuntimeState& runtime_state,
  HostSessionState& session);
const HostCaptureProcessState& start_host_capture_process(
  AgentRuntimeState& runtime_state,
  HostSessionState& session);
void stop_host_capture_process(
  HostSessionState& session,
  const std::string& reason);
void set_host_video_codec(HostSessionState& session, const std::string& codec);
bool prepare_obs_ingest_session(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  bool wait_for_stream,
  int requested_port,
  std::string* error);
void clear_obs_ingest_prepared(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest);
void start_obs_ingest_worker(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest);
void stop_obs_ingest_session(
  AgentRuntimeState& runtime_state,
  HostSessionState& session,
  ObsIngestState& obs_ingest);

}  // namespace vds::media_agent
