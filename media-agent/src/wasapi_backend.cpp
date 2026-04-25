#include "wasapi_backend.h"
#include "json_protocol.h"

#ifdef _WIN32

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <propidl.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {

using vds::media_agent::json_escape;

constexpr int kWasapiStartTimeoutMs = 7000;

std::string hresult_to_string(HRESULT hr) {
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "HRESULT 0x%08lx", static_cast<unsigned long>(hr));
  return buffer;
}

struct ScopedCoInitialize {
  HRESULT result = E_UNEXPECTED;
  bool should_uninitialize = false;

  explicit ScopedCoInitialize(DWORD apartment_model = COINIT_MULTITHREADED) {
    result = CoInitializeEx(nullptr, apartment_model);
    should_uninitialize = SUCCEEDED(result);
  }

  ~ScopedCoInitialize() {
    if (should_uninitialize) {
      CoUninitialize();
    }
  }

  bool ok() const {
    return SUCCEEDED(result) || result == RPC_E_CHANGED_MODE;
  }
};

void apply_probe_to_status(WasapiSessionStatus& status, const WasapiProbeResult& probe) {
  status.ready = probe.platform_supported && probe.device_enumerator_available;
  status.platform_supported = probe.platform_supported;
  status.device_enumerator_available = probe.device_enumerator_available;
  status.render_device_count = probe.render_device_count;
  status.backend_mode = probe.backend_mode;
  status.implementation = probe.implementation;
}

class ActivationCompletionHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationCompletionHandler() : ref_count_(1), completion_event_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}

  ~ActivationCompletionHandler() {
    if (completion_event_) {
      CloseHandle(completion_event_);
      completion_event_ = nullptr;
    }
  }

  HRESULT wait_for_completion(DWORD timeout_ms, ComPtr<IAudioClient>& audio_client) {
    if (!completion_event_) {
      return E_HANDLE;
    }

    const DWORD wait_result = WaitForSingleObject(completion_event_, timeout_ms);
    if (wait_result != WAIT_OBJECT_0) {
      return wait_result == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(WAIT_TIMEOUT) : HRESULT_FROM_WIN32(GetLastError());
    }

    if (FAILED(activate_result_)) {
      return activate_result_;
    }

    if (!audio_client_) {
      return E_NOINTERFACE;
    }

    audio_client = audio_client_;
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
    if (!object) {
      return E_POINTER;
    }

    *object = nullptr;
    if (
      riid == __uuidof(IUnknown) ||
      riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
      riid == __uuidof(IAgileObject)
    ) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }

    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&ref_count_));
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = static_cast<ULONG>(InterlockedDecrement(&ref_count_));
    if (remaining == 0) {
      delete this;
    }
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    activate_result_ = E_FAIL;

    if (operation) {
      HRESULT activation_result = E_FAIL;
      ComPtr<IUnknown> activated_interface;
      const HRESULT get_result = operation->GetActivateResult(&activation_result, &activated_interface);
      if (SUCCEEDED(get_result) && SUCCEEDED(activation_result) && activated_interface) {
        activate_result_ = activated_interface.As(&audio_client_);
      } else {
        activate_result_ = FAILED(get_result) ? get_result : activation_result;
      }
    }

    if (completion_event_) {
      SetEvent(completion_event_);
    }

    return S_OK;
  }

 private:
  volatile long ref_count_;
  HANDLE completion_event_ = nullptr;
  ComPtr<IAudioClient> audio_client_;
  HRESULT activate_result_ = E_PENDING;
};

struct WasapiRuntime {
  std::mutex mutex;
  std::condition_variable start_cv;
  std::thread worker;
  bool stop_requested = false;
  bool start_completed = false;
  WasapiSessionStatus status;
  WasapiEventCallback event_callback = nullptr;
  WasapiPcmPacketCallback pcm_packet_callback = nullptr;
};

WasapiRuntime& runtime() {
  static WasapiRuntime instance;
  return instance;
}

void set_start_complete(WasapiRuntime& state) {
  state.start_completed = true;
  state.start_cv.notify_all();
}

void configure_pcm_request_format(WAVEFORMATEX& format) {
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;
}

