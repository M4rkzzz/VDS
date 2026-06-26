#include "runtime_registry.h"

#include "agent_runtime.h"
#include "agent_context.h"
#include "session_lifecycle.h"

namespace vds::media_agent {

PeerState* find_peer(AgentRuntimeState& runtime_state, const std::string& peer_id) {
  if (peer_id.empty()) {
    return nullptr;
  }
  return runtime_state.peer_sessions.find(peer_id);
}

const PeerState* find_peer(const AgentRuntimeState& runtime_state, const std::string& peer_id) {
  if (peer_id.empty()) {
    return nullptr;
  }
  return runtime_state.peer_sessions.find(peer_id);
}

PeerState& ensure_peer(AgentRuntimeState& runtime_state, const std::string& peer_id) {
  PeerState& peer = runtime_state.peer_sessions.ensure(peer_id);
  if (peer.peer_id.empty()) {
    peer.peer_id = peer_id;
  }
  return peer;
}

bool has_peer(const AgentRuntimeState& runtime_state, const std::string& peer_id) {
  return find_peer(runtime_state, peer_id) != nullptr;
}

bool erase_peer(AgentRuntimeState& runtime_state, const std::string& peer_id) {
  return runtime_state.peer_sessions.erase(peer_id);
}

std::size_t peer_count(const AgentRuntimeState& runtime_state) {
  return runtime_state.peer_sessions.count();
}

void for_each_peer(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const PeerState&)>& callback) {
  runtime_state.peer_sessions.for_each(callback);
}

void for_each_mutable_peer(
  AgentRuntimeState& runtime_state,
  const std::function<void(PeerState&)>& callback) {
  runtime_state.peer_sessions.for_each_mutable(callback);
}

void for_each_mutable_peer_with_role(
  AgentRuntimeState& runtime_state,
  const std::string& role,
  const std::function<void(PeerState&)>& callback) {
  runtime_state.peer_sessions.for_each_mutable_with_role(role, callback);
}

SurfaceAttachmentState* find_surface(AgentRuntimeState& runtime_state, const std::string& surface_id) {
  if (surface_id.empty()) {
    return nullptr;
  }
  return runtime_state.surface_sessions.find(surface_id);
}

const SurfaceAttachmentState* find_surface(const AgentRuntimeState& runtime_state, const std::string& surface_id) {
  if (surface_id.empty()) {
    return nullptr;
  }
  return runtime_state.surface_sessions.find(surface_id);
}

SurfaceAttachmentState& ensure_surface(AgentRuntimeState& runtime_state, const std::string& surface_id) {
  SurfaceAttachmentState& surface = runtime_state.surface_sessions.ensure(surface_id);
  if (surface.surface_id.empty()) {
    surface.surface_id = surface_id;
  }
  return surface;
}

bool has_surface(const AgentRuntimeState& runtime_state, const std::string& surface_id) {
  return find_surface(runtime_state, surface_id) != nullptr;
}

bool erase_surface(AgentRuntimeState& runtime_state, const std::string& surface_id) {
  return runtime_state.surface_sessions.erase(surface_id);
}

std::size_t surface_count(const AgentRuntimeState& runtime_state) {
  return runtime_state.surface_sessions.count();
}

void for_each_surface(
  AgentRuntimeState& runtime_state,
  const std::function<void(SurfaceAttachmentState&)>& callback) {
  runtime_state.surface_sessions.for_each(callback);
}

void for_each_surface(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const SurfaceAttachmentState&)>& callback) {
  runtime_state.surface_sessions.for_each(callback);
}

void for_each_surface(
  AgentRuntimeState& runtime_state,
  const std::function<void(const std::string&, SurfaceAttachmentState&)>& callback) {
  runtime_state.surface_sessions.for_each(callback);
}

void for_each_surface(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const std::string&, const SurfaceAttachmentState&)>& callback) {
  runtime_state.surface_sessions.for_each(callback);
}

HostSessionState& active_host_session(AgentRuntimeState& runtime_state) {
  return runtime_state.host_sessions.active_session();
}

const HostSessionState& active_host_session(const AgentRuntimeState& runtime_state) {
  return runtime_state.host_sessions.active_session();
}

AudioSessionState& active_audio_session(AgentRuntimeState& runtime_state) {
  return runtime_state.audio_sessions.active_session();
}

const AudioSessionState& active_audio_session(const AgentRuntimeState& runtime_state) {
  return runtime_state.audio_sessions.active_session();
}

ObsIngestState& active_obs_ingest_session(AgentRuntimeState& runtime_state) {
  return runtime_state.obs_ingest_sessions.active_session();
}

const ObsIngestState& active_obs_ingest_session(const AgentRuntimeState& runtime_state) {
  return runtime_state.obs_ingest_sessions.active_session();
}

const HostSessionState& host_session_snapshot(const AgentRuntimeState& runtime_state) {
  return runtime_state.host_sessions.active_session();
}

const AudioSessionState& audio_session_snapshot(const AgentRuntimeState& runtime_state) {
  return runtime_state.audio_sessions.active_session();
}

const ObsIngestState& obs_ingest_session_snapshot(const AgentRuntimeState& runtime_state) {
  return runtime_state.obs_ingest_sessions.active_session();
}

const std::string& active_host_session_id(const AgentRuntimeState& runtime_state) {
  return runtime_state.host_sessions.active_session_id();
}

const std::string& active_audio_session_id(const AgentRuntimeState& runtime_state) {
  return runtime_state.audio_sessions.active_session_id();
}

const std::string& active_obs_ingest_session_id(const AgentRuntimeState& runtime_state) {
  return runtime_state.obs_ingest_sessions.active_session_id();
}

bool activate_host_session(AgentRuntimeState& runtime_state, const std::string& session_id) {
  return runtime_state.host_sessions.activate_session(session_id);
}

bool activate_audio_session(AgentRuntimeState& runtime_state, const std::string& session_id) {
  return runtime_state.audio_sessions.activate_session(session_id);
}

bool activate_obs_ingest_session(AgentRuntimeState& runtime_state, const std::string& session_id) {
  return runtime_state.obs_ingest_sessions.activate_session(session_id);
}

std::size_t host_session_count(const AgentRuntimeState& runtime_state) {
  return runtime_state.host_sessions.session_count();
}

std::size_t audio_session_count(const AgentRuntimeState& runtime_state) {
  return runtime_state.audio_sessions.session_count();
}

std::size_t obs_ingest_session_count(const AgentRuntimeState& runtime_state) {
  return runtime_state.obs_ingest_sessions.session_count();
}

PeerTransportBackendInfo& peer_transport_backend(AgentRuntimeState& runtime_state) {
  return runtime_state.peer_transport_backend;
}

const PeerTransportBackendInfo& peer_transport_backend(const AgentRuntimeState& runtime_state) {
  return runtime_state.peer_transport_backend;
}

bool peer_transport_ready(const AgentRuntimeState& runtime_state) {
  return peer_transport_backend(runtime_state).transport_ready;
}

FfmpegProbeResult& ffmpeg_probe_result(AgentRuntimeState& runtime_state) {
  return runtime_state.ffmpeg;
}

const FfmpegProbeResult& ffmpeg_probe_result(const AgentRuntimeState& runtime_state) {
  return runtime_state.ffmpeg;
}

WgcCaptureProbe& wgc_capture_backend(AgentRuntimeState& runtime_state) {
  return runtime_state.wgc_capture_backend;
}

const WgcCaptureProbe& wgc_capture_backend(const AgentRuntimeState& runtime_state) {
  return runtime_state.wgc_capture_backend;
}

} // namespace vds::media_agent
