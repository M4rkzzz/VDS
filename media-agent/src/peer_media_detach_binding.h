#pragma once

#include <string>

struct PeerState;

bool detach_peer_media_binding(PeerState& peer, std::string* error);
bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error);