void fill_status_from_wave_format(WasapiSessionStatus& status, const WAVEFORMATEX& format, UINT32 buffer_frames) {
  status.sample_rate = format.nSamplesPerSec;
  status.channel_count = format.nChannels;
  status.bits_per_sample = format.wBitsPerSample;
  status.block_align = format.nBlockAlign;
  status.buffer_frame_count = buffer_frames;
}

std::string base64_encode(const BYTE* data, std::size_t size) {
  static constexpr char kAlphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  std::string encoded;
  encoded.reserve(((size + 2) / 3) * 4);

  std::size_t index = 0;
  while (index + 2 < size) {
    const unsigned int chunk =
      (static_cast<unsigned int>(data[index]) << 16) |
      (static_cast<unsigned int>(data[index + 1]) << 8) |
      static_cast<unsigned int>(data[index + 2]);
    encoded.push_back(kAlphabet[(chunk >> 18) & 0x3f]);
    encoded.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
    encoded.push_back(kAlphabet[(chunk >> 6) & 0x3f]);
    encoded.push_back(kAlphabet[chunk & 0x3f]);
    index += 3;
  }

  if (index < size) {
    unsigned int chunk = static_cast<unsigned int>(data[index]) << 16;
    encoded.push_back(kAlphabet[(chunk >> 18) & 0x3f]);

    if (index + 1 < size) {
      chunk |= static_cast<unsigned int>(data[index + 1]) << 8;
      encoded.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
      encoded.push_back(kAlphabet[(chunk >> 6) & 0x3f]);
      encoded.push_back('=');
    } else {
      encoded.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
      encoded.push_back('=');
      encoded.push_back('=');
    }
  }

  return encoded;
}

void emit_audio_packet_event(
  WasapiRuntime& state,
  const WasapiSessionStatus& status,
  const BYTE* data,
  UINT32 frames_available,
  bool silent) {
  WasapiEventCallback callback = nullptr;
  WasapiPcmPacketCallback pcm_callback = nullptr;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    callback = state.event_callback;
    pcm_callback = state.pcm_packet_callback;
  }

  if (pcm_callback) {
    pcm_callback(
      status,
      data,
      frames_available,
      silent
    );
  }

  if (!callback) {
    return;
  }

  const std::size_t byte_count = static_cast<std::size_t>(frames_available) * status.block_align;
  const std::string encoded_data = (!silent && data && byte_count > 0)
    ? base64_encode(data, byte_count)
    : "";

  std::ostringstream payload;
  payload
    << "{\"pid\":" << status.pid
    << ",\"processName\":\"" << json_escape(status.process_name) << "\""
    << ",\"sampleRate\":" << status.sample_rate
    << ",\"channels\":" << status.channel_count
    << ",\"bitsPerSample\":" << status.bits_per_sample
    << ",\"blockAlign\":" << status.block_align
    << ",\"frames\":" << frames_available
    << ",\"silent\":" << (silent ? "true" : "false")
    << ",\"encoding\":\"base64-s16le-interleaved\""
    << ",\"data\":\"" << json_escape(encoded_data) << "\""
    << "}";

  callback("audio-data", payload.str());
}

HRESULT activate_process_loopback_audio_client(DWORD pid, ComPtr<IAudioClient>& audio_client) {
  AUDIOCLIENT_ACTIVATION_PARAMS activation_params = {};
  activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activation_params.ProcessLoopbackParams.TargetProcessId = pid;
  activation_params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activate_params = {};
  activate_params.vt = VT_BLOB;
  activate_params.blob.cbSize = sizeof(activation_params);
  activate_params.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

  ActivationCompletionHandler* completion_handler = new ActivationCompletionHandler();
  if (!completion_handler) {
    return E_OUTOFMEMORY;
  }

  ComPtr<IActivateAudioInterfaceAsyncOperation> async_operation;
  const HRESULT activate_result = ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    __uuidof(IAudioClient),
    &activate_params,
    completion_handler,
    &async_operation
  );

  if (FAILED(activate_result)) {
    completion_handler->Release();
    return activate_result;
  }

  const HRESULT wait_result = completion_handler->wait_for_completion(5000, audio_client);
  completion_handler->Release();
  return wait_result;
}

