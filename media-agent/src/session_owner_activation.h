#pragma once

#include <string>

struct AgentRuntimeState;

namespace vds::media_agent {

std::string extract_session_owner_id(const std::string& request_json);
void activate_media_owner_sessions_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json);
void activate_audio_owner_session_from_request(
  AgentRuntimeState& runtime_state,
  const std::string& request_json);

} // namespace vds::media_agent
