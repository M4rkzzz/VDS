#pragma once

#include "host_audio_dispatch_session.h"
#include "obs_ingest_session.h"

struct AgentRuntimeState;

namespace vds::media_agent {
class PeerSessionController;
}

ObsIngestSession bind_active_obs_ingest_session(AgentRuntimeState& runtime_state);
HostAudioDispatchSession bind_active_host_audio_dispatch(
  AgentRuntimeState& runtime_state,
  vds::media_agent::PeerSessionController& peer_sessions);
