#pragma once

#include <cstdint>
#include <memory>
#include <string>

class PeerTransportSession;

struct RelaySubscriberState {
  std::string peer_id;
  std::weak_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
  bool pending_video_bootstrap = true;
  bool bootstrap_snapshot_sent = false;
  unsigned long long frames_sent = 0;
  std::uint64_t video_sequence = 0;
  std::uint64_t audio_sequence = 0;
  std::uint64_t last_video_sequence = 0;
  std::uint64_t last_video_timestamp_us = 0;
  bool last_video_sequence_valid = false;
  std::uint64_t video_recovery_generation = 0;
  std::string source_epoch;
  std::string upstream_source_epoch;
  std::string reason = "relay-subscriber-idle";
  std::string last_error;
};
