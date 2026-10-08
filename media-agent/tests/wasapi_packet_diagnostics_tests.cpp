// Exercise the actual packet dispatcher without opening an audio device.
// The private WASAPI runtime stays local to this translation unit.
#include "../src/wasapi_backend.cpp"

#include <iostream>
#include <vector>

namespace {
int checks = 0;
int failures = 0;
int pcm_calls = 0;
const unsigned char* received_data = nullptr;
unsigned int received_frames = 0;
bool received_silent = false;
WasapiSessionStatus received_status;
std::vector<std::string> event_names;
std::vector<std::string> event_payloads;

void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

void capture_pcm(const WasapiSessionStatus& status, const unsigned char* data,
    unsigned int frames, bool silent) {
  ++pcm_calls;
  received_data = data;
  received_frames = frames;
  received_silent = silent;
  received_status = status;
}

void capture_event(const std::string& name, const std::string& payload) {
  event_names.push_back(name);
  event_payloads.push_back(payload);
}
}  // namespace

int main() {
#ifndef _WIN32
  std::cout << "WASAPI packet diagnostics require Windows\n";
  return 0;
#else
  char* original = nullptr;
  std::size_t original_length = 0;
  _dupenv_s(&original, &original_length, "VDS_VERBOSE_MEDIA_LOGS");
  for (const char* value : { "", "0", "true", "01", "1", "1 " }) {
    expect(_putenv_s("VDS_VERBOSE_MEDIA_LOGS", value) == 0, "set diagnostic switch");
    expect(audio_packet_diagnostics_enabled() == (std::string(value) == "1"),
      "only the existing explicit value 1 enables packet diagnostics");
  }
  expect(_putenv_s("VDS_VERBOSE_MEDIA_LOGS", original ? original : "") == 0,
    "restore the inherited diagnostic switch");
  std::free(original);

  WasapiRuntime state;
  state.event_callback = capture_event;
  state.pcm_packet_callback = capture_pcm;
  WasapiSessionStatus status;
  status.pid = 123;
  status.process_name = "player\"name";
  status.sample_rate = 48000;
  status.channel_count = 2;
  status.bits_per_sample = 16;
  status.block_align = 4;
  status.packets_captured = 77;
  status.frames_captured = 96000;

  // A disabled diagnostic path must not even read PCM for base64 encoding.
  auto* unreadable = static_cast<unsigned char*>(VirtualAlloc(
    nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_NOACCESS));
  expect(unreadable != nullptr, "allocate a guarded PCM buffer");
  if (!unreadable) return 1;
  expect(!state.packet_diagnostics_enabled, "per-packet diagnostics default off");
  emit_audio_packet_event(state, status, unreadable, 480, false);
  expect(pcm_calls == 1 && received_data == unreadable && received_frames == 480 && !received_silent,
    "normal PCM is forwarded unchanged with diagnostics off");
  expect(received_status.packets_captured == 77 && received_status.frames_captured == 96000,
    "capture counters remain available to the encoder callback");
  expect(event_names.empty(), "disabled diagnostics emit no packet JSON");

  emit_audio_packet_event(state, status, nullptr, 240, true);
  expect(pcm_calls == 2 && received_data == nullptr && received_frames == 240 && received_silent,
    "silent packet timing is forwarded with diagnostics off");
  expect(event_names.empty(), "silent packets also skip diagnostic serialization");

  const unsigned char pcm[] = { 1, 2, 3, 4 };
  state.packet_diagnostics_enabled = true;
  emit_audio_packet_event(state, status, pcm, 1, false);
  expect(pcm_calls == 3 && received_data == pcm && received_frames == 1 && !received_silent,
    "diagnostics do not replace the real PCM callback");
  expect(event_names.size() == 1 && event_names[0] == "audio-data",
    "enabled diagnostics retain the audio-data event");
  expect(!event_payloads.empty() && event_payloads[0].find("\"data\":\"AQIDBA==\"") != std::string::npos,
    "enabled diagnostics encode the original PCM bytes");
  expect(!event_payloads.empty() && event_payloads[0].find("player\\\"name") != std::string::npos,
    "diagnostic JSON keeps escaping process metadata");

  emit_audio_packet_event(state, status, nullptr, 240, true);
  expect(pcm_calls == 4 && received_silent && received_frames == 240,
    "diagnostic silent packets still reach the PCM callback");
  expect(event_names.size() == 2 && event_payloads.back().find("\"silent\":true") != std::string::npos &&
      event_payloads.back().find("\"data\":\"\"") != std::string::npos,
    "diagnostic silent packets retain metadata without reading null PCM");

  state.event_callback = nullptr;
  emit_audio_packet_event(state, status, unreadable, 480, false);
  expect(pcm_calls == 5 && event_names.size() == 2,
    "missing diagnostic observer avoids PCM serialization");

  state.event_callback = capture_event;
  state.pcm_packet_callback = nullptr;
  state.packet_diagnostics_enabled = false;
  emit_audio_packet_event(state, status, unreadable, 480, false);
  expect(pcm_calls == 5 && event_names.size() == 2,
    "a packet with no active consumer does no diagnostic work");
  expect(status.packets_captured == 77 && status.frames_captured == 96000,
    "dispatch gating does not reset capture counters");
  expect(VirtualFree(unreadable, 0, MEM_RELEASE) != FALSE, "release the guarded PCM buffer");
  std::cout << "WASAPI packet diagnostics: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
#endif
}
