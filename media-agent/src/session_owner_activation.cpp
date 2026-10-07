#include "session_owner_activation.h"

#include "audio_session_state.h"
#include "host_session_state.h"
#include "json_protocol.h"
#include "obs_ingest_session_state.h"
#include "runtime_registry.h"

namespace vds::media_agent {
namespace {

bool can_select_media_owner(const AgentRuntimeState& runtime_state, const std::string& session_id) {
  const HostSessionState& host = host_session_snapshot(runtime_state);
  if (session_id != active_host_session_id(runtime_state) &&
      (host.running || host.capture_process.running)) {
    return false;
  }
  const AudioSessionState& audio = audio_session_snapshot(runtime_state);
  if (session_id != active_audio_session_id(runtime_state) && audio.capture_active) {
    return false;
  }
  const ObsIngestState& obs = obs_ingest_session_snapshot(runtime_state);
  std::lock_guard<std::mutex> lock(obs.mutex);
  return session_id == active_obs_ingest_session_id(runtime_state) ||
    (!obs.worker.joinable() && !obs.waiting && !obs.ingest_connected && !obs.stream_running);
}

} // namespace

std::string extract_session_owner_id(const std::string& request_json) {
  std::string session_id = extract_string_value(request_json, "mediaSessionId");
  if (session_id.empty()) {
    session_id = extract_string_value(request_json, "sessionId");
  }
  return session_id;
}

bool activate_media_owner_sessions_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string session_id = extract_session_owner_id(request_json);
  if (session_id.empty()) {
    return true;
  }
  // The capture, WASAPI and OBS relay backends currently share a single owner.
  // Reject a busy switch before creating registry entries or changing any id.
  if (!can_select_media_owner(runtime_state, session_id)) {
    return false;
  }
  activate_host_session(runtime_state, session_id);
  activate_audio_session(runtime_state, session_id);
  activate_obs_ingest_session(runtime_state, session_id);
  return true;
}

bool activate_audio_owner_session_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string session_id = extract_session_owner_id(request_json);
  if (!session_id.empty()) {
    if (!can_select_media_owner(runtime_state, session_id)) {
      return false;
    }
    activate_audio_session(runtime_state, session_id);
  }
  return true;
}

} // namespace vds::media_agent
