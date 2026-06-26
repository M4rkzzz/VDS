#include "agent_status_json.h"

#include <sstream>

#include "audio_state_json.h"
#include "ffmpeg_probe.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "peer_snapshot_aggregator.h"
#include "peer_transport_state.h"
#include "peer_transport_state_json.h"
#include "runtime_registry.h"
#include "surface_snapshot_aggregator.h"

std::string capabilities_json(const AgentRuntimeState& state) {
  const auto& peer_transport = vds::media_agent::peer_transport_backend(state);
  std::ostringstream payload;
  payload
    << "{\"platform\":\"win32\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (peer_transport.transport_ready ? "true" : "false")
    << ",\"videoCodecs\":[\"h264\",\"h265\"]"
    << ",\"audioCodecs\":[\"opus\",\"pcmu\",\"aac\"]"
    << ",\"hostBackends\":[\"native\",\"obs-ingest\"]"
    << ",\"captureModes\":[\"window\",\"display\"]"
    << ",\"audioModes\":[\"process\",\"none\"]"
    << ",\"surfaceTargets\":[\"host-capture-artifact\",\"peer-video:<peerId>\"]"
    << ",\"peerTransport\":" << vds::media_agent::peer_transport_backend_json(peer_transport)
    << ",\"peerMethods\":[\"createPeer\",\"closePeer\",\"setRemoteDescription\",\"addRemoteIceCandidate\",\"attachPeerMediaSource\",\"detachPeerMediaSource\",\"attachSurface\",\"updateSurface\",\"detachSurface\",\"setViewerVolume\",\"getViewerVolume\",\"getStats\"]"
    << ",\"implementation\":\"native-media-agent\""
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(vds::media_agent::ffmpeg_probe_result(state))
    << "}";
  return payload.str();
}

std::string build_status_json(const AgentRuntimeState& state) {
  const auto& peer_transport = vds::media_agent::peer_transport_backend(state);
  std::ostringstream payload;
  payload
    << "{\"ready\":true"
    << ",\"state\":\"running\""
    << ",\"implementation\":\"native-media-agent\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (peer_transport.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",";
  append_host_session_status_json_fields(payload, vds::media_agent::host_session_snapshot(state));
  payload
    << ",\"hostSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_host_session_id(state)) << "\""
    << ",\"audioSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_audio_session_id(state)) << "\""
    << ",\"obsIngestSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_obs_ingest_session_id(state)) << "\""
    << ",\"hostSessionCount\":" << vds::media_agent::host_session_count(state)
    << ",\"audioSessionCount\":" << vds::media_agent::audio_session_count(state)
    << ",\"obsIngestSessionCount\":" << vds::media_agent::obs_ingest_session_count(state)
    << ",\"peerCount\":" << vds::media_agent::peer_session_count(state)
    << ",\"surfaceCount\":" << vds::media_agent::surface_session_count(state)
    << ",\"peerTransport\":" << vds::media_agent::peer_transport_backend_json(peer_transport)
    << ",\"message\":\"Native media-agent control plane is running. libdatachannel transport is "
    << (peer_transport.transport_ready ? "available" : "not available")
    << ".\"}";
  return payload.str();
}

std::string build_agent_ready_json(const AgentRuntimeState& state) {
  const auto& peer_transport = vds::media_agent::peer_transport_backend(state);
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_NAME) << "\""
    << ",\"version\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_VERSION) << "\""
    << ",\"implementation\":\"native-media-agent\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (peer_transport.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"peerTransport\":" << vds::media_agent::peer_transport_backend_json(peer_transport)
    << "}";
  return payload.str();
}

std::string build_stats_json(const AgentRuntimeState& state) {
  std::ostringstream payload;
  payload << "{";
  append_host_session_stats_json_fields(payload, vds::media_agent::host_session_snapshot(state));
  payload
    << ",\"hostSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_host_session_id(state)) << "\""
    << ",\"audioSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_audio_session_id(state)) << "\""
    << ",\"obsIngestSessionId\":\"" << vds::media_agent::json_escape(vds::media_agent::active_obs_ingest_session_id(state)) << "\""
    << ",\"hostSessionCount\":" << vds::media_agent::host_session_count(state)
    << ",\"audioSessionCount\":" << vds::media_agent::audio_session_count(state)
    << ",\"obsIngestSessionCount\":" << vds::media_agent::obs_ingest_session_count(state)
    << ",\"audioBackend\":" << audio_session_json(vds::media_agent::audio_session_snapshot(state))
    << ",\"surfaces\":" << vds::media_agent::surface_session_stats_json(state)
    << ",\"peers\":" << vds::media_agent::peer_session_stats_json(state)
    << "}";
  return payload.str();
}
