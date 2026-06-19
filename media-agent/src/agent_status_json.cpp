#include "agent_status_json.h"

#include <sstream>

#include "agent_runtime.h"
#include "ffmpeg_probe.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "media_audio.h"
#include "obs_ingest_state.h"
#include "peer_receiver_runtime.h"
#include "peer_state_json.h"
#include "peer_transport.h"
#include "relay_dispatch.h"
#include "surface_attachment_runtime.h"

std::string capabilities_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"platform\":\"win32\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"videoCodecs\":[\"h264\",\"h265\"]"
    << ",\"audioCodecs\":[\"opus\",\"pcmu\",\"aac\"]"
    << ",\"hostBackends\":[\"native\",\"obs-ingest\"]"
    << ",\"captureModes\":[\"window\",\"display\"]"
    << ",\"audioModes\":[\"process\",\"none\"]"
    << ",\"surfaceTargets\":[\"host-capture-artifact\",\"peer-video:<peerId>\"]"
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"peerMethods\":[\"createPeer\",\"closePeer\",\"setRemoteDescription\",\"addRemoteIceCandidate\",\"attachPeerMediaSource\",\"detachPeerMediaSource\",\"attachSurface\",\"updateSurface\",\"detachSurface\",\"setViewerVolume\",\"getViewerVolume\",\"getStats\"]"
    << ",\"implementation\":\"native-media-agent\""
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(state.ffmpeg)
    << "}";
  return payload.str();
}

std::string build_status_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"ready\":true"
    << ",\"state\":\"running\""
    << ",\"implementation\":\"native-media-agent\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"hostBackend\":\"" << vds::media_agent::json_escape(state.host_backend) << "\""
    << ",\"peerCount\":" << state.peers.size()
    << ",\"surfaceCount\":" << state.attached_surfaces.size()
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"message\":\"Native media-agent control plane is running. libdatachannel transport is "
    << (state.peer_transport_backend.transport_ready ? "available" : "not available")
    << ".\"}";
  return payload.str();
}

std::string build_agent_ready_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_NAME) << "\""
    << ",\"version\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_VERSION) << "\""
    << ",\"implementation\":\"native-media-agent\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << "}";
  return payload.str();
}

std::string build_peer_state_json(const PeerState& peer, const std::string& state) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"state\":\"" << vds::media_agent::json_escape(state) << "\""
    << "}";
  return payload.str();
}

std::string build_host_session_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"running\":" << (state.host_session_running ? "true" : "false")
    << ",\"backend\":\"" << vds::media_agent::json_escape(state.host_backend) << "\""
    << ",\"requestedCodec\":\"" << vds::media_agent::json_escape(state.host_requested_codec) << "\""
    << ",\"codec\":\"" << vds::media_agent::json_escape(state.host_codec) << "\""
    << ",\"effectiveCodec\":\"" << vds::media_agent::json_escape(state.host_codec) << "\""
    << ",\"pipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"capturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << "}";
  return payload.str();
}

std::string build_peer_result_json(const PeerState& peer) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << "}";
  return payload.str();
}

std::string build_stats_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"peers\":[";

  bool first = true;
  for (const auto& entry : state.peers) {
    if (!first) {
      payload << ",";
    }
    first = false;

    const PeerState& peer = entry.second;
    payload
      << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
      << ",\"role\":\"" << vds::media_agent::json_escape(peer.role) << "\""
      << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
      << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
      << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
      << ",\"relaySubscriberRuntime\":" << relay_subscriber_runtime_json(peer.peer_id)
      << "}";
  }

  payload << "]}";
  return payload.str();
}
