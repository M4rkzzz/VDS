#include "viewer_audio_playback.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <cctype>
#include <mutex>
#include <sstream>
#include <thread>

#include "json_protocol.h"
#include "media_audio.h"
#include "relay_dispatch.h"
#include "time_utils.h"
#include "wasapi_backend.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

namespace {

constexpr unsigned int kViewerAudioStartupBufferFrames = 960;    // 20 ms @ 48 kHz device smoothing
constexpr unsigned int kViewerAudioBaseMaxBufferedFrames = 4800; // 100 ms @ 48 kHz
constexpr unsigned int kViewerAudioPassthroughJitterHeadroomMs = 120;
constexpr unsigned int kViewerAudioMaxDelayMs = 300;

unsigned int pcm_sample_count_to_frames(std::size_t sample_count, unsigned int channel_count) {
  const unsigned int normalized_channel_count = std::max(1u, channel_count);
  return static_cast<unsigned int>(sample_count / normalized_channel_count);
}

#ifdef _WIN32
unsigned int viewer_audio_passthrough_startup_frames(
  const AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
  (void)runtime;
  return kViewerAudioStartupBufferFrames;
}

unsigned int viewer_audio_passthrough_max_buffered_frames(
  const AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
  const unsigned int delay_ms = std::min(runtime.passthrough_audio_delay_ms, kViewerAudioMaxDelayMs);
  const unsigned int target_ms = delay_ms + kViewerAudioPassthroughJitterHeadroomMs;
  const unsigned int target_frames =
    static_cast<unsigned int>((static_cast<std::uint64_t>(target_ms) * kViewerAudioSampleRate) / 1000u);
  return std::max(kViewerAudioBaseMaxBufferedFrames, target_frames);
}

void viewer_audio_playback_worker(AgentRuntimeState::ViewerAudioPlaybackRuntime* runtime) {
  if (!runtime) {
    return;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kViewerAudioChannelCount;
  format.nSamplesPerSec = kViewerAudioSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  HWAVEOUT wave_out = nullptr;
  MMRESULT open_result = waveOutOpen(&wave_out, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL);
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    if (open_result != MMSYSERR_NOERROR || !wave_out) {
      runtime->running = false;
      runtime->ready = false;
      runtime->last_error = "viewer-audio-waveout-open-failed";
      runtime->reason = "viewer-audio-open-failed";
      return;
    }
    runtime->wave_out = wave_out;
    runtime->running = true;
    runtime->ready = true;
    runtime->playback_primed = false;
    runtime->reason = "viewer-audio-passthrough-ready";
  }

  std::vector<WAVEHDR*> in_flight_headers;
  while (true) {
    std::vector<std::int16_t> pcm_block;
    std::int64_t release_at_steady_us = 0;
    float volume = 1.0f;
    {
      std::unique_lock<std::mutex> lock(runtime->mutex);
      runtime->cv.wait_for(lock, std::chrono::milliseconds(20), [&]() {
        if (runtime->stop_requested) {
          return true;
        }
        if (runtime->pcm_queue.empty()) {
          return false;
        }
        if (runtime->passthrough_mode) {
          if (runtime->pcm_queue.front().release_at_steady_us > vds::media_agent::current_time_micros_steady()) {
            return false;
          }
          if (runtime->playback_primed) {
            return true;
          }
          return runtime->buffered_pcm_frames >= viewer_audio_passthrough_startup_frames(*runtime);
        }
        if (runtime->playback_primed) {
          return true;
        }
        return runtime->buffered_pcm_frames >= runtime->target_buffer_frames;
      });

      if (runtime->stop_requested && runtime->pcm_queue.empty()) {
        break;
      }

      if (runtime->pcm_queue.empty()) {
        continue;
      }

      if (runtime->passthrough_mode) {
        release_at_steady_us = runtime->pcm_queue.front().release_at_steady_us;
        const std::int64_t now_steady_us = vds::media_agent::current_time_micros_steady();
        if (!runtime->stop_requested && release_at_steady_us > now_steady_us) {
          runtime->reason = "viewer-audio-delay-waiting";
          continue;
        }
        if (!runtime->playback_primed) {
          runtime->playback_primed = true;
          runtime->reason = "viewer-audio-running";
        }
      }

      pcm_block = std::move(runtime->pcm_queue.front().pcm);
      runtime->pcm_queue.pop_front();
      const unsigned int pcm_block_frames = pcm_sample_count_to_frames(pcm_block.size(), runtime->channel_count);
      runtime->buffered_pcm_frames = runtime->buffered_pcm_frames > pcm_block_frames
        ? runtime->buffered_pcm_frames - pcm_block_frames
        : 0;
      volume = runtime->software_volume;
    }

    for (auto it = in_flight_headers.begin(); it != in_flight_headers.end();) {
      WAVEHDR* header = *it;
      if ((header->dwFlags & WHDR_DONE) != 0) {
        waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
        delete[] reinterpret_cast<char*>(header->lpData);
        delete header;
        it = in_flight_headers.erase(it);
        continue;
      }
      ++it;
    }

    if (pcm_block.empty()) {
      continue;
    }

    for (auto& sample : pcm_block) {
      const float scaled = static_cast<float>(sample) * volume;
      sample = static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, scaled)));
    }

    const std::size_t byte_count = pcm_block.size() * sizeof(std::int16_t);
    auto* buffer = new char[byte_count];
    std::memcpy(buffer, pcm_block.data(), byte_count);

    auto* header = new WAVEHDR{};
    header->lpData = buffer;
    header->dwBufferLength = static_cast<DWORD>(byte_count);
    if (waveOutPrepareHeader(wave_out, header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR ||
        waveOutWrite(wave_out, header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
      waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
      delete[] buffer;
      delete header;
      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->last_error = "viewer-audio-waveout-write-failed";
      runtime->reason = "viewer-audio-write-failed";
      continue;
    }

    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->pcm_frames_played += pcm_sample_count_to_frames(pcm_block.size(), runtime->channel_count);
    }
    in_flight_headers.push_back(header);
  }

  waveOutReset(wave_out);
  for (WAVEHDR* header : in_flight_headers) {
    waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
    delete[] reinterpret_cast<char*>(header->lpData);
    delete header;
  }
  waveOutClose(wave_out);

  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->wave_out = nullptr;
    runtime->running = false;
    runtime->ready = false;
    runtime->thread_started = false;
    runtime->playback_primed = false;
    runtime->buffered_pcm_frames = 0;
    if (runtime->reason == "viewer-audio-running") {
      runtime->reason = "viewer-audio-stopped";
    }
  }
}
#endif

} // namespace

