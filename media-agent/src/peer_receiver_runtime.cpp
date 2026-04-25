#include "peer_receiver_runtime.h"

#include <mutex>
#include <sstream>

#include "json_protocol.h"
#include "media_audio.h"
#include "native_video_surface.h"
#include "peer_transport.h"

void begin_close_peer_video_receiver_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.closing = true;
  runtime.pending_video_annexb_bytes.clear();
  runtime.startup_video_decoder_config_au.clear();
  runtime.reason = "peer-closing";
}

void close_peer_video_receiver_handles(PeerState::PeerVideoReceiverRuntime& runtime) {
  begin_close_peer_video_receiver_runtime(runtime);
  reset_peer_audio_decoder_runtime(runtime);
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.surface_attached = false;
  runtime.process_id = 0;
}

void refresh_peer_video_receiver_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = runtime.surface;
  }

  if (!surface) {
    return;
  }

  const NativeVideoSurfaceSnapshot snapshot = surface->snapshot();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.surface_attached = snapshot.attached;
  runtime.launch_attempted = snapshot.launch_attempted;
  runtime.running = snapshot.running;
  runtime.decoder_ready = snapshot.decoder_ready;
  runtime.process_id = snapshot.process_id;
  runtime.decoded_frames_rendered = snapshot.decoded_frames_rendered;
  runtime.frame_interval_stddev_ms = snapshot.frame_interval_stddev_ms;
  runtime.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
  runtime.codec_path = snapshot.codec_path;
  runtime.preview_surface_backend = snapshot.preview_surface_backend;
  runtime.decoder_backend = snapshot.decoder_backend;
  runtime.implementation = snapshot.implementation;
  runtime.window_title = snapshot.window_title;
  runtime.embedded_parent_debug = snapshot.embedded_parent_debug;
  runtime.surface_window_debug = snapshot.surface_window_debug;
  runtime.reason = snapshot.reason;
  runtime.last_error = snapshot.last_error;
#ifdef _WIN32
  runtime.thread_id = snapshot.thread_id;
#endif
}

void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime,
  const std::shared_ptr<PeerTransportSession>& transport_session) {
  if (!transport_session || !runtime) {
    return;
  }

  std::lock_guard<std::mutex> lock(runtime->mutex);
  set_peer_transport_decoder_state(
    transport_session,
    runtime->decoder_ready,
    runtime->decoded_frames_rendered,
    runtime->last_decoded_frame_at_unix_ms,
    runtime->decoder_backend,
    nullptr
  );
}

std::string peer_video_receiver_runtime_json(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime) {
  if (!runtime) {
    return "null";
  }

  refresh_peer_video_receiver_runtime(*runtime);
  std::lock_guard<std::mutex> lock(runtime->mutex);

  std::ostringstream payload;
  payload
    << "{\"surfaceAttached\":" << (runtime->surface_attached ? "true" : "false")
    << ",\"running\":" << (runtime->running ? "true" : "false")
    << ",\"decoderReady\":" << (runtime->decoder_ready ? "true" : "false")
    << ",\"remoteFramesReceived\":" << runtime->remote_frames_received
    << ",\"remoteBytesReceived\":" << runtime->remote_bytes_received
    << ",\"scheduledVideoUnits\":" << runtime->scheduled_video_units
    << ",\"scheduledAudioBlocks\":0"
    << ",\"submittedVideoUnits\":" << runtime->submitted_video_units
    << ",\"dispatchedAudioBlocks\":" << runtime->dispatched_audio_blocks
    << ",\"droppedVideoUnits\":" << runtime->dropped_video_units
    << ",\"droppedAudioBlocks\":" << runtime->dropped_audio_blocks
    << ",\"queuedVideoUnits\":0"
    << ",\"queuedAudioBlocks\":0"
    << ",\"avSyncRunning\":false"
    << ",\"avSyncAnchorInitialized\":false"
    << ",\"targetLatencyMs\":0"
    << ",\"lastVideoLatenessMs\":0"
    << ",\"lastAudioLatenessMs\":0"
    << ",\"codecPath\":\"" << vds::media_agent::json_escape(runtime->codec_path) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(runtime->reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(runtime->last_error) << "\""
    << ",\"surface\":\"" << vds::media_agent::json_escape(runtime->surface_id) << "\""
    << ",\"target\":\"" << vds::media_agent::json_escape(runtime->target) << "\""
    << "}";
  return payload.str();
}
