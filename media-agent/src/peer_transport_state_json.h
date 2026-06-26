#pragma once

#include <string>

struct PeerTransportBackendInfo;

namespace vds::media_agent {

std::string peer_transport_backend_json(const PeerTransportBackendInfo& backend);

}  // namespace vds::media_agent
