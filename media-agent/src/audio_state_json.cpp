#include "audio_state_json.h"

#include <sstream>

#include "audio_session_state.h"

std::string audio_session_json(const AudioSessionState& session) {
  std::ostringstream payload;
  payload
    << "{\"captureActive\":" << (session.capture_active ? "true" : "false")
    << ",\"packetsCaptured\":" << session.packets_captured
    << ",\"framesCaptured\":" << session.frames_captured
    << "}";
  return payload.str();
}
