#include "surface_session_controller.h"

#include <memory>
#include <mutex>
#include <vector>

#include "agent_events.h"
#include "host_session_state.h"
#include "json_protocol.h"
#include "native_surface_layout.h"
#include "peer_receiver_runtime.h"
#include "peer_session_state.h"
#include "runtime_registry.h"
#include "surface_attachment_runtime.h"
#include "surface_attachment_state.h"
#include "surface_state_json.h"
#include "surface_target.h"

namespace {

using vds::media_agent::extract_string_value;
using vds::media_agent::json_escape;

SurfaceControlCommandResult ok_result(std::string result_json) {
  SurfaceControlCommandResult result;
  result.ok = true;
  result.result_json = std::move(result_json);
  return result;
}

SurfaceControlCommandResult error_result(const std::string& code, const std::string& message) {
  SurfaceControlCommandResult result;
  result.ok = false;
  result.error_code = code;
  result.error_message = message;
  return result;
}

void mark_surface_draining(SurfaceAttachmentState& surface, const std::string& reason) {
  surface.phase = vds::media_agent::SessionPhase::Draining;
  surface.phase_reason = reason;
}

void mark_surface_started(SurfaceAttachmentState& surface, const std::string& running_reason) {
  if (surface.running) {
    surface.phase = vds::media_agent::SessionPhase::Running;
    surface.phase_reason = running_reason;
    return;
  }
  if (surface.waiting_for_artifact) {
    surface.phase = vds::media_agent::SessionPhase::Running;
    surface.phase_reason = "surface-waiting-for-artifact";
    return;
  }
  surface.phase = vds::media_agent::SessionPhase::Failed;
  surface.phase_reason = surface.reason.empty() ? "surface-start-failed" : surface.reason;
}

void mark_surface_stopped(SurfaceAttachmentState& surface, const std::string& reason) {
  surface.phase = vds::media_agent::SessionPhase::Stopped;
  surface.phase_reason = reason;
}

}  // namespace

