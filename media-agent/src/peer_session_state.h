#pragma once

#include <memory>
#include <string>

#include "peer_media_binding_state.h"
#include "peer_transport.h"
#include "peer_video_receiver_state.h"
#include "peer_video_sender_state.h"
#include "session_lifecycle.h"

struct PeerState {
  using PeerVideoSenderRuntime = ::PeerVideoSenderRuntime;
  using PeerVideoReceiverRuntime = ::PeerVideoReceiverRuntime;
  using MediaBindingState = ::PeerMediaBindingState;

  std::string peer_id;
  std::string role;
  vds::media_agent::SessionPhase phase = vds::media_agent::SessionPhase::Created;
  std::string phase_reason = "peer-created";
  bool initiator = false;
  std::string media_session_id;
  int media_manifest_version = 0;
  std::string expected_video_codec;
  std::string expected_audio_codec;
  PeerMediaBindingState media_binding;
  PeerTransportSnapshot transport;
  std::shared_ptr<PeerTransportSession> transport_session;
  std::shared_ptr<PeerVideoReceiverRuntime> receiver_runtime;
};
