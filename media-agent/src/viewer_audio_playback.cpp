#include "viewer_audio_playback.h"

#include <algorithm>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

#include "time_utils.h"
#include "media_audio.h"
#include "viewer_audio_packet_budget.h"
#include "viewer_audio_timing.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

namespace {
constexpr unsigned int kViewerAudioStartupFrames = 960;
constexpr unsigned int kViewerAudioJitterHeadroomMs = 120;
constexpr unsigned int kViewerAudioMaxDelayMs = 300;
constexpr unsigned int kViewerAudioMaxDeviceFrames = 2880;
constexpr std::size_t kViewerAudioMaxEncodedFrames = 24;
constexpr std::size_t kViewerAudioMaxEncodedBytes = 1024 * 1024;
constexpr std::int64_t kViewerAudioMaxEncodedAgeUs = 500000;

std::int64_t steady_now() { return vds::media_agent::current_time_micros_steady(); }
unsigned int pcm_frames(std::size_t samples) {
  return static_cast<unsigned int>(samples / kViewerAudioChannelCount);
}

struct ViewerAudioPlaybackRuntime {
  struct QueuedPcmBlock {
    std::vector<std::int16_t> pcm;
    MediaFrameTiming timing;
    std::int64_t release_at_steady_us = 0;
  };
  struct QueuedEncodedBlock {
    std::weak_ptr<PeerVideoReceiverRuntime> receiver;
    std::vector<std::uint8_t> bytes;
    std::string codec;
    MediaFrameTiming timing;
    unsigned int reserved_frames = 0;
    std::int64_t arrival_us = 0;
    bool reset_decoder = false;
    std::size_t cursor = 0;
    std::uint64_t timestamp_remainder = 0;
    unsigned int remainder_rate = 0;
  };
  bool ready = false;
  bool stop_requested = false;
  bool thread_started = false;
  bool playback_primed = false;
  bool reset_requested = false;
  std::uint64_t generation = 0;
  unsigned long long buffered_pcm_frames = 0;
  unsigned long long in_flight_pcm_frames = 0;
  unsigned long long dropped_pcm_frames = 0;
  unsigned long long dropped_encoded_frames = 0;
  unsigned int decoding_pcm_frames = 0;
  std::size_t encoded_bytes = 0;
  unsigned int passthrough_audio_delay_ms = 0;
  float software_volume = 1.0f;
  std::string source_id;
  std::uint64_t written_source_end_us = 0;
  bool written_source_valid = false;
  bool decoder_reset_required = false;
  unsigned int soft_pcm_limit_frames = 0;
  std::int64_t last_device_progress_us = 0;
  bool ingress_sequence_valid = false;
  std::uint64_t ingress_sequence = 0;
  bool ingress_timestamp_valid = false;
  std::uint64_t ingress_timestamp_us = 0;
  std::int64_t retry_open_at_us = 0;
  std::mutex mutex;
  std::mutex lifecycle_mutex;
  std::thread worker;
  std::deque<QueuedPcmBlock> pcm_queue;
  std::deque<QueuedEncodedBlock> encoded_queue;
  ViewerAudioTimingPlan timing_plan;
  ViewerAudioDeviceClock device_clock;
#ifdef _WIN32
  HANDLE wake_event = nullptr;
#endif
};

ViewerAudioPlaybackRuntime& playback_runtime() {
  static ViewerAudioPlaybackRuntime runtime;
  return runtime;
}
unsigned int max_buffered_frames(const ViewerAudioPlaybackRuntime& runtime) {
  return std::max((runtime.passthrough_audio_delay_ms + kViewerAudioJitterHeadroomMs) * 48,
    runtime.soft_pcm_limit_frames);
}
unsigned int target_buffered_frames(const ViewerAudioPlaybackRuntime& runtime) {
  return (runtime.passthrough_audio_delay_ms + kViewerAudioJitterHeadroomMs) * 48;
}
void wake_locked(ViewerAudioPlaybackRuntime& runtime) {
#ifdef _WIN32
  if (runtime.wake_event) { SetEvent(runtime.wake_event); }
#else
  (void)runtime;
#endif
}
void request_reset_locked(ViewerAudioPlaybackRuntime& runtime, std::int64_t now_us) {
  ++runtime.generation;
  runtime.reset_requested = true;
  runtime.playback_primed = false;
  runtime.device_clock.invalidate();
  runtime.written_source_valid = false;
  runtime.soft_pcm_limit_frames = 0;
  runtime.last_device_progress_us = now_us;
  runtime.timing_plan.reset();
  if (!runtime.pcm_queue.empty()) {
    runtime.timing_plan.anchor(runtime.pcm_queue.front().timing, now_us);
    for (auto& block : runtime.pcm_queue) {
      block.release_at_steady_us = runtime.timing_plan.deadline(
        block.timing, now_us, runtime.passthrough_audio_delay_ms);
    }
  }
  wake_locked(runtime);
}
void trim_queue_locked(ViewerAudioPlaybackRuntime& runtime) {
  bool trimmed = false;
  while (!runtime.pcm_queue.empty() &&
         runtime.buffered_pcm_frames + runtime.in_flight_pcm_frames + runtime.decoding_pcm_frames > max_buffered_frames(runtime)) {
    const auto frames = pcm_frames(runtime.pcm_queue.front().pcm.size());
    runtime.buffered_pcm_frames -= frames;
    runtime.dropped_pcm_frames += frames;
    runtime.pcm_queue.pop_front();
    trimmed = true;
  }
  if (trimmed) { request_reset_locked(runtime, steady_now()); }
}

void clear_encoded_locked(ViewerAudioPlaybackRuntime& runtime) {
  runtime.dropped_encoded_frames += runtime.encoded_queue.size();
  runtime.encoded_queue.clear();
  runtime.encoded_bytes = 0;
}
void replace_source_locked(ViewerAudioPlaybackRuntime& runtime, const MediaFrameTiming& timing,
                           std::int64_t now_us) {
  runtime.dropped_pcm_frames += runtime.buffered_pcm_frames;
  runtime.buffered_pcm_frames = 0;
  runtime.pcm_queue.clear();
  clear_encoded_locked(runtime);
  runtime.decoding_pcm_frames = 0;
  if (runtime.source_id != timing.source_id) {
    runtime.ingress_sequence_valid = runtime.ingress_timestamp_valid = false;
  }
  runtime.source_id = timing.source_id;
  runtime.last_device_progress_us = now_us;
  runtime.decoder_reset_required = true;
  request_reset_locked(runtime, now_us);
}
void enqueue_pcm_locked(ViewerAudioPlaybackRuntime& runtime, std::vector<std::int16_t> pcm,
                        const MediaFrameTiming& timing, std::int64_t arrival_us) {
  const auto total_frames = pcm_frames(pcm.size());
  const auto chunk_limit = total_frames > kViewerAudioMaxDeviceFrames ?
    kViewerAudioStartupFrames : kViewerAudioMaxDeviceFrames;
  unsigned int offset = 0;
  while (offset < total_frames) {
    const auto frames = std::min(chunk_limit, total_frames - offset);
    ViewerAudioPlaybackRuntime::QueuedPcmBlock block;
    block.timing = timing;
    const auto offset_us = static_cast<std::uint64_t>(offset) * 1000000 / kViewerAudioSampleRate;
    if (timing.timestamp_us <= std::numeric_limits<std::uint64_t>::max() - offset_us) {
      block.timing.timestamp_us += offset_us;
    } else { block.timing.timestamp_valid = false; }
    block.release_at_steady_us = runtime.timing_plan.deadline(
      block.timing, arrival_us, runtime.passthrough_audio_delay_ms);
    if (offset == 0 && frames == total_frames) { block.pcm = std::move(pcm); }
    else {
      block.pcm.assign(pcm.begin() + static_cast<std::size_t>(offset) * kViewerAudioChannelCount,
        pcm.begin() + static_cast<std::size_t>(offset + frames) * kViewerAudioChannelCount);
    }
    if (block.timing.timestamp_valid && runtime.written_source_valid &&
        block.timing.timestamp_us + 1000 < runtime.written_source_end_us) {
      runtime.dropped_pcm_frames += frames;
    } else if (block.timing.timestamp_valid && !block.timing.source_id.empty()) {
      const auto position = std::lower_bound(runtime.pcm_queue.begin(), runtime.pcm_queue.end(),
        block.timing.timestamp_us, [](const auto& queued, std::uint64_t pts) {
          return queued.timing.timestamp_valid && queued.timing.timestamp_us < pts;
        });
      if (position != runtime.pcm_queue.end() && position->timing.timestamp_valid &&
          position->timing.timestamp_us == block.timing.timestamp_us) {
        runtime.dropped_pcm_frames += frames;
      } else {
        runtime.buffered_pcm_frames += frames;
        runtime.pcm_queue.insert(position, std::move(block));
      }
    } else {
      runtime.buffered_pcm_frames += frames;
      runtime.pcm_queue.push_back(std::move(block));
    }
    offset += frames;
  }
  trim_queue_locked(runtime);
}

// No global playback/lifecycle lock is held while attempting the receiver lock.
// try_lock is essential: stop_source may join this worker while another ingress
// callback holds its receiver lock and waits to start the playback runtime.
bool decode_pending_audio(ViewerAudioPlaybackRuntime& runtime) {
  ViewerAudioPlaybackRuntime::QueuedEncodedBlock work;
  std::uint64_t generation = 0;
  ViewerAudioPacketUnit unit;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.stop_requested || runtime.reset_requested || runtime.encoded_queue.empty()) { return false; }
    const auto now_us = steady_now();
    if (now_us - runtime.encoded_queue.front().arrival_us > kViewerAudioMaxEncodedAgeUs &&
        now_us - runtime.last_device_progress_us > kViewerAudioMaxEncodedAgeUs &&
        runtime.timing_plan.due(runtime.encoded_queue.front().timing, now_us, runtime.passthrough_audio_delay_ms)) {
      const auto timing = runtime.encoded_queue.front().timing;
      replace_source_locked(runtime, timing, steady_now());
      return true;
    }
    if (runtime.encoded_queue.empty()) { return false; }
    const auto& front = runtime.encoded_queue.front();
    unit = front.codec == "opus" ? ViewerAudioPacketUnit{front.bytes.size(), front.reserved_frames,
      front.reserved_frames, 48000} : viewer_audio_packet_unit(front.codec, front.bytes, front.cursor);
    if (unit.bytes == 0) {
      runtime.encoded_bytes -= front.bytes.size();
      runtime.encoded_queue.pop_front();
      ++runtime.dropped_encoded_frames;
      return true;
    }
    const auto reserve = unit.device_frames;
    const auto old_frames = runtime.buffered_pcm_frames + runtime.in_flight_pcm_frames;
    const auto target = target_buffered_frames(runtime);
    if (reserve > target && runtime.soft_pcm_limit_frames == 0 && old_frames <= kViewerAudioMaxDeviceFrames) {
      runtime.soft_pcm_limit_frames = static_cast<unsigned int>(old_frames) + reserve;
    }
    if (old_frames + reserve > max_buffered_frames(runtime)) {
      return false;
    }
    work = std::move(runtime.encoded_queue.front());
    runtime.encoded_queue.pop_front();
    runtime.decoding_pcm_frames = reserve;
    generation = runtime.generation;
    work.reset_decoder = work.reset_decoder || runtime.decoder_reset_required;
    runtime.decoder_reset_required = false;
  }
  auto receiver = work.receiver.lock();
  if (!receiver) {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.decoding_pcm_frames = 0;
    if (generation == runtime.generation) { runtime.encoded_bytes -= work.bytes.size(); }
    ++runtime.dropped_encoded_frames;
    return true;
  }
  std::unique_lock<std::mutex> receiver_lock(receiver->mutex, std::try_to_lock);
  if (!receiver_lock.owns_lock()) {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.decoding_pcm_frames = 0;
    if (generation == runtime.generation && !runtime.stop_requested) {
      runtime.encoded_queue.push_front(std::move(work));
    } else { ++runtime.dropped_encoded_frames; }
    return false;
  }
  if (receiver->closing || !receiver->local_playback_enabled || receiver->startup_waiting_for_random_access) {
    ++receiver->dropped_audio_blocks;
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.decoding_pcm_frames = 0;
    if (generation == runtime.generation) { runtime.encoded_bytes -= work.bytes.size(); }
    ++runtime.dropped_encoded_frames;
    return true;
  }
  std::string error;
  if (work.reset_decoder) { reset_peer_audio_decoder_runtime(*receiver); }
  auto unit_timing = work.timing;
  // The original wire sequence was checked once at blob ingress. Internal
  // access units share its identity but have distinct sample-based timestamps.
  unit_timing.sequence_valid = false;
  std::vector<std::uint8_t> unit_bytes;
  const bool partial = work.cursor != 0 || unit.bytes != work.bytes.size();
  if (partial) {
    unit_bytes.assign(work.bytes.begin() + work.cursor, work.bytes.begin() + work.cursor + unit.bytes);
  }
  auto blocks = decode_audio_to_pcm_blocks(receiver, partial ? unit_bytes : work.bytes,
    work.codec, unit_timing, &error);
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.decoding_pcm_frames = 0;
  if (generation != runtime.generation || runtime.stop_requested || runtime.reset_requested ||
      work.timing.source_id != runtime.source_id || blocks.empty()) {
    ++runtime.dropped_encoded_frames;
    if (generation == runtime.generation) { runtime.encoded_bytes -= work.bytes.size(); }
    ++receiver->dropped_audio_blocks;
    if (error == "audio-decoder-stale-packet") { receiver->reason = "peer-audio-stale-packet-dropped"; }
    return true;
  }
  unsigned int decoded_frames = 0;
  for (const auto& block : blocks) { decoded_frames += pcm_frames(block.pcm.size()); }
  if (runtime.buffered_pcm_frames + runtime.in_flight_pcm_frames + decoded_frames > max_buffered_frames(runtime)) {
    // An invalid duration header cannot secretly overfill the device queue.
    runtime.dropped_pcm_frames += decoded_frames;
    ++runtime.dropped_encoded_frames;
    runtime.encoded_bytes -= work.bytes.size();
    ++receiver->dropped_audio_blocks;
    return true;
  }
  receiver->dispatched_audio_blocks += blocks.size();
  receiver->reason = "peer-audio-passthrough-dispatched";
  for (auto& block : blocks) {
    enqueue_pcm_locked(runtime, std::move(block.pcm), block.timing, work.arrival_us);
  }
  work.cursor += unit.bytes;
  if (work.cursor < work.bytes.size()) {
    if (work.remainder_rate != 0 && work.remainder_rate != unit.source_rate) {
      work.timestamp_remainder = work.timestamp_remainder * unit.source_rate / work.remainder_rate;
    }
    const auto numerator = static_cast<std::uint64_t>(unit.source_samples) * 1000000 + work.timestamp_remainder;
    const auto delta_us = numerator / unit.source_rate;
    if (work.timing.timestamp_valid && work.timing.timestamp_us > static_cast<std::uint64_t>(INT64_MAX) - delta_us) {
      runtime.encoded_bytes -= work.bytes.size();
      ++runtime.dropped_encoded_frames;
      return true;
    }
    work.timing.timestamp_us += delta_us;
    work.timestamp_remainder = numerator % unit.source_rate;
    work.remainder_rate = unit.source_rate;
    work.reset_decoder = false;
    runtime.encoded_queue.push_front(std::move(work));
  } else { runtime.encoded_bytes -= work.bytes.size(); }
  return true;
}

