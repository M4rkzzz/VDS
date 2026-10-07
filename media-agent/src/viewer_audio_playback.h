#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "media_frame_timing.h"
struct PeerVideoReceiverRuntime;

inline constexpr unsigned int kViewerAudioSampleRate = 48000;
inline constexpr unsigned int kViewerAudioChannelCount = 2;

struct ViewerAudioPlaybackSnapshot {
  bool ready = false;
  unsigned long long queued_pcm_frames = 0;
  unsigned long long in_flight_pcm_frames = 0;
  unsigned long long dropped_pcm_frames = 0;
  unsigned int max_buffered_pcm_frames = 0;
  unsigned int queued_encoded_frames = 0;
  unsigned long long dropped_encoded_frames = 0;
};

// This clock is valid only while the device has reported forward progress in
// timed PCM. It represents heard source time, before the user's audio offset.
struct ViewerAudioPlaybackClockSnapshot {
  bool valid = false;
  std::uint64_t timestamp_us = 0;
  std::string source_id;
  unsigned int delay_ms = 0;
};

ViewerAudioPlaybackSnapshot get_viewer_audio_playback_snapshot();
ViewerAudioPlaybackClockSnapshot get_viewer_audio_playback_clock_snapshot();
bool viewer_audio_playback_is_active();
float set_viewer_audio_software_volume(float requested_volume);
float get_viewer_audio_software_volume();
void set_viewer_audio_delay_ms(unsigned int delay_ms);
void stop_viewer_audio_playback_runtime();
void stop_viewer_audio_playback_source(const std::string& source_id);
void queue_viewer_audio_pcm_block(
  std::vector<std::int16_t> pcm_block, const MediaFrameTiming& timing = {});
bool queue_viewer_audio_encoded_frame(
  const std::shared_ptr<PeerVideoReceiverRuntime>& receiver,
  const std::vector<std::uint8_t>& bytes, const std::string& codec,
  const MediaFrameTiming& timing, std::int64_t arrival_steady_us = 0);
