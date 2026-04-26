#include "agent_status_json.h"

#include <sstream>

#include "ffmpeg_probe.h"
#include "host_capture_process.h"
#include "host_state_json.h"
#include "json_protocol.h"
#include "media_audio.h"
#include "obs_ingest_state.h"
#include "peer_receiver_runtime.h"
#include "peer_state_json.h"
#include "peer_transport.h"
#include "relay_dispatch.h"
#include "surface_attachment_runtime.h"
#include "viewer_audio_playback.h"
#include "wgc_capture.h"

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
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"peerMethods\":[\"createPeer\",\"closePeer\",\"setRemoteDescription\",\"addRemoteIceCandidate\",\"attachPeerMediaSource\",\"detachPeerMediaSource\",\"attachSurface\",\"updateSurface\",\"detachSurface\",\"setViewerVolume\",\"getViewerVolume\",\"getStats\"]"
    << ",\"implementation\":\"scaffold\""
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(state.ffmpeg)
    << "}";
  return payload.str();
}

std::string build_status_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"ready\":true"
    << ",\"state\":\"scaffold\""
    << ",\"implementation\":\"stub\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"hostBackend\":\"" << vds::media_agent::json_escape(state.host_backend) << "\""
    << ",\"peerCount\":" << state.peers.size()
    << ",\"surfaceCount\":" << state.attached_surfaces.size()
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(state.ffmpeg)
    << ",\"message\":\"Native media-agent control plane is running. libdatachannel transport is "
    << (state.peer_transport_backend.transport_ready ? "available" : "not available")
    << ", while native decode/render is still pending before the media plane can be considered ready.\"}";
  return payload.str();
}

std::string build_agent_ready_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_NAME) << "\""
    << ",\"version\":\"" << vds::media_agent::json_escape(VDS_MEDIA_AGENT_VERSION) << "\""
    << ",\"implementation\":\"stub\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(state.ffmpeg)
    << "}";
  return payload.str();
}

std::string build_peer_state_json(const PeerState& peer, const std::string& state) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"role\":\"" << vds::media_agent::json_escape(peer.role) << "\""
    << ",\"initiator\":" << (peer.initiator ? "true" : "false")
    << ",\"state\":\"" << vds::media_agent::json_escape(state) << "\""
    << ",\"mediaSessionId\":\"" << vds::media_agent::json_escape(peer.media_session_id) << "\""
    << ",\"mediaManifestVersion\":" << peer.media_manifest_version
    << ",\"expectedVideoCodec\":\"" << vds::media_agent::json_escape(peer.expected_video_codec) << "\""
    << ",\"expectedAudioCodec\":\"" << vds::media_agent::json_escape(peer.expected_audio_codec) << "\""
    << ",\"driver\":\"" << vds::media_agent::json_escape(peer.transport.transport_ready ? "libdatachannel-native-webrtc" : "stub-native-media-agent") << "\""
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
    << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
    << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
    << ",\"relaySubscriberRuntime\":" << relay_subscriber_runtime_json(peer.peer_id)
    << "}";
  return payload.str();
}

std::string build_host_session_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"running\":" << (state.host_session_running ? "true" : "false")
    << ",\"backend\":\"" << vds::media_agent::json_escape(state.host_backend) << "\""
    << ",\"captureTargetId\":\"" << vds::media_agent::json_escape(state.host_capture_target_id) << "\""
    << ",\"requestedCodec\":\"" << vds::media_agent::json_escape(state.host_requested_codec) << "\""
    << ",\"codec\":\"" << vds::media_agent::json_escape(state.host_codec) << "\""
    << ",\"effectiveCodec\":\"" << vds::media_agent::json_escape(state.host_codec) << "\""
    << ",\"downgradeReason\":\"\""
    << ",\"pipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"capturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"captureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"captureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"implementation\":\"stub\"}";
  return payload.str();
}

std::string build_peer_result_json(const PeerState& peer) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"role\":\"" << vds::media_agent::json_escape(peer.role) << "\""
    << ",\"initiator\":" << (peer.initiator ? "true" : "false")
    << ",\"mediaSessionId\":\"" << vds::media_agent::json_escape(peer.media_session_id) << "\""
    << ",\"mediaManifestVersion\":" << peer.media_manifest_version
    << ",\"expectedVideoCodec\":\"" << vds::media_agent::json_escape(peer.expected_video_codec) << "\""
    << ",\"expectedAudioCodec\":\"" << vds::media_agent::json_escape(peer.expected_audio_codec) << "\""
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << ",\"implementation\":\"" << vds::media_agent::json_escape(peer.transport.transport_ready ? "libdatachannel" : "stub") << "\""
    << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
    << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
    << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
    << "}";
  return payload.str();
}

std::string build_stats_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"implementation\":\"stub\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"ffmpeg\":" << vds::media_agent::ffmpeg_probe_json(state.ffmpeg)
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
      << ",\"initiator\":" << (peer.initiator ? "true" : "false")
      << ",\"remoteDescription\":" << (peer.has_remote_description ? "true" : "false")
      << ",\"remoteCandidateCount\":" << peer.remote_candidate_count
      << ",\"mediaSessionId\":\"" << vds::media_agent::json_escape(peer.media_session_id) << "\""
      << ",\"mediaManifestVersion\":" << peer.media_manifest_version
      << ",\"expectedVideoCodec\":\"" << vds::media_agent::json_escape(peer.expected_video_codec) << "\""
      << ",\"expectedAudioCodec\":\"" << vds::media_agent::json_escape(peer.expected_audio_codec) << "\""
      << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
      << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
      << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
      << ",\"relaySubscriberRuntime\":" << relay_subscriber_runtime_json(peer.peer_id)
      << "}";
  }

  payload << "]}";
  return payload.str();
}
