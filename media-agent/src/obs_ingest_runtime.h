#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "agent_runtime.h"

inline constexpr const char* kObsIngestVirtualUpstreamPeerId = "__obs_ingest_host__";

struct ObsIngestCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

ObsIngestCommandResult prepare_obs_ingest_from_request(
  AgentRuntimeState& state,
  const std::string& request_json);
bool prepare_obs_ingest_session(AgentRuntimeState& state, bool force_refresh, int requested_port, std::string* error);
void clear_obs_ingest_prepared_session(AgentRuntimeState& state);
bool is_obs_ingest_backend(const AgentRuntimeState& state);
void stop_obs_ingest_runtime(AgentRuntimeState& state, const std::string& reason);
void obs_ingest_worker(AgentRuntimeState* state_ptr);
