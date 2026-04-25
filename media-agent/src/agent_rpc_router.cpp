#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "agent_rpc_router.h"

#include <iostream>
#include <string>

#include "agent_events.h"
#include "agent_lifecycle.h"
#include "agent_status_json.h"
#include "host_session_controller.h"
#include "json_protocol.h"
#include "media_audio.h"
#include "obs_ingest_runtime.h"
#include "peer_control_runtime.h"
#include "peer_media_binding_runtime.h"
#include "surface_control_runtime.h"
#include "viewer_audio_playback.h"

namespace {

using vds::media_agent::build_error_payload;
using vds::media_agent::build_result_payload;
using vds::media_agent::extract_id;
using vds::media_agent::extract_method;

template <typename CommandResult>
void write_command_result(int id, const CommandResult& result) {
  if (!result.ok) {
    write_json_line(build_error_payload(id, result.error_code, result.error_message));
    return;
  }
  write_json_line(build_result_payload(id, result.result_json));
}

}  // namespace

void run_agent_rpc_loop(AgentRuntimeState& runtime_state) {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    const int id = extract_id(line);
    const std::string method = extract_method(line);
    if (id < 0 || method.empty()) {
      write_json_line(build_error_payload(id < 0 ? 0 : id, "BAD_REQUEST", "Invalid JSON-RPC payload"));
      continue;
    }

    if (method == "ping") {
      write_json_line(build_result_payload(id, R"json({"ok":true,"name":"vds-media-agent","implementation":"stub"})json"));
      continue;
    }

    if (method == "getStatus") {
      write_command_result(id, get_status_result(runtime_state));
      continue;
    }

    if (method == "getCapabilities") {
      write_command_result(id, get_capabilities_result(runtime_state));
      continue;
    }

    if (method == "listCaptureTargets") {
      write_json_line(build_result_payload(id, "[]"));
      continue;
    }

    if (method == "getAudioBackendStatus") {
      write_command_result(id, get_audio_backend_status_result(runtime_state));
      continue;
    }

    if (method == "startAudioSession") {
      write_command_result(id, start_audio_session_from_request(runtime_state, line));
      continue;
    }

    if (method == "prepareObsIngest") {
      write_command_result(id, prepare_obs_ingest_from_request(runtime_state, line));
      continue;
    }

    if (method == "stopAudioSession") {
      write_command_result(id, stop_audio_session_from_request(runtime_state));
      continue;
    }

    if (method == "startHostSession") {
      HostSessionControllerCallbacks callbacks = make_start_host_session_callbacks(runtime_state);
      write_command_result(id, start_host_session_from_request(runtime_state, line, callbacks));
      continue;
    }

    if (method == "stopHostSession") {
      HostSessionControllerCallbacks callbacks = make_stop_host_session_callbacks(runtime_state);
      write_command_result(id, stop_host_session(runtime_state, callbacks));
      continue;
    }

    if (method == "createPeer") {
      write_command_result(id, create_peer_from_request(runtime_state, line));
      continue;
    }

    if (method == "closePeer") {
      write_command_result(id, close_peer_from_request(runtime_state, line));
      continue;
    }

    if (method == "setRemoteDescription") {
      write_command_result(id, set_peer_remote_description_from_request(runtime_state, line));
      continue;
    }

    if (method == "addRemoteIceCandidate") {
      write_command_result(id, add_peer_remote_ice_candidate_from_request(runtime_state, line));
      continue;
    }

    if (method == "attachPeerMediaSource") {
      write_command_result(id, attach_peer_media_source_from_request(runtime_state, line));
      continue;
    }

    if (method == "detachPeerMediaSource") {
      write_command_result(id, detach_peer_media_source_from_request(runtime_state, line));
      continue;
    }

    if (method == "attachSurface") {
      write_command_result(id, attach_surface_from_request(runtime_state, line));
      continue;
    }

    if (method == "updateSurface") {
      write_command_result(id, update_surface_from_request(runtime_state, line));
      continue;
    }

    if (method == "detachSurface") {
      write_command_result(id, detach_surface_from_request(runtime_state, line));
      continue;
    }

    if (method == "setViewerVolume") {
      write_command_result(id, set_viewer_volume_from_request(runtime_state, line));
      continue;
    }

    if (method == "setViewerPlaybackMode") {
      write_command_result(id, set_viewer_playback_mode_from_request(runtime_state, line));
      continue;
    }

    if (method == "setViewerAudioDelay") {
      write_command_result(id, set_viewer_audio_delay_from_request(runtime_state, line));
      continue;
    }

    if (method == "getViewerVolume") {
      write_command_result(id, get_viewer_volume_from_request(runtime_state, line));
      continue;
    }

    if (method == "getStats") {
      write_command_result(id, get_stats_result(runtime_state));
      continue;
    }

    write_json_line(build_error_payload(id, "NOT_IMPLEMENTED", "Method not implemented in scaffold"));
  }
}
