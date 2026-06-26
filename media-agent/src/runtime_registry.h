#pragma once

#include <cstddef>
#include <functional>
#include <string>

struct AgentRuntimeState;
struct AudioSessionState;
struct FfmpegProbeResult;
struct HostSessionState;
struct ObsIngestState;
struct PeerState;
struct PeerTransportBackendInfo;
struct SurfaceAttachmentState;
struct WgcCaptureProbe;

namespace vds::media_agent {

PeerState* find_peer(AgentRuntimeState& runtime_state, const std::string& peer_id);
const PeerState* find_peer(const AgentRuntimeState& runtime_state, const std::string& peer_id);
PeerState& ensure_peer(AgentRuntimeState& runtime_state, const std::string& peer_id);
bool has_peer(const AgentRuntimeState& runtime_state, const std::string& peer_id);
bool erase_peer(AgentRuntimeState& runtime_state, const std::string& peer_id);
std::size_t peer_count(const AgentRuntimeState& runtime_state);
void for_each_peer(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const PeerState&)>& callback);
void for_each_mutable_peer(
  AgentRuntimeState& runtime_state,
  const std::function<void(PeerState&)>& callback);
void for_each_mutable_peer_with_role(
  AgentRuntimeState& runtime_state,
  const std::string& role,
  const std::function<void(PeerState&)>& callback);

SurfaceAttachmentState* find_surface(AgentRuntimeState& runtime_state, const std::string& surface_id);
const SurfaceAttachmentState* find_surface(const AgentRuntimeState& runtime_state, const std::string& surface_id);
SurfaceAttachmentState& ensure_surface(AgentRuntimeState& runtime_state, const std::string& surface_id);
bool has_surface(const AgentRuntimeState& runtime_state, const std::string& surface_id);
bool erase_surface(AgentRuntimeState& runtime_state, const std::string& surface_id);
std::size_t surface_count(const AgentRuntimeState& runtime_state);
void for_each_surface(
  AgentRuntimeState& runtime_state,
  const std::function<void(SurfaceAttachmentState&)>& callback);
void for_each_surface(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const SurfaceAttachmentState&)>& callback);
void for_each_surface(
  AgentRuntimeState& runtime_state,
  const std::function<void(const std::string&, SurfaceAttachmentState&)>& callback);
void for_each_surface(
  const AgentRuntimeState& runtime_state,
  const std::function<void(const std::string&, const SurfaceAttachmentState&)>& callback);

HostSessionState& active_host_session(AgentRuntimeState& runtime_state);
const HostSessionState& active_host_session(const AgentRuntimeState& runtime_state);
AudioSessionState& active_audio_session(AgentRuntimeState& runtime_state);
const AudioSessionState& active_audio_session(const AgentRuntimeState& runtime_state);
ObsIngestState& active_obs_ingest_session(AgentRuntimeState& runtime_state);
const ObsIngestState& active_obs_ingest_session(const AgentRuntimeState& runtime_state);
const HostSessionState& host_session_snapshot(const AgentRuntimeState& runtime_state);
const AudioSessionState& audio_session_snapshot(const AgentRuntimeState& runtime_state);
const ObsIngestState& obs_ingest_session_snapshot(const AgentRuntimeState& runtime_state);
const std::string& active_host_session_id(const AgentRuntimeState& runtime_state);
const std::string& active_audio_session_id(const AgentRuntimeState& runtime_state);
const std::string& active_obs_ingest_session_id(const AgentRuntimeState& runtime_state);
bool activate_host_session(AgentRuntimeState& runtime_state, const std::string& session_id);
bool activate_audio_session(AgentRuntimeState& runtime_state, const std::string& session_id);
bool activate_obs_ingest_session(AgentRuntimeState& runtime_state, const std::string& session_id);
std::size_t host_session_count(const AgentRuntimeState& runtime_state);
std::size_t audio_session_count(const AgentRuntimeState& runtime_state);
std::size_t obs_ingest_session_count(const AgentRuntimeState& runtime_state);

PeerTransportBackendInfo& peer_transport_backend(AgentRuntimeState& runtime_state);
const PeerTransportBackendInfo& peer_transport_backend(const AgentRuntimeState& runtime_state);
bool peer_transport_ready(const AgentRuntimeState& runtime_state);
FfmpegProbeResult& ffmpeg_probe_result(AgentRuntimeState& runtime_state);
const FfmpegProbeResult& ffmpeg_probe_result(const AgentRuntimeState& runtime_state);
WgcCaptureProbe& wgc_capture_backend(AgentRuntimeState& runtime_state);
const WgcCaptureProbe& wgc_capture_backend(const AgentRuntimeState& runtime_state);

} // namespace vds::media_agent