HRESULT initialize_capture_client(
  IAudioClient* audio_client,
  ComPtr<IAudioCaptureClient>& capture_client,
  HANDLE& sample_ready_event,
  WasapiSessionStatus& status) {
  if (!audio_client) {
    return E_POINTER;
  }

  constexpr DWORD stream_flags =
    AUDCLNT_STREAMFLAGS_LOOPBACK |
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

  WAVEFORMATEX requested_format = {};
  configure_pcm_request_format(requested_format);

  HRESULT init_result = audio_client->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    stream_flags,
    0,
    0,
    &requested_format,
    nullptr
  );

  WAVEFORMATEX selected_format = requested_format;
  if (FAILED(init_result)) {
    WAVEFORMATEX* mix_format = nullptr;
    const HRESULT mix_result = audio_client->GetMixFormat(&mix_format);
    if (FAILED(mix_result) || !mix_format) {
      return FAILED(init_result) ? init_result : mix_result;
    }

    init_result = audio_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      stream_flags,
      0,
      0,
      mix_format,
      nullptr
    );
    if (SUCCEEDED(init_result)) {
      selected_format = *mix_format;
    }
    CoTaskMemFree(mix_format);
  }

  if (FAILED(init_result)) {
    return init_result;
  }

  UINT32 buffer_frames = 0;
  HRESULT buffer_result = audio_client->GetBufferSize(&buffer_frames);
  if (FAILED(buffer_result)) {
    return buffer_result;
  }

  HRESULT service_result = audio_client->GetService(IID_PPV_ARGS(&capture_client));
  if (FAILED(service_result)) {
    return service_result;
  }

  sample_ready_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!sample_ready_event) {
    return HRESULT_FROM_WIN32(GetLastError());
  }

  HRESULT event_result = audio_client->SetEventHandle(sample_ready_event);
  if (FAILED(event_result)) {
    CloseHandle(sample_ready_event);
    sample_ready_event = nullptr;
    return event_result;
  }

  fill_status_from_wave_format(status, selected_format, buffer_frames);
  return S_OK;
}

void record_runtime_failure(
  WasapiRuntime& state,
  const WasapiProbeResult& probe,
  const std::string& reason,
  const std::string& error) {
  std::lock_guard<std::mutex> lock(state.mutex);
  apply_probe_to_status(state.status, probe);
  state.status.running = false;
  state.status.capture_active = false;
  state.status.reason = reason;
  state.status.last_error = error;
  set_start_complete(state);
}

