#pragma once

#include <string>

namespace vds::media_agent {

enum class SessionPhase {
  Created,
  Configured,
  Starting,
  Running,
  Draining,
  Stopped,
  Destroyed,
  Failed
};

inline const char* session_phase_to_string(SessionPhase phase) {
  switch (phase) {
    case SessionPhase::Created:
      return "created";
    case SessionPhase::Configured:
      return "configured";
    case SessionPhase::Starting:
      return "starting";
    case SessionPhase::Running:
      return "running";
    case SessionPhase::Draining:
      return "draining";
    case SessionPhase::Stopped:
      return "stopped";
    case SessionPhase::Destroyed:
      return "destroyed";
    case SessionPhase::Failed:
      return "failed";
  }
  return "unknown";
}

inline bool is_terminal_session_phase(SessionPhase phase) {
  return phase == SessionPhase::Stopped ||
         phase == SessionPhase::Destroyed ||
         phase == SessionPhase::Failed;
}

struct SessionSnapshot {
  std::string id;
  SessionPhase phase = SessionPhase::Created;
  std::string reason;
  std::string last_error;
};

} // namespace vds::media_agent
