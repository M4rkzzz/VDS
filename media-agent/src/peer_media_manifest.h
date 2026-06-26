#pragma once

#include <string>

struct PeerState;

namespace vds::media_agent {

std::string normalize_manifest_codec(std::string value);
void apply_media_manifest_to_peer(PeerState& peer, const std::string& request_json);

}  // namespace vds::media_agent
