#pragma once

#include <functional>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "agent_runtime.h"

struct HostSessionControllerCallbacks {
  std::function<void(const std::string& reason)> stop_all_surface_attachments;
  std::function<void()> refresh_host_capture_runtime;
  std::function<void()> restart_host_capture_surface_attachments;
  std::function<bool(PeerState& peer, std::string* error)> attach_host_video_media_binding;
  std::function<bool(PeerState& peer, std::string* error)> detach_peer_media_binding;
};

struct HostSessionCommandResult {
  bool ok = false;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

HostSessionCommandResult start_host_session_from_request(
  AgentRuntimeState& state,
  const std::string& request_json,
  const HostSessionControllerCallbacks& callbacks);

HostSessionCommandResult stop_host_session(
  AgentRuntimeState& state,
  const HostSessionControllerCallbacks& callbacks);
