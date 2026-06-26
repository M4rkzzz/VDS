#pragma once

#include <cstdint>
#include <vector>

inline constexpr unsigned int kViewerAudioSampleRate = 48000;
inline constexpr unsigned int kViewerAudioChannelCount = 2;

bool viewer_audio_playback_is_active();
float set_viewer_audio_software_volume(float requested_volume);
float get_viewer_audio_software_volume();
void set_viewer_audio_delay_ms(unsigned int delay_ms);
void stop_viewer_audio_playback_runtime();
void queue_viewer_audio_pcm_block(std::vector<std::int16_t> pcm_block);
