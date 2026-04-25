#include "surface_control_runtime.h"

#include <memory>
#include <mutex>

#include "agent_events.h"
#include "json_protocol.h"
#include "native_surface_layout.h"
#include "peer_receiver_runtime.h"
#include "surface_attachment_runtime.h"
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

}  // namespace

SurfaceControlCommandResult attach_surface_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  const std::string target = extract_string_value(request_json, "target");
  const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(request_json);
  if (surface.empty()) {
    return error_result("BAD_REQUEST", "surface is required");
  }

  auto existing = state.attached_surfaces.find(surface);
  if (existing != state.attached_surfaces.end()) {
    if (existing->second.peer_runtime) {
      stop_peer_video_surface_attachment(*existing->second.peer_runtime, "surface-reattach");
    } else {
      stop_surface_attachment(existing->second, "surface-reattach");
    }
  }

  SurfaceAttachmentState attachment;
  attachment.surface_id = surface;
  attachment.target = target;
  attachment.surface_layout = layout;
  if (is_peer_video_surface_target(target)) {
    const std::string peer_id = extract_peer_id_from_surface_target(target);
    auto peer_it = state.peers.find(peer_id);
    if (peer_it == state.peers.end()) {
      return error_result("PEER_NOT_FOUND", "Peer has not been created");
    }

    if (!peer_it->second.receiver_runtime) {
      peer_it->second.receiver_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime>();
      peer_it->second.receiver_runtime->peer_id = peer_id;
      peer_it->second.receiver_runtime->local_playback_enabled =
        peer_it->second.role == "viewer-upstream";
    }

    attachment.peer_id = peer_id;
    attachment.peer_runtime = peer_it->second.receiver_runtime;
    {
      std::lock_guard<std::mutex> lock(peer_it->second.receiver_runtime->mutex);
      peer_it->second.receiver_runtime->surface_id = surface;
      peer_it->second.receiver_runtime->target = target;
      peer_it->second.receiver_runtime->surface_layout = layout;
      peer_it->second.receiver_runtime->codec_path =
        peer_it->second.transport.codec_path.empty() ? "h264" : peer_it->second.transport.codec_path;
    }

    std::string surface_error;
    if (!start_peer_video_surface_attachment(state.ffmpeg, *peer_it->second.receiver_runtime, &surface_error)) {
      sync_surface_attachment_from_peer_runtime(attachment, peer_it->second.receiver_runtime);
      attachment.last_error = surface_error;
      attachment.reason = "peer-video-surface-start-failed";
      if (peer_it->second.receiver_runtime) {
        std::lock_guard<std::mutex> lock(peer_it->second.receiver_runtime->mutex);
        peer_it->second.receiver_runtime->last_error = surface_error;
        peer_it->second.receiver_runtime->reason = "peer-video-surface-start-failed";
      }
    } else {
      sync_surface_attachment_from_peer_runtime(attachment, peer_it->second.receiver_runtime);
    }
    update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
  } else {
    attachment = start_surface_attachment(
      state.ffmpeg,
      state.host_capture_plan,
      state.host_capture_process,
      state.host_capture_artifact,
      attachment
    );
  }

  if (!attachment.running) {
    const std::string attach_error = attachment.last_error.empty()
      ? "Native embedded surface failed to start."
      : attachment.last_error;
    if (attachment.peer_runtime) {
      stop_peer_video_surface_attachment(*attachment.peer_runtime, "surface-attach-failed");
      auto peer_it = state.peers.find(attachment.peer_id);
      if (peer_it != state.peers.end()) {
        update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
      }
    } else {
      stop_surface_attachment(attachment, "surface-attach-failed");
    }
    return error_result("SURFACE_ATTACH_FAILED", attach_error);
  }

  state.attached_surfaces[surface] = attachment;
  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-attached\",\"surface\":\"") + json_escape(surface) +
      "\",\"target\":\"" + json_escape(target) +
      "\",\"attachment\":" + surface_attachment_json(state.attached_surfaces[surface]) +
      ",\"implementation\":\"" + json_escape(state.attached_surfaces[surface].implementation) + "\",\"transportReady\":" +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  if (!state.attached_surfaces[surface].running &&
      !state.attached_surfaces[surface].last_error.empty()) {
    emit_event(
      "warning",
      std::string("{\"scope\":\"surface\",\"surface\":\"") + json_escape(surface) +
        "\",\"message\":\"" + json_escape(state.attached_surfaces[surface].last_error) +
        "\",\"reason\":\"" + json_escape(state.attached_surfaces[surface].reason) + "\"}"
    );
  }
  return ok_result(build_surface_result_json(state.attached_surfaces[surface]));
}

SurfaceControlCommandResult update_surface_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(request_json);
  auto attachment = state.attached_surfaces.find(surface);
  if (attachment == state.attached_surfaces.end()) {
    return error_result("SURFACE_NOT_FOUND", "Surface is not attached");
  }

  std::string layout_error;
  if (!update_surface_attachment_layout(attachment->second, layout, &layout_error)) {
    return error_result(
      "SURFACE_UPDATE_FAILED",
      layout_error.empty() ? "surface-update-failed" : layout_error
    );
  }

  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-updated\",\"surface\":\"") + json_escape(surface) +
      "\",\"attachment\":" + surface_attachment_json(attachment->second) +
      ",\"implementation\":\"" + json_escape(attachment->second.implementation) + "\",\"transportReady\":" +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  return ok_result(build_surface_result_json(attachment->second));
}

SurfaceControlCommandResult detach_surface_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const std::string surface = extract_string_value(request_json, "surface");
  auto attachment = state.attached_surfaces.find(surface);
  if (attachment != state.attached_surfaces.end()) {
    if (attachment->second.peer_runtime) {
      stop_peer_video_surface_attachment(*attachment->second.peer_runtime, "surface-detached");
      auto peer_it = state.peers.find(attachment->second.peer_id);
      if (peer_it != state.peers.end()) {
        update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
      }
    } else {
      stop_surface_attachment(attachment->second, "surface-detached");
    }
  }
  emit_event(
    "media-state",
    std::string("{\"state\":\"surface-detached\",\"surface\":\"") + json_escape(surface) +
      "\",\"implementation\":\"stub\",\"transportReady\":" +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
  );
  if (attachment != state.attached_surfaces.end()) {
    state.attached_surfaces.erase(attachment);
  }
  return ok_result(R"json({"detached":true,"implementation":"stub"})json");
}
