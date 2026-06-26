#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "peer_video_receiver_state.h"

struct ViewerAudioCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

class ViewerAudioSession {
 public:
  ViewerAudioSession() = default;

  ViewerAudioCommandResult set_volume_from_request(const std::string& request_json);
  ViewerAudioCommandResult get_volume_from_request(const std::string& request_json);
  ViewerAudioCommandResult set_delay_from_request(const std::string& request_json);

  void stop();
  void consume_remote_peer_frame(
    const std::string& peer_id,
    const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
    const std::vector<std::uint8_t>& frame,
    const std::string& codec,
    std::uint32_t rtp_timestamp);
};