#ifdef _WIN32
struct DevicePcmBlock {
  WAVEHDR header{};
  std::vector<std::int16_t> pcm;
};

void playback_worker(ViewerAudioPlaybackRuntime* runtime) {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kViewerAudioChannelCount;
  format.nSamplesPerSec = kViewerAudioSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  HANDLE wake_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HWAVEOUT wave_out = nullptr;
  const auto open_result = wake_event ? waveOutOpen(&wave_out, WAVE_MAPPER, &format,
    reinterpret_cast<DWORD_PTR>(wake_event), 0, CALLBACK_EVENT) : MMSYSERR_NOMEM;
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    if (open_result != MMSYSERR_NOERROR || !wave_out) {
      if (wake_event) { CloseHandle(wake_event); }
      runtime->ready = runtime->thread_started = false;
      runtime->stop_requested = true;
      runtime->retry_open_at_us = steady_now() + 1000000;
      runtime->buffered_pcm_frames = 0;
      runtime->pcm_queue.clear();
      clear_encoded_locked(*runtime);
      runtime->decoding_pcm_frames = 0;
      runtime->device_clock.reset();
      return;
    }
    runtime->wake_event = wake_event;
    runtime->ready = true;
  }
  std::deque<std::unique_ptr<DevicePcmBlock>> device_blocks;
  auto clear_device = [&]() {
    waveOutReset(wave_out);
    for (auto& block : device_blocks) {
      waveOutUnprepareHeader(wave_out, &block->header, sizeof(WAVEHDR));
    }
    device_blocks.clear();
  };
  while (true) {
    bool resetting = false;
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (runtime->stop_requested) { break; }
      resetting = runtime->reset_requested;
      if (resetting) {
        runtime->reset_requested = false;
        runtime->dropped_pcm_frames += runtime->in_flight_pcm_frames;
        runtime->in_flight_pcm_frames = 0;
        runtime->device_clock.reset();
      }
    }
    if (resetting) { clear_device(); }

    MMTIME position{};
    position.wType = TIME_SAMPLES;
    const auto position_result = waveOutGetPosition(wave_out, &position, sizeof(position));
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (runtime->reset_requested) { continue; }
      if (position_result == MMSYSERR_NOERROR) {
        auto unit = ViewerAudioPositionUnit::Unsupported;
        std::uint32_t value = 0;
        if (position.wType == TIME_SAMPLES) { unit = ViewerAudioPositionUnit::Samples; value = position.u.sample; }
        else if (position.wType == TIME_BYTES) { unit = ViewerAudioPositionUnit::Bytes; value = position.u.cb; }
        else if (position.wType == TIME_MS) { unit = ViewerAudioPositionUnit::Milliseconds; value = position.u.ms; }
        const auto previous_frames = runtime->device_clock.position_frames();
        const auto now_us = steady_now();
        if (runtime->device_clock.observe(value, unit, now_us) &&
            runtime->device_clock.position_frames() > previous_frames) {
          runtime->last_device_progress_us = now_us;
        }
      } else { runtime->device_clock.invalidate(); }
    }
    for (auto it = device_blocks.begin(); it != device_blocks.end();) {
      if (((*it)->header.dwFlags & WHDR_DONE) != 0) {
        const auto frames = pcm_frames((*it)->pcm.size());
        waveOutUnprepareHeader(wave_out, &(*it)->header, sizeof(WAVEHDR));
        {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->in_flight_pcm_frames -= std::min<unsigned long long>(runtime->in_flight_pcm_frames, frames);
        }
        it = device_blocks.erase(it);
      } else { ++it; }
    }
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (runtime->decoding_pcm_frames == 0 && runtime->buffered_pcm_frames + runtime->in_flight_pcm_frames <=
          target_buffered_frames(*runtime)) {
        runtime->soft_pcm_limit_frames = 0;
      }
    }
    if (decode_pending_audio(*runtime)) { continue; }
    ViewerAudioPlaybackRuntime::QueuedPcmBlock queued;
    std::uint64_t block_generation = 0;
    unsigned int frames = 0;
    float volume = 1.0f;
    DWORD wait_ms = INFINITE;
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (runtime->stop_requested) { break; }
      if (runtime->reset_requested) { continue; }
      if (runtime->in_flight_pcm_frames != 0) { wait_ms = 10; }
      if (!runtime->encoded_queue.empty()) { wait_ms = std::min(wait_ms, DWORD{10}); }
      if (!runtime->pcm_queue.empty()) {
        const auto now_us = steady_now();
        const auto& front = runtime->pcm_queue.front();
        frames = pcm_frames(front.pcm.size());
        if (front.timing.timestamp_valid && runtime->written_source_valid &&
            front.timing.timestamp_us + 1000 < runtime->written_source_end_us) {
          runtime->buffered_pcm_frames -= frames;
          runtime->dropped_pcm_frames += frames;
          runtime->pcm_queue.pop_front();
          continue;
        }
        // First-sample deadline minus device headroom, to submit adjacent blocks
        // before the device finishes the previous one.
        const auto remaining_us = front.release_at_steady_us - now_us -
          static_cast<std::int64_t>(runtime->in_flight_pcm_frames) * 1000000 / kViewerAudioSampleRate;
        const bool enough_startup = runtime->playback_primed ||
          runtime->buffered_pcm_frames >= kViewerAudioStartupFrames;
        const bool device_space = runtime->in_flight_pcm_frames + frames <= kViewerAudioMaxDeviceFrames;
        if (remaining_us <= 0 && enough_startup && device_space) {
          queued = std::move(runtime->pcm_queue.front());
          runtime->pcm_queue.pop_front();
          runtime->buffered_pcm_frames -= frames;
          runtime->in_flight_pcm_frames += frames;
          runtime->playback_primed = true;
          block_generation = runtime->generation;
          volume = runtime->software_volume;
        } else {
          if (remaining_us > 0) {
            wait_ms = std::min(wait_ms, static_cast<DWORD>(std::min<std::int64_t>(
              60000, (remaining_us + 999) / 1000)));
          } else if (enough_startup && !device_space) { wait_ms = std::min(wait_ms, DWORD{10}); }
          // A final short block can start after its smoothing interval without
          // waiting forever for another packet.
          if (!enough_startup) {
            if (front.release_at_steady_us <= now_us - 20000) {
              runtime->playback_primed = true;
              wait_ms = 0;
            } else { wait_ms = std::min(wait_ms, DWORD{20}); }
          }
        }
      } else if (runtime->in_flight_pcm_frames == 0) {
        runtime->device_clock.invalidate();
        runtime->playback_primed = false;
      }
    }
    if (queued.pcm.empty()) { WaitForSingleObject(wake_event, wait_ms); continue; }

    auto block = std::make_unique<DevicePcmBlock>();
    block->pcm = std::move(queued.pcm);
    if (volume != 1.0f) {
      for (auto& sample : block->pcm) {
        const float scaled = static_cast<float>(sample) * volume;
        sample = static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, scaled)));
      }
    }
    block->header.lpData = reinterpret_cast<char*>(block->pcm.data());
    block->header.dwBufferLength = static_cast<DWORD>(block->pcm.size() * sizeof(std::int16_t));
    const auto prepare_result = waveOutPrepareHeader(wave_out, &block->header, sizeof(WAVEHDR));
    bool written = false;
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (prepare_result == MMSYSERR_NOERROR && !runtime->stop_requested &&
          !runtime->reset_requested && block_generation == runtime->generation) {
        written = waveOutWrite(wave_out, &block->header, sizeof(WAVEHDR)) == MMSYSERR_NOERROR;
        if (written) {
          runtime->device_clock.record_write(frames, queued.timing);
          runtime->written_source_valid = queued.timing.timestamp_valid;
          if (runtime->written_source_valid) {
            runtime->written_source_end_us = queued.timing.timestamp_us +
              static_cast<std::uint64_t>(frames) * 1000000 / kViewerAudioSampleRate;
          }
        }
      }
      if (!written) {
        runtime->in_flight_pcm_frames -= std::min<unsigned long long>(runtime->in_flight_pcm_frames, frames);
        runtime->dropped_pcm_frames += frames;
        runtime->device_clock.invalidate();
      }
    }
    if (written) { device_blocks.push_back(std::move(block)); }
    else if (prepare_result == MMSYSERR_NOERROR) {
      waveOutUnprepareHeader(wave_out, &block->header, sizeof(WAVEHDR));
    }
  }
  clear_device();
  waveOutClose(wave_out);
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->wake_event = nullptr;
    runtime->ready = runtime->thread_started = runtime->playback_primed = false;
    runtime->buffered_pcm_frames = runtime->in_flight_pcm_frames = 0;
    runtime->pcm_queue.clear();
    clear_encoded_locked(*runtime);
    runtime->decoding_pcm_frames = 0;
    runtime->device_clock.reset();
    runtime->timing_plan.reset();
    runtime->source_id.clear();
    CloseHandle(wake_event);
  }
}
#endif