namespace vds::media_agent {

SurfaceSessionController::SurfaceSessionController(AgentRuntimeState& runtime_state)
    : runtime_state_(runtime_state) {}

SurfaceControlCommandResult SurfaceSessionController::attach_from_request(const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  const std::string target = extract_string_value(request_json, "target");
  const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(request_json);
  if (surface.empty()) {
    return error_result("BAD_REQUEST", "surface is required");
  }

  SurfaceAttachmentState* existing = find_surface(runtime_state_, surface);
  if (existing) {
    if (existing->peer_runtime) {
      stop_peer_video_surface_attachment(*existing->peer_runtime, "surface-reattach");
    } else {
      stop_surface_attachment(*existing, "surface-reattach");
    }
  }

  SurfaceAttachmentState attachment;
  attachment.surface_id = surface;
  attachment.target = target;
  attachment.surface_layout = layout;
  attachment.phase = SessionPhase::Configured;
  attachment.phase_reason = "surface-request-configured";
  if (is_peer_video_surface_target(target)) {
    const std::string peer_id = extract_peer_id_from_surface_target(target);
    PeerState* peer = find_peer(runtime_state_, peer_id);
    if (!peer) {
      return error_result("PEER_NOT_FOUND", "Peer has not been created");
    }

    if (!peer->receiver_runtime) {
      peer->receiver_runtime = std::make_shared<PeerVideoReceiverRuntime>();
      peer->receiver_runtime->peer_id = peer_id;
      peer->receiver_runtime->local_playback_enabled = peer->role == "viewer-upstream";
    }

    attachment.peer_id = peer_id;
    attachment.peer_runtime = peer->receiver_runtime;
    {
      std::lock_guard<std::mutex> lock(peer->receiver_runtime->mutex);
      peer->receiver_runtime->surface_id = surface;
      peer->receiver_runtime->target = target;
      peer->receiver_runtime->surface_layout = layout;
      peer->receiver_runtime->codec_path =
        peer->transport.codec_path.empty() ? "h264" : peer->transport.codec_path;
    }

    std::string surface_error;
    attachment.phase = SessionPhase::Starting;
    attachment.phase_reason = "peer-surface-starting";
    if (!start_peer_video_surface_attachment(*peer->receiver_runtime, &surface_error)) {
      sync_surface_attachment_from_peer_runtime(attachment, peer->receiver_runtime);
      attachment.last_error = surface_error;
      attachment.reason = "peer-video-surface-start-failed";
      attachment.phase = SessionPhase::Failed;
      attachment.phase_reason = "peer-video-surface-start-failed";
      if (peer->receiver_runtime) {
        std::lock_guard<std::mutex> lock(peer->receiver_runtime->mutex);
        peer->receiver_runtime->last_error = surface_error;
        peer->receiver_runtime->reason = "peer-video-surface-start-failed";
      }
    } else {
      sync_surface_attachment_from_peer_runtime(attachment, peer->receiver_runtime);
      attachment.phase = SessionPhase::Running;
      attachment.phase_reason = "peer-surface-running";
    }
    update_peer_decoder_state_from_runtime(peer->receiver_runtime, peer->transport_session);
  } else {
    const HostSessionState& host_session = host_session_snapshot(runtime_state_);
    attachment.phase = SessionPhase::Starting;
    attachment.phase_reason = "surface-starting";
    attachment = start_surface_attachment(
      ffmpeg_probe_result(runtime_state_),
      host_session.capture_plan,
      host_session.capture_process,
      host_session.capture_artifact,
      attachment
    );
  }

  if (!attachment.running) {
    if (!attachment.peer_runtime && attachment.waiting_for_artifact) {
      SurfaceAttachmentState& stored_attachment = ensure_surface(runtime_state_, surface);
      stored_attachment = attachment;
      stored_attachment.phase = SessionPhase::Running;
      stored_attachment.phase_reason = "surface-waiting-for-artifact";
      emit_event(
        "media-state",
        std::string("{\"state\":\"surface-attached\",\"surface\":\"") + json_escape(surface) +
          "\",\"target\":\"" + json_escape(target) +
          "\",\"attachment\":" + surface_attachment_json(stored_attachment) +
          ",\"implementation\":\"" + json_escape(stored_attachment.implementation) + "\",\"transportReady\":" +
          std::string(peer_transport_ready(runtime_state_) ? "true" : "false") + "}"
      );
      return ok_result(build_surface_result_json(stored_attachment));
    }
    const std::string attach_error = attachment.last_error.empty()
      ? "Native embedded surface failed to start."
      : attachment.last_error;
    if (attachment.peer_runtime) {
      attachment.phase = SessionPhase::Failed;
      attachment.phase_reason = "surface-attach-failed";
      stop_peer_video_surface_attachment(*attachment.peer_runtime, "surface-attach-failed");
      PeerState* attached_peer = find_peer(runtime_state_, attachment.peer_id);
      if (attached_peer) {
        update_peer_decoder_state_from_runtime(attached_peer->receiver_runtime, attached_peer->transport_session);
      }
    } else {
      attachment.phase = SessionPhase::Failed;
      attachment.phase_reason = "surface-attach-failed";
      stop_surface_attachment(attachment, "surface-attach-failed");
    }
    return error_result("SURFACE_ATTACH_FAILED", attach_error);
  }

  SurfaceAttachmentState& stored_attachment = ensure_surface(runtime_state_, surface);
  stored_attachment = attachment;
  stored_attachment.phase = stored_attachment.running ? SessionPhase::Running : SessionPhase::Failed;
  stored_attachment.phase_reason = stored_attachment.running ? "surface-running" : stored_attachment.reason;
  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-attached\",\"surface\":\"") + json_escape(surface) +
      "\",\"target\":\"" + json_escape(target) +
      "\",\"attachment\":" + surface_attachment_json(stored_attachment) +
      ",\"implementation\":\"" + json_escape(stored_attachment.implementation) + "\",\"transportReady\":" +
      std::string(peer_transport_ready(runtime_state_) ? "true" : "false") + "}"
  );
  if (!stored_attachment.running && !stored_attachment.last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"surface\",\"surface\":\"") + json_escape(surface) +
        "\",\"message\":\"" + json_escape(stored_attachment.last_error) +
        "\",\"reason\":\"" + json_escape(stored_attachment.reason) + "\"}"
    );
  }
  return ok_result(build_surface_result_json(stored_attachment));
}

SurfaceControlCommandResult SurfaceSessionController::update_from_request(const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(request_json);
  SurfaceAttachmentState* attachment = find_surface(runtime_state_, surface);
  if (!attachment) {
    return error_result("SURFACE_NOT_FOUND", "Surface is not attached");
  }

  std::string layout_error;
  if (!update_surface_attachment_layout(*attachment, layout, &layout_error)) {
    attachment->phase = SessionPhase::Failed;
    attachment->phase_reason = "surface-update-failed";
    return error_result(
      "SURFACE_UPDATE_FAILED",
      layout_error.empty() ? "surface-update-failed" : layout_error
    );
  }

  attachment->phase = attachment->running ? SessionPhase::Running : SessionPhase::Stopped;
  attachment->phase_reason = attachment->running ? "surface-updated" : attachment->reason;
  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-updated\",\"surface\":\"") + json_escape(surface) +
      "\",\"attachment\":" + surface_attachment_json(*attachment) +
      ",\"implementation\":\"" + json_escape(attachment->implementation) + "\",\"transportReady\":" +
      std::string(peer_transport_ready(runtime_state_) ? "true" : "false") + "}"
  );
  return ok_result(build_surface_result_json(*attachment));
}