ViewerAudioCommandResult set_viewer_volume_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const int pid = vds::media_agent::extract_int_value(request_json, "pid", 0);
  const float requested_volume = static_cast<float>(
    vds::media_agent::extract_double_value(request_json, "volume", 1.0));
  {
    std::lock_guard<std::mutex> lock(state.viewer_audio_playback.mutex);
    if (state.viewer_audio_playback.thread_started || state.viewer_audio_playback.ready) {
      state.viewer_audio_playback.software_volume =
        std::max(0.0f, std::min(1.0f, requested_volume));

      std::ostringstream payload;
      payload
        << "{\"pid\":0"
        << ",\"volume\":" << state.viewer_audio_playback.software_volume
        << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
      return {true, payload.str(), {}, {}};
    }
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

ViewerAudioCommandResult get_viewer_volume_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const int pid = vds::media_agent::extract_int_value(request_json, "pid", 0);
  {
    std::lock_guard<std::mutex> lock(state.viewer_audio_playback.mutex);
    if (state.viewer_audio_playback.thread_started || state.viewer_audio_playback.ready) {
      std::ostringstream payload;
      payload
        << "{\"pid\":0"
        << ",\"volume\":" << state.viewer_audio_playback.software_volume
        << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
      return {true, payload.str(), {}, {}};
    }
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

ViewerAudioCommandResult set_viewer_playback_mode_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  (void)request_json;
  const std::string normalized_mode = "passthrough";
  state.viewer_playback_mode = normalized_mode;
  {
    std::lock_guard<std::mutex> lock(state.viewer_audio_playback.mutex);
    state.viewer_audio_playback.passthrough_mode = true;
    state.viewer_audio_playback.target_buffer_frames = 0u;
    state.viewer_audio_playback.playback_primed = false;
    state.viewer_audio_playback.reason = "viewer-audio-passthrough-ready";
    state.viewer_audio_playback.cv.notify_all();
  }
  std::ostringstream payload;
  payload
    << "{\"mode\":\"" << vds::media_agent::json_escape(normalized_mode) << "\""
    << ",\"implementation\":\"viewer-playback-mode\"}";
  return {true, payload.str(), {}, {}};
}

ViewerAudioCommandResult set_viewer_audio_delay_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const int requested_delay_ms = vds::media_agent::extract_int_value(request_json, "delayMs", 0);
  const unsigned int normalized_delay_ms =
    static_cast<unsigned int>(std::max(0, std::min(300, requested_delay_ms)));
  state.viewer_audio_delay_ms = normalized_delay_ms;
  {
    std::lock_guard<std::mutex> lock(state.viewer_audio_playback.mutex);
    state.viewer_audio_playback.passthrough_audio_delay_ms = normalized_delay_ms;
    state.viewer_audio_playback.cv.notify_all();
  }
  std::ostringstream payload;
  payload
    << "{\"delayMs\":" << normalized_delay_ms
    << ",\"implementation\":\"viewer-audio-delay\"}";
  return {true, payload.str(), {}, {}};
}

void ensure_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
#ifdef _WIN32
  std::lock_guard<std::mutex> lock(runtime.mutex);
  if (runtime.thread_started) {
    return;
  }
  runtime.stop_requested = false;
  runtime.thread_started = true;
  runtime.worker = std::thread(viewer_audio_playback_worker, &runtime);
#else
  (void)runtime;
#endif
}

