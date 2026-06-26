#pragma once

#include <string>

struct PeerMediaBindingState;
struct PeerState;

std::string build_peer_state_json(const PeerState& peer, const std::string& state);
std::string build_peer_result_json(const PeerState& peer);
std::string build_peer_ok_json(const PeerState& peer);
std::string build_peer_closed_result_json(bool transport_ready);
std::string build_peer_stats_json(const PeerState& peer);
std::string peer_media_binding_json(const PeerMediaBindingState& state);