void capture_worker_main(DWORD pid, const std::string process_name) {
  WasapiRuntime& state = runtime();
  const WasapiProbeResult probe = probe_wasapi_backend();
  ScopedCoInitialize com(COINIT_APARTMENTTHREADED);
  if (!com.ok()) {
    record_runtime_failure(state, probe, "native-wasapi-com-initialization-failed", hresult_to_string(com.result));
    return;
  }

  ComPtr<IAudioClient> audio_client;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.status.activation_attempts += 1;
  }

  const HRESULT activate_result = activate_process_loopback_audio_client(pid, audio_client);
  if (FAILED(activate_result)) {
    record_runtime_failure(state, probe, "native-wasapi-session-start-failed", hresult_to_string(activate_result));
    return;
  }

  ComPtr<IAudioCaptureClient> capture_client;
  HANDLE sample_ready_event = nullptr;
  WasapiSessionStatus configured_status;
  apply_probe_to_status(configured_status, probe);
  configured_status.pid = static_cast<int>(pid);
  configured_status.process_name = process_name;
  configured_status.reason = "native-wasapi-capture-internal-only";
  configured_status.activation_attempts = 1;

  const HRESULT init_result = initialize_capture_client(audio_client.Get(), capture_client, sample_ready_event, configured_status);
  if (FAILED(init_result)) {
    record_runtime_failure(state, probe, "native-wasapi-session-start-failed", hresult_to_string(init_result));
    return;
  }

  const HRESULT start_result = audio_client->Start();
  if (FAILED(start_result)) {
    if (sample_ready_event) {
      CloseHandle(sample_ready_event);
    }
    record_runtime_failure(state, probe, "native-wasapi-session-start-failed", hresult_to_string(start_result));
    return;
  }

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.status = configured_status;
    state.status.running = true;
    state.status.capture_active = true;
    state.status.activation_successes = 1;
    state.status.last_error.clear();
    state.status.reason = "native-wasapi-capturing-internal-only";
    set_start_complete(state);
  }

  bool runtime_failed = false;
  std::string runtime_error;
  while (true) {
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      if (state.stop_requested) {
        break;
      }
    }

    const DWORD wait_result = WaitForSingleObject(sample_ready_event, 100);
    if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_TIMEOUT) {
      runtime_failed = true;
      runtime_error = hresult_to_string(HRESULT_FROM_WIN32(GetLastError()));
      break;
    }

    while (true) {
      UINT32 next_packet_frames = 0;
      const HRESULT next_packet_result = capture_client->GetNextPacketSize(&next_packet_frames);
      if (FAILED(next_packet_result)) {
        runtime_failed = true;
        runtime_error = hresult_to_string(next_packet_result);
        break;
      }

      if (next_packet_frames == 0) {
        break;
      }

      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 device_position = 0;
      UINT64 qpc_position = 0;
      UINT32 frames_available = 0;
      const HRESULT get_buffer_result = capture_client->GetBuffer(
        &data,
        &frames_available,
        &flags,
        &device_position,
        &qpc_position
      );
      if (FAILED(get_buffer_result)) {
        runtime_failed = true;
        runtime_error = hresult_to_string(get_buffer_result);
        break;
      }

      {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.status.packets_captured += 1;
        state.status.frames_captured += frames_available;
        state.status.last_buffer_frames = frames_available;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
          state.status.silent_packets += 1;
        }
      }

      WasapiSessionStatus snapshot;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        snapshot = state.status;
      }
      emit_audio_packet_event(
        state,
        snapshot,
        data,
        frames_available,
        (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0
      );

      const HRESULT release_result = capture_client->ReleaseBuffer(frames_available);
      if (FAILED(release_result)) {
        runtime_failed = true;
        runtime_error = hresult_to_string(release_result);
        break;
      }
    }

    if (runtime_failed) {
      break;
    }
  }

  audio_client->Stop();
  if (sample_ready_event) {
    CloseHandle(sample_ready_event);
    sample_ready_event = nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    apply_probe_to_status(state.status, probe);
    state.status.running = false;
    state.status.capture_active = false;
    if (runtime_failed) {
      state.status.reason = "native-wasapi-session-runtime-failed";
      state.status.last_error = runtime_error.empty()
        ? "WASAPI process-loopback capture stopped after a runtime failure."
        : runtime_error;
    } else if (state.status.last_error.empty()) {
      state.status.reason = "native-wasapi-session-stopped";
    }
    set_start_complete(state);
  }
}

WasapiSessionStatus snapshot_status_locked(WasapiRuntime& state, const WasapiProbeResult& probe) {
  apply_probe_to_status(state.status, probe);
  return state.status;
}

bool find_process_render_sessions(
  int pid,
  std::vector<ComPtr<ISimpleAudioVolume>>& volumes,
  std::string* error) {
  if (pid <= 0) {
    if (error) {
      *error = "A positive renderer PID is required.";
    }
    return false;
  }

  ScopedCoInitialize com(COINIT_MULTITHREADED);
  if (!com.ok()) {
    if (error) {
      *error = hresult_to_string(com.result);
    }
    return false;
  }

  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(
    __uuidof(MMDeviceEnumerator),
    nullptr,
    CLSCTX_ALL,
    IID_PPV_ARGS(&enumerator)
  );
  if (FAILED(hr) || !enumerator) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    return false;
  }

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
  if (FAILED(hr) || !device) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    return false;
  }

  ComPtr<IAudioSessionManager2> session_manager;
  hr = device->Activate(
    __uuidof(IAudioSessionManager2),
    CLSCTX_ALL,
    nullptr,
    reinterpret_cast<void**>(session_manager.GetAddressOf())
  );
  if (FAILED(hr) || !session_manager) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    return false;
  }

  ComPtr<IAudioSessionEnumerator> session_enumerator;
  hr = session_manager->GetSessionEnumerator(&session_enumerator);
  if (FAILED(hr) || !session_enumerator) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    return false;
  }

  int session_count = 0;
  hr = session_enumerator->GetCount(&session_count);
  if (FAILED(hr)) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    return false;
  }

  for (int index = 0; index < session_count; ++index) {
    ComPtr<IAudioSessionControl> control;
    hr = session_enumerator->GetSession(index, &control);
    if (FAILED(hr) || !control) {
      continue;
    }

    ComPtr<IAudioSessionControl2> control2;
    if (FAILED(control.As(&control2)) || !control2) {
      continue;
    }

    DWORD session_pid = 0;
    hr = control2->GetProcessId(&session_pid);
    if (FAILED(hr) || static_cast<int>(session_pid) != pid) {
      continue;
    }

    ComPtr<ISimpleAudioVolume> session_volume;
    if (FAILED(control.As(&session_volume)) || !session_volume) {
      continue;
    }

    volumes.push_back(session_volume);
  }

  if (volumes.empty()) {
    if (error) {
      *error = "No active render audio session was found for the target renderer PID.";
    }
    return false;
  }

  if (error) {
    error->clear();
  }
  return true;
}

}  // namespace

