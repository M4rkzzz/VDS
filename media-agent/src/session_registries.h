#pragma once

#include <map>
#include <cstddef>
#include <functional>
#include <string>

#include "audio_session_state.h"
#include "host_session_state.h"
#include "obs_ingest_session_state.h"
#include "peer_session_state.h"
#include "surface_attachment_state.h"

struct HostSessionRegistry {
  HostSessionRegistry() { sessions_.try_emplace(active_session_id_); }

  HostSessionState& active_session() { return sessions_.at(active_session_id_); }
  const HostSessionState& active_session() const { return sessions_.at(active_session_id_); }
  HostSessionState& ensure_session(const std::string& session_id) {
    return sessions_.try_emplace(session_id.empty() ? active_session_id_ : session_id).first->second;
  }
  bool activate_session(const std::string& session_id) {
    if (session_id.empty()) {
      return false;
    }
    ensure_session(session_id);
    active_session_id_ = session_id;
    return true;
  }
  const std::string& active_session_id() const { return active_session_id_; }
  std::size_t session_count() const { return sessions_.size(); }

 private:
  std::string active_session_id_ = "host-default";
  std::map<std::string, HostSessionState> sessions_;
};

struct AudioSessionRegistry {
  AudioSessionRegistry() { sessions_.try_emplace(active_session_id_); }

  AudioSessionState& active_session() { return sessions_.at(active_session_id_); }
  const AudioSessionState& active_session() const { return sessions_.at(active_session_id_); }
  AudioSessionState& ensure_session(const std::string& session_id) {
    return sessions_.try_emplace(session_id.empty() ? active_session_id_ : session_id).first->second;
  }
  bool activate_session(const std::string& session_id) {
    if (session_id.empty()) {
      return false;
    }
    ensure_session(session_id);
    active_session_id_ = session_id;
    return true;
  }
  const std::string& active_session_id() const { return active_session_id_; }
  std::size_t session_count() const { return sessions_.size(); }

 private:
  std::string active_session_id_ = "audio-default";
  std::map<std::string, AudioSessionState> sessions_;
};

struct ObsIngestSessionRegistry {
  ObsIngestSessionRegistry() { sessions_.try_emplace(active_session_id_); }

  ObsIngestState& active_session() { return sessions_.at(active_session_id_); }
  const ObsIngestState& active_session() const { return sessions_.at(active_session_id_); }
  ObsIngestState& ensure_session(const std::string& session_id) {
    return sessions_.try_emplace(session_id.empty() ? active_session_id_ : session_id).first->second;
  }
  bool activate_session(const std::string& session_id) {
    if (session_id.empty()) {
      return false;
    }
    ensure_session(session_id);
    active_session_id_ = session_id;
    return true;
  }
  const std::string& active_session_id() const { return active_session_id_; }
  std::size_t session_count() const { return sessions_.size(); }

 private:
  std::string active_session_id_ = "obs-ingest-default";
  std::map<std::string, ObsIngestState> sessions_;
};

struct PeerSessionRegistry {
  PeerState* find(const std::string& peer_id) {
    const auto it = peers_.find(peer_id);
    return it == peers_.end() ? nullptr : &it->second;
  }

  const PeerState* find(const std::string& peer_id) const {
    const auto it = peers_.find(peer_id);
    return it == peers_.end() ? nullptr : &it->second;
  }

  PeerState& ensure(const std::string& peer_id) {
    return peers_[peer_id];
  }

  bool erase(const std::string& peer_id) {
    return peers_.erase(peer_id) > 0;
  }

  std::size_t count() const {
    return peers_.size();
  }

  void for_each(const std::function<void(const PeerState&)>& callback) const {
    for (const auto& entry : peers_) {
      callback(entry.second);
    }
  }

  void for_each_mutable(const std::function<void(PeerState&)>& callback) {
    for (auto& entry : peers_) {
      callback(entry.second);
    }
  }

  void for_each_mutable_with_role(
    const std::string& role,
    const std::function<void(PeerState&)>& callback) {
    for_each_mutable([&](PeerState& peer) {
      if (peer.role == role) {
        callback(peer);
      }
    });
  }

 private:
  std::map<std::string, PeerState> peers_;
};

struct SurfaceSessionRegistry {
  SurfaceAttachmentState* find(const std::string& surface_id) {
    const auto it = surfaces_.find(surface_id);
    return it == surfaces_.end() ? nullptr : &it->second;
  }

  const SurfaceAttachmentState* find(const std::string& surface_id) const {
    const auto it = surfaces_.find(surface_id);
    return it == surfaces_.end() ? nullptr : &it->second;
  }

  SurfaceAttachmentState& ensure(const std::string& surface_id) {
    return surfaces_[surface_id];
  }

  bool erase(const std::string& surface_id) {
    return surfaces_.erase(surface_id) > 0;
  }

  std::size_t count() const {
    return surfaces_.size();
  }

  void for_each(const std::function<void(SurfaceAttachmentState&)>& callback) {
    for (auto& entry : surfaces_) {
      callback(entry.second);
    }
  }

  void for_each(const std::function<void(const SurfaceAttachmentState&)>& callback) const {
    for (const auto& entry : surfaces_) {
      callback(entry.second);
    }
  }

  void for_each(const std::function<void(const std::string&, SurfaceAttachmentState&)>& callback) {
    for (auto& entry : surfaces_) {
      callback(entry.first, entry.second);
    }
  }

  void for_each(const std::function<void(const std::string&, const SurfaceAttachmentState&)>& callback) const {
    for (const auto& entry : surfaces_) {
      callback(entry.first, entry.second);
    }
  }

 private:
  std::map<std::string, SurfaceAttachmentState> surfaces_;
};
