#include "viewer_audio_playback.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

#include "time_utils.h"

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

struct ViewerAudioPlaybackRuntime {
  struct QueuedPcmBlock {
    std::vector<std::int16_t> pcm;
    std::int64_t release_at_steady_us = 0;
  };

  bool running = false;
  bool ready = false;
  bool stop_requested = false;
  bool thread_started = false;
  bool playback_primed = false;
  unsigned long long buffered_pcm_frames = 0;
  unsigned int channel_count = kViewerAudioChannelCount;
  unsigned int passthrough_audio_delay_ms = 0;
  float software_volume = 1.0f;
  std::mutex mutex;
  std::condition_variable cv;
  std::thread worker;
  std::deque<QueuedPcmBlock> pcm_queue;
};

ViewerAudioPlaybackRuntime& viewer_audio_playback_runtime() {
  static ViewerAudioPlaybackRuntime runtime;
  return runtime;
}

unsigned int pcm_sample_count_to_frames(std::size_t sample_count, unsigned int channel_count) {
  const unsigned int normalized_channel_count = std::max(1u, channel_count);
  return static_cast<unsigned int>(sample_count / normalized_channel_count);
}

#ifdef _WIN32
unsigned int viewer_audio_passthrough_startup_frames() {
  return kViewerAudioStartupBufferFrames;
}

unsigned int viewer_audio_passthrough_max_buffered_frames(
  const ViewerAudioPlaybackRuntime& runtime) {
  const unsigned int delay_ms = std::min(runtime.passthrough_audio_delay_ms, kViewerAudioMaxDelayMs);
  const unsigned int target_ms = delay_ms + kViewerAudioPassthroughJitterHeadroomMs;
  const unsigned int target_frames =
    static_cast<unsigned int>((static_cast<std::uint64_t>(target_ms) * kViewerAudioSampleRate) / 1000u);
  return std::max(kViewerAudioBaseMaxBufferedFrames, target_frames);
}

void viewer_audio_playback_worker(ViewerAudioPlaybackRuntime* runtime) {
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
      runtime->thread_started = false;
      runtime->playback_primed = false;
      runtime->buffered_pcm_frames = 0;
      runtime->cv.notify_all();
      return;
    }
    runtime->running = true;
    runtime->ready = true;
    runtime->playback_primed = false;
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
        if (runtime->pcm_queue.front().release_at_steady_us > vds::media_agent::current_time_micros_steady()) {
          return false;
        }
        if (runtime->playback_primed) {
          return true;
        }
        return runtime->buffered_pcm_frames >= viewer_audio_passthrough_startup_frames();
      });

      if (runtime->stop_requested && runtime->pcm_queue.empty()) {
        break;
      }

      if (runtime->pcm_queue.empty()) {
        continue;
      }

      release_at_steady_us = runtime->pcm_queue.front().release_at_steady_us;
      const std::int64_t now_steady_us = vds::media_agent::current_time_micros_steady();
      if (!runtime->stop_requested && release_at_steady_us > now_steady_us) {
        continue;
      }
      if (!runtime->playback_primed) {
        runtime->playback_primed = true;
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
      continue;
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
    runtime->running = false;
    runtime->ready = false;
    runtime->thread_started = false;
    runtime->playback_primed = false;
    runtime->buffered_pcm_frames = 0;
  }
}
#endif

} // namespace

void ensure_viewer_audio_playback_runtime() {
#ifdef _WIN32
  auto& runtime = viewer_audio_playback_runtime();
  std::thread finished_worker;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.thread_started) {
      return;
    }
    if (runtime.worker.joinable()) {
      finished_worker = std::move(runtime.worker);
    }
  }
  if (finished_worker.joinable()) {
    finished_worker.join();
  }
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.thread_started) {
      return;
    }
    runtime.stop_requested = false;
    runtime.thread_started = true;
    runtime.worker = std::thread(viewer_audio_playback_worker, &runtime);
  }
#else
  (void)viewer_audio_playback_runtime();
#endif
}

bool viewer_audio_playback_is_active() {
  auto& runtime = viewer_audio_playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  return runtime.thread_started || runtime.ready;
}

float set_viewer_audio_software_volume(float requested_volume) {
  auto& runtime = viewer_audio_playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.software_volume = std::max(0.0f, std::min(1.0f, requested_volume));
  return runtime.software_volume;
}

float get_viewer_audio_software_volume() {
  auto& runtime = viewer_audio_playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  return runtime.software_volume;
}

void set_viewer_audio_delay_ms(unsigned int delay_ms) {
  auto& runtime = viewer_audio_playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.passthrough_audio_delay_ms = std::min(delay_ms, kViewerAudioMaxDelayMs);
  runtime.cv.notify_all();
}

void stop_viewer_audio_playback_runtime() {
#ifdef _WIN32
  auto& runtime = viewer_audio_playback_runtime();
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
  (void)viewer_audio_playback_runtime();
#endif
}

void queue_viewer_audio_pcm_block(std::vector<std::int16_t> pcm_block) {
  if (pcm_block.empty()) {
    return;
  }

  ensure_viewer_audio_playback_runtime();
  auto& runtime = viewer_audio_playback_runtime();
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    ViewerAudioPlaybackRuntime::QueuedPcmBlock queued_block;
    queued_block.release_at_steady_us =
      vds::media_agent::current_time_micros_steady() +
      static_cast<std::int64_t>(std::min(runtime.passthrough_audio_delay_ms, kViewerAudioMaxDelayMs)) * 1000;
    queued_block.pcm = std::move(pcm_block);
    const unsigned int queued_block_frames =
      pcm_sample_count_to_frames(queued_block.pcm.size(), runtime.channel_count);

    runtime.buffered_pcm_frames += queued_block_frames;
    runtime.pcm_queue.push_back(std::move(queued_block));
    const unsigned int max_buffered_frames = std::max(
      viewer_audio_passthrough_max_buffered_frames(runtime),
      viewer_audio_passthrough_startup_frames()
    );
    while (!runtime.pcm_queue.empty() && runtime.buffered_pcm_frames > max_buffered_frames) {
      const unsigned int front_frames = pcm_sample_count_to_frames(runtime.pcm_queue.front().pcm.size(), runtime.channel_count);
      runtime.buffered_pcm_frames = runtime.buffered_pcm_frames > front_frames
        ? runtime.buffered_pcm_frames - front_frames
        : 0;
      runtime.pcm_queue.pop_front();
      runtime.playback_primed = false;
    }
  }
  runtime.cv.notify_one();
}
