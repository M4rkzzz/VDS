#include "viewer_audio_session.h"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <utility>

#include "json_protocol.h"
#include "media_audio.h"
#include "relay_hub.h"
#include "viewer_audio_playback.h"
#include "wasapi_backend.h"

ViewerAudioCommandResult ViewerAudioSession::set_volume_from_request(const std::string& request_json) {
  const int pid = vds::media_agent::extract_int_value(request_json, "pid", 0);
  const float requested_volume = static_cast<float>(
    vds::media_agent::extract_double_value(request_json, "volume", 1.0));
  if (viewer_audio_playback_is_active()) {
    const float software_volume = set_viewer_audio_software_volume(requested_volume);
    std::ostringstream payload;
    payload
      << "{\"pid\":0"
      << ",\"volume\":" << software_volume
      << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
    return {true, payload.str(), {}, {}};
  }

  float effective_volume = 0.0f;
  std::string volume_error;
  if (!set_wasapi_render_session_volume_for_pid(pid, requested_volume, &effective_volume, &volume_error)) {
    return {false, {}, "VIEWER_VOLUME_SET_FAILED", volume_error};
  }

  std::ostringstream payload;
  payload
    << "{\"pid\":" << pid
    << ",\"volume\":" << effective_volume
    << ",\"implementation\":\"native-wasapi-render-session-volume\"}";
  return {true, payload.str(), {}, {}};
}

ViewerAudioCommandResult ViewerAudioSession::get_volume_from_request(const std::string& request_json) {
  const int pid = vds::media_agent::extract_int_value(request_json, "pid", 0);
  if (viewer_audio_playback_is_active()) {
    std::ostringstream payload;
    payload
      << "{\"pid\":0"
      << ",\"volume\":" << get_viewer_audio_software_volume()
      << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
    return {true, payload.str(), {}, {}};
  }

  float effective_volume = 0.0f;
  std::string volume_error;
  if (!get_wasapi_render_session_volume_for_pid(pid, &effective_volume, &volume_error)) {
    return {false, {}, "VIEWER_VOLUME_GET_FAILED", volume_error};
  }

  std::ostringstream payload;
  payload
    << "{\"pid\":" << pid
    << ",\"volume\":" << effective_volume
    << ",\"implementation\":\"native-wasapi-render-session-volume\"}";
  return {true, payload.str(), {}, {}};
}

ViewerAudioCommandResult ViewerAudioSession::set_delay_from_request(const std::string& request_json) {
  const int requested_delay_ms = vds::media_agent::extract_int_value(request_json, "delayMs", 0);
  const unsigned int normalized_delay_ms =
    static_cast<unsigned int>(std::max(0, std::min(300, requested_delay_ms)));
  set_viewer_audio_delay_ms(normalized_delay_ms);
  std::ostringstream payload;
  payload
    << "{\"delayMs\":" << normalized_delay_ms
    << ",\"implementation\":\"viewer-audio-delay\"}";
  return {true, payload.str(), {}, {}};
}

void ViewerAudioSession::stop() {
  stop_viewer_audio_playback_runtime();
}

void ViewerAudioSession::consume_remote_peer_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (!runtime_ptr) {
    return;
  }

  bool local_playback_enabled = false;
  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
    local_playback_enabled = runtime_ptr->local_playback_enabled;
  }

  std::string lowered_codec = codec;
  std::transform(lowered_codec.begin(), lowered_codec.end(), lowered_codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  relay_hub().publish_audio_frame(peer_id, frame, lowered_codec, rtp_timestamp);
  if (!local_playback_enabled) {
    return;
  }
  if (lowered_codec != "pcmu" && lowered_codec != "opus" && lowered_codec != "aac") {
    return;
  }

  auto pcm = lowered_codec == "pcmu"
    ? decode_pcmu_to_pcm16(frame)
    : decode_audio_to_pcm16(runtime_ptr, frame, lowered_codec, nullptr);
  if (pcm.empty()) {
    return;
  }

  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
    if (runtime_ptr->startup_waiting_for_random_access) {
      runtime_ptr->dropped_audio_blocks += 1;
      runtime_ptr->reason = "peer-audio-waiting-for-random-access";
      return;
    }
    runtime_ptr->dispatched_audio_blocks += 1;
    runtime_ptr->reason = "peer-audio-passthrough-dispatched";
  }
  queue_viewer_audio_pcm_block(std::move(pcm));
}
