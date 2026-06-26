#include "session_owner_activation.h"

#include "json_protocol.h"
#include "runtime_registry.h"

namespace vds::media_agent {

std::string extract_session_owner_id(const std::string& request_json) {
  std::string session_id = extract_string_value(request_json, "mediaSessionId");
  if (session_id.empty()) {
    session_id = extract_string_value(request_json, "sessionId");
  }
  return session_id;
}

void activate_media_owner_sessions_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string session_id = extract_session_owner_id(request_json);
  if (session_id.empty()) {
    return;
  }
  activate_host_session(runtime_state, session_id);
  activate_audio_session(runtime_state, session_id);
  activate_obs_ingest_session(runtime_state, session_id);
}

void activate_audio_owner_session_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json) {
  const std::string session_id = extract_session_owner_id(request_json);
  if (!session_id.empty()) {
    activate_audio_session(runtime_state, session_id);
  }
}

} // namespace vds::media_agent