#endif

WasapiProbeResult probe_wasapi_backend() {
  WasapiProbeResult probe;

#ifndef _WIN32
  probe.reason = "wasapi-only-available-on-windows";
  probe.last_error = "WASAPI is only available on Windows.";
  return probe;
#else
  probe.platform_supported = true;

  const HRESULT init_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool should_uninitialize = SUCCEEDED(init_result);
  if (SUCCEEDED(init_result) || init_result == RPC_E_CHANGED_MODE) {
    probe.com_initialized = true;
  } else {
    probe.reason = "wasapi-com-initialization-failed";
    probe.last_error = hresult_to_string(init_result);
    return probe;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  const HRESULT create_result = CoCreateInstance(
    __uuidof(MMDeviceEnumerator),
    nullptr,
    CLSCTX_ALL,
    IID_PPV_ARGS(&enumerator)
  );

  if (FAILED(create_result) || !enumerator) {
    probe.reason = "wasapi-device-enumerator-unavailable";
    probe.last_error = hresult_to_string(create_result);
    if (should_uninitialize) {
      CoUninitialize();
    }
    return probe;
  }

  probe.device_enumerator_available = true;

  IMMDeviceCollection* devices = nullptr;
  const HRESULT enum_result = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
  if (SUCCEEDED(enum_result) && devices) {
    UINT count = 0;
    if (SUCCEEDED(devices->GetCount(&count))) {
      probe.render_device_count = count;
    }
    devices->Release();
  } else {
    probe.last_error = hresult_to_string(enum_result);
  }

  enumerator->Release();

  if (should_uninitialize) {
    CoUninitialize();
  }

  probe.reason = "native-wasapi-capture-available-internal-only";
  probe.last_error.clear();
  return probe;
#endif
}

WasapiSessionStatus get_wasapi_process_loopback_session_status() {
#ifndef _WIN32
  WasapiSessionStatus status;
  status.reason = "wasapi-only-available-on-windows";
  status.last_error = "WASAPI is only available on Windows.";
  return status;
#else
  WasapiRuntime& state = runtime();
  const WasapiProbeResult probe = probe_wasapi_backend();
  std::lock_guard<std::mutex> lock(state.mutex);
  return snapshot_status_locked(state, probe);
#endif
}

WasapiSessionStatus stop_wasapi_process_loopback_session() {
#ifndef _WIN32
  return get_wasapi_process_loopback_session_status();
#else
  WasapiRuntime& state = runtime();
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.stop_requested = true;
  }

  if (state.worker.joinable()) {
    state.worker.join();
  }

  const WasapiProbeResult probe = probe_wasapi_backend();
  std::lock_guard<std::mutex> lock(state.mutex);
  apply_probe_to_status(state.status, probe);
  state.status.running = false;
  state.status.capture_active = false;
  state.status.pid = 0;
  state.status.process_name.clear();
  state.stop_requested = false;
  state.start_completed = false;
  if (state.status.last_error.empty()) {
    state.status.reason = "native-wasapi-session-stopped";
  }
  return state.status;
#endif
}

