#pragma once

#include <string>

#include "peer_control_result.h"
#include "peer_media_binding_result.h"

struct AgentRuntimeState;

namespace vds::media_agent {

class PeerSessionController {
 public:
  explicit PeerSessionController(AgentRuntimeState& runtime_state);

  PeerControlCommandResult create_from_request(const std::string& request_json);
  PeerControlCommandResult close_from_request(const std::string& request_json);
  PeerControlCommandResult set_remote_description_from_request(const std::string& request_json);
  PeerControlCommandResult add_remote_ice_candidate_from_request(const std::string& request_json);
  PeerMediaBindingCommandResult attach_media_source_from_request(const std::string& request_json);
  PeerMediaBindingCommandResult detach_media_source_from_request(const std::string& request_json);

  void refresh_transport_runtime();
  void perform_host_video_sender_soft_refresh();
  void refresh_host_audio_senders();
  void close_all_receiver_handles();
  void close_all_transport_sessions();

 private:
  AgentRuntimeState& runtime_state_;
};

} // namespace vds::media_agent