void stop_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
#ifdef _WIN32
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.stop_requested = true;
    runtime.cv.notify_all();
  }
  if (runtime.worker.joinable()) {
    runtime.worker.join();
  }
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.pcm_queue.clear();
  runtime.buffered_pcm_frames = 0;
  runtime.playback_primed = false;
#else
  (void)runtime;
#endif
}

void queue_viewer_audio_pcm_block(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime,
  std::vector<std::int16_t> pcm_block) {
  if (pcm_block.empty()) {
    return;
  }

  ensure_viewer_audio_playback_runtime(runtime);
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    AgentRuntimeState::ViewerAudioPlaybackRuntime::QueuedPcmBlock queued_block;
    queued_block.release_at_steady_us = runtime.passthrough_mode
      ? (vds::media_agent::current_time_micros_steady() + static_cast<std::int64_t>(std::min(runtime.passthrough_audio_delay_ms, kViewerAudioMaxDelayMs)) * 1000)
      : 0;
    queued_block.pcm = std::move(pcm_block);
    const unsigned int queued_block_frames =
      pcm_sample_count_to_frames(queued_block.pcm.size(), runtime.channel_count);

    runtime.audio_packets_received += 1;
    runtime.audio_bytes_received += queued_block.pcm.size() * sizeof(std::int16_t);
    runtime.pcm_frames_queued += queued_block_frames;
    runtime.buffered_pcm_frames += queued_block_frames;
    runtime.reason = runtime.passthrough_mode
      ? "viewer-audio-passthrough-queued"
      : "viewer-audio-passthrough-queued";
    runtime.pcm_queue.push_back(std::move(queued_block));
    const unsigned int max_buffered_frames = std::max(
      viewer_audio_passthrough_max_buffered_frames(runtime),
      viewer_audio_passthrough_startup_frames(runtime)
    );
    while (!runtime.pcm_queue.empty() && runtime.buffered_pcm_frames > max_buffered_frames) {
      const unsigned int front_frames = pcm_sample_count_to_frames(runtime.pcm_queue.front().pcm.size(), runtime.channel_count);
      runtime.buffered_pcm_frames = runtime.buffered_pcm_frames > front_frames
        ? runtime.buffered_pcm_frames - front_frames
        : 0;
      runtime.pcm_queue.pop_front();
      runtime.playback_primed = false;
      runtime.reason = "viewer-audio-rebuffering";
    }
  }
  runtime.cv.notify_one();
}

std::string viewer_audio_playback_json(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
  std::lock_guard<std::mutex> lock(runtime.mutex);

  std::ostringstream payload;
  payload
    << "{\"running\":" << (runtime.running ? "true" : "false")
    << ",\"ready\":" << (runtime.ready ? "true" : "false")
    << ",\"threadStarted\":" << (runtime.thread_started ? "true" : "false")
    << ",\"playbackPrimed\":" << (runtime.playback_primed ? "true" : "false")
    << ",\"passthroughMode\":" << (runtime.passthrough_mode ? "true" : "false")
    << ",\"queueDepth\":" << runtime.pcm_queue.size()
    << ",\"audioPacketsReceived\":" << runtime.audio_packets_received
    << ",\"audioBytesReceived\":" << runtime.audio_bytes_received
    << ",\"pcmFramesQueued\":" << runtime.pcm_frames_queued
    << ",\"pcmFramesPlayed\":" << runtime.pcm_frames_played
    << ",\"bufferedPcmFrames\":" << runtime.buffered_pcm_frames
    << ",\"targetBufferFrames\":" << runtime.target_buffer_frames
    << ",\"targetBufferMs\":" << ((runtime.target_buffer_frames * 1000u) / kViewerAudioSampleRate)
    << ",\"audioDelayMs\":" << runtime.passthrough_audio_delay_ms
    << ",\"softwareVolume\":" << runtime.software_volume
    << ",\"implementation\":\"" << vds::media_agent::json_escape(runtime.implementation) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(runtime.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(runtime.last_error) << "\""
    << "}";
  return payload.str();
}

void consume_remote_peer_audio_frame(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime,
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
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
  fanout_relay_audio_frame(peer_id, frame, lowered_codec, rtp_timestamp);
  if (!local_playback_enabled) {
    return;
  }
  if (lowered_codec != "pcmu" && lowered_codec != "opus" && lowered_codec != "aac") {
    std::lock_guard<std::mutex> lock(audio_runtime.mutex);
    audio_runtime.last_error = "viewer-audio-unsupported-codec:" + codec;
    audio_runtime.reason = "viewer-audio-unsupported-codec";
    return;
  }

  std::string decode_error;
  auto pcm = lowered_codec == "pcmu"
    ? decode_pcmu_to_pcm16(frame)
    : decode_audio_to_pcm16(runtime_ptr, frame, lowered_codec, &decode_error);
  if (pcm.empty()) {
    if (!decode_error.empty()) {
      std::lock_guard<std::mutex> lock(audio_runtime.mutex);
      audio_runtime.last_error = decode_error;
      audio_runtime.reason = "viewer-audio-decode-failed";
    }
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
  queue_viewer_audio_pcm_block(audio_runtime, std::move(pcm));
}
