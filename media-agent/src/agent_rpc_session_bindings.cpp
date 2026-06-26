#include "agent_rpc_session_bindings.h"

#include "peer_session_controller.h"
#include "runtime_registry.h"

ObsIngestSession bind_active_obs_ingest_session(AgentRuntimeState& runtime_state) {
  return ObsIngestSession(
    vds::media_agent::active_obs_ingest_session(runtime_state),
    make_obs_ingest_runtime_access(runtime_state, vds::media_agent::active_host_session(runtime_state)));
}

HostAudioDispatchSession bind_active_host_audio_dispatch(
  AgentRuntimeState& runtime_state,
  vds::media_agent::PeerSessionController& peer_sessions) {
  return HostAudioDispatchSession(
    vds::media_agent::active_audio_session(runtime_state),
    peer_sessions,
    [&runtime_state]() { return vds::media_agent::peer_transport_ready(runtime_state); });
}
