#pragma once

#include <memory>
#include <string>

#include "peer_video_receiver_state.h"

class PeerTransportSession;

void begin_close_peer_video_receiver_runtime(PeerVideoReceiverRuntime& runtime);
void close_peer_video_receiver_handles(PeerVideoReceiverRuntime& runtime);
void refresh_peer_video_receiver_runtime(PeerVideoReceiverRuntime& runtime);
void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime,
  const std::shared_ptr<PeerTransportSession>& transport_session
);
std::string peer_video_receiver_runtime_json(
  const std::shared_ptr<PeerVideoReceiverRuntime>& runtime
);