WasapiSessionStatus start_wasapi_process_loopback_session(int pid, const std::string& process_name) {
#ifndef _WIN32
  return get_wasapi_process_loopback_session_status();
#else
  stop_wasapi_process_loopback_session();

  WasapiRuntime& state = runtime();
  const WasapiProbeResult probe = probe_wasapi_backend();

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.status = WasapiSessionStatus{};
    apply_probe_to_status(state.status, probe);
    state.status.pid = pid;
    state.status.process_name = process_name;
    state.status.reason = probe.reason;
    state.status.last_error = probe.last_error;
    state.start_completed = false;
    state.stop_requested = false;
  }

  if (pid <= 0) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.status.reason = "native-wasapi-invalid-pid";
    state.status.last_error = "A positive target PID is required for process-loopback capture.";
    state.start_completed = true;
    return state.status;
  }

  if (!probe.platform_supported || !probe.device_enumerator_available) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.start_completed = true;
    return state.status;
  }

  state.worker = std::thread(capture_worker_main, static_cast<DWORD>(pid), process_name);

  std::unique_lock<std::mutex> lock(state.mutex);
  const bool start_completed = state.start_cv.wait_for(lock, std::chrono::milliseconds(kWasapiStartTimeoutMs), [&]() {
    return state.start_completed;
  });
  if (!start_completed) {
    state.stop_requested = true;
    state.status.running = false;
    state.status.capture_active = false;
    state.status.reason = "native-wasapi-session-start-timeout";
    state.status.last_error = "WASAPI process-loopback capture did not finish starting in time.";
  }
  return state.status;
#endif
}

void set_wasapi_event_callback(WasapiEventCallback callback) {
#ifdef _WIN32
  WasapiRuntime& state = runtime();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.event_callback = callback;
#else
  (void)callback;
#endif
}

void set_wasapi_pcm_packet_callback(WasapiPcmPacketCallback callback) {
#ifdef _WIN32
  WasapiRuntime& state = runtime();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.pcm_packet_callback = callback;
#else
  (void)callback;
#endif
}

bool set_wasapi_render_session_volume_for_pid(int pid, float volume, float* effective_volume, std::string* error) {
#ifndef _WIN32
  if (error) {
    *error = "WASAPI render-session volume control is only available on Windows.";
  }
  if (effective_volume) {
    *effective_volume = 0.0f;
  }
  return false;
#else
  float clamped_volume = volume;
  if (clamped_volume < 0.0f) {
    clamped_volume = 0.0f;
  } else if (clamped_volume > 1.0f) {
    clamped_volume = 1.0f;
  }
  std::vector<ComPtr<ISimpleAudioVolume>> volumes;
  if (!find_process_render_sessions(pid, volumes, error)) {
    if (effective_volume) {
      *effective_volume = 0.0f;
    }
    return false;
  }

  for (const auto& session_volume : volumes) {
    const HRESULT hr = session_volume->SetMasterVolume(clamped_volume, nullptr);
    if (FAILED(hr)) {
      if (error) {
        *error = hresult_to_string(hr);
      }
      if (effective_volume) {
        *effective_volume = 0.0f;
      }
      return false;
    }
  }

  float resolved_volume = clamped_volume;
  const HRESULT hr = volumes.front()->GetMasterVolume(&resolved_volume);
  if (FAILED(hr)) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    if (effective_volume) {
      *effective_volume = 0.0f;
    }
    return false;
  }

  if (effective_volume) {
    *effective_volume = resolved_volume;
  }
  if (error) {
    error->clear();
  }
  return true;
#endif
}

bool get_wasapi_render_session_volume_for_pid(int pid, float* volume, std::string* error) {
#ifndef _WIN32
  if (error) {
    *error = "WASAPI render-session volume control is only available on Windows.";
  }
  if (volume) {
    *volume = 0.0f;
  }
  return false;
#else
  std::vector<ComPtr<ISimpleAudioVolume>> volumes;
  if (!find_process_render_sessions(pid, volumes, error)) {
    if (volume) {
      *volume = 0.0f;
    }
    return false;
  }

  float resolved_volume = 0.0f;
  const HRESULT hr = volumes.front()->GetMasterVolume(&resolved_volume);
  if (FAILED(hr)) {
    if (error) {
      *error = hresult_to_string(hr);
    }
    if (volume) {
      *volume = 0.0f;
    }
    return false;
  }

  if (volume) {
    *volume = resolved_volume;
  }
  if (error) {
    error->clear();
  }
  return true;
#endif
}
