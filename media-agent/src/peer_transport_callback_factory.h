#pragma once

#include <memory>
#include <string>

#include "peer_transport.h"
#include "peer_video_receiver_state.h"

namespace vds::media_agent {

struct PeerTransportCallbackContext {
  std::string peer_id;
  std::string role;
  bool initiator = false;
  std::string expected_video_codec;
  std::string expected_audio_codec;
  std::shared_ptr<PeerVideoReceiverRuntime> receiver_runtime;
  std::shared_ptr<std::weak_ptr<PeerTransportSession>> transport_session_holder;
};

PeerTransportCallbacks create_peer_transport_callbacks(const PeerTransportCallbackContext& context);

}  // namespace vds::media_agent
