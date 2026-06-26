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
#include "agent_rpc_session_bindings.h"
#include "agent_status_json.h"
#include "host_audio_dispatch_session.h"
#include "host_session_controller.h"
#include "json_protocol.h"
#include "obs_ingest_session.h"
#include "peer_session_controller.h"
#include "runtime_registry.h"
#include "session_owner_activation.h"
#include "surface_session_controller.h"
#include "viewer_audio_session.h"

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
  vds::media_agent::PeerSessionController peer_sessions(runtime_state);
  vds::media_agent::SurfaceSessionController surface_sessions(runtime_state);
  ViewerAudioSession viewer_audio;
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
      write_json_line(build_result_payload(id, R"json({"ok":true,"name":"vds-media-agent","implementation":"native-media-agent"})json"));
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

    if (method == "startAudioSession") {
      vds::media_agent::activate_audio_owner_session_from_request(runtime_state, line);
      HostAudioDispatchSession host_audio_dispatch = bind_active_host_audio_dispatch(runtime_state, peer_sessions);
      write_command_result(id, host_audio_dispatch.start_from_request(line));
      continue;
    }

    if (method == "prepareObsIngest") {
      vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line);
      ObsIngestSession obs_ingest = bind_active_obs_ingest_session(runtime_state);
      write_command_result(id, obs_ingest.prepare_from_request(line));
      continue;
    }

    if (method == "stopAudioSession") {
      vds::media_agent::activate_audio_owner_session_from_request(runtime_state, line);
      HostAudioDispatchSession host_audio_dispatch = bind_active_host_audio_dispatch(runtime_state, peer_sessions);
      write_command_result(id, host_audio_dispatch.stop_from_request());
      continue;
    }

    if (method == "startHostSession") {
      vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line);
      HostSessionController host_sessions(runtime_state);
      HostSessionControllerCallbacks callbacks = make_start_host_session_callbacks(runtime_state);
      write_command_result(id, host_sessions.start_from_request(line, callbacks));
      continue;
    }

    if (method == "stopHostSession") {
      vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line);
      HostSessionController host_sessions(runtime_state);
      HostSessionControllerCallbacks callbacks = make_stop_host_session_callbacks(runtime_state);
      write_command_result(id, host_sessions.stop(callbacks));
      continue;
    }

    if (method == "createPeer") {
      write_command_result(id, peer_sessions.create_from_request(line));
      continue;
    }

    if (method == "closePeer") {
      write_command_result(id, peer_sessions.close_from_request(line));
      continue;
    }

    if (method == "setRemoteDescription") {
      write_command_result(id, peer_sessions.set_remote_description_from_request(line));
      continue;
    }

    if (method == "addRemoteIceCandidate") {
      write_command_result(id, peer_sessions.add_remote_ice_candidate_from_request(line));
      continue;
    }

    if (method == "attachPeerMediaSource") {
      write_command_result(id, peer_sessions.attach_media_source_from_request(line));
      continue;
    }

    if (method == "detachPeerMediaSource") {
      write_command_result(id, peer_sessions.detach_media_source_from_request(line));
      continue;
    }

    if (method == "attachSurface") {
      write_command_result(id, surface_sessions.attach_from_request(line));
      continue;
    }

    if (method == "updateSurface") {
      write_command_result(id, surface_sessions.update_from_request(line));
      continue;
    }

    if (method == "detachSurface") {
      write_command_result(id, surface_sessions.detach_from_request(line));
      continue;
    }

    if (method == "setViewerVolume") {
      write_command_result(id, viewer_audio.set_volume_from_request(line));
      continue;
    }

    if (method == "setViewerAudioDelay") {
      write_command_result(id, viewer_audio.set_delay_from_request(line));
      continue;
    }

    if (method == "getViewerVolume") {
      write_command_result(id, viewer_audio.get_volume_from_request(line));
      continue;
    }

    if (method == "getStats") {
      write_command_result(id, get_stats_result(runtime_state));
      continue;
    }

    write_json_line(build_error_payload(id, "NOT_IMPLEMENTED", "Method is not implemented by this media-agent build"));
  }
}
