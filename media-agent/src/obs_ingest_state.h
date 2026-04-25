#pragma once

#include <string>

#include "agent_runtime.h"

inline constexpr int kDefaultObsIngestPort = 61080;
inline constexpr int kMinObsIngestPort = 1024;
inline constexpr int kMaxObsIngestPort = 65535;

std::string obs_ingest_json(const ObsIngestState& state);
bool is_valid_obs_ingest_port(int port);
int resolve_requested_obs_ingest_port(int requested_port);
std::string build_obs_ingest_publish_url(int port);
std::string build_obs_ingest_listen_url(int port);
