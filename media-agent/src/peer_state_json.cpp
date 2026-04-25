#include "peer_state_json.h"

#include <sstream>

#include "json_protocol.h"

std::string peer_media_binding_json(const PeerState::MediaBindingState& state) {
  std::ostringstream payload;
  payload
    << "{\"attached\":" << (state.attached ? "true" : "false")
    << ",\"senderConfigured\":" << (state.sender_configured ? "true" : "false")
    << ",\"active\":" << (state.active ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"sourceFramesCaptured\":" << state.source_frames_captured
    << ",\"sourceBytesCaptured\":" << state.source_bytes_captured
    << ",\"avgSourceCopyResourceUs\":" << state.avg_source_copy_resource_us
    << ",\"avgSourceMapUs\":" << state.avg_source_map_us
    << ",\"avgSourceMemcpyUs\":" << state.avg_source_memcpy_us
    << ",\"avgSourceTotalReadbackUs\":" << state.avg_source_total_readback_us
    << ",\"framesSent\":" << state.frames_sent
    << ",\"bytesSent\":" << state.bytes_sent
    << ",\"width\":" << state.width
    << ",\"height\":" << state.height
    << ",\"frameRate\":" << state.frame_rate
    << ",\"bitrateKbps\":" << state.bitrate_kbps
    << ",\"kind\":\"" << vds::media_agent::json_escape(state.kind) << "\""
    << ",\"source\":\"" << vds::media_agent::json_escape(state.source) << "\""
    << ",\"codec\":\"" << vds::media_agent::json_escape(state.codec) << "\""
    << ",\"codecPath\":\"" << vds::media_agent::json_escape(state.codec) << "\""
    << ",\"videoEncoderBackend\":\"" << vds::media_agent::json_escape(state.video_encoder_backend) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << vds::media_agent::json_escape(state.command_line) << "\""
    << ",\"attachedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.attached_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"detachedAtMs\":";
  vds::media_agent::append_nullable_int64(payload, state.detached_at_unix_ms);
  payload << "}";
  return payload.str();
}
