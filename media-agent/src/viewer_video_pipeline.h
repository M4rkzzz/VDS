#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "agent_runtime.h"

class PeerTransportSession;

bool submit_scheduled_video_unit_to_surface(
  const std::string& peer_id,
  PeerState::PeerVideoReceiverRuntime& runtime,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec_path,
  std::string* warning_message
);

void consume_remote_peer_video_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::shared_ptr<PeerTransportSession>& transport_session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp
);
