#pragma once

#include <string>

#include "surface_control_result.h"

struct AgentRuntimeState;

namespace vds::media_agent {

class SurfaceSessionController {
 public:
  explicit SurfaceSessionController(AgentRuntimeState& runtime_state);

  SurfaceControlCommandResult attach_from_request(const std::string& request_json);
  SurfaceControlCommandResult update_from_request(const std::string& request_json);
  SurfaceControlCommandResult detach_from_request(const std::string& request_json);

  void refresh_host_capture_surfaces();
  void stop_all(const std::string& reason);
  void restart_host_capture_surfaces();
  void detach_peer_surfaces(const std::string& peer_id, const std::string& reason);

 private:
  AgentRuntimeState& runtime_state_;
};

} // namespace vds::media_agent
