#pragma once

#include <string>

struct AudioSessionState {
  bool ready = false;
  bool capture_active = false;
  int pid = 0;
  std::string process_name;
  std::string backend_mode = "native-wasapi-agent";
  std::string implementation = "wasapi-process-loopback";
  std::string last_error;
  std::string reason = "native-wasapi-capture-available-internal-only";
  unsigned int sample_rate = 0;
  unsigned int channel_count = 0;
  unsigned long long packets_captured = 0;
  unsigned long long frames_captured = 0;
};

inline bool audio_session_capture_ready(const AudioSessionState& session) {
  return session.capture_active && session.ready;
}
