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
#include "agent_rpc_boundary.h"
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

template <typename CommandResult>
void write_command_result(int id, const CommandResult& result) {
  if (!result.ok) {
    write_json_line(build_error_payload(id, result.error_code, result.error_message));
    return;
  }
  write_json_line(build_result_payload(id, result.result_json));
}

void write_owner_busy_error(int id) {
  write_json_line(build_error_payload(
    id,
    "MEDIA_SESSION_ACTIVE",
    "Stop the active media session before selecting a different mediaSessionId"));
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

    vds::media_agent::dispatch_agent_rpc_request(line, [&](int id, const std::string& method) {
      if (method == "ping") {
        write_json_line(build_result_payload(id, R"json({"ok":true,"name":"vds-media-agent","implementation":"native-media-agent"})json"));
        return;
      }

      if (method == "getStatus") {
        write_command_result(id, get_status_result(runtime_state));
        return;
      }

      if (method == "getCapabilities") {
        write_command_result(id, get_capabilities_result(runtime_state));
        return;
      }

      if (method == "listCaptureTargets") {
        write_json_line(build_result_payload(id, "[]"));
        return;
      }

      if (method == "startAudioSession") {
        if (!vds::media_agent::activate_audio_owner_session_from_request(runtime_state, line)) {
          write_owner_busy_error(id);
          return;
        }
        HostAudioDispatchSession host_audio_dispatch = bind_active_host_audio_dispatch(runtime_state, peer_sessions);
        write_command_result(id, host_audio_dispatch.start_from_request(line));
        return;
      }

      if (method == "prepareObsIngest") {
        if (!vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line)) {
          write_owner_busy_error(id);
          return;
        }
        ObsIngestSession obs_ingest = bind_active_obs_ingest_session(runtime_state);
        write_command_result(id, obs_ingest.prepare_from_request(line));
        return;
      }

      if (method == "stopAudioSession") {
        if (!vds::media_agent::activate_audio_owner_session_from_request(runtime_state, line)) {
          write_owner_busy_error(id);
          return;
        }
        HostAudioDispatchSession host_audio_dispatch = bind_active_host_audio_dispatch(runtime_state, peer_sessions);
        write_command_result(id, host_audio_dispatch.stop_from_request());
        return;
      }

      if (method == "startHostSession") {
        if (!vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line)) {
          write_owner_busy_error(id);
          return;
        }
        HostSessionController host_sessions(runtime_state);
        HostSessionControllerCallbacks callbacks = make_start_host_session_callbacks(runtime_state);
        write_command_result(id, host_sessions.start_from_request(line, callbacks));
        return;
      }

      if (method == "stopHostSession") {
        if (!vds::media_agent::activate_media_owner_sessions_from_request(runtime_state, line)) {
          write_owner_busy_error(id);
          return;
        }
        HostSessionController host_sessions(runtime_state);
        HostSessionControllerCallbacks callbacks = make_stop_host_session_callbacks(runtime_state);
        write_command_result(id, host_sessions.stop(callbacks));
        return;
      }

      if (method == "createPeer") {
        write_command_result(id, peer_sessions.create_from_request(line));
        return;
      }

      if (method == "closePeer") {
        write_command_result(id, peer_sessions.close_from_request(line));
        return;
      }

      if (method == "setRemoteDescription") {
        write_command_result(id, peer_sessions.set_remote_description_from_request(line));
        return;
      }

      if (method == "addRemoteIceCandidate") {
        write_command_result(id, peer_sessions.add_remote_ice_candidate_from_request(line));
        return;
      }

      if (method == "attachPeerMediaSource") {
        write_command_result(id, peer_sessions.attach_media_source_from_request(line));
        return;
      }

      if (method == "detachPeerMediaSource") {
        write_command_result(id, peer_sessions.detach_media_source_from_request(line));
        return;
      }

      if (method == "attachSurface") {
        write_command_result(id, surface_sessions.attach_from_request(line));
        return;
      }

      if (method == "updateSurface") {
        write_command_result(id, surface_sessions.update_from_request(line));
        return;
      }

      if (method == "detachSurface") {
        write_command_result(id, surface_sessions.detach_from_request(line));
        return;
      }

      if (method == "setViewerVolume") {
        write_command_result(id, viewer_audio.set_volume_from_request(line));
        return;
      }

      if (method == "setViewerAudioDelay") {
        write_command_result(id, viewer_audio.set_delay_from_request(line));
        return;
      }

      if (method == "getViewerVolume") {
        write_command_result(id, viewer_audio.get_volume_from_request(line));
        return;
      }

      if (method == "getStats") {
        write_command_result(id, get_stats_result(runtime_state));
        return;
      }

      write_json_line(build_error_payload(id, "NOT_IMPLEMENTED", "Method is not implemented by this media-agent build"));
    }, [](int id, const std::string& code, const std::string& message) {
      write_json_line(build_error_payload(id, code, message));
    });
  }
}
