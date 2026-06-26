#include "peer_transport_state_json.h"

#include <sstream>

#include "json_protocol.h"
#include "peer_transport_state.h"

namespace vds::media_agent {

std::string peer_transport_backend_json(const PeerTransportBackendInfo& backend) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (backend.available ? "true" : "false")
    << ",\"transportReady\":" << (backend.transport_ready ? "true" : "false")
    << ",\"backend\":\"" << json_escape(backend.backend) << "\""
    << ",\"implementation\":\"" << json_escape(backend.implementation) << "\""
    << ",\"mode\":\"" << json_escape(backend.mode) << "\""
    << ",\"reason\":\"" << json_escape(backend.reason) << "\""
    << ",\"lastError\":\"" << json_escape(backend.last_error) << "\""
    << ",\"iceServers\":" << json_array_from_strings(backend.ice_servers)
    << "}";
  return payload.str();
}

}  // namespace vds::media_agent
