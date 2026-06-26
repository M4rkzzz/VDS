#pragma once

struct AgentRuntimeState;
struct HostSessionControllerCallbacks;

namespace vds::media_agent {

void attach_host_downstream_media_bindings(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks);
void detach_host_downstream_media_bindings(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks);

}  // namespace vds::media_agent