void ensure_runtime() {
#ifdef _WIN32
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lifecycle_lock(runtime.lifecycle_mutex);
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.thread_started || steady_now() < runtime.retry_open_at_us) { return; }
  }
  if (runtime.worker.joinable()) { runtime.worker.join(); }
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.stop_requested = runtime.reset_requested = false;
  runtime.thread_started = true;
  runtime.worker = std::thread(playback_worker, &runtime);
#endif
}
} // namespace

bool viewer_audio_playback_is_active() {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  return runtime.thread_started || runtime.ready;
}
ViewerAudioPlaybackSnapshot get_viewer_audio_playback_snapshot() {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  return {runtime.ready, runtime.buffered_pcm_frames + runtime.decoding_pcm_frames, runtime.in_flight_pcm_frames,
    runtime.dropped_pcm_frames, max_buffered_frames(runtime),
    static_cast<unsigned int>(runtime.encoded_queue.size()), runtime.dropped_encoded_frames};
}
ViewerAudioPlaybackClockSnapshot get_viewer_audio_playback_clock_snapshot() {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  const auto clock = runtime.ready && !runtime.reset_requested
    ? runtime.device_clock.estimate(steady_now()) : ViewerAudioClockEstimate{};
  return {clock.valid, clock.timestamp_us, clock.source_id, runtime.passthrough_audio_delay_ms};
}
float set_viewer_audio_software_volume(float requested_volume) {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.software_volume = std::max(0.0f, std::min(1.0f, requested_volume));
  return runtime.software_volume;
}
float get_viewer_audio_software_volume() {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  return runtime.software_volume;
}
void set_viewer_audio_delay_ms(unsigned int delay_ms) {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  const auto delay = std::min(delay_ms, kViewerAudioMaxDelayMs);
  if (runtime.passthrough_audio_delay_ms == delay) { return; }
  runtime.passthrough_audio_delay_ms = delay;
  trim_queue_locked(runtime);
  request_reset_locked(runtime, steady_now());
}
namespace {
void stop_runtime(const std::string* expected_source) {
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lifecycle_lock(runtime.lifecycle_mutex);
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (expected_source && runtime.source_id != *expected_source &&
        runtime.source_id.rfind(*expected_source + "/epoch=", 0) != 0 &&
        runtime.source_id != *expected_source + "/rtp-audio") { return; }
    runtime.stop_requested = true;
    runtime.device_clock.invalidate();
    wake_locked(runtime);
  }
  if (runtime.worker.joinable()) { runtime.worker.join(); }
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.pcm_queue.clear();
  clear_encoded_locked(runtime);
  runtime.decoding_pcm_frames = 0;
  runtime.buffered_pcm_frames = runtime.in_flight_pcm_frames = 0;
  runtime.playback_primed = runtime.ready = runtime.thread_started = false;
  runtime.source_id.clear();
  runtime.ingress_sequence_valid = runtime.ingress_timestamp_valid = false;
  runtime.soft_pcm_limit_frames = 0;
  runtime.device_clock.reset();
  runtime.timing_plan.reset();
  runtime.written_source_valid = false;
  runtime.retry_open_at_us = 0;
}
} // namespace
void stop_viewer_audio_playback_runtime() { stop_runtime(nullptr); }
void stop_viewer_audio_playback_source(const std::string& source_id) {
  if (!source_id.empty()) { stop_runtime(&source_id); }
}
void queue_viewer_audio_pcm_block(std::vector<std::int16_t> pcm, const MediaFrameTiming& timing) {
  if (pcm.empty() || pcm.size() % kViewerAudioChannelCount != 0) { return; }
  if (timing.timestamp_valid && timing.timestamp_us > static_cast<std::uint64_t>(INT64_MAX)) { return; }
  ensure_runtime();
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  if (runtime.stop_requested || !runtime.thread_started) { return; }
  const auto now_us = steady_now();
  if (runtime.source_id != timing.source_id || runtime.timing_plan.discontinuous(timing, now_us)) {
    replace_source_locked(runtime, timing, now_us);
  }
  enqueue_pcm_locked(runtime, std::move(pcm), timing, now_us);
  wake_locked(runtime);
}

