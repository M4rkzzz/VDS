#include "agent_lifecycle.h"

#include <string>

#include "agent_status_json.h"
#include "ffmpeg_probe.h"
#include "ffmpeg_probe_state.h"
#include "host_audio_dispatch_session.h"
#include "host_session_controller.h"
#include "host_session_state.h"
#include "host_session_runtime.h"
#include "obs_ingest_session.h"
#include "peer_host_source_binding.h"
#include "peer_media_detach_binding.h"
#include "peer_session_controller.h"
#include "relay_hub.h"
#include "peer_transport.h"
#include "runtime_registry.h"
#include "surface_session_controller.h"
#include "string_utils.h"
#include "viewer_audio_session.h"
#include "wasapi_backend.h"
#include "wgc_capture.h"

namespace {

struct AgentLifecycleSessions {
  explicit AgentLifecycleSessions(AgentRuntimeState& runtime_state)
      : state(runtime_state),
        host(vds::media_agent::active_host_session(runtime_state)),
        audio(vds::media_agent::active_audio_session(runtime_state)),
        obs(vds::media_agent::active_obs_ingest_session(runtime_state)),
        peer_sessions(runtime_state),
        surface_sessions(runtime_state),
        host_audio(audio, peer_sessions, [&runtime_state]() {
          return vds::media_agent::peer_transport_ready(runtime_state);
        }) {}

  AgentRuntimeState& state;
  HostSessionState& host;
  AudioSessionState& audio;
  ObsIngestState& obs;
  vds::media_agent::PeerSessionController peer_sessions;
  vds::media_agent::SurfaceSessionController surface_sessions;
  HostAudioDispatchSession host_audio;
};

void refresh_host_capture_runtime(AgentLifecycleSessions& sessions) {
  vds::media_agent::refresh_host_capture_runtime(sessions.state, sessions.host);
  sessions.surface_sessions.refresh_host_capture_surfaces();
}

void stop_all_surface_attachments(AgentLifecycleSessions& sessions, const std::string& reason) {
  sessions.surface_sessions.stop_all(reason);
}

void restart_host_capture_surface_attachments(AgentLifecycleSessions& sessions) {
  sessions.surface_sessions.restart_host_capture_surfaces();
}

} // namespace

void refresh_host_capture_runtime(AgentRuntimeState& state) {
  AgentLifecycleSessions sessions(state);
  refresh_host_capture_runtime(sessions);
}

void refresh_agent_runtime_state(AgentRuntimeState& state) {
  AgentLifecycleSessions sessions(state);
  sessions.host_audio.refresh_session_status();
  refresh_host_capture_runtime(sessions);
  sessions.peer_sessions.refresh_transport_runtime();
  sessions.peer_sessions.perform_host_video_sender_soft_refresh();
  sessions.peer_sessions.refresh_transport_runtime();
}

void initialize_agent_runtime(AgentRuntimeState& state, const std::string& agent_binary_path) {
  AgentLifecycleSessions sessions(state);
  sessions.host_audio.attach_wasapi_callbacks();
  vds::media_agent::peer_transport_backend(state) = get_peer_transport_backend_info();
  vds::media_agent::ffmpeg_probe_result(state) = vds::media_agent::probe_ffmpeg(agent_binary_path);
  vds::media_agent::wgc_capture_backend(state) = probe_wgc_capture_backend();
  sessions.host_audio.refresh_session_status();
  vds::media_agent::initialize_default_capture_runtime(state, sessions.host);
  refresh_host_capture_runtime(sessions);
}

void stop_all_surface_attachments(AgentRuntimeState& state, const std::string& reason) {
  AgentLifecycleSessions sessions(state);
  stop_all_surface_attachments(sessions, reason);
}

void restart_host_capture_surface_attachments(AgentRuntimeState& state) {
  AgentLifecycleSessions sessions(state);
  restart_host_capture_surface_attachments(sessions);
}

void shutdown_agent_runtime(AgentRuntimeState& state) {
  AgentLifecycleSessions sessions(state);
  stop_wasapi_process_loopback_session();
  stop_all_surface_attachments(sessions, "agent-shutdown");
  sessions.peer_sessions.close_all_receiver_handles();
  sessions.host_audio.reset_transport_sessions();
  ViewerAudioSession viewer_audio;
  viewer_audio.stop();
  sessions.peer_sessions.close_all_transport_sessions();
  vds::media_agent::stop_obs_ingest_session(state, sessions.host, sessions.obs);
  relay_hub().shutdown_runtime();
  vds::media_agent::stop_host_capture_process(sessions.host, "agent-shutdown");
}

AgentLifecycleCommandResult get_status_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, build_status_json(state), {}, {}};
}

AgentLifecycleCommandResult get_capabilities_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, capabilities_json(state), {}, {}};
}

AgentLifecycleCommandResult get_stats_result(AgentRuntimeState& state) {
  refresh_agent_runtime_state(state);
  return {true, build_stats_json(state), {}, {}};
}

HostSessionControllerCallbacks make_start_host_session_callbacks(AgentRuntimeState& state) {
  HostSessionControllerCallbacks callbacks;
  callbacks.stop_all_surface_attachments = [&state](const std::string& reason) {
    stop_all_surface_attachments(state, reason);
  };
  callbacks.refresh_host_capture_runtime = [&state]() {
    refresh_host_capture_runtime(state);
  };
  callbacks.restart_host_capture_surface_attachments = [&state]() {
    restart_host_capture_surface_attachments(state);
  };
  callbacks.transport_ready = [&state]() {
    return vds::media_agent::peer_transport_ready(state);
  };
  callbacks.attach_host_video_media_binding = [&state](PeerState& peer, std::string* error) {
    const ObsIngestSessionSnapshot obs_ingest =
      make_obs_ingest_session_snapshot(vds::media_agent::obs_ingest_session_snapshot(state));
    return attach_host_video_media_binding(
      HostVideoBindingContext{
        vds::media_agent::host_session_snapshot(state),
        vds::media_agent::ffmpeg_probe_result(state),
        vds::media_agent::audio_session_snapshot(state),
        obs_ingest
      },
      peer,
      error);
  };
  return callbacks;
}

HostSessionControllerCallbacks make_stop_host_session_callbacks(AgentRuntimeState& state) {
  HostSessionControllerCallbacks callbacks;
  callbacks.stop_all_surface_attachments = [&state](const std::string& reason) {
    stop_all_surface_attachments(state, reason);
  };
  callbacks.detach_peer_media_binding = [](PeerState& peer, std::string* error) {
    return detach_peer_media_binding(peer, error);
  };
  callbacks.transport_ready = [&state]() {
    return vds::media_agent::peer_transport_ready(state);
  };
  return callbacks;
}
