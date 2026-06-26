#include "peer_create_request_config.h"

#include <memory>
#include <string>
#include <utility>

#include "agent_diagnostics.h"
#include "json_protocol.h"
#include "peer_media_manifest.h"
#include "peer_video_receiver_state.h"
#include "peer_transport.h"

namespace vds::media_agent {
namespace {

void emit_peer_create_request_breadcrumb(const std::string& step) {
  emit_agent_breadcrumb(step);
}

PeerControlCommandResult error_peer_control_result(const std::string& code, const std::string& message) {
  PeerControlCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

}  // namespace

PeerCreateRequestConfig configure_peer_create_request(
  const PeerTransportBackendInfo& peer_transport,
  const std::string& request_json) {
  PeerCreateRequestConfig config;
  config.encoded_media_data_channel = extract_bool_value(request_json, "encodedMediaDataChannel", true);
  config.peer.peer_id = extract_string_value(request_json, "peerId");
  config.peer.role = extract_string_value(request_json, "role");
  config.peer.initiator = extract_bool_value(request_json, "initiator");

  emit_peer_create_request_breadcrumb(
    std::string("createPeer:begin peer=") + config.peer.peer_id +
    " role=" + config.peer.role +
    " initiator=" + (config.peer.initiator ? "true" : "false"));
  if (config.peer.peer_id.empty()) {
    config.error = error_peer_control_result("BAD_REQUEST", "peerId is required");
    return config;
  }

  config.peer.phase = SessionPhase::Configured;
  config.peer.phase_reason = "peer-request-configured";
  config.peer.transport.transport_ready = peer_transport.transport_ready;
  config.peer.transport.reason = peer_transport.reason;
  config.peer.receiver_runtime = std::make_shared<PeerVideoReceiverRuntime>();
  config.peer.receiver_runtime->peer_id = config.peer.peer_id;
  config.peer.receiver_runtime->local_playback_enabled = config.peer.role == "viewer-upstream";
  apply_media_manifest_to_peer(config.peer, request_json);
  config.ok = true;
  return config;
}

}  // namespace vds::media_agent
