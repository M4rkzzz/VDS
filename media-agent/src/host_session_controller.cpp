#include "host_session_controller.h"

#include <string>

#include "agent_diagnostics.h"
#include "host_session_state.h"
#include "host_session_runtime.h"
#include "host_session_start_pipeline.h"
#include "host_session_stop_pipeline.h"
#include "runtime_registry.h"

namespace {

void emit_host_session_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

HostSessionCommandResult start_host_session_from_request(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const std::string& request_json,
  const HostSessionControllerCallbacks& callbacks) {
  emit_host_session_breadcrumb("startHostSession:begin");
  vds::media_agent::drain_running_host_session(state, session, obs_ingest, callbacks, "host-session-restart");

  const int requested_obs_port = vds::media_agent::apply_host_session_start_request(session, request_json);
  emit_host_session_breadcrumb(
    std::string("startHostSession:config-applied target=") +
    session.capture_target_id +
    " backend=" + session.backend +
    " codec=" + session.codec +
    " size=" + std::to_string(session.width) + "x" + std::to_string(session.height) +
    " fps=" + std::to_string(session.frame_rate)
  );

  if (vds::media_agent::is_obs_ingest_backend_state(session)) {
    return vds::media_agent::start_obs_ingest_host_session(state, session, obs_ingest, requested_obs_port, callbacks);
  }

  return vds::media_agent::start_native_capture_host_session(state, session, obs_ingest, callbacks);
}

}  // namespace

HostSessionController::HostSessionController(AgentRuntimeState& state)
    : state_(state),
      session_(vds::media_agent::active_host_session(state)),
      obs_ingest_(vds::media_agent::active_obs_ingest_session(state)) {}

HostSessionCommandResult HostSessionController::start_from_request(
  const std::string& request_json,
  const HostSessionControllerCallbacks& callbacks) {
  return start_host_session_from_request(state_, session_, obs_ingest_, request_json, callbacks);
}

HostSessionCommandResult HostSessionController::stop(const HostSessionControllerCallbacks& callbacks) {
  return vds::media_agent::stop_host_session(state_, session_, obs_ingest_, callbacks);
}
