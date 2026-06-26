#include "host_session_start_pipeline.h"

#include <utility>

#include "agent_diagnostics.h"
#include "agent_events.h"
#include "host_capture_plan.h"
#include "host_capture_process.h"
#include "host_pipeline.h"
#include "host_session_command.h"
#include "host_session_runtime.h"
#include "host_session_state.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "obs_ingest_state.h"
#include "peer_host_binding_pipeline.h"
#include "string_utils.h"

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

HostSessionCommandResult error_result(const std::string& code, const std::string& message) {
  HostSessionCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

}  // namespace

bool is_obs_ingest_backend_state(const HostSessionState& session) {
  return to_lower_copy(session.backend) == "obs-ingest";
}

HostSessionCommandResult start_obs_ingest_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  int requested_obs_port,
  const HostSessionControllerCallbacks& callbacks) {
  session.pipeline = HostPipelineState{};
  session.capture_plan = HostCapturePlan{};
  session.capture_artifact = HostCaptureArtifactProbe{};
  if (callbacks.refresh_host_capture_runtime) {
    callbacks.refresh_host_capture_runtime();
  }
  if (callbacks.restart_host_capture_surface_attachments) {
    callbacks.restart_host_capture_surface_attachments();
  }

  std::string prepare_error;
  if (!prepare_obs_ingest_session(state, session, obs_ingest, false, requested_obs_port, &prepare_error)) {
    session.running = false;
    session.backend = "native";
    clear_obs_ingest_prepared(state, session, obs_ingest);
    return error_result("OBS_INGEST_PREPARE_FAILED", prepare_error);
  }

  start_obs_ingest_worker(state, session, obs_ingest);
  emit_host_session_breadcrumb("startHostSession:after-start-obs-ingest-worker");
  emit_host_session_breadcrumb("startHostSession:before-result");
  return ok_result(host_session_json(session, obs_ingest));
}

HostSessionCommandResult start_native_capture_host_session(
  AgentRuntimeState& state,
  HostSessionState& session,
  ObsIngestState& obs_ingest,
  const HostSessionControllerCallbacks& callbacks) {
  clear_obs_ingest_prepared(state, session, obs_ingest);
  refresh_default_native_host_plan(state, session);
  emit_host_session_breadcrumb("startHostSession:after-select-pipeline");
  emit_host_session_breadcrumb("startHostSession:after-build-capture-plan");
  emit_host_session_breadcrumb("startHostSession:after-validate-capture-plan");
  start_host_capture_process(state, session);
  emit_host_session_breadcrumb("startHostSession:after-start-host-capture-process");
  if (callbacks.refresh_host_capture_runtime) {
    callbacks.refresh_host_capture_runtime();
  }
  emit_host_session_breadcrumb("startHostSession:after-refresh-host-capture-runtime");
  if (callbacks.restart_host_capture_surface_attachments) {
    callbacks.restart_host_capture_surface_attachments();
  }
  emit_host_session_breadcrumb("startHostSession:after-restart-surface-attachments");
  attach_host_downstream_media_bindings(state, callbacks);
  emit_host_session_breadcrumb("startHostSession:before-result");

  emit_event(
    "media-state",
    std::string("{\"state\":\"host-session-started\",\"captureTargetId\":\"") +
      json_escape(session.capture_target_id) +
      "\",\"requestedCodec\":\"" + json_escape(session.requested_codec) +
      "\",\"codec\":\"" + json_escape(session.codec) +
      "\",\"effectiveCodec\":\"" + json_escape(session.codec) +
      "\",\"pipeline\":" + host_pipeline_json(session.pipeline) +
      ",\"capturePlan\":" + host_capture_plan_json(session.capture_plan) +
      ",\"captureProcess\":" + host_capture_process_json(session.capture_process) +
      ",\"implementation\":\"native-media-agent\",\"transportReady\":" +
      std::string(callbacks.transport_ready && callbacks.transport_ready() ? "true" : "false") + "}"
  );

  if ((!session.capture_plan.ready || !session.capture_plan.validated) &&
      !session.capture_plan.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"host-capture\",\"message\":\"") +
        json_escape(session.capture_plan.last_error) +
        "\",\"reason\":\"" + json_escape(session.capture_plan.reason) + "\"}"
    );
  }
  if (session.capture_process.enabled &&
      !session.capture_process.running &&
      !session.capture_process.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"host-capture-process\",\"message\":\"") +
        json_escape(session.capture_process.last_error) +
        "\",\"reason\":\"" + json_escape(session.capture_process.reason) + "\"}"
    );
  }
  return ok_result(host_session_json(session, obs_ingest));
}

}  // namespace vds::media_agent
