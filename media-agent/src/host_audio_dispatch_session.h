#pragma once

#include <memory>
#include <functional>
#include <string>

#include "audio_session_result.h"

struct AudioSessionState;
struct WasapiSessionStatus;

namespace vds::media_agent { class PeerSessionController; }

class PeerTransportSession;

class HostAudioDispatchSession {
 public:
  HostAudioDispatchSession() = default;
  explicit HostAudioDispatchSession(AudioSessionState& session);
  HostAudioDispatchSession(AudioSessionState& session, vds::media_agent::PeerSessionController& peer_sessions);
  HostAudioDispatchSession(
    AudioSessionState& session,
    vds::media_agent::PeerSessionController& peer_sessions,
    std::function<bool()> transport_ready_provider);

  bool capture_ready() const;
  void refresh_session_status() const;
  AudioSessionCommandResult start_from_request(const std::string& request_json) const;
  AudioSessionCommandResult stop_from_request() const;
  void attach_wasapi_callbacks() const;
  void set_capture_active(bool active) const;
  void register_transport_session(const std::shared_ptr<PeerTransportSession>& session) const;
  void unregister_transport_session(const std::shared_ptr<PeerTransportSession>& session) const;
  void reset_transport_sessions() const;
  void dispatch_capture_packet(
    const WasapiSessionStatus& status,
    const unsigned char* data,
    unsigned int frames,
    bool silent) const;
  std::string stats_json() const;

 private:
  bool transport_ready() const;
  void refresh_host_audio_senders() const;

  AudioSessionState* session_ = nullptr;
  vds::media_agent::PeerSessionController* peer_sessions_ = nullptr;
  std::function<bool()> transport_ready_provider_;
};
