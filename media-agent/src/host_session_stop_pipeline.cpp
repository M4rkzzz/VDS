#include "host_session_stop_pipeline.h"

#include <utility>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "host_capture_process.h"
#include "host_session_command.h"
#include "host_session_runtime.h"
#include "host_session_state.h"
#include "host_state_json.h"
#include "obs_ingest_state.h"
#include "peer_host_binding_pipeline.h"

namespace vds::media_agent {
namespace {

void emit_host_session_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

HostSessionCommandResult ok_result(std::string result_json) {
  HostSessionCommandResult result;
  result.ok = true;
  result.result_json = std::move(result_json);
  return result;
}

}  // namespace

void drain_running_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks,
  const std::string& reason) {
  const bool restarting = reason == "host-session-restart";
  if (callbacks.stop_all_surface_attachments) {
    callbacks.stop_all_surface_attachments(reason);
  }
  emit_host_session_breadcrumb(
    reason == "host-session-restart"
      ? "startHostSession:after-stop-all-surfaces"
      : "stopHostSession:after-stop-all-surfaces"
  );
  if (restarting) {
    stop_host_capture_process(session, reason);
    emit_host_session_breadcrumb("startHostSession:after-stop-host-capture-process");
    stop_obs_ingest_session(state, session, obs_ingest);
    emit_host_session_breadcrumb("startHostSession:after-stop-obs-ingest-runtime");
    return;
  }
  stop_obs_ingest_session(state, session, obs_ingest);
  emit_host_session_breadcrumb(
    reason == "host-session-restart"
      ? "startHostSession:after-stop-obs-ingest-runtime"
      : "stopHostSession:after-stop-obs-ingest-runtime"
  );
  if (reason == "host-session-stopped") {
    detach_host_downstream_media_bindings(state, callbacks);
    emit_host_session_breadcrumb("stopHostSession:after-detach-host-downstream-peers");
  }
  stop_host_capture_process(session, reason);
  emit_host_session_breadcrumb(
    reason == "host-session-restart"
      ? "startHostSession:after-stop-host-capture-process"
      : "stopHostSession:after-stop-host-capture-process"
  );
}

HostSessionCommandResult stop_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks) {
  emit_host_session_breadcrumb("stopHostSession:begin");
  drain_running_host_session(state, session, obs_ingest, callbacks, "host-session-stopped");

  reset_host_session_to_default_native(state, session, obs_ingest);
  emit_host_session_breadcrumb("stopHostSession:before-result");
  emit_event(
    "media-state",
    std::string("{\"state\":\"host-session-stopped\",\"captureProcess\":") +
      host_capture_process_json(session.capture_process) +
      ",\"implementation\":\"native-media-agent\",\"transportReady\":" +
      std::string(callbacks.transport_ready && callbacks.transport_ready() ? "true" : "false") + "}"
  );
  return ok_result(host_session_json(session, obs_ingest));
}

}  // namespace vds::media_agent