SurfaceControlCommandResult SurfaceSessionController::detach_from_request(const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  SurfaceAttachmentState* attachment = find_surface(runtime_state_, surface);
  if (attachment) {
    attachment->phase = SessionPhase::Draining;
    attachment->phase_reason = "surface-detaching";
    if (attachment->peer_runtime) {
      stop_peer_video_surface_attachment(*attachment->peer_runtime, "surface-detached");
      PeerState* peer = find_peer(runtime_state_, attachment->peer_id);
      if (peer) {
        update_peer_decoder_state_from_runtime(peer->receiver_runtime, peer->transport_session);
      }
    } else {
      stop_surface_attachment(*attachment, "surface-detached");
    }
  }
  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-detached\",\"surface\":\"") + json_escape(surface) +
      "\",\"implementation\":\"native-media-agent\",\"transportReady\":" +
      std::string(peer_transport_ready(runtime_state_) ? "true" : "false") + "}"
  );
  if (attachment) {
    attachment->phase = SessionPhase::Stopped;
    attachment->phase_reason = "surface-detached";
    erase_surface(runtime_state_, surface);
  }
  return ok_result(build_surface_detached_result_json());
}

void SurfaceSessionController::refresh_host_capture_surfaces() {
  const HostSessionState& host_session = host_session_snapshot(runtime_state_);
  for_each_surface(runtime_state_, [&](SurfaceAttachmentState& surface) {
    refresh_surface_attachment_state(surface);
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      return;
    }

    const bool should_wait_for_artifact =
      host_session.running &&
      !surface.running &&
      surface.waiting_for_artifact &&
      host_session.capture_artifact.ready;
    const bool should_restart_exited_surface =
      host_session.running &&
      !surface.running &&
      !surface.waiting_for_artifact &&
      host_session.capture_artifact.ready &&
      (surface.reason == "surface-process-exited" ||
        surface.reason == "artifact-preview-stopped");

    if (!should_wait_for_artifact && !should_restart_exited_surface) {
      return;
    }

    if (surface.running) {
      mark_surface_draining(surface, "surface-auto-restart");
      stop_surface_attachment(surface, "surface-auto-restart");
    }
    surface.phase = SessionPhase::Starting;
    surface.phase_reason = "surface-auto-restart-starting";
    surface = start_surface_attachment(
      ffmpeg_probe_result(runtime_state_),
      host_session.capture_plan,
      host_session.capture_process,
      host_session.capture_artifact,
      surface
    );
    mark_surface_started(surface, "surface-auto-restarted");
  });
}

void SurfaceSessionController::stop_all(const std::string& reason) {
  for_each_surface(runtime_state_, [&](SurfaceAttachmentState& surface) {
    mark_surface_draining(surface, reason);
    if (surface.peer_runtime) {
      stop_peer_video_surface_attachment(*surface.peer_runtime, reason);
    } else {
      stop_surface_attachment(surface, reason);
    }
    mark_surface_stopped(surface, reason);
  });
}

void SurfaceSessionController::restart_host_capture_surfaces() {
  const HostSessionState& host_session = host_session_snapshot(runtime_state_);
  for_each_surface(runtime_state_, [&](SurfaceAttachmentState& surface) {
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      return;
    }
    mark_surface_draining(surface, "host-capture-surface-restart");
    stop_surface_attachment(surface, "host-capture-surface-restart");
    surface.phase = SessionPhase::Starting;
    surface.phase_reason = "host-capture-surface-restart-starting";
    surface = start_surface_attachment(
      ffmpeg_probe_result(runtime_state_),
      host_session.capture_plan,
      host_session.capture_process,
      host_session.capture_artifact,
      surface
    );
    mark_surface_started(surface, "host-capture-surface-restarted");
  });
}

void SurfaceSessionController::detach_peer_surfaces(
  const std::string& peer_id,
  const std::string& reason) {
  std::vector<std::string> detached_surface_ids;
  for_each_surface(runtime_state_, [&](const std::string& surface_id, SurfaceAttachmentState& surface) {
    if (surface.peer_id != peer_id) {
      return;
    }
    mark_surface_draining(surface, reason);
    if (surface.peer_runtime) {
      stop_peer_video_surface_attachment(*surface.peer_runtime, reason);
    } else {
      stop_surface_attachment(surface, reason);
    }
    mark_surface_stopped(surface, reason);
    detached_surface_ids.push_back(surface_id);
  });
  for (const std::string& surface_id : detached_surface_ids) {
    erase_surface(runtime_state_, surface_id);
  }
}

} // namespace vds::media_agent
