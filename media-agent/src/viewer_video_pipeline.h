#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "peer_video_receiver_state.h"

class PeerTransportSession;

void consume_remote_peer_video_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime_ptr,
  const std::shared_ptr<PeerTransportSession>& transport_session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp
);
