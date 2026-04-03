#pragma once

#include <string>

struct WasapiProbeResult {
  bool platform_supported = false;
  bool com_initialized = false;
  bool device_enumerator_available = false;
  unsigned int render_device_count = 0;
  bool process_loopback_targeted = true;
  std::string backend_mode = "native-wasapi-agent";
  std::string implementation = "wasapi-process-loopback";
  std::string reason = "native-wasapi-capture-available-internal-only";
  std::string last_error;
};

struct WasapiSessionStatus {
  bool ready = false;
  bool running = false;
  bool capture_active = false;
  bool platform_supported = false;
  bool device_enumerator_available = false;
  unsigned int render_device_count = 0;
  int pid = 0;
  std::string process_name;
  std::string backend_mode = "native-wasapi-agent";
  std::string implementation = "wasapi-process-loopback";
  std::string reason = "native-wasapi-capture-available-internal-only";
  std::string last_error;
  unsigned int sample_rate = 0;
  unsigned int channel_count = 0;
  unsigned int bits_per_sample = 0;
  unsigned int block_align = 0;
  unsigned int buffer_frame_count = 0;
  unsigned int last_buffer_frames = 0;
  unsigned long long packets_captured = 0;
  unsigned long long frames_captured = 0;
  unsigned long long silent_packets = 0;
  unsigned long long activation_attempts = 0;
  unsigned long long activation_successes = 0;
};

using WasapiEventCallback = void(*)(const std::string& event_name, const std::string& params_json);
using WasapiPcmPacketCallback = void(*)(const WasapiSessionStatus& status, const unsigned char* data, unsigned int frames, bool silent);

WasapiProbeResult probe_wasapi_backend();
WasapiSessionStatus get_wasapi_process_loopback_session_status();
WasapiSessionStatus start_wasapi_process_loopback_session(int pid, const std::string& process_name);
WasapiSessionStatus stop_wasapi_process_loopback_session();
void set_wasapi_event_callback(WasapiEventCallback callback);
void set_wasapi_pcm_packet_callback(WasapiPcmPacketCallback callback);
bool set_wasapi_render_session_volume_for_pid(int pid, float volume, float* effective_volume, std::string* error);
bool get_wasapi_render_session_volume_for_pid(int pid, float* volume, std::string* error);
