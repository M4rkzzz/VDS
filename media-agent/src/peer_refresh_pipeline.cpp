#include "peer_refresh_pipeline.h"

#include <mutex>

#include "peer_receiver_runtime.h"
#include "peer_session_state.h"
#include "peer_transport.h"
#include "peer_video_sender.h"
#include "runtime_registry.h"

namespace vds::media_agent {
void refresh_all_peer_transport_runtime(AgentRuntimeState& runtime_state) {
  for_each_mutable_peer(runtime_state, [&](PeerState& peer) {
    if (peer.receiver_runtime) {
      refresh_peer_video_receiver_runtime(*peer.receiver_runtime);
      {
        std::lock_guard<std::mutex> lock(peer.receiver_runtime->mutex);
        if (!peer.receiver_runtime->running) {
          peer.receiver_runtime->decoder_ready = false;
        }
      }
      update_peer_decoder_state_from_runtime(peer.receiver_runtime, peer.transport_session);
    }
    if (peer.transport_session) {
      peer.transport = get_peer_transport_snapshot(peer.transport_session);
    } else {
      const auto& peer_transport = peer_transport_backend(runtime_state);
      peer.transport.transport_ready = peer_transport.transport_ready;
      if (peer.transport.reason.empty()) {
        peer.transport.reason = peer_transport.reason;
      }
    }
    const bool use_encoded_data_channel =
      peer.transport.encoded_media_data_channel_requested ||
      peer.transport.encoded_media_data_channel_supported;
    peer.media_binding.active = use_encoded_data_channel
      ? peer.transport.encoded_media_data_channel_open
      : peer.transport.video_track_open;
    if (peer.media_binding.reason == "peer-media-not-attached") {
      if (use_encoded_data_channel) {
        peer.media_binding.reason = peer.transport.encoded_media_data_channel_ready
          ? "peer-datachannel-media-attached"
          : "peer-datachannel-media-configured";
      } else if (peer.transport.video_track_configured) {
        peer.media_binding.reason = "peer-media-configured";
      }
    }
    refresh_peer_media_binding(peer);
  });
}

}  // namespace vds::media_agent
