#include "surface_state_json.h"

#include <sstream>

#include "json_protocol.h"
#include "native_surface_layout.h"
#include "surface_attachment_state.h"
#include "surface_attachment_runtime.h"
#include "surface_target.h"

std::string surface_attachment_json(const SurfaceAttachmentState& state) {
  std::ostringstream payload;
  payload
    << "{\"attached\":" << (state.attached ? "true" : "false")
    << ",\"sessionPhase\":\"" << vds::media_agent::session_phase_to_string(state.phase) << "\""
    << ",\"phaseReason\":\"" << vds::media_agent::json_escape(state.phase_reason) << "\""
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"decoderReady\":" << (state.decoder_ready ? "true" : "false")
    << ",\"decodedFramesRendered\":" << state.decoded_frames_rendered
    << ",\"frameIntervalStddevMs\":" << state.frame_interval_stddev_ms
    << ",\"surface\":\"" << vds::media_agent::json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << vds::media_agent::json_escape(state.target) << "\""
    << ",\"processId\":" << state.process_id
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\""
    << ",\"layout\":" << surface_layout_json(state.surface_layout)
    << ",\"windowTitle\":\"" << vds::media_agent::json_escape(state.window_title) << "\""
    << ",\"embeddedParentDebug\":\"" << vds::media_agent::json_escape(state.embedded_parent_debug) << "\""
    << ",\"surfaceWindowDebug\":\"" << vds::media_agent::json_escape(state.surface_window_debug) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(state.last_error) << "\""
    << "}";
  return payload.str();
}

std::string surface_attachment_json(SurfaceAttachmentState& state) {
  if (is_peer_video_surface_target(state.target)) {
    sync_surface_attachment_from_peer_runtime(state, state.peer_runtime);
  } else {
    refresh_surface_attachment_state(state);
  }
  return surface_attachment_json(static_cast<const SurfaceAttachmentState&>(state));
}

std::string build_surface_result_json(SurfaceAttachmentState& state) {
  std::ostringstream payload;
  payload
    << "{\"surface\":\"" << vds::media_agent::json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << vds::media_agent::json_escape(state.target) << "\""
    << ",\"attachment\":" << surface_attachment_json(state)
    << ",\"implementation\":\"" << vds::media_agent::json_escape(state.implementation) << "\"}";
  return payload.str();
}

std::string build_surface_detached_result_json() {
  return R"json({"detached":true,"implementation":"native-media-agent"})json";
}
