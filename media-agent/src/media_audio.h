#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "peer_video_receiver_state.h"

std::vector<std::int16_t> decode_pcmu_to_pcm16(const std::vector<std::uint8_t>& encoded);
std::vector<std::int16_t> decode_audio_to_pcm16(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  const std::string& codec_name,
  std::string* error);
void reset_peer_audio_decoder_runtime(PeerVideoReceiverRuntime& runtime);
