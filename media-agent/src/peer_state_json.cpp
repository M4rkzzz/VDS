#include "peer_state_json.h"

#include <sstream>

#include "json_protocol.h"

std::string peer_media_binding_json(const PeerState::MediaBindingState& state) {
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
