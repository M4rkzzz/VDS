#pragma once

#include "peer_session_state.h"

struct HostVideoBindingContext;

namespace vds::media_agent {

void attach_host_downstream_media_if_running(const HostVideoBindingContext& binding_context, PeerState& peer);
void ensure_initial_peer_negotiation(PeerState& peer);

}  // namespace vds::media_agent
