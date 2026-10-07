#include "peer_receiver_runtime.h"

#include <mutex>
#include <sstream>

#include "json_protocol.h"
#include "media_audio.h"
#include "native_video_surface.h"
#include "peer_transport.h"
#include "viewer_audio_playback.h"

void begin_close_peer_video_receiver_runtime(PeerVideoReceiverRuntime& runtime) {
  std::string source_id;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.closing = true;
    runtime.pending_video_annexb_bytes.clear();
    runtime.startup_video_decoder_config_au.clear();
    runtime.on_keyframe_needed = {};
    runtime.reason = "peer-closing";
    source_id = runtime.peer_id + "/" + runtime.source_generation;
  }
  // Joining the playback worker must happen outside the receiver lock: its
  // final decode callback may still be finishing against this receiver.
  stop_viewer_audio_playback_source(source_id);
  stop_viewer_audio_playback_source(source_id + "/rtp-audio");
}

void close_peer_video_receiver_handles(PeerVideoReceiverRuntime& runtime) {
  begin_close_peer_video_receiver_runtime(runtime);
  reset_peer_audio_decoder_runtime(runtime);
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.surface_attached = false;
  runtime.process_id = 0;
}

void refresh_peer_video_receiver_runtime(PeerVideoReceiverRuntime& runtime) {
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
  runtime.running = snapshot.running;
  runtime.decoder_ready = snapshot.decoder_ready;
  runtime.process_id = snapshot.process_id;
  runtime.decoded_frames_rendered = snapshot.decoded_frames_rendered;
  runtime.decoded_frames = snapshot.decoded_frames;
  runtime.painted_frames = snapshot.painted_frames;
  runtime.dropped_decoded_frames = snapshot.dropped_decoded_frames;
  runtime.dropped_encoded_frames = snapshot.dropped_encoded_frames;
  runtime.reference_chain_resets = snapshot.reference_chain_resets;
  runtime.decode_late_frames = snapshot.decode_late_frames;
  runtime.presentation_late_frames = snapshot.presentation_late_frames;
  runtime.max_decode_lateness_ms = snapshot.max_decode_lateness_ms;
  runtime.max_presentation_lateness_ms = snapshot.max_presentation_lateness_ms;
  runtime.pending_decoded_frames = snapshot.pending_decoded_frames;
  runtime.pending_encoded_frames = snapshot.pending_encoded_frames;
  runtime.buffer_delay_ms = snapshot.buffer_delay_ms;
  runtime.needs_keyframe = snapshot.needs_keyframe;
  runtime.frame_interval_stddev_ms = snapshot.frame_interval_stddev_ms;
  runtime.codec_path = snapshot.codec_path;
  runtime.implementation = snapshot.implementation;
  runtime.window_title = snapshot.window_title;
  runtime.embedded_parent_debug = snapshot.embedded_parent_debug;
  runtime.surface_window_debug = snapshot.surface_window_debug;
  runtime.reason = snapshot.reason;
  runtime.last_error = snapshot.last_error;
}

void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime,
  const std::shared_ptr<PeerTransportSession>& transport_session) {
  if (!transport_session || !runtime) {
    return;
  }

  std::lock_guard<std::mutex> lock(runtime->mutex);
  set_peer_transport_decoder_state(
    transport_session,
    runtime->decoder_ready,
    runtime->decoded_frames_rendered,
    nullptr
  );
}

std::string peer_video_receiver_runtime_json(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime) {
  if (!runtime) {
    return "null";
  }

  refresh_peer_video_receiver_runtime(*runtime);
  std::lock_guard<std::mutex> lock(runtime->mutex);

  std::ostringstream payload;
  payload
    << "{\"submittedVideoUnits\":" << runtime->submitted_video_units
    << ",\"dispatchedAudioBlocks\":" << runtime->dispatched_audio_blocks
    << ",\"droppedVideoUnits\":" << runtime->dropped_video_units
    << ",\"droppedAudioBlocks\":" << runtime->dropped_audio_blocks
    << ",\"decodedFrames\":" << runtime->decoded_frames
    << ",\"paintedFrames\":" << runtime->painted_frames
    << ",\"droppedDecodedFrames\":" << runtime->dropped_decoded_frames
    << ",\"droppedEncodedFrames\":" << runtime->dropped_encoded_frames
    << ",\"referenceChainResets\":" << runtime->reference_chain_resets
    << ",\"decodeLateFrames\":" << runtime->decode_late_frames
    << ",\"presentationLateFrames\":" << runtime->presentation_late_frames
    << ",\"maxDecodeLatenessMs\":" << runtime->max_decode_lateness_ms
    << ",\"maxPresentationLatenessMs\":" << runtime->max_presentation_lateness_ms
    << ",\"pendingDecodedFrames\":" << runtime->pending_decoded_frames
    << ",\"pendingEncodedFrames\":" << runtime->pending_encoded_frames
    << ",\"bufferDelayMs\":" << runtime->buffer_delay_ms
    << ",\"needsKeyframe\":" << (runtime->needs_keyframe ? "true" : "false")
    << ",\"retiredEpochFramesDropped\":" << runtime->retired_epoch_frames_dropped
    << ",\"sourceEpoch\":\"" << vds::media_agent::json_escape(runtime->source_epochs.current()) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(runtime->reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(runtime->last_error) << "\""
    << "}";
  return payload.str();
}