bool queue_viewer_audio_encoded_frame(
  const std::shared_ptr<PeerVideoReceiverRuntime>& receiver,
  const std::vector<std::uint8_t>& bytes, const std::string& codec,
  const MediaFrameTiming& timing, std::int64_t arrival_steady_us) {
  const auto ingress_us = arrival_steady_us > 0 ? std::min(arrival_steady_us, steady_now()) : steady_now();
  const auto frames = viewer_audio_packet_device_frames(codec, bytes);
  if (!receiver || frames == 0 ||
      (timing.timestamp_valid && timing.timestamp_us > static_cast<std::uint64_t>(INT64_MAX))) { return false; }
  ensure_runtime();
  auto& runtime = playback_runtime();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  if (runtime.stop_requested || !runtime.thread_started) { return false; }
  const auto now_us = steady_now();
  if (runtime.source_id == timing.source_id && !timing.config &&
      ((timing.sequence_valid && runtime.ingress_sequence_valid && timing.sequence <= runtime.ingress_sequence) ||
       (timing.timestamp_valid && runtime.ingress_timestamp_valid && timing.timestamp_us <= runtime.ingress_timestamp_us))) {
    ++runtime.dropped_encoded_frames;
    return false;
  }
  if (runtime.source_id != timing.source_id || runtime.timing_plan.discontinuous(timing, now_us)) {
    replace_source_locked(runtime, timing, now_us);
  }
  const bool stalled_head = !runtime.encoded_queue.empty() &&
    now_us - runtime.encoded_queue.front().arrival_us > kViewerAudioMaxEncodedAgeUs &&
    now_us - runtime.last_device_progress_us > kViewerAudioMaxEncodedAgeUs &&
    runtime.timing_plan.due(runtime.encoded_queue.front().timing, now_us, runtime.passthrough_audio_delay_ms);
  if (runtime.encoded_queue.size() + (runtime.decoding_pcm_frames != 0 ? 1 : 0) >= kViewerAudioMaxEncodedFrames ||
      bytes.size() > kViewerAudioMaxEncodedBytes ||
      runtime.encoded_bytes > kViewerAudioMaxEncodedBytes - bytes.size() ||
      stalled_head) {
    // The memory figure is a queue target, never a codec-format restriction.
    // One validated large blob may occupy it alone; competing backlog causes a
    // bounded timeline recovery rather than rejecting that legitimate payload.
    replace_source_locked(runtime, timing, now_us);
  }
  runtime.encoded_queue.push_back({receiver, bytes, codec, timing, frames, ingress_us});
  runtime.encoded_bytes += bytes.size();
  if (!timing.config) {
    if (timing.sequence_valid) { runtime.ingress_sequence_valid = true; runtime.ingress_sequence = timing.sequence; }
    if (timing.timestamp_valid) { runtime.ingress_timestamp_valid = true; runtime.ingress_timestamp_us = timing.timestamp_us; }
  }
  wake_locked(runtime);
  return true;
}
