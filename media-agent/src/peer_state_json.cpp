#include "peer_state_json.h"

#include <sstream>

#include "json_protocol.h"
#include "peer_session_state.h"
#include "peer_receiver_runtime.h"
#include "peer_transport.h"
#include "relay_hub.h"

std::string build_peer_state_json(const PeerState& peer, const std::string& state) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"state\":\"" << vds::media_agent::json_escape(state) << "\""
    << ",\"sessionPhase\":\"" << vds::media_agent::session_phase_to_string(peer.phase) << "\""
    << ",\"phaseReason\":\"" << vds::media_agent::json_escape(peer.phase_reason) << "\""
    << "}";
  return payload.str();
}

std::string build_peer_result_json(const PeerState& peer) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"sessionPhase\":\"" << vds::media_agent::session_phase_to_string(peer.phase) << "\""
    << ",\"phaseReason\":\"" << vds::media_agent::json_escape(peer.phase_reason) << "\""
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << "}";
  return payload.str();
}

std::string build_peer_ok_json(const PeerState& peer) {
  return std::string("{\"ok\":true,\"implementation\":\"") +
    vds::media_agent::json_escape(peer.transport.transport_ready ? "libdatachannel" : "native-media-agent-no-transport") + "\"}";
}

std::string build_peer_closed_result_json(bool transport_ready) {
  return std::string("{\"closed\":true,\"implementation\":\"") +
    vds::media_agent::json_escape(transport_ready ? "libdatachannel" : "native-media-agent-no-transport") + "\"}";
}

std::string build_peer_stats_json(const PeerState& peer) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << vds::media_agent::json_escape(peer.peer_id) << "\""
    << ",\"role\":\"" << vds::media_agent::json_escape(peer.role) << "\""
    << ",\"sessionPhase\":\"" << vds::media_agent::session_phase_to_string(peer.phase) << "\""
    << ",\"phaseReason\":\"" << vds::media_agent::json_escape(peer.phase_reason) << "\""
    << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
    << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
    << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
    << ",\"relaySubscriberRuntime\":" << relay_hub().subscriber_runtime_json(peer.peer_id)
    << "}";
  return payload.str();
}

std::string peer_media_binding_json(const PeerMediaBindingState& state) {
  std::ostringstream payload;
  payload
    << "{\"sourceFramesCaptured\":" << state.source_frames_captured
    << ",\"avgSourceCopyResourceUs\":" << state.avg_source_copy_resource_us
    << ",\"avgSourceMapUs\":" << state.avg_source_map_us
    << ",\"avgSourceMemcpyUs\":" << state.avg_source_memcpy_us
    << ",\"avgSourceTotalReadbackUs\":" << state.avg_source_total_readback_us
    << ",\"framesSent\":" << state.frames_sent
    << ",\"width\":" << state.width
    << ",\"height\":" << state.height
    << ",\"frameRate\":" << state.frame_rate
    << ",\"bitrateKbps\":" << state.bitrate_kbps
    << ",\"videoEncoderBackend\":\"" << vds::media_agent::json_escape(state.video_encoder_backend) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << "}";
  return payload.str();
}
