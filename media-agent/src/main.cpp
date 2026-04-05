#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
}

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

#include "native_artifact_preview.h"
#include "native_live_preview.h"
#include "native_surface_layout.h"
#include "native_video_surface.h"
#include "peer_transport.h"
#include "wasapi_backend.h"
#include "win32_placeholder_frame.h"
#include "wgc_capture.h"

namespace fs = std::filesystem;

namespace {

struct AgentRuntimeState;

std::mutex g_output_mutex;
AgentRuntimeState* g_agent_runtime_for_audio = nullptr;

constexpr unsigned int kTransportAudioSampleRate = 48000;
constexpr unsigned int kTransportAudioChannelCount = 2;
constexpr unsigned int kTransportAudioBitrateKbps = 128;
constexpr unsigned int kViewerAudioSampleRate = kTransportAudioSampleRate;
constexpr unsigned int kViewerAudioChannelCount = kTransportAudioChannelCount;
constexpr unsigned int kViewerAudioStartupBufferFrames = 960;    // 20 ms @ 48 kHz device smoothing
constexpr unsigned int kViewerAudioMaxBufferedFrames = 9600;     // 200 ms @ 48 kHz
constexpr std::uint64_t kPeerAvSyncInitialLatencyUs = 180000;
constexpr std::uint64_t kPeerAvSyncMinLatencyUs = 120000;
constexpr std::uint64_t kPeerAvSyncMaxLatencyUs = 400000;
constexpr std::uint64_t kPeerAvSyncVideoClockRate = 90000;
constexpr std::uint64_t kPeerAvSyncLateToleranceUs = 15000;
constexpr std::uint64_t kPeerAvSyncEarlyRelaxUs = 50000;
constexpr std::size_t kPeerAvSyncMaxQueuedVideoUnits = 120;
constexpr std::size_t kPeerAvSyncMaxQueuedAudioBlocks = 32;
constexpr std::uint64_t kPeerAvSyncMaxSleepChunkUs = 10000;
constexpr std::uint64_t kPeerAvSyncForceReanchorWaitUs = 250000;
constexpr std::uint64_t kPeerAvSyncVideoStallRecoverUs = 120000;
constexpr std::uint64_t kPeerAvSyncVideoStallLeadAllowanceUs = 30000;
constexpr std::size_t kPeerAvSyncVideoBacklogPriorityUnits = 6;
constexpr std::size_t kPeerAvSyncAudioBacklogTrimTargetBlocks = 12;
constexpr std::uint64_t kPeerAvSyncCatchupLatencyStepUs = 4000;
constexpr std::uint64_t kPeerAvSyncAudioDispatchStarveUs = 40000;

#ifdef _WIN32
enum class WindowCaptureAvailability {
  normal,
  minimized,
  unavailable
};

HWND parse_runtime_window_handle(const std::string& value) {
  std::string trimmed = value;
  trimmed.erase(trimmed.begin(), std::find_if(trimmed.begin(), trimmed.end(), [](unsigned char ch) {
    return !std::isspace(ch);
  }));
  trimmed.erase(std::find_if(trimmed.rbegin(), trimmed.rend(), [](unsigned char ch) {
    return !std::isspace(ch);
  }).base(), trimmed.end());
  if (trimmed.empty()) {
    return nullptr;
  }

  try {
    std::size_t parsed_length = 0;
    const auto numeric = static_cast<std::uintptr_t>(std::stoull(trimmed, &parsed_length, 0));
    if (parsed_length != trimmed.size()) {
      return nullptr;
    }
    return reinterpret_cast<HWND>(numeric);
  } catch (...) {
    return nullptr;
  }
}

WindowCaptureAvailability query_window_capture_availability(const std::string& window_handle) {
  const HWND hwnd = parse_runtime_window_handle(window_handle);
  if (!hwnd || !IsWindow(hwnd)) {
    return WindowCaptureAvailability::unavailable;
  }
  if (IsIconic(hwnd)) {
    return WindowCaptureAvailability::minimized;
  }
  return WindowCaptureAvailability::normal;
}

std::vector<std::uint8_t> build_window_restore_placeholder_frame_bgra(int width, int height) {
  return build_placeholder_frame_bgra(
    width,
    height,
    L"\u7b49\u5f85\u623f\u4e3b\u7a97\u53e3\u6062\u590d"
  );
}
#endif

struct PeerState {
  struct PeerVideoSenderRuntime {
    bool launch_attempted = false;
    bool running = false;
    unsigned long process_id = 0;
    unsigned long long source_frames_captured = 0;
    unsigned long long source_bytes_captured = 0;
    unsigned long long source_copy_resource_us_total = 0;
    unsigned long long source_map_us_total = 0;
    unsigned long long source_memcpy_us_total = 0;
    unsigned long long source_total_readback_us_total = 0;
    unsigned long long frames_sent = 0;
    unsigned long long bytes_sent = 0;
    unsigned long long next_frame_timestamp_us = 0;
    unsigned long long frame_interval_us = 16666;
    long long next_frame_send_deadline_steady_us = -1;
    long long last_frame_sent_at_steady_us = -1;
    long long started_at_unix_ms = 0;
    long long updated_at_unix_ms = 0;
    long long stopped_at_unix_ms = 0;
    int last_exit_code = std::numeric_limits<int>::min();
    std::string command_line;
    std::string source_backend = "gdigrab";
    std::string codec_path = "h264";
    std::string reason = "peer-video-sender-idle";
    std::string last_error;
    std::vector<std::uint8_t> pending_video_annexb_bytes;
    std::vector<std::uint8_t> cached_video_decoder_config_au;
    std::vector<std::uint8_t> cached_video_random_access_au;
    bool pending_video_bootstrap = true;
    std::atomic<bool> soft_refresh_requested { false };
    std::atomic<bool> stop_requested { false };
#ifdef _WIN32
    HANDLE process_handle = nullptr;
    HANDLE thread_handle = nullptr;
    HANDLE stdin_write_handle = nullptr;
    HANDLE stdout_read_handle = nullptr;
#endif
    std::thread source_thread;
    std::thread pump_thread;
    std::mutex mutex;
  };

  struct PeerVideoReceiverRuntime {
    struct PeerAudioDecoderRuntime {
      std::mutex mutex;
      AVCodecContext* context = nullptr;
      AVPacket* packet = nullptr;
      AVFrame* frame = nullptr;
      std::string codec = "none";
      std::string last_error;
    };
    struct ScheduledVideoUnit {
      std::uint64_t remote_timestamp_us = 0;
      std::int64_t local_arrival_us = 0;
      std::string codec;
      std::vector<std::uint8_t> bytes;
    };
    struct ScheduledAudioBlock {
      std::uint64_t remote_timestamp_us = 0;
      std::int64_t local_arrival_us = 0;
      std::vector<std::int16_t> pcm;
    };
    bool surface_attached = false;
    bool launch_attempted = false;
    bool running = false;
    bool decoder_ready = false;
    bool av_sync_running = false;
    bool av_sync_thread_started = false;
    bool av_sync_anchor_initialized = false;
    bool av_sync_stop_requested = false;
    bool closing = false;
    bool local_playback_enabled = false;
    bool passthrough_playback_enabled = false;
    unsigned long process_id = 0;
    unsigned long long remote_frames_received = 0;
    unsigned long long remote_bytes_received = 0;
    unsigned long long decoded_frames_rendered = 0;
    unsigned long long scheduled_video_units = 0;
    unsigned long long scheduled_audio_blocks = 0;
    unsigned long long submitted_video_units = 0;
    unsigned long long dispatched_audio_blocks = 0;
    unsigned long long dropped_video_units = 0;
    unsigned long long dropped_audio_blocks = 0;
    double frame_interval_stddev_ms = 0.0;
    long long last_remote_frame_at_unix_ms = -1;
    long long last_decoded_frame_at_unix_ms = -1;
    long long last_start_attempt_at_unix_ms = 0;
    long long last_start_success_at_unix_ms = 0;
    long long last_stop_at_unix_ms = 0;
    long long av_sync_last_scheduler_wake_at_unix_ms = -1;
    long long av_sync_last_video_submit_at_unix_ms = -1;
    long long av_sync_last_audio_dispatch_at_unix_ms = -1;
    long long av_sync_last_video_lateness_us = 0;
    long long av_sync_last_audio_lateness_us = 0;
    long long av_sync_anchor_remote_us = 0;
    long long av_sync_anchor_local_us = 0;
    long long av_sync_target_latency_us = static_cast<long long>(kPeerAvSyncInitialLatencyUs);
    int last_exit_code = std::numeric_limits<int>::min();
    std::string peer_id;
    std::string surface_id;
    std::string target;
    std::string codec_path = "h264";
    std::string preview_surface_backend = "native-win32-gdi";
    std::string decoder_backend = "none";
    std::string implementation = "ffmpeg-native-video-surface";
    std::string window_title;
    std::string embedded_parent_debug;
    std::string surface_window_debug;
    std::string reason = "peer-video-surface-idle";
    std::string last_error;
    std::string command_line;
    std::shared_ptr<NativeVideoSurface> surface;
    std::shared_ptr<PeerAudioDecoderRuntime> audio_decoder_runtime;
    NativeEmbeddedSurfaceLayout surface_layout;
    std::vector<std::uint8_t> pending_video_annexb_bytes;
    std::vector<std::uint8_t> startup_video_decoder_config_au;
    bool startup_waiting_for_random_access = true;
    std::deque<ScheduledVideoUnit> scheduled_video_queue;
    std::deque<ScheduledAudioBlock> scheduled_audio_queue;
    std::condition_variable av_sync_cv;
    std::thread av_sync_thread;
#ifdef _WIN32
    unsigned long thread_id = 0;
#endif
    std::mutex mutex;
  };

  std::string peer_id;
  std::string role;
  bool initiator = false;
  bool has_remote_description = false;
  int remote_candidate_count = 0;
  struct MediaBindingState {
    bool attached = false;
    bool sender_configured = false;
    bool active = false;
    int width = 0;
    int height = 0;
    int frame_rate = 0;
    int bitrate_kbps = 0;
    long long attached_at_unix_ms = 0;
    long long updated_at_unix_ms = 0;
    long long detached_at_unix_ms = 0;
    std::string kind = "video";
    std::string source = "unbound";
    std::string codec = "h264";
    std::string video_encoder_backend = "none";
    std::string implementation = "libdatachannel-h264-track";
    std::string reason = "peer-media-not-attached";
    std::string last_error;
    unsigned long process_id = 0;
    unsigned long long source_frames_captured = 0;
    unsigned long long source_bytes_captured = 0;
    unsigned long long avg_source_copy_resource_us = 0;
    unsigned long long avg_source_map_us = 0;
    unsigned long long avg_source_memcpy_us = 0;
    unsigned long long avg_source_total_readback_us = 0;
    unsigned long long frames_sent = 0;
    unsigned long long bytes_sent = 0;
    std::string command_line;
    std::shared_ptr<PeerVideoSenderRuntime> runtime;
  } media_binding;
  PeerTransportSnapshot transport;
  std::shared_ptr<PeerTransportSession> transport_session;
  std::shared_ptr<PeerVideoReceiverRuntime> receiver_runtime;
};

struct CommandResult {
  bool launched = false;
  int exit_code = -1;
  std::string output;
};

struct VideoEncoderProbeResult {
  std::string name;
  bool exists = false;
  bool hardware = false;
  bool supports_low_latency = false;
  bool requires_hw_device = false;
  std::string hw_device_type;
  bool hw_device_ready = false;
  bool open_succeeded = false;
  bool output_succeeded = false;
  bool validated = false;
  int priority = 0;
  std::string reason;
  std::string error;
};

struct FfmpegProbeResult {
  bool available = false;
  std::string path;
  std::string version;
  std::vector<std::string> hwaccels;
  std::vector<std::string> bitstream_filters;
  std::vector<std::string> input_devices;
  std::vector<std::string> video_encoders;
  std::vector<std::string> validated_video_encoders;
  std::vector<VideoEncoderProbeResult> video_encoder_probes;
  std::vector<std::string> video_decoders;
  std::vector<std::string> audio_encoders;
  std::vector<std::string> audio_decoders;
  bool h264_metadata_bsf_available = false;
  bool hevc_metadata_bsf_available = false;
  std::string error;
};

struct AudioBackendProbe {
  bool ready = false;
  std::string backend_mode = "native-wasapi-agent";
  std::string implementation = "wasapi-process-loopback";
  std::string reason = "native-wasapi-capture-available-internal-only";
  std::string last_error;
  bool platform_supported = false;
  bool device_enumerator_available = false;
  unsigned int render_device_count = 0;
};

struct AudioSessionState {
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
  std::string last_error;
  std::string reason = "native-wasapi-capture-available-internal-only";
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

struct HostPipelineState {
  bool ready = false;
  bool hardware = false;
  bool validated = false;
  bool prefer_hardware = true;
  std::string requested_video_codec = "h264";
  std::string requested_video_encoder;
  std::string requested_preset = "balanced";
  std::string requested_tune;
  std::string selected_video_encoder;
  std::string video_encoder_backend = "none";
  std::string selected_audio_encoder;
  std::string implementation = "stub";
  std::string reason = "pipeline-not-initialized";
  std::string validation_reason = "pipeline-not-validated";
  std::string last_error;
};

struct HostCapturePlan {
  bool ready = false;
  bool validated = false;
  std::string capture_kind = "window";
  std::string capture_state = "normal";
  std::string preferred_capture_backend = "wgc";
  std::string capture_backend = "gdigrab";
  std::string capture_fallback_reason;
  std::string capture_handle;
  std::string capture_display_id = "0";
  int width = 1920;
  int height = 1080;
  int frame_rate = 60;
  int bitrate_kbps = 10000;
  int input_width = 0;
  int input_height = 0;
  std::string input_format;
  std::string input_target;
  std::string codec_path = "h264";
  std::string implementation = "stub";
  std::string reason = "capture-plan-not-initialized";
  std::string validation_reason = "capture-plan-not-validated";
  std::string last_error;
  std::string command_preview;
};

struct HostCaptureProcessState {
  bool enabled = false;
  bool launch_attempted = false;
  bool running = false;
  bool preserve_output = false;
  unsigned long process_id = 0;
  unsigned long long output_bytes = 0;
  long long started_at_unix_ms = 0;
  long long updated_at_unix_ms = 0;
  long long stopped_at_unix_ms = 0;
  int last_exit_code = std::numeric_limits<int>::min();
  std::string implementation = "ffmpeg-host-capture-process";
  std::string output_mode = "disabled";
  std::string container = "mpegts";
  std::string session_id;
  std::string output_directory;
  std::string output_path;
  std::string manifest_path;
  std::string reason = "host-capture-process-disabled";
  std::string last_error;
  std::string command_line;
#ifdef _WIN32
  HANDLE process_handle = nullptr;
  HANDLE thread_handle = nullptr;
#endif
};

struct SurfaceAttachmentState {
  bool attached = false;
  bool launch_attempted = false;
  bool running = false;
  bool waiting_for_artifact = false;
  bool decoder_ready = false;
  unsigned int restart_count = 0;
  unsigned long long decoded_frames_rendered = 0;
  double frame_interval_stddev_ms = 0.0;
  long long last_start_attempt_at_unix_ms = 0;
  long long last_start_success_at_unix_ms = 0;
  long long last_stop_at_unix_ms = 0;
  long long last_decoded_frame_at_unix_ms = -1;
  unsigned long process_id = 0;
  int last_exit_code = std::numeric_limits<int>::min();
  std::string surface_id;
  std::string target;
  std::string preview_surface_backend = "native-win32-gdi";
  std::string decoder_backend = "none";
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-native-artifact-preview";
  std::string media_path;
  std::string manifest_path;
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "surface-not-attached";
  std::string last_error;
  std::string command_line;
  std::string peer_id;
  NativeEmbeddedSurfaceLayout surface_layout;
  std::shared_ptr<PeerState::PeerVideoReceiverRuntime> peer_runtime;
  std::shared_ptr<NativeArtifactPreview> preview_runtime;
  std::shared_ptr<NativeLivePreview> live_preview_runtime;
#ifdef _WIN32
  HANDLE process_handle = nullptr;
  HANDLE thread_handle = nullptr;
#endif
};

struct HostCaptureArtifactProbe {
  bool available = false;
  bool ready = false;
  unsigned long long file_size_bytes = 0;
  int width = 0;
  int height = 0;
  double frame_rate = 0.0;
  long long last_probe_at_unix_ms = 0;
  std::string media_path;
  std::string format_name;
  std::string video_codec;
  std::string pixel_format;
  std::string reason = "artifact-not-probed";
  std::string last_error;
};

struct AgentRuntimeState {
  std::string viewer_playback_mode = "synced";
  unsigned int viewer_audio_delay_ms = 0;
  bool host_session_running = false;
  std::string host_capture_target_id;
  std::string host_requested_codec = "h264";
  std::string host_codec = "h264";
  bool host_hardware_acceleration = true;
  std::string host_video_encoder_preference;
  std::string host_encoder_preset = "balanced";
  std::string host_encoder_tune;
  std::string host_capture_kind = "window";
  std::string host_capture_state = "normal";
  std::string host_capture_title;
  std::string host_capture_hwnd;
  std::string host_capture_display_id;
  std::string host_capture_source_id;
  bool host_window_restore_placeholder_active = false;
  bool host_video_sender_refresh_requested = false;
  std::string host_video_sender_refresh_reason;
  int host_width = 1920;
  int host_height = 1080;
  int host_frame_rate = 60;
  int host_bitrate_kbps = 10000;
  std::map<std::string, PeerState> peers;
  std::map<std::string, SurfaceAttachmentState> attached_surfaces;
  PeerTransportBackendInfo peer_transport_backend;
  WgcCaptureProbe wgc_capture_backend;
  FfmpegProbeResult ffmpeg;
  AudioBackendProbe audio_backend_probe;
  AudioSessionState audio_session;
  HostPipelineState host_pipeline;
  HostCapturePlan host_capture_plan;
  HostCaptureProcessState host_capture_process;
  HostCaptureArtifactProbe host_capture_artifact;
  struct ViewerAudioPlaybackRuntime {
    struct QueuedPcmBlock {
      std::vector<std::int16_t> pcm;
      std::int64_t release_at_steady_us = 0;
    };
    bool running = false;
    bool ready = false;
    bool stop_requested = false;
    bool thread_started = false;
    bool playback_primed = false;
    bool passthrough_mode = false;
    unsigned long long audio_packets_received = 0;
    unsigned long long audio_bytes_received = 0;
    unsigned long long pcm_frames_queued = 0;
    unsigned long long pcm_frames_played = 0;
    unsigned long long buffered_pcm_frames = 0;
    unsigned int target_buffer_frames = kViewerAudioStartupBufferFrames;
    unsigned int channel_count = kViewerAudioChannelCount;
    unsigned int passthrough_audio_delay_ms = 0;
    float software_volume = 1.0f;
    std::string implementation = "native-waveout-opus-playback";
    std::string reason = "viewer-audio-idle";
    std::string last_error;
    std::mutex mutex;
    std::condition_variable cv;
    std::thread worker;
    std::deque<QueuedPcmBlock> pcm_queue;
#ifdef _WIN32
    HWAVEOUT wave_out = nullptr;
#endif
  } viewer_audio_playback;
};

struct HostAudioDispatchState {
  std::mutex mutex;
  std::vector<std::weak_ptr<PeerTransportSession>> sessions;
  unsigned long long next_timestamp_samples = 0;
  std::deque<std::int16_t> pending_pcm;
  AVCodecContext* encoder_context = nullptr;
  AVPacket* encoder_packet = nullptr;
  int encoder_frame_size = 960;
  std::string last_error;
};

HostAudioDispatchState& host_audio_dispatch_state() {
  static HostAudioDispatchState state;
  return state;
}

struct RelaySubscriberState {
  std::string peer_id;
  std::string upstream_peer_id;
  std::weak_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
  bool pending_video_bootstrap = true;
  bool bootstrap_snapshot_sent = false;
  unsigned long long frames_sent = 0;
  unsigned long long bytes_sent = 0;
  std::uint64_t last_video_timestamp_us = 0;
  long long next_video_send_deadline_steady_us = -1;
  std::string reason = "relay-subscriber-idle";
  std::string last_error;
  long long updated_at_unix_ms = 0;
};

struct RelayUpstreamVideoBootstrapState {
  struct CachedAccessUnit {
    std::vector<std::uint8_t> bytes;
    std::uint64_t timestamp_us = 0;
  };
  std::string codec_path = "h264";
  std::vector<std::uint8_t> decoder_config_au;
  std::vector<std::uint8_t> random_access_au;
  std::vector<CachedAccessUnit> gop_access_units;
};

struct QueuedRelayVideoDispatch {
  std::string upstream_peer_id;
  std::string codec;
  std::vector<std::vector<std::uint8_t>> access_units;
  std::uint32_t rtp_timestamp = 0;
};

struct RelayDispatchState {
  std::mutex mutex;
  std::condition_variable video_cv;
  std::map<std::string, std::vector<RelaySubscriberState>> subscribers_by_upstream_peer;
  std::map<std::string, RelayUpstreamVideoBootstrapState> video_bootstrap_by_upstream_peer;
  std::deque<QueuedRelayVideoDispatch> pending_video_dispatches;
  bool video_worker_started = false;
};

struct RelayDispatchTarget {
  std::string peer_id;
  std::string upstream_peer_id;
  std::shared_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
};

RelayDispatchState& relay_dispatch_state() {
  static RelayDispatchState state;
  return state;
}

constexpr std::size_t kMaxQueuedRelayVideoDispatches = 512;
constexpr std::size_t kMaxRelayBootstrapGopAccessUnits = 96;

std::string normalize_video_codec(const std::string& codec, const std::string& fallback = "h264");
bool video_access_unit_has_decoder_config_nal(const std::string& codec, const std::vector<std::uint8_t>& access_unit);
bool video_access_unit_has_random_access_nal(const std::string& codec, const std::vector<std::uint8_t>& access_unit);
bool video_bootstrap_is_complete(
  const std::string& codec,
  const std::vector<std::uint8_t>& decoder_config_au,
  const std::vector<std::uint8_t>& random_access_au);
bool is_hardware_video_encoder(const std::string& encoder);

std::int64_t current_time_micros_steady() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now().time_since_epoch()
  ).count();
}

bool sleep_until_steady_us(std::int64_t target_us, const std::atomic<bool>* stop_flag = nullptr) {
  while (true) {
    if (stop_flag && stop_flag->load()) {
      return false;
    }

    const std::int64_t now_us = current_time_micros_steady();
    if (target_us <= now_us) {
      return true;
    }

    const std::int64_t remaining_us = target_us - now_us;
    const auto sleep_for = std::chrono::microseconds(std::min<std::int64_t>(
      remaining_us,
      static_cast<std::int64_t>(kPeerAvSyncMaxSleepChunkUs)
    ));
    std::this_thread::sleep_for(sleep_for);
  }
}

std::uint64_t rtp_timestamp_to_us(std::uint32_t timestamp, std::uint64_t clock_rate) {
  if (clock_rate == 0) {
    return 0;
  }
  return (static_cast<std::uint64_t>(timestamp) * 1000000ull) / clock_rate;
}


std::string json_escape(const std::string& value) {
  std::ostringstream escaped;
  for (const char ch : value) {
    switch (ch) {
      case '\\':
        escaped << "\\\\";
        break;
      case '"':
        escaped << "\\\"";
        break;
      case '\n':
        escaped << "\\n";
        break;
      case '\r':
        escaped << "\\r";
        break;
      case '\t':
        escaped << "\\t";
        break;
      default:
        escaped << ch;
        break;
    }
  }
  return escaped.str();
}

std::string trim_copy(const std::string& value) {
  const auto begin = std::find_if_not(value.begin(), value.end(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  });
  const auto end = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  }).base();

  if (begin >= end) {
    return {};
  }

  return std::string(begin, end);
}

std::string json_unescape(const std::string& value) {
  std::string unescaped;
  unescaped.reserve(value.size());

  for (size_t index = 0; index < value.size(); ++index) {
    const char ch = value[index];
    if (ch != '\\' || index + 1 >= value.size()) {
      unescaped.push_back(ch);
      continue;
    }

    const char escaped = value[++index];
    switch (escaped) {
      case '\\':
        unescaped.push_back('\\');
        break;
      case '"':
        unescaped.push_back('"');
        break;
      case 'n':
        unescaped.push_back('\n');
        break;
      case 'r':
        unescaped.push_back('\r');
        break;
      case 't':
        unescaped.push_back('\t');
        break;
      default:
        unescaped.push_back(escaped);
        break;
    }
  }

  return unescaped;
}

long long current_time_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

void emit_breadcrumb(const std::string& step) {
  std::cerr << "[media-agent breadcrumb] t=" << current_time_millis()
            << " step=" << step << std::endl;
}

std::uint8_t linear16_to_ulaw_sample(std::int16_t sample) {
  constexpr int kBias = 0x84;
  constexpr int kClip = 32635;

  int value = static_cast<int>(sample);
  int sign = (value < 0) ? 0x80 : 0x00;
  if (value < 0) {
    value = -value;
  }
  if (value > kClip) {
    value = kClip;
  }
  value += kBias;

  int exponent = 7;
  for (int exp_mask = 0x4000; (value & exp_mask) == 0 && exponent > 0; exp_mask >>= 1) {
    --exponent;
  }

  const int mantissa = (value >> (exponent + 3)) & 0x0f;
  return static_cast<std::uint8_t>(~(sign | (exponent << 4) | mantissa));
}

std::int16_t ulaw_to_linear16_sample(std::uint8_t value) {
  value = static_cast<std::uint8_t>(~value);
  const int sign = value & 0x80;
  const int exponent = (value >> 4) & 0x07;
  const int mantissa = value & 0x0f;

  int sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return static_cast<std::int16_t>(sign ? -sample : sample);
}

std::vector<std::uint8_t> convert_capture_pcm_to_pcmu(
  const unsigned char* data,
  unsigned int frames,
  const WasapiSessionStatus& status) {
  std::vector<std::uint8_t> encoded;
  if (!data || frames == 0 || status.bits_per_sample != 16 || status.block_align == 0 || status.sample_rate == 0) {
    return encoded;
  }

  const unsigned int channel_count = std::max(1u, status.channel_count);
  const auto* samples = reinterpret_cast<const std::int16_t*>(data);
  const std::uint64_t output_frames = std::max<std::uint64_t>(1, (static_cast<std::uint64_t>(frames) * 8000ull) / status.sample_rate);
  encoded.reserve(static_cast<std::size_t>(output_frames));

  for (std::uint64_t output_index = 0; output_index < output_frames; ++output_index) {
    const std::uint64_t input_index =
      std::min<std::uint64_t>(frames - 1, (output_index * status.sample_rate) / 8000ull);
    std::int32_t mixed = 0;
    for (unsigned int channel = 0; channel < channel_count; ++channel) {
      mixed += samples[input_index * channel_count + channel];
    }
    mixed /= static_cast<std::int32_t>(channel_count);
    encoded.push_back(linear16_to_ulaw_sample(static_cast<std::int16_t>(mixed)));
  }

  return encoded;
}

std::vector<std::int16_t> decode_pcmu_to_pcm16(const std::vector<std::uint8_t>& encoded) {
  std::vector<std::int16_t> decoded;
  decoded.reserve(encoded.size());
  for (const std::uint8_t value : encoded) {
    decoded.push_back(ulaw_to_linear16_sample(value));
  }
  return decoded;
}

unsigned int pcm_sample_count_to_frames(std::size_t sample_count, unsigned int channel_count) {
  const unsigned int normalized_channel_count = std::max(1u, channel_count);
  return static_cast<unsigned int>(sample_count / normalized_channel_count);
}

std::vector<std::int16_t> convert_capture_pcm_to_opus_input(
  const unsigned char* data,
  unsigned int frames,
  const WasapiSessionStatus& status) {
  std::vector<std::int16_t> pcm;
  if (!data || frames == 0 || status.bits_per_sample != 16 || status.block_align == 0 || status.sample_rate == 0) {
    return pcm;
  }

  const unsigned int input_channels = std::max(1u, status.channel_count);
  const auto* samples = reinterpret_cast<const std::int16_t*>(data);
  const std::uint64_t output_frames = std::max<std::uint64_t>(
    1,
    (static_cast<std::uint64_t>(frames) * kTransportAudioSampleRate) / status.sample_rate
  );
  pcm.reserve(static_cast<std::size_t>(output_frames) * kTransportAudioChannelCount);

  for (std::uint64_t output_index = 0; output_index < output_frames; ++output_index) {
    const std::uint64_t input_index =
      std::min<std::uint64_t>(frames - 1, (output_index * status.sample_rate) / kTransportAudioSampleRate);

    std::int16_t left = 0;
    std::int16_t right = 0;
    if (input_channels == 1) {
      left = right = samples[input_index];
    } else {
      left = samples[input_index * input_channels];
      right = samples[input_index * input_channels + 1];
    }

    pcm.push_back(left);
    pcm.push_back(right);
  }

  return pcm;
}

bool ensure_host_audio_encoder_locked(HostAudioDispatchState& state, std::string* error) {
  if (state.encoder_context && state.encoder_packet) {
    return true;
  }

  const AVCodec* codec = avcodec_find_encoder_by_name("libopus");
  if (!codec) {
    if (error) {
      *error = "libopus-encoder-unavailable";
    }
    return false;
  }

  AVCodecContext* context = avcodec_alloc_context3(codec);
  AVPacket* packet = av_packet_alloc();
  if (!context || !packet) {
    if (context) {
      avcodec_free_context(&context);
    }
    if (packet) {
      av_packet_free(&packet);
    }
    if (error) {
      *error = "libopus-encoder-allocation-failed";
    }
    return false;
  }

  context->sample_rate = kTransportAudioSampleRate;
  context->bit_rate = kTransportAudioBitrateKbps * 1000;
  context->time_base = AVRational{ 1, static_cast<int>(kTransportAudioSampleRate) };
  av_channel_layout_default(&context->ch_layout, kTransportAudioChannelCount);
  context->sample_fmt = AV_SAMPLE_FMT_S16;

  AVDictionary* options = nullptr;
  av_dict_set(&options, "application", "lowdelay", 0);
  av_dict_set(&options, "vbr", "off", 0);
  const int open_result = avcodec_open2(context, codec, &options);
  av_dict_free(&options);
  if (open_result < 0) {
    avcodec_free_context(&context);
    av_packet_free(&packet);
    if (error) {
      *error = "libopus-encoder-open-failed";
    }
    return false;
  }

  state.encoder_context = context;
  state.encoder_packet = packet;
  state.encoder_frame_size = context->frame_size > 0 ? context->frame_size : 960;
  state.last_error.clear();
  return true;
}

void reset_host_audio_encoder_locked(HostAudioDispatchState& state) {
  state.pending_pcm.clear();
  state.last_error.clear();
  if (state.encoder_packet) {
    av_packet_free(&state.encoder_packet);
  }
  if (state.encoder_context) {
    avcodec_free_context(&state.encoder_context);
  }
  state.encoder_frame_size = 960;
}

bool send_host_audio_opus_frame_locked(
  HostAudioDispatchState& state,
  const std::vector<std::shared_ptr<PeerTransportSession>>& sessions,
  std::string* error) {
  if (!state.encoder_context || !state.encoder_packet) {
    if (error) {
      *error = "host-audio-encoder-not-ready";
    }
    return false;
  }

  const std::size_t required_samples =
    static_cast<std::size_t>(state.encoder_frame_size) * kTransportAudioChannelCount;
  if (state.pending_pcm.size() < required_samples) {
    return true;
  }

  AVFrame* frame = av_frame_alloc();
  if (!frame) {
    if (error) {
      *error = "host-audio-frame-allocation-failed";
    }
    return false;
  }

  frame->nb_samples = state.encoder_frame_size;
  frame->format = state.encoder_context->sample_fmt;
  frame->sample_rate = state.encoder_context->sample_rate;
  if (av_channel_layout_copy(&frame->ch_layout, &state.encoder_context->ch_layout) < 0 ||
      av_frame_get_buffer(frame, 0) < 0) {
    av_frame_free(&frame);
    if (error) {
      *error = "host-audio-frame-buffer-failed";
    }
    return false;
  }

  if (av_frame_make_writable(frame) < 0) {
    av_frame_free(&frame);
    if (error) {
      *error = "host-audio-frame-not-writable";
    }
    return false;
  }

  auto* interleaved = reinterpret_cast<std::int16_t*>(frame->data[0]);
  for (int index = 0; index < state.encoder_frame_size; ++index) {
    interleaved[index * 2] = state.pending_pcm.front();
    state.pending_pcm.pop_front();
    interleaved[index * 2 + 1] = state.pending_pcm.front();
    state.pending_pcm.pop_front();
  }

  const std::uint64_t timestamp_us =
    (state.next_timestamp_samples * 1000000ull) / kTransportAudioSampleRate;
  const int send_result = avcodec_send_frame(state.encoder_context, frame);
  av_frame_free(&frame);
  if (send_result < 0) {
    if (error) {
      *error = "host-audio-encoder-send-failed";
    }
    return false;
  }

  bool emitted_packet = false;
  while (true) {
    const int receive_result = avcodec_receive_packet(state.encoder_context, state.encoder_packet);
    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      break;
    }
    if (receive_result < 0) {
      if (error) {
        *error = "host-audio-encoder-receive-failed";
      }
      return false;
    }

    std::vector<std::uint8_t> encoded(
      state.encoder_packet->data,
      state.encoder_packet->data + state.encoder_packet->size
    );
    std::string send_error;
    for (const auto& session : sessions) {
      send_peer_transport_audio_frame(session, encoded, timestamp_us, &send_error);
    }
    av_packet_unref(state.encoder_packet);
    emitted_packet = true;
  }

  if (emitted_packet) {
    state.next_timestamp_samples += static_cast<unsigned long long>(state.encoder_frame_size);
  }

  return true;
}

bool ensure_peer_audio_decoder_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  std::string* error) {
  if (!runtime_ptr) {
    if (error) {
      *error = "peer-audio-runtime-missing";
    }
    return false;
  }

  if (!runtime_ptr->audio_decoder_runtime) {
    runtime_ptr->audio_decoder_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime::PeerAudioDecoderRuntime>();
  }

  auto& decoder = *runtime_ptr->audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  if (decoder.context && decoder.packet && decoder.frame) {
    return true;
  }

  const AVCodec* codec = avcodec_find_decoder_by_name("libopus");
  if (!codec) {
    codec = avcodec_find_decoder(AV_CODEC_ID_OPUS);
  }
  if (!codec) {
    if (error) {
      *error = "opus-decoder-unavailable";
    }
    return false;
  }

  AVCodecContext* context = avcodec_alloc_context3(codec);
  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  if (!context || !packet || !frame) {
    if (context) {
      avcodec_free_context(&context);
    }
    if (packet) {
      av_packet_free(&packet);
    }
    if (frame) {
      av_frame_free(&frame);
    }
    if (error) {
      *error = "opus-decoder-allocation-failed";
    }
    return false;
  }

  context->sample_rate = kTransportAudioSampleRate;
  av_channel_layout_default(&context->ch_layout, kTransportAudioChannelCount);
  if (avcodec_open2(context, codec, nullptr) < 0) {
    avcodec_free_context(&context);
    av_packet_free(&packet);
    av_frame_free(&frame);
    if (error) {
      *error = "opus-decoder-open-failed";
    }
    return false;
  }

  decoder.context = context;
  decoder.packet = packet;
  decoder.frame = frame;
  decoder.codec = "opus";
  decoder.last_error.clear();
  return true;
}

void reset_peer_audio_decoder_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
  if (!runtime.audio_decoder_runtime) {
    return;
  }

  auto& decoder = *runtime.audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  if (decoder.frame) {
    av_frame_free(&decoder.frame);
  }
  if (decoder.packet) {
    av_packet_free(&decoder.packet);
  }
  if (decoder.context) {
    avcodec_free_context(&decoder.context);
  }
  decoder.codec = "none";
  decoder.last_error.clear();
}

std::vector<std::int16_t> decode_opus_to_pcm16(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& encoded,
  std::string* error) {
  std::vector<std::int16_t> pcm;
  if (!ensure_peer_audio_decoder_runtime(runtime_ptr, error)) {
    return pcm;
  }

  auto& decoder = *runtime_ptr->audio_decoder_runtime;
  std::lock_guard<std::mutex> decoder_lock(decoder.mutex);
  decoder.packet->data = const_cast<std::uint8_t*>(encoded.data());
  decoder.packet->size = static_cast<int>(encoded.size());

  const int send_result = avcodec_send_packet(decoder.context, decoder.packet);
  if (send_result < 0) {
    if (error) {
      *error = "opus-decoder-send-failed";
    }
    av_packet_unref(decoder.packet);
    return pcm;
  }
  av_packet_unref(decoder.packet);

  while (true) {
    const int receive_result = avcodec_receive_frame(decoder.context, decoder.frame);
    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      break;
    }
    if (receive_result < 0) {
      if (error) {
        *error = "opus-decoder-receive-failed";
      }
      break;
    }

    const int channel_count = decoder.frame->ch_layout.nb_channels > 0
      ? decoder.frame->ch_layout.nb_channels
      : kTransportAudioChannelCount;
    const int sample_count = decoder.frame->nb_samples;
    const AVSampleFormat sample_format = static_cast<AVSampleFormat>(decoder.frame->format);

    const auto append_interleaved_s16 = [&](auto read_sample) {
      const std::size_t start = pcm.size();
      pcm.resize(start + static_cast<std::size_t>(sample_count) * channel_count);
      for (int sample_index = 0; sample_index < sample_count; ++sample_index) {
        for (int channel_index = 0; channel_index < channel_count; ++channel_index) {
          pcm[start + static_cast<std::size_t>(sample_index) * channel_count + channel_index] =
            read_sample(sample_index, channel_index);
        }
      }
    };

    if (sample_format == AV_SAMPLE_FMT_S16) {
      const auto* interleaved = reinterpret_cast<const std::int16_t*>(decoder.frame->data[0]);
      append_interleaved_s16([&](int sample_index, int channel_index) {
        return interleaved[sample_index * channel_count + channel_index];
      });
    } else if (sample_format == AV_SAMPLE_FMT_S16P) {
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const auto* plane = reinterpret_cast<const std::int16_t*>(decoder.frame->data[channel_index]);
        return plane[sample_index];
      });
    } else if (sample_format == AV_SAMPLE_FMT_FLT) {
      const auto* interleaved = reinterpret_cast<const float*>(decoder.frame->data[0]);
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const float value = interleaved[sample_index * channel_count + channel_index] * 32767.0f;
        return static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, value)));
      });
    } else if (sample_format == AV_SAMPLE_FMT_FLTP) {
      append_interleaved_s16([&](int sample_index, int channel_index) {
        const auto* plane = reinterpret_cast<const float*>(decoder.frame->data[channel_index]);
        const float value = plane[sample_index] * 32767.0f;
        return static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, value)));
      });
    } else {
      if (error) {
        *error = "opus-decoder-unsupported-sample-format";
      }
      av_frame_unref(decoder.frame);
      pcm.clear();
      return pcm;
    }

    av_frame_unref(decoder.frame);
  }

  return pcm;
}

void register_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session) {
  if (!session) {
    return;
  }

  auto& state = host_audio_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto it = state.sessions.begin(); it != state.sessions.end();) {
    const auto existing = it->lock();
    if (!existing) {
      it = state.sessions.erase(it);
      continue;
    }
    if (existing == session) {
      return;
    }
    ++it;
  }
  state.sessions.push_back(session);
}

void unregister_host_audio_transport_session(const std::shared_ptr<PeerTransportSession>& session) {
  auto& state = host_audio_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto it = state.sessions.begin(); it != state.sessions.end();) {
    const auto existing = it->lock();
    if (!existing || existing == session) {
      it = state.sessions.erase(it);
      continue;
    }
    ++it;
  }
}

void reset_host_audio_transport_sessions() {
  auto& state = host_audio_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.sessions.clear();
  state.next_timestamp_samples = 0;
  reset_host_audio_encoder_locked(state);
}

void dispatch_host_audio_capture_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) {
  auto& state = host_audio_dispatch_state();

  std::vector<std::shared_ptr<PeerTransportSession>> sessions;
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto it = state.sessions.begin(); it != state.sessions.end();) {
    const auto session = it->lock();
    if (!session) {
      it = state.sessions.erase(it);
      continue;
    }
    sessions.push_back(session);
    ++it;
  }

  if (sessions.empty()) {
    return;
  }

  std::string encoder_error;
  if (!ensure_host_audio_encoder_locked(state, &encoder_error)) {
    state.last_error = encoder_error;
    return;
  }

  std::vector<std::int16_t> pcm = silent
    ? std::vector<std::int16_t>(static_cast<std::size_t>(std::max(1u, static_cast<unsigned int>((static_cast<std::uint64_t>(frames) * kTransportAudioSampleRate) / std::max(1u, status.sample_rate)))) * kTransportAudioChannelCount, 0)
    : convert_capture_pcm_to_opus_input(data, frames, status);
  if (pcm.empty()) {
    return;
  }

  for (const std::int16_t sample : pcm) {
    state.pending_pcm.push_back(sample);
  }

  while (state.pending_pcm.size() >= static_cast<std::size_t>(state.encoder_frame_size) * kTransportAudioChannelCount) {
    std::string send_error;
    if (!send_host_audio_opus_frame_locked(state, sessions, &send_error)) {
      state.last_error = send_error;
      break;
    }
  }
}

#ifdef _WIN32
void stop_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime);

void viewer_audio_playback_worker(AgentRuntimeState::ViewerAudioPlaybackRuntime* runtime) {
  if (!runtime) {
    return;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kViewerAudioChannelCount;
  format.nSamplesPerSec = kViewerAudioSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  HWAVEOUT wave_out = nullptr;
  MMRESULT open_result = waveOutOpen(&wave_out, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL);
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    if (open_result != MMSYSERR_NOERROR || !wave_out) {
      runtime->running = false;
      runtime->ready = false;
      runtime->last_error = "viewer-audio-waveout-open-failed";
      runtime->reason = "viewer-audio-open-failed";
      return;
    }
    runtime->wave_out = wave_out;
    runtime->running = true;
    runtime->ready = true;
    runtime->playback_primed = false;
    runtime->reason = "viewer-audio-buffering";
  }

  std::vector<WAVEHDR*> in_flight_headers;
  while (true) {
    std::vector<std::int16_t> pcm_block;
    std::int64_t release_at_steady_us = 0;
    float volume = 1.0f;
    {
      std::unique_lock<std::mutex> lock(runtime->mutex);
      runtime->cv.wait_for(lock, std::chrono::milliseconds(20), [&]() {
        if (runtime->stop_requested) {
          return true;
        }
        if (runtime->pcm_queue.empty()) {
          return false;
        }
        if (runtime->passthrough_mode) {
          return runtime->pcm_queue.front().release_at_steady_us <= current_time_micros_steady();
        }
        if (runtime->playback_primed) {
          return true;
        }
        return runtime->buffered_pcm_frames >= runtime->target_buffer_frames;
      });

      if (runtime->stop_requested && runtime->pcm_queue.empty()) {
        break;
      }

      if (runtime->pcm_queue.empty()) {
        continue;
      }

      if (runtime->passthrough_mode) {
        release_at_steady_us = runtime->pcm_queue.front().release_at_steady_us;
        const std::int64_t now_steady_us = current_time_micros_steady();
        if (!runtime->stop_requested && release_at_steady_us > now_steady_us) {
          runtime->reason = "viewer-audio-delay-waiting";
          continue;
        }
        if (!runtime->playback_primed) {
          runtime->playback_primed = true;
          runtime->reason = "viewer-audio-running";
        }
      }

      if (!runtime->passthrough_mode && !runtime->playback_primed) {
        if (runtime->buffered_pcm_frames < runtime->target_buffer_frames) {
          runtime->reason = "viewer-audio-buffering";
          continue;
        }
        runtime->playback_primed = true;
        runtime->reason = "viewer-audio-running";
      }

      pcm_block = std::move(runtime->pcm_queue.front().pcm);
      runtime->pcm_queue.pop_front();
      const unsigned int pcm_block_frames = pcm_sample_count_to_frames(pcm_block.size(), runtime->channel_count);
      runtime->buffered_pcm_frames = runtime->buffered_pcm_frames > pcm_block_frames
        ? runtime->buffered_pcm_frames - pcm_block_frames
        : 0;
      volume = runtime->software_volume;
    }

    for (auto it = in_flight_headers.begin(); it != in_flight_headers.end();) {
      WAVEHDR* header = *it;
      if ((header->dwFlags & WHDR_DONE) != 0) {
        waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
        delete[] reinterpret_cast<char*>(header->lpData);
        delete header;
        it = in_flight_headers.erase(it);
        continue;
      }
      ++it;
    }

    if (pcm_block.empty()) {
      continue;
    }

    for (auto& sample : pcm_block) {
      const float scaled = static_cast<float>(sample) * volume;
      sample = static_cast<std::int16_t>(std::max(-32768.0f, std::min(32767.0f, scaled)));
    }

    const std::size_t byte_count = pcm_block.size() * sizeof(std::int16_t);
    auto* buffer = new char[byte_count];
    std::memcpy(buffer, pcm_block.data(), byte_count);

    auto* header = new WAVEHDR{};
    header->lpData = buffer;
    header->dwBufferLength = static_cast<DWORD>(byte_count);
    if (waveOutPrepareHeader(wave_out, header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR ||
        waveOutWrite(wave_out, header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
      waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
      delete[] buffer;
      delete header;
      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->last_error = "viewer-audio-waveout-write-failed";
      runtime->reason = "viewer-audio-write-failed";
      continue;
    }

    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->pcm_frames_played += pcm_sample_count_to_frames(pcm_block.size(), runtime->channel_count);
    }
    in_flight_headers.push_back(header);
  }

  waveOutReset(wave_out);
  for (WAVEHDR* header : in_flight_headers) {
    waveOutUnprepareHeader(wave_out, header, sizeof(WAVEHDR));
    delete[] reinterpret_cast<char*>(header->lpData);
    delete header;
  }
  waveOutClose(wave_out);

  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->wave_out = nullptr;
    runtime->running = false;
    runtime->ready = false;
    runtime->thread_started = false;
    runtime->playback_primed = false;
    runtime->buffered_pcm_frames = 0;
    if (runtime->reason == "viewer-audio-running") {
      runtime->reason = "viewer-audio-stopped";
    }
  }
}
#endif

void ensure_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
#ifdef _WIN32
  std::lock_guard<std::mutex> lock(runtime.mutex);
  if (runtime.thread_started) {
    return;
  }
  runtime.stop_requested = false;
  runtime.thread_started = true;
  runtime.worker = std::thread(viewer_audio_playback_worker, &runtime);
#else
  (void)runtime;
#endif
}

void stop_viewer_audio_playback_runtime(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
#ifdef _WIN32
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.stop_requested = true;
    runtime.cv.notify_all();
  }
  if (runtime.worker.joinable()) {
    runtime.worker.join();
  }
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.pcm_queue.clear();
  runtime.buffered_pcm_frames = 0;
  runtime.playback_primed = false;
#else
  (void)runtime;
#endif
}

void queue_viewer_audio_pcm_block(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime,
  std::vector<std::int16_t> pcm_block) {
  if (pcm_block.empty()) {
    return;
  }

  ensure_viewer_audio_playback_runtime(runtime);
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    AgentRuntimeState::ViewerAudioPlaybackRuntime::QueuedPcmBlock queued_block;
    queued_block.release_at_steady_us = runtime.passthrough_mode
      ? (current_time_micros_steady() + static_cast<std::int64_t>(runtime.passthrough_audio_delay_ms) * 1000)
      : 0;
    queued_block.pcm = std::move(pcm_block);

    runtime.audio_packets_received += 1;
    runtime.audio_bytes_received += queued_block.pcm.size() * sizeof(std::int16_t);
    runtime.pcm_frames_queued += pcm_sample_count_to_frames(queued_block.pcm.size(), runtime.channel_count);
    runtime.buffered_pcm_frames += pcm_sample_count_to_frames(queued_block.pcm.size(), runtime.channel_count);
    runtime.reason = runtime.passthrough_mode
      ? "viewer-audio-passthrough-queued"
      : (runtime.playback_primed ? "viewer-audio-queued" : "viewer-audio-buffering");
    runtime.pcm_queue.push_back(std::move(queued_block));
    while (!runtime.pcm_queue.empty() && runtime.buffered_pcm_frames > kViewerAudioMaxBufferedFrames) {
      const unsigned int front_frames = pcm_sample_count_to_frames(runtime.pcm_queue.front().pcm.size(), runtime.channel_count);
      runtime.buffered_pcm_frames = runtime.buffered_pcm_frames > front_frames
        ? runtime.buffered_pcm_frames - front_frames
        : 0;
      runtime.pcm_queue.pop_front();
      runtime.playback_primed = false;
      runtime.reason = "viewer-audio-rebuffering";
    }
  }
  runtime.cv.notify_one();
}

bool submit_scheduled_video_unit_to_surface(
  const std::string& peer_id,
  PeerState::PeerVideoReceiverRuntime& runtime,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec_path,
  std::string* warning_message);

void register_relay_subscriber(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::shared_ptr<PeerTransportSession>& session,
  bool audio_enabled) {
  if (upstream_peer_id.empty() || peer_id.empty() || !session) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto& subscribers = state.subscribers_by_upstream_peer[upstream_peer_id];
  for (auto& subscriber : subscribers) {
    if (subscriber.peer_id == peer_id) {
      subscriber.session = session;
      subscriber.audio_enabled = audio_enabled;
      subscriber.pending_video_bootstrap = true;
      subscriber.bootstrap_snapshot_sent = false;
      subscriber.last_video_timestamp_us = 0;
      subscriber.next_video_send_deadline_steady_us = -1;
      subscriber.reason = "relay-subscriber-registered";
      subscriber.last_error.clear();
      subscriber.updated_at_unix_ms = current_time_millis();
      return;
    }
  }

  RelaySubscriberState subscriber;
  subscriber.peer_id = peer_id;
  subscriber.upstream_peer_id = upstream_peer_id;
  subscriber.session = session;
  subscriber.audio_enabled = audio_enabled;
  subscriber.pending_video_bootstrap = true;
  subscriber.bootstrap_snapshot_sent = false;
  subscriber.last_video_timestamp_us = 0;
  subscriber.next_video_send_deadline_steady_us = -1;
  subscriber.reason = "relay-subscriber-registered";
  subscriber.updated_at_unix_ms = current_time_millis();
  subscribers.push_back(std::move(subscriber));
}

void unregister_relay_subscriber(const std::string& peer_id) {
  if (peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (auto upstream_it = state.subscribers_by_upstream_peer.begin();
       upstream_it != state.subscribers_by_upstream_peer.end();) {
    auto& subscribers = upstream_it->second;
    subscribers.erase(
      std::remove_if(subscribers.begin(), subscribers.end(), [&](const RelaySubscriberState& subscriber) {
        const auto session = subscriber.session.lock();
        return subscriber.peer_id == peer_id || !session;
      }),
      subscribers.end()
    );
    if (subscribers.empty()) {
      upstream_it = state.subscribers_by_upstream_peer.erase(upstream_it);
      continue;
    }
    ++upstream_it;
  }
}

void clear_relay_upstream_bootstrap_state(const std::string& upstream_peer_id) {
  if (upstream_peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  state.video_bootstrap_by_upstream_peer.erase(upstream_peer_id);
}

void cache_relay_video_bootstrap_access_unit(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit,
  std::uint64_t timestamp_us) {
  if (upstream_peer_id.empty() || access_unit.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto& bootstrap = state.video_bootstrap_by_upstream_peer[upstream_peer_id];
  const std::string normalized_codec = normalize_video_codec(codec);
  if (bootstrap.codec_path != normalized_codec) {
    bootstrap.codec_path = normalized_codec;
    bootstrap.decoder_config_au.clear();
    bootstrap.random_access_au.clear();
    bootstrap.gop_access_units.clear();

    auto subscribers_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
    if (subscribers_it != state.subscribers_by_upstream_peer.end()) {
      for (auto& subscriber : subscribers_it->second) {
        subscriber.pending_video_bootstrap = true;
        subscriber.bootstrap_snapshot_sent = false;
      }
    }
  }

  if (video_access_unit_has_decoder_config_nal(bootstrap.codec_path, access_unit)) {
    bootstrap.decoder_config_au = access_unit;
  }
  if (video_access_unit_has_random_access_nal(bootstrap.codec_path, access_unit)) {
    bootstrap.random_access_au = access_unit;
    bootstrap.gop_access_units.clear();
  }
  if (!bootstrap.random_access_au.empty()) {
    RelayUpstreamVideoBootstrapState::CachedAccessUnit cached;
    cached.bytes = access_unit;
    cached.timestamp_us = timestamp_us;
    bootstrap.gop_access_units.push_back(std::move(cached));
    while (bootstrap.gop_access_units.size() > kMaxRelayBootstrapGopAccessUnits) {
      bootstrap.gop_access_units.erase(bootstrap.gop_access_units.begin());
    }
  }
}

bool collect_relay_video_bootstrap_access_units(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::vector<std::vector<std::uint8_t>>& current_access_units,
  std::uint64_t current_timestamp_us,
  std::vector<RelayUpstreamVideoBootstrapState::CachedAccessUnit>* out_access_units) {
  if (!out_access_units || upstream_peer_id.empty() || peer_id.empty()) {
    return false;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return false;
  }

  RelaySubscriberState* matched_subscriber = nullptr;
  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id == peer_id) {
      matched_subscriber = &subscriber;
      break;
    }
  }
  if (!matched_subscriber || !matched_subscriber->pending_video_bootstrap) {
    return false;
  }

  auto bootstrap_it = state.video_bootstrap_by_upstream_peer.find(upstream_peer_id);
  if (bootstrap_it == state.video_bootstrap_by_upstream_peer.end()) {
    return false;
  }

  if (!video_bootstrap_is_complete(
        bootstrap_it->second.codec_path,
        bootstrap_it->second.decoder_config_au,
        bootstrap_it->second.random_access_au)) {
    return false;
  }

  if (!matched_subscriber->bootstrap_snapshot_sent) {
    if (!bootstrap_it->second.gop_access_units.empty()) {
      const std::uint64_t bootstrap_timestamp_us =
        bootstrap_it->second.gop_access_units.front().timestamp_us > 0
          ? bootstrap_it->second.gop_access_units.front().timestamp_us
          : current_timestamp_us;
      if (!bootstrap_it->second.decoder_config_au.empty()) {
        RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
        config_unit.bytes = bootstrap_it->second.decoder_config_au;
        config_unit.timestamp_us = bootstrap_timestamp_us;
        out_access_units->push_back(std::move(config_unit));
      }
      for (const auto& cached_unit : bootstrap_it->second.gop_access_units) {
        if (!out_access_units->empty() && out_access_units->back().bytes == cached_unit.bytes) {
          continue;
        }
        out_access_units->push_back(cached_unit);
      }
      if (!out_access_units->empty()) {
        matched_subscriber->bootstrap_snapshot_sent = true;
        matched_subscriber->pending_video_bootstrap = false;
        return true;
      }
    }

    if (!bootstrap_it->second.decoder_config_au.empty()) {
      RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
      config_unit.bytes = bootstrap_it->second.decoder_config_au;
      config_unit.timestamp_us = current_timestamp_us;
      out_access_units->push_back(std::move(config_unit));
    }
    if (!bootstrap_it->second.random_access_au.empty() &&
        (out_access_units->empty() || out_access_units->back().bytes != bootstrap_it->second.random_access_au)) {
      RelayUpstreamVideoBootstrapState::CachedAccessUnit random_access_unit;
      random_access_unit.bytes = bootstrap_it->second.random_access_au;
      random_access_unit.timestamp_us = current_timestamp_us;
      out_access_units->push_back(std::move(random_access_unit));
    }
    if (!out_access_units->empty()) {
      matched_subscriber->bootstrap_snapshot_sent = true;
      return true;
    }
  }

  auto random_access_it = std::find_if(
    current_access_units.begin(),
    current_access_units.end(),
    [&](const std::vector<std::uint8_t>& access_unit) {
      return video_access_unit_has_random_access_nal(bootstrap_it->second.codec_path, access_unit);
    }
  );
  if (random_access_it == current_access_units.end()) {
    return false;
  }

  if (!bootstrap_it->second.decoder_config_au.empty()) {
    RelayUpstreamVideoBootstrapState::CachedAccessUnit config_unit;
    config_unit.bytes = bootstrap_it->second.decoder_config_au;
    config_unit.timestamp_us = current_timestamp_us;
    out_access_units->push_back(std::move(config_unit));
  }
  for (auto it = random_access_it; it != current_access_units.end(); ++it) {
    if (!out_access_units->empty() && out_access_units->back().bytes == *it) {
      continue;
    }
    RelayUpstreamVideoBootstrapState::CachedAccessUnit unit;
    unit.bytes = *it;
    unit.timestamp_us = current_timestamp_us;
    out_access_units->push_back(std::move(unit));
  }
  if (out_access_units->empty()) {
    return false;
  }

  matched_subscriber->bootstrap_snapshot_sent = true;
  matched_subscriber->pending_video_bootstrap = false;
  return true;
}

bool query_relay_subscriber_state(
  const std::string& peer_id,
  RelaySubscriberState* out_state) {
  if (peer_id.empty()) {
    return false;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  for (const auto& entry : state.subscribers_by_upstream_peer) {
    for (const auto& subscriber : entry.second) {
      if (subscriber.peer_id == peer_id) {
        if (out_state) {
          *out_state = subscriber;
        }
        return true;
      }
    }
  }
  return false;
}

std::vector<RelayDispatchTarget> collect_relay_dispatch_targets(const std::string& upstream_peer_id) {
  std::vector<RelayDispatchTarget> targets;
  if (upstream_peer_id.empty()) {
    return targets;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return targets;
  }

  auto& subscribers = upstream_it->second;
  for (auto subscriber_it = subscribers.begin(); subscriber_it != subscribers.end();) {
    const auto session = subscriber_it->session.lock();
    if (!session) {
      subscriber_it = subscribers.erase(subscriber_it);
      continue;
    }

    RelayDispatchTarget target;
    target.peer_id = subscriber_it->peer_id;
    target.upstream_peer_id = upstream_peer_id;
    target.session = session;
    target.audio_enabled = subscriber_it->audio_enabled;
    targets.push_back(std::move(target));
    ++subscriber_it;
  }

  if (subscribers.empty()) {
    state.subscribers_by_upstream_peer.erase(upstream_it);
  }

  return targets;
}

void update_relay_subscriber_runtime(
  const std::string& upstream_peer_id,
  const std::string& peer_id,
  const std::string& reason,
  const std::string& last_error,
  unsigned long long frames_delta,
  unsigned long long bytes_delta) {
  if (upstream_peer_id.empty() || peer_id.empty()) {
    return;
  }

  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  auto upstream_it = state.subscribers_by_upstream_peer.find(upstream_peer_id);
  if (upstream_it == state.subscribers_by_upstream_peer.end()) {
    return;
  }

  for (auto& subscriber : upstream_it->second) {
    if (subscriber.peer_id != peer_id) {
      continue;
    }

    subscriber.reason = reason;
    subscriber.last_error = last_error;
    subscriber.frames_sent += frames_delta;
    subscriber.bytes_sent += bytes_delta;
    subscriber.updated_at_unix_ms = current_time_millis();
    return;
  }
}

void fanout_relay_video_units_now(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  const std::uint64_t timestamp_us = rtp_timestamp_to_us(rtp_timestamp, kPeerAvSyncVideoClockRate);
  for (const auto& access_unit : access_units) {
    cache_relay_video_bootstrap_access_unit(upstream_peer_id, codec, access_unit, timestamp_us);
  }

  const auto targets = collect_relay_dispatch_targets(upstream_peer_id);
  if (targets.empty()) {
    return;
  }

  for (const auto& target : targets) {
    const PeerTransportSnapshot snapshot = get_peer_transport_snapshot(target.session);
    if (!snapshot.remote_description_set || snapshot.connection_state != "connected") {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-peer-connected",
        "",
        0,
        0
      );
      continue;
    }
    if (!snapshot.video_track_open) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-video-track-open",
        "",
        0,
        0
      );
      continue;
    }

    bool send_failed = false;
    std::string send_error;
    unsigned long long sent_frames = 0;
    unsigned long long sent_bytes = 0;
    std::vector<RelayUpstreamVideoBootstrapState::CachedAccessUnit> units_to_send;
    const bool using_bootstrap =
      collect_relay_video_bootstrap_access_units(
        upstream_peer_id,
        target.peer_id,
        access_units,
        timestamp_us,
        &units_to_send
      );
    if (!using_bootstrap) {
      RelaySubscriberState relay_state;
      if (query_relay_subscriber_state(target.peer_id, &relay_state) && relay_state.pending_video_bootstrap) {
        update_relay_subscriber_runtime(
          upstream_peer_id,
          target.peer_id,
          "relay-waiting-for-random-access",
          "",
          0,
          0
        );
        continue;
      }
      for (const auto& access_unit : access_units) {
        RelayUpstreamVideoBootstrapState::CachedAccessUnit live_unit;
        live_unit.bytes = access_unit;
        live_unit.timestamp_us = timestamp_us;
        units_to_send.push_back(std::move(live_unit));
      }
    }
    for (const auto& access_unit : units_to_send) {
      const std::uint64_t unit_timestamp_us = access_unit.timestamp_us > 0 ? access_unit.timestamp_us : timestamp_us;
      if (!send_peer_transport_video_frame(target.session, access_unit.bytes, codec, unit_timestamp_us, &send_error)) {
        send_failed = true;
        break;
      }
      sent_frames += 1;
      sent_bytes += static_cast<unsigned long long>(access_unit.bytes.size());
    }

    if (send_failed) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-video-send-failed",
        send_error,
        sent_frames,
        sent_bytes
      );
    } else {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-video-forwarding",
        "",
        sent_frames,
        sent_bytes
      );
    }
  }
}

void ensure_relay_video_dispatch_worker_running() {
  auto& state = relay_dispatch_state();
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.video_worker_started) {
    return;
  }

  state.video_worker_started = true;
  std::thread([]() {
    auto& worker_state = relay_dispatch_state();
    while (true) {
      QueuedRelayVideoDispatch task;
      {
        std::unique_lock<std::mutex> lock(worker_state.mutex);
        worker_state.video_cv.wait(lock, [&]() {
          return !worker_state.pending_video_dispatches.empty();
        });
        task = std::move(worker_state.pending_video_dispatches.front());
        worker_state.pending_video_dispatches.pop_front();
      }

      fanout_relay_video_units_now(
        task.upstream_peer_id,
        task.codec,
        task.access_units,
        task.rtp_timestamp
      );
    }
  }).detach();
}

void fanout_relay_video_units(
  const std::string& upstream_peer_id,
  const std::string& codec,
  const std::vector<std::vector<std::uint8_t>>& access_units,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || access_units.empty()) {
    return;
  }

  ensure_relay_video_dispatch_worker_running();

  auto& state = relay_dispatch_state();
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    QueuedRelayVideoDispatch task;
    task.upstream_peer_id = upstream_peer_id;
    task.codec = codec;
    task.access_units = access_units;
    task.rtp_timestamp = rtp_timestamp;
    state.pending_video_dispatches.push_back(std::move(task));
    while (state.pending_video_dispatches.size() > kMaxQueuedRelayVideoDispatches) {
      state.pending_video_dispatches.pop_front();
    }
  }
  state.video_cv.notify_one();
}

void fanout_relay_audio_frame(
  const std::string& upstream_peer_id,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (upstream_peer_id.empty() || frame.empty()) {
    return;
  }

  std::string lowered_codec = codec;
  std::transform(lowered_codec.begin(), lowered_codec.end(), lowered_codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  const std::uint64_t clock_rate = lowered_codec == "opus" ? kTransportAudioSampleRate : 8000ull;
  const std::uint64_t timestamp_us = rtp_timestamp_to_us(rtp_timestamp, clock_rate);

  const auto targets = collect_relay_dispatch_targets(upstream_peer_id);
  if (targets.empty()) {
    return;
  }

  for (const auto& target : targets) {
    if (!target.audio_enabled) {
      continue;
    }

    const PeerTransportSnapshot snapshot = get_peer_transport_snapshot(target.session);
    if (!snapshot.remote_description_set || snapshot.connection_state != "connected") {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-peer-connected",
        "",
        0,
        0
      );
      continue;
    }
    if (!snapshot.audio_track_open) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-waiting-for-audio-track-open",
        "",
        0,
        0
      );
      continue;
    }

    std::string send_error;
    if (!send_peer_transport_audio_frame(target.session, frame, timestamp_us, &send_error)) {
      update_relay_subscriber_runtime(
        upstream_peer_id,
        target.peer_id,
        "relay-audio-send-failed",
        send_error,
        0,
        0
      );
      continue;
    }

    update_relay_subscriber_runtime(
      upstream_peer_id,
      target.peer_id,
      "relay-audio-forwarding",
      "",
      0,
      0
    );
  }
}

void ensure_peer_av_sync_anchor_locked(
  PeerState::PeerVideoReceiverRuntime& runtime,
  std::int64_t now_us,
  std::uint64_t remote_timestamp_us) {
  if (runtime.av_sync_anchor_initialized) {
    return;
  }
  runtime.av_sync_anchor_initialized = true;
  runtime.av_sync_anchor_remote_us = static_cast<long long>(remote_timestamp_us);
  runtime.av_sync_anchor_local_us = now_us + runtime.av_sync_target_latency_us;
}

void retune_peer_av_sync_latency_locked(PeerState::PeerVideoReceiverRuntime& runtime, long long lateness_us) {
  runtime.av_sync_last_video_lateness_us = lateness_us;
  const long long previous_target_latency_us = runtime.av_sync_target_latency_us;
  long long delta_us = 0;
  if (lateness_us > static_cast<long long>(kPeerAvSyncLateToleranceUs)) {
    const long long available_raise =
      static_cast<long long>(kPeerAvSyncMaxLatencyUs) - runtime.av_sync_target_latency_us;
    if (available_raise > 0) {
      delta_us = std::min<long long>(available_raise, std::min<long long>(lateness_us + 10000, 50000));
    }
  } else if (lateness_us < -static_cast<long long>(kPeerAvSyncEarlyRelaxUs)) {
    const long long available_drop =
      runtime.av_sync_target_latency_us - static_cast<long long>(kPeerAvSyncMinLatencyUs);
    if (available_drop > 0) {
      delta_us = -std::min<long long>(available_drop, 2000);
    }
  }

  if (delta_us == 0) {
    return;
  }

  runtime.av_sync_target_latency_us += delta_us;
  if (runtime.av_sync_anchor_initialized) {
    runtime.av_sync_anchor_local_us += (runtime.av_sync_target_latency_us - previous_target_latency_us);
  }
}

void peer_av_sync_worker(
  PeerState::PeerVideoReceiverRuntime* runtime,
  AgentRuntimeState::ViewerAudioPlaybackRuntime* audio_runtime) {
  if (!runtime || !audio_runtime) {
    return;
  }

  while (true) {
    enum class DispatchKind {
      None,
      Audio,
      Video
    };

    DispatchKind dispatch_kind = DispatchKind::None;
    PeerState::PeerVideoReceiverRuntime::ScheduledAudioBlock audio_block;
    PeerState::PeerVideoReceiverRuntime::ScheduledVideoUnit video_unit;
    std::int64_t dispatch_target_local_us = 0;

    {
      std::unique_lock<std::mutex> lock(runtime->mutex);
      runtime->av_sync_running = true;
      if (runtime->scheduled_audio_queue.empty() && runtime->scheduled_video_queue.empty()) {
        runtime->av_sync_cv.wait(lock, [&]() {
          return runtime->av_sync_stop_requested ||
            !runtime->scheduled_audio_queue.empty() ||
            !runtime->scheduled_video_queue.empty();
        });
      }
      runtime->av_sync_last_scheduler_wake_at_unix_ms = current_time_millis();

      if (runtime->av_sync_stop_requested &&
          runtime->scheduled_audio_queue.empty() &&
          runtime->scheduled_video_queue.empty()) {
        runtime->av_sync_running = false;
        break;
      }

      if (runtime->scheduled_audio_queue.empty() && runtime->scheduled_video_queue.empty()) {
        continue;
      }

      const std::int64_t now_us = current_time_micros_steady();
      const std::int64_t now_unix_ms = current_time_millis();

      if (runtime->scheduled_audio_queue.size() >= kPeerAvSyncMaxQueuedAudioBlocks) {
        while (runtime->scheduled_audio_queue.size() > kPeerAvSyncAudioBacklogTrimTargetBlocks) {
          runtime->scheduled_audio_queue.pop_front();
          runtime->dropped_audio_blocks += 1;
        }
        runtime->reason = "peer-av-sync-audio-trimmed";
      }

      const auto compute_dispatch_time = [&](
        std::uint64_t remote_timestamp_us,
        std::int64_t local_arrival_us) -> std::int64_t {
        if (remote_timestamp_us == 0) {
          return local_arrival_us + runtime->av_sync_target_latency_us;
        }
        ensure_peer_av_sync_anchor_locked(*runtime, now_us, remote_timestamp_us);
        return runtime->av_sync_anchor_local_us +
          (static_cast<long long>(remote_timestamp_us) - runtime->av_sync_anchor_remote_us);
      };

      const bool surface_ready = runtime->surface && runtime->surface_attached;
      if (!surface_ready && !runtime->scheduled_video_queue.empty()) {
        runtime->reason = "peer-av-sync-waiting-for-surface";
        continue;
      }

      std::int64_t next_audio_target_us = std::numeric_limits<std::int64_t>::max();
      if (!runtime->scheduled_audio_queue.empty()) {
        next_audio_target_us = compute_dispatch_time(
          runtime->scheduled_audio_queue.front().remote_timestamp_us,
          runtime->scheduled_audio_queue.front().local_arrival_us);
      }

      std::int64_t next_video_target_us = std::numeric_limits<std::int64_t>::max();
      if (!runtime->scheduled_video_queue.empty()) {
        next_video_target_us = compute_dispatch_time(
          runtime->scheduled_video_queue.front().remote_timestamp_us,
          runtime->scheduled_video_queue.front().local_arrival_us);
      }

      const auto choose_next_dispatch = [&]() {
        dispatch_kind = next_audio_target_us <= next_video_target_us ? DispatchKind::Audio : DispatchKind::Video;
        dispatch_target_local_us = dispatch_kind == DispatchKind::Audio ? next_audio_target_us : next_video_target_us;
      };

      choose_next_dispatch();
      std::int64_t wait_us = dispatch_target_local_us - now_us;
      const bool video_queue_backed_up =
        runtime->scheduled_video_queue.size() >= kPeerAvSyncVideoBacklogPriorityUnits;
      const bool video_submit_stalled =
        !runtime->scheduled_video_queue.empty() &&
        runtime->av_sync_last_video_submit_at_unix_ms > 0 &&
        (now_unix_ms - runtime->av_sync_last_video_submit_at_unix_ms) >= static_cast<std::int64_t>(kPeerAvSyncVideoStallRecoverUs / 1000);

      const bool audio_dispatch_starved =
        !runtime->scheduled_audio_queue.empty() &&
        runtime->submitted_video_units > 0 &&
        (runtime->av_sync_last_audio_dispatch_at_unix_ms <= 0 ||
         (now_unix_ms - runtime->av_sync_last_audio_dispatch_at_unix_ms) >=
           static_cast<std::int64_t>(kPeerAvSyncAudioDispatchStarveUs / 1000));

      if (video_queue_backed_up &&
          !runtime->scheduled_video_queue.empty() &&
          next_video_target_us > now_us + 4000 &&
          runtime->av_sync_target_latency_us > static_cast<long long>(kPeerAvSyncMinLatencyUs)) {
        const long long catchup_step_us = std::min<long long>(
          static_cast<long long>(kPeerAvSyncCatchupLatencyStepUs),
          runtime->av_sync_target_latency_us - static_cast<long long>(kPeerAvSyncMinLatencyUs)
        );
        runtime->av_sync_target_latency_us -= catchup_step_us;
        if (!runtime->scheduled_audio_queue.empty()) {
          next_audio_target_us = compute_dispatch_time(
            runtime->scheduled_audio_queue.front().remote_timestamp_us,
            runtime->scheduled_audio_queue.front().local_arrival_us);
        }
        if (!runtime->scheduled_video_queue.empty()) {
          next_video_target_us = compute_dispatch_time(
            runtime->scheduled_video_queue.front().remote_timestamp_us,
            runtime->scheduled_video_queue.front().local_arrival_us);
        }
        choose_next_dispatch();
        wait_us = dispatch_target_local_us - now_us;
        runtime->reason = "peer-av-sync-video-catching-up";
      }

      if (audio_dispatch_starved &&
          !runtime->scheduled_audio_queue.empty() &&
          next_audio_target_us <= now_us + static_cast<std::int64_t>(kPeerAvSyncAudioDispatchStarveUs / 2)) {
        dispatch_kind = DispatchKind::Audio;
        dispatch_target_local_us = std::min(next_audio_target_us, now_us);
        wait_us = dispatch_target_local_us - now_us;
        runtime->reason = "peer-av-sync-audio-recovery";
      } else if (!runtime->scheduled_video_queue.empty() &&
                 (video_submit_stalled ||
                  (video_queue_backed_up &&
                   next_video_target_us <= (now_us + static_cast<std::int64_t>(kPeerAvSyncVideoStallLeadAllowanceUs))) &&
                   runtime->scheduled_audio_queue.empty())) {
        dispatch_kind = DispatchKind::Video;
        dispatch_target_local_us = std::min(next_video_target_us, now_us);
        wait_us = dispatch_target_local_us - now_us;
        runtime->reason = "peer-av-sync-video-priority-recovery";
      }

      if (wait_us > 2000) {
        runtime->reason = "peer-av-sync-waiting";
        const auto wake_time = std::chrono::steady_clock::time_point(
          std::chrono::microseconds(std::max<std::int64_t>(0, dispatch_target_local_us))
        );
        runtime->av_sync_cv.wait_until(lock, wake_time);
        runtime->av_sync_last_scheduler_wake_at_unix_ms = current_time_millis();
        continue;
      }

      if (dispatch_kind == DispatchKind::Audio) {
        if (runtime->scheduled_audio_queue.empty()) {
          continue;
        }
        audio_block = std::move(runtime->scheduled_audio_queue.front());
        runtime->scheduled_audio_queue.pop_front();
      } else {
        if (runtime->scheduled_video_queue.empty()) {
          continue;
        }
        video_unit = std::move(runtime->scheduled_video_queue.front());
        runtime->scheduled_video_queue.pop_front();
      }
    }

    const std::int64_t dispatch_now_us = current_time_micros_steady();
    const long long lateness_us = dispatch_now_us - dispatch_target_local_us;

    if (dispatch_kind == DispatchKind::Audio) {
      queue_viewer_audio_pcm_block(*audio_runtime, std::move(audio_block.pcm));
      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->dispatched_audio_blocks += 1;
      runtime->av_sync_last_audio_dispatch_at_unix_ms = current_time_millis();
      runtime->av_sync_last_audio_lateness_us = lateness_us;
      runtime->reason = "peer-av-sync-audio-dispatched";
      continue;
    }

    std::string warning_message;
    const bool submitted = submit_scheduled_video_unit_to_surface(
      runtime->peer_id.empty() ? (runtime->surface_id.empty() ? "peer-video" : runtime->surface_id) : runtime->peer_id,
      *runtime,
      video_unit.bytes,
      video_unit.codec,
      &warning_message
    );
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (submitted) {
        runtime->submitted_video_units += 1;
        runtime->av_sync_last_video_submit_at_unix_ms = current_time_millis();
        runtime->reason = "peer-av-sync-video-submitted";
        retune_peer_av_sync_latency_locked(*runtime, lateness_us);
      } else {
        runtime->dropped_video_units += 1;
        runtime->reason = "peer-av-sync-video-dropped";
        if (!warning_message.empty()) {
          runtime->last_error = warning_message;
        }
      }
    }
  }
}

void ensure_peer_av_sync_runtime(
  PeerState::PeerVideoReceiverRuntime& runtime,
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime) {
  std::lock_guard<std::mutex> lock(runtime.mutex);
  if (runtime.closing || runtime.av_sync_thread_started) {
    return;
  }
  runtime.av_sync_stop_requested = false;
  runtime.av_sync_running = true;
  runtime.av_sync_thread_started = true;
  runtime.av_sync_thread = std::thread(peer_av_sync_worker, &runtime, &audio_runtime);
}

void begin_close_peer_video_receiver_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.closing = true;
  runtime.av_sync_stop_requested = true;
  runtime.pending_video_annexb_bytes.clear();
  runtime.startup_video_decoder_config_au.clear();
  runtime.scheduled_audio_queue.clear();
  runtime.scheduled_video_queue.clear();
  runtime.av_sync_anchor_initialized = false;
  runtime.reason = "peer-closing";
  runtime.av_sync_cv.notify_all();
}

void stop_peer_av_sync_runtime(PeerState::PeerVideoReceiverRuntime& runtime, bool clear_pending) {
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.av_sync_stop_requested = true;
    if (clear_pending) {
      runtime.scheduled_audio_queue.clear();
      runtime.scheduled_video_queue.clear();
      runtime.av_sync_anchor_initialized = false;
    }
    runtime.av_sync_cv.notify_all();
  }
  if (runtime.av_sync_thread.joinable()) {
    runtime.av_sync_thread.join();
  }
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.av_sync_running = false;
  runtime.av_sync_thread_started = false;
  runtime.av_sync_stop_requested = false;
  if (clear_pending) {
    runtime.scheduled_audio_queue.clear();
    runtime.scheduled_video_queue.clear();
    runtime.av_sync_last_video_lateness_us = 0;
    runtime.av_sync_last_audio_lateness_us = 0;
  }
}

void consume_remote_peer_audio_frame(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime,
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (!runtime_ptr) {
    return;
  }
  bool local_playback_enabled = false;
  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
    local_playback_enabled = runtime_ptr->local_playback_enabled;
  }
  std::string lowered_codec = codec;
  std::transform(lowered_codec.begin(), lowered_codec.end(), lowered_codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  fanout_relay_audio_frame(peer_id, frame, lowered_codec, rtp_timestamp);
  if (!local_playback_enabled) {
    return;
  }
  if (lowered_codec != "pcmu" && lowered_codec != "opus") {
    std::lock_guard<std::mutex> lock(audio_runtime.mutex);
    audio_runtime.last_error = "viewer-audio-unsupported-codec:" + codec;
    audio_runtime.reason = "viewer-audio-unsupported-codec";
    return;
  }

  std::string decode_error;
  auto pcm = lowered_codec == "opus"
    ? decode_opus_to_pcm16(runtime_ptr, frame, &decode_error)
    : decode_pcmu_to_pcm16(frame);
  if (pcm.empty()) {
    if (!decode_error.empty()) {
      std::lock_guard<std::mutex> lock(audio_runtime.mutex);
      audio_runtime.last_error = decode_error;
      audio_runtime.reason = "viewer-audio-decode-failed";
    }
    return;
  }

  bool passthrough_enabled = false;
  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
    if (runtime_ptr->startup_waiting_for_random_access) {
      runtime_ptr->dropped_audio_blocks += 1;
      runtime_ptr->reason = "peer-av-sync-audio-waiting-for-random-access";
      return;
    }
    passthrough_enabled = runtime_ptr->passthrough_playback_enabled;
    if (passthrough_enabled) {
      runtime_ptr->dispatched_audio_blocks += 1;
      runtime_ptr->reason = "peer-audio-passthrough-dispatched";
      runtime_ptr->av_sync_last_audio_lateness_us = 0;
    }
  }
  if (passthrough_enabled) {
    queue_viewer_audio_pcm_block(audio_runtime, std::move(pcm));
    return;
  }
  ensure_peer_av_sync_runtime(*runtime_ptr, audio_runtime);
  std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
  if (runtime_ptr->closing) {
    return;
  }
  PeerState::PeerVideoReceiverRuntime::ScheduledAudioBlock block;
  block.remote_timestamp_us = rtp_timestamp_to_us(
    rtp_timestamp,
    lowered_codec == "opus" ? kTransportAudioSampleRate : 8000
  );
  block.local_arrival_us = current_time_micros_steady();
  block.pcm = std::move(pcm);
  runtime_ptr->scheduled_audio_queue.push_back(std::move(block));
  runtime_ptr->scheduled_audio_blocks += 1;
  while (runtime_ptr->scheduled_audio_queue.size() > kPeerAvSyncMaxQueuedAudioBlocks) {
    runtime_ptr->scheduled_audio_queue.pop_front();
    runtime_ptr->dropped_audio_blocks += 1;
  }
  runtime_ptr->reason = "peer-av-sync-audio-queued";
  runtime_ptr->av_sync_cv.notify_all();
}

std::string to_lower_copy(const std::string& value) {
  std::string lowered = value;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return lowered;
}

std::vector<std::string> split_lines(const std::string& value) {
  std::vector<std::string> lines;
  std::stringstream stream(value);
  std::string line;
  while (std::getline(stream, line)) {
    lines.push_back(line);
  }
  return lines;
}

std::string build_error_payload(int id, const std::string& code, const std::string& message) {
  std::ostringstream payload;
  payload
    << "{\"id\":" << id
    << ",\"error\":{\"code\":\"" << json_escape(code)
    << "\",\"message\":\"" << json_escape(message) << "\"}}";
  return payload.str();
}

std::string build_result_payload(int id, const std::string& result_json) {
  std::ostringstream payload;
  payload << "{\"id\":" << id << ",\"result\":" << result_json << "}";
  return payload.str();
}

void emit_event(const std::string& event_name, const std::string& params_json) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"" << json_escape(event_name) << "\",\"params\":" << params_json << "}" << std::endl;
}

void write_json_line(const std::string& payload) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << payload << std::endl;
}

void emit_wasapi_backend_event(const std::string& event_name, const std::string& params_json) {
  emit_event(event_name, params_json);
}

void emit_wasapi_pcm_packet(
  const WasapiSessionStatus& status,
  const unsigned char* data,
  unsigned int frames,
  bool silent) {
  (void)status;
  AgentRuntimeState* runtime = g_agent_runtime_for_audio;
  if (!runtime || !runtime->audio_session.capture_active) {
    return;
  }

  dispatch_host_audio_capture_packet(status, data, frames, silent);
}

int extract_id(const std::string& line) {
  const std::regex id_pattern("\"id\"\\s*:\\s*(\\d+)");
  std::smatch match;
  if (std::regex_search(line, match, id_pattern)) {
    try {
      const long long parsed = std::stoll(match[1].str());
      if (parsed < 0 || parsed > std::numeric_limits<int>::max()) {
        return -1;
      }
      return static_cast<int>(parsed);
    } catch (...) {
      return -1;
    }
  }

  return -1;
}

std::string extract_method(const std::string& line) {
  const std::regex method_pattern("\"method\"\\s*:\\s*\"([^\"]+)\"");
  std::smatch match;
  if (std::regex_search(line, match, method_pattern)) {
    return match[1].str();
  }

  return {};
}

std::string extract_string_value(const std::string& json, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    return json_unescape(match[1].str());
  }

  return {};
}

int extract_int_value(const std::string& json, const std::string& key, int default_value = 0) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?\\d+)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    try {
      return std::stoi(match[1].str());
    } catch (...) {
      return default_value;
    }
  }

  return default_value;
}

double extract_double_value(const std::string& json, const std::string& key, double default_value = 0.0) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    try {
      return std::stod(match[1].str());
    } catch (...) {
      return default_value;
    }
  }

  return default_value;
}

bool extract_bool_value(const std::string& json, const std::string& key, bool default_value = false) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    return match[1].str() == "true";
  }

  return default_value;
}

std::string json_array_from_strings(const std::vector<std::string>& values) {
  std::ostringstream payload;
  payload << "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) {
      payload << ",";
    }
    payload << "\"" << json_escape(values[index]) << "\"";
  }
  payload << "]";
  return payload.str();
}

std::string ffmpeg_error_string(int error_code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(error_code, buffer, sizeof(buffer));
  return std::string(buffer);
}

std::string json_object_from_video_encoder_probe(const VideoEncoderProbeResult& probe) {
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << json_escape(probe.name) << "\""
    << ",\"exists\":" << (probe.exists ? "true" : "false")
    << ",\"hardware\":" << (probe.hardware ? "true" : "false")
    << ",\"supportsLowLatency\":" << (probe.supports_low_latency ? "true" : "false")
    << ",\"requiresHwDevice\":" << (probe.requires_hw_device ? "true" : "false")
    << ",\"hwDeviceType\":\"" << json_escape(probe.hw_device_type) << "\""
    << ",\"hwDeviceReady\":" << (probe.hw_device_ready ? "true" : "false")
    << ",\"openSucceeded\":" << (probe.open_succeeded ? "true" : "false")
    << ",\"outputSucceeded\":" << (probe.output_succeeded ? "true" : "false")
    << ",\"validated\":" << (probe.validated ? "true" : "false")
    << ",\"priority\":" << probe.priority
    << ",\"reason\":\"" << json_escape(probe.reason) << "\""
    << ",\"error\":\"" << json_escape(probe.error) << "\""
    << "}";
  return payload.str();
}

std::string json_array_from_video_encoder_probes(const std::vector<VideoEncoderProbeResult>& probes) {
  std::ostringstream payload;
  payload << "[";
  for (std::size_t index = 0; index < probes.size(); ++index) {
    if (index > 0) {
      payload << ",";
    }
    payload << json_object_from_video_encoder_probe(probes[index]);
  }
  payload << "]";
  return payload.str();
}

std::string quote_command_path(const std::string& path) {
  if (path.find(' ') == std::string::npos && path.find('&') == std::string::npos) {
    return path;
  }

  return "\"" + path + "\"";
}

std::string build_gdigrab_hwnd_target(const std::string& hwnd_value) {
  const std::string trimmed = trim_copy(hwnd_value);
  if (trimmed.empty()) {
    return {};
  }

  try {
    std::size_t parsed_length = 0;
    const unsigned long long handle = std::stoull(trimmed, &parsed_length, 0);
    if (parsed_length == trimmed.size()) {
      std::ostringstream target;
      target << "hwnd=0x" << std::uppercase << std::hex << handle;
      return target.str();
    }
  } catch (...) {
  }

  return "hwnd=" + trimmed;
}

#ifdef _WIN32
struct WindowTitleSearchContext {
  std::string wanted_title;
  std::string wanted_title_lower;
  HWND exact_match = nullptr;
  HWND partial_match = nullptr;
};

BOOL CALLBACK enum_windows_for_title_proc(HWND hwnd, LPARAM lparam) {
  auto* context = reinterpret_cast<WindowTitleSearchContext*>(lparam);
  if (!context || !IsWindow(hwnd) || !IsWindowVisible(hwnd)) {
    return TRUE;
  }

  const int title_length = GetWindowTextLengthW(hwnd);
  if (title_length <= 0) {
    return TRUE;
  }

  std::wstring title_wide(static_cast<std::size_t>(title_length), L'\0');
  const int copied = GetWindowTextW(hwnd, title_wide.data(), title_length + 1);
  if (copied <= 0) {
    return TRUE;
  }
  title_wide.resize(static_cast<std::size_t>(copied));
  const int required = WideCharToMultiByte(CP_UTF8, 0, title_wide.c_str(), copied, nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return TRUE;
  }
  std::string title(static_cast<std::size_t>(required), '\0');
  const int converted = WideCharToMultiByte(CP_UTF8, 0, title_wide.c_str(), copied, title.data(), required, nullptr, nullptr);
  if (converted <= 0) {
    return TRUE;
  }
  const std::string lowered = to_lower_copy(trim_copy(title));
  if (lowered.empty()) {
    return TRUE;
  }

  if (lowered == context->wanted_title_lower) {
    context->exact_match = hwnd;
    return FALSE;
  }

  if (!context->partial_match && lowered.find(context->wanted_title_lower) != std::string::npos) {
    context->partial_match = hwnd;
  }
  return TRUE;
}

std::string resolve_window_handle_from_title(const std::string& window_title) {
  const std::string trimmed = trim_copy(window_title);
  if (trimmed.empty()) {
    return {};
  }

  WindowTitleSearchContext context;
  context.wanted_title = trimmed;
  context.wanted_title_lower = to_lower_copy(trimmed);
  EnumWindows(&enum_windows_for_title_proc, reinterpret_cast<LPARAM>(&context));

  const HWND resolved = context.exact_match ? context.exact_match : context.partial_match;
  if (!resolved) {
    return {};
  }

  std::ostringstream handle;
  handle << "0x" << std::uppercase << std::hex << reinterpret_cast<std::uintptr_t>(resolved);
  return handle.str();
}
#else
std::string resolve_window_handle_from_title(const std::string&) {
  return {};
}
#endif

std::string build_host_capture_session_id() {
  std::ostringstream session_id;
  session_id << current_time_millis();
#ifdef _WIN32
  session_id << "-" << GetCurrentProcessId();
#endif
  return session_id.str();
}

bool is_host_capture_surface_target(const std::string& target) {
  const std::string normalized = to_lower_copy(trim_copy(target));
  return normalized == "host-capture-artifact" ||
    normalized == "host-capture-preview" ||
    normalized == "host-session-artifact";
}

bool is_peer_video_surface_target(const std::string& target) {
  const std::string normalized = to_lower_copy(trim_copy(target));
  return normalized.rfind("peer-video:", 0) == 0;
}

bool is_peer_video_media_source(const std::string& source) {
  return is_peer_video_surface_target(source);
}

std::string extract_peer_id_from_surface_target(const std::string& target) {
  const std::string trimmed = trim_copy(target);
  const std::string lowered = to_lower_copy(trimmed);
  const std::string prefix = "peer-video:";
  if (lowered.rfind(prefix, 0) != 0 || trimmed.size() <= prefix.size()) {
    return {};
  }
  return trimmed.substr(prefix.size());
}

std::string extract_peer_id_from_media_source(const std::string& source) {
  return extract_peer_id_from_surface_target(source);
}

bool is_native_host_capture_process_enabled() {
  static const bool enabled = []() {
#ifdef _WIN32
    char* raw_value = nullptr;
    std::size_t raw_length = 0;
    const errno_t env_result = _dupenv_s(&raw_value, &raw_length, "VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS");
    const bool is_enabled = env_result == 0 && raw_value && std::string(raw_value) == "1";
    if (raw_value) {
      std::free(raw_value);
    }
    return is_enabled;
#else
    const char* raw_value = std::getenv("VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS");
    return raw_value && std::string(raw_value) == "1";
#endif
  }();
  return enabled;
}

bool should_preserve_host_capture_output() {
  static const bool preserve = []() {
#ifdef _WIN32
    char* raw_value = nullptr;
    std::size_t raw_length = 0;
    const errno_t env_result = _dupenv_s(&raw_value, &raw_length, "VDS_PRESERVE_AGENT_HOST_CAPTURE_OUTPUT");
    const bool should_preserve = env_result == 0 && raw_value && std::string(raw_value) == "1";
    if (raw_value) {
      std::free(raw_value);
    }
    return should_preserve;
#else
    const char* raw_value = std::getenv("VDS_PRESERVE_AGENT_HOST_CAPTURE_OUTPUT");
    return raw_value && std::string(raw_value) == "1";
#endif
  }();
  return preserve;
}

bool initialize_host_capture_artifact_paths(HostCaptureProcessState& state) {
  try {
    state.session_id = build_host_capture_session_id();
    const fs::path output_dir = fs::temp_directory_path() / "vds-media-agent" / ("host-session-" + state.session_id);
    fs::create_directories(output_dir);
    state.output_directory = output_dir.string();
    state.output_path = (output_dir / "capture.ts").string();
    state.manifest_path = (output_dir / "capture-manifest.json").string();
    state.updated_at_unix_ms = current_time_millis();
    return true;
  } catch (...) {
    state.session_id.clear();
    state.output_directory.clear();
    state.output_path.clear();
    state.manifest_path.clear();
    return false;
  }
}

HostCaptureProcessState build_host_capture_process_state() {
  HostCaptureProcessState state;
  state.enabled = is_native_host_capture_process_enabled();
  state.preserve_output = should_preserve_host_capture_output();
  state.output_mode = state.enabled ? "mpegts-session-artifact" : "disabled";
  if (state.enabled) {
    if (initialize_host_capture_artifact_paths(state)) {
      state.reason = "host-capture-process-idle";
    } else {
      state.reason = "host-capture-artifact-path-init-failed";
      state.last_error = "Failed to initialize the native host capture artifact directory.";
    }
  } else {
    state.reason = "host-capture-process-disabled";
  }
  return state;
}

#ifdef _WIN32
std::wstring utf8_to_wide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (required <= 0) {
    return {};
  }

  std::wstring wide(static_cast<std::size_t>(required), L'\0');
  if (MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), required) <= 0) {
    return {};
  }
  if (!wide.empty() && wide.back() == L'\0') {
    wide.pop_back();
  }
  return wide;
}

std::string wide_to_utf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }

  const int required = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return {};
  }

  std::string narrow(static_cast<std::size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, narrow.data(), required, nullptr, nullptr) <= 0) {
    return {};
  }
  if (!narrow.empty() && narrow.back() == '\0') {
    narrow.pop_back();
  }
  return narrow;
}

std::string format_windows_error(DWORD error_code) {
  LPWSTR message_buffer = nullptr;
  const DWORD message_length = FormatMessageW(
    FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    nullptr,
    error_code,
    0,
    reinterpret_cast<LPWSTR>(&message_buffer),
    0,
    nullptr
  );

  std::wstring message = message_length && message_buffer
    ? std::wstring(message_buffer, message_length)
    : L"Unknown Windows error";

  if (message_buffer) {
    LocalFree(message_buffer);
  }

  return trim_copy(wide_to_utf8(message));
}

void close_host_capture_process_handles(HostCaptureProcessState& state) {
  if (state.thread_handle) {
    CloseHandle(state.thread_handle);
    state.thread_handle = nullptr;
  }
  if (state.process_handle) {
    CloseHandle(state.process_handle);
    state.process_handle = nullptr;
  }
}

void append_nullable_int64(std::ostringstream& payload, long long value) {
  if (value > 0) {
    payload << value;
  } else {
    payload << "null";
  }
}

NativeEmbeddedSurfaceLayout build_surface_layout_from_json(const std::string& json) {
  NativeEmbeddedSurfaceLayout layout;
  layout.embedded = extract_bool_value(json, "embedded", false);
  layout.visible = extract_bool_value(json, "visible", true);
  layout.parent_window_handle = extract_string_value(json, "parentWindowHandle");
  layout.x = extract_int_value(json, "x", 0);
  layout.y = extract_int_value(json, "y", 0);
  layout.width = extract_int_value(json, "width", 0);
  layout.height = extract_int_value(json, "height", 0);
  return layout;
}

std::string surface_layout_json(const NativeEmbeddedSurfaceLayout& layout) {
  std::ostringstream payload;
  payload
    << "{\"embedded\":" << (layout.embedded ? "true" : "false")
    << ",\"visible\":" << (layout.visible ? "true" : "false")
    << ",\"parentWindowHandle\":\"" << json_escape(layout.parent_window_handle) << "\""
    << ",\"x\":" << layout.x
    << ",\"y\":" << layout.y
    << ",\"width\":" << layout.width
    << ",\"height\":" << layout.height
    << "}";
  return payload.str();
}

std::string host_pipeline_json(const HostPipelineState& pipeline);
std::string host_capture_plan_json(const HostCapturePlan& plan);
std::string host_capture_process_json(HostCaptureProcessState& state);
std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe);
std::string surface_attachment_json(SurfaceAttachmentState& state);
std::string build_surface_attachments_json(AgentRuntimeState& state);
CommandResult run_command_capture(const std::string& command);
bool start_peer_video_sender(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  PeerState& peer,
  std::string* error);
void refresh_peer_media_binding(PeerState& peer);
bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error);
bool attach_host_video_media_binding(AgentRuntimeState& state, PeerState& peer, std::string* error, bool force_restart = false);
void perform_host_video_sender_soft_refresh(AgentRuntimeState& state);
bool configure_host_audio_sender(AgentRuntimeState& state, PeerState& peer, std::string* error);
void clear_host_audio_sender(PeerState& peer);
void refresh_host_audio_senders(AgentRuntimeState& state);
void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason);
void ensure_peer_av_sync_runtime(
  PeerState::PeerVideoReceiverRuntime& runtime,
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime);
void stop_peer_av_sync_runtime(PeerState::PeerVideoReceiverRuntime& runtime, bool clear_pending);
bool update_peer_video_surface_layout(
  PeerState::PeerVideoReceiverRuntime& runtime,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error);
bool update_surface_attachment_layout(
  SurfaceAttachmentState& state,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error);
std::string normalize_video_codec(const std::string& codec, const std::string& fallback);
bool video_access_unit_has_decoder_config_nal(const std::string& codec, const std::vector<std::uint8_t>& access_unit);
bool video_access_unit_has_random_access_nal(const std::string& codec, const std::vector<std::uint8_t>& access_unit);
bool video_bootstrap_is_complete(
  const std::string& codec,
  const std::vector<std::uint8_t>& decoder_config_au,
  const std::vector<std::uint8_t>& random_access_au);
void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime,
  const std::shared_ptr<PeerTransportSession>& transport_session);
bool submit_scheduled_video_unit_to_surface(
  const std::string& peer_id,
  PeerState::PeerVideoReceiverRuntime& runtime,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec_path,
  std::string* warning_message);
void consume_remote_peer_video_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::shared_ptr<PeerTransportSession>& transport_session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp);
void consume_remote_peer_audio_frame(
  AgentRuntimeState::ViewerAudioPlaybackRuntime& audio_runtime,
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp);

std::string build_host_capture_manifest_json(
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState& state,
  const HostCaptureArtifactProbe& artifact_probe) {
  std::ostringstream payload;
  payload
    << "{\"sessionId\":\"" << json_escape(state.session_id) << "\""
    << ",\"container\":\"" << json_escape(state.container) << "\""
    << ",\"outputMode\":\"" << json_escape(state.output_mode) << "\""
    << ",\"preserveOutput\":" << (state.preserve_output ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"outputBytes\":" << state.output_bytes
    << ",\"outputDirectory\":\"" << json_escape(state.output_directory) << "\""
    << ",\"mediaPath\":\"" << json_escape(state.output_path) << "\""
    << ",\"manifestPath\":\"" << json_escape(state.manifest_path) << "\""
    << ",\"reason\":\"" << json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << json_escape(state.last_error) << "\""
    << ",\"startedAtMs\":";
  append_nullable_int64(payload, state.started_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"stoppedAtMs\":";
  append_nullable_int64(payload, state.stopped_at_unix_ms);
  payload
    << ",\"pipeline\":" << host_pipeline_json(pipeline)
    << ",\"capturePlan\":" << host_capture_plan_json(plan)
    << ",\"captureProcess\":" << host_capture_process_json(state)
    << ",\"captureArtifact\":" << host_capture_artifact_json(artifact_probe)
    << "}";
  return payload.str();
}

void persist_host_capture_process_manifest(
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState& state,
  const HostCaptureArtifactProbe& artifact_probe) {
  if (state.manifest_path.empty()) {
    return;
  }

  state.updated_at_unix_ms = current_time_millis();
  try {
    std::ofstream output(state.manifest_path, std::ios::binary | std::ios::trunc);
    if (!output.is_open()) {
      return;
    }
    output << build_host_capture_manifest_json(pipeline, plan, state, artifact_probe);
    output.flush();
  } catch (...) {
  }
}

std::string resolve_ffplay_path(const FfmpegProbeResult& ffmpeg) {
  if (ffmpeg.path.empty()) {
    return {};
  }

  try {
    const fs::path ffplay_path = fs::path(ffmpeg.path).parent_path() / "ffplay.exe";
    return fs::exists(ffplay_path) ? ffplay_path.string() : std::string{};
  } catch (...) {
    return {};
  }
}

std::string resolve_ffprobe_path(const FfmpegProbeResult& ffmpeg) {
  if (ffmpeg.path.empty()) {
    return {};
  }

  try {
    const fs::path ffprobe_path = fs::path(ffmpeg.path).parent_path() / "ffprobe.exe";
    return fs::exists(ffprobe_path) ? ffprobe_path.string() : std::string{};
  } catch (...) {
    return {};
  }
}

bool wait_for_path_to_exist(const std::string& path, int timeout_ms = 2000) {
  if (path.empty()) {
    return false;
  }

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    try {
      if (fs::exists(path)) {
        return true;
      }
    } catch (...) {
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  try {
    return fs::exists(path);
  } catch (...) {
    return false;
  }
}

HostCaptureArtifactProbe probe_host_capture_artifact(
  const FfmpegProbeResult& ffmpeg,
  const HostCaptureProcessState& host_capture_process,
  HostCaptureArtifactProbe previous_probe = {}) {
  HostCaptureArtifactProbe probe = previous_probe;
  probe.media_path = host_capture_process.output_path;
  probe.last_probe_at_unix_ms = current_time_millis();

  if (host_capture_process.output_path.empty()) {
    probe.available = false;
    probe.ready = false;
    probe.reason = "artifact-path-missing";
    probe.last_error = "Host capture artifact path is not available.";
    return probe;
  }

  try {
    if (!fs::exists(host_capture_process.output_path)) {
      probe.available = false;
      probe.ready = false;
      probe.file_size_bytes = 0;
      probe.reason = host_capture_process.running ? "artifact-pending" : "artifact-file-missing";
      probe.last_error = host_capture_process.running
        ? "Host capture artifact file has not been materialized yet."
        : "Host capture artifact file does not exist.";
      return probe;
    }

    probe.file_size_bytes = static_cast<unsigned long long>(fs::file_size(host_capture_process.output_path));
    probe.available = probe.file_size_bytes > 0;
  } catch (...) {
    probe.available = false;
    probe.ready = false;
    probe.reason = "artifact-file-stat-failed";
    probe.last_error = "Failed to read host capture artifact file metadata.";
    return probe;
  }

  const std::string ffprobe_path = resolve_ffprobe_path(ffmpeg);
  if (ffprobe_path.empty()) {
    probe.ready = false;
    probe.reason = "ffprobe-unavailable";
    probe.last_error = "Bundled FFprobe runtime is not available for host capture artifact validation.";
    return probe;
  }

  if (!probe.available) {
    probe.ready = false;
    probe.reason = host_capture_process.running ? "artifact-growing" : "artifact-empty";
    probe.last_error = host_capture_process.running
      ? "Host capture artifact exists but has not emitted decodable payload yet."
      : "Host capture artifact is empty.";
    return probe;
  }

  const std::string command =
    quote_command_path(ffprobe_path) +
    " -v error -select_streams v:0 -show_entries stream=codec_name,width,height,avg_frame_rate,pix_fmt -show_entries format=format_name,size"
    " -of default=noprint_wrappers=1:nokey=0 " + quote_command_path(host_capture_process.output_path) +
    " 2>&1";

  const CommandResult result = run_command_capture(command);
  if (!result.launched || result.exit_code != 0) {
    probe.ready = false;
    probe.reason = "artifact-probe-failed";
    probe.last_error = trim_copy(result.output);
    if (probe.last_error.empty()) {
      probe.last_error = "FFprobe failed to inspect the host capture artifact.";
    }
    return probe;
  }

  for (const std::string& raw_line : split_lines(result.output)) {
    const std::string line = trim_copy(raw_line);
    const std::size_t equals_index = line.find('=');
    if (equals_index == std::string::npos) {
      continue;
    }

    const std::string key = trim_copy(line.substr(0, equals_index));
    const std::string value = trim_copy(line.substr(equals_index + 1));
    if (key == "codec_name") {
      probe.video_codec = value;
    } else if (key == "width") {
      try { probe.width = std::stoi(value); } catch (...) {}
    } else if (key == "height") {
      try { probe.height = std::stoi(value); } catch (...) {}
    } else if (key == "pix_fmt") {
      probe.pixel_format = value;
    } else if (key == "format_name") {
      probe.format_name = value;
    } else if (key == "size") {
      try { probe.file_size_bytes = static_cast<unsigned long long>(std::stoull(value)); } catch (...) {}
    } else if (key == "avg_frame_rate") {
      const std::size_t slash_index = value.find('/');
      try {
        if (slash_index != std::string::npos) {
          const double numerator = std::stod(value.substr(0, slash_index));
          const double denominator = std::stod(value.substr(slash_index + 1));
          if (denominator > 0.0) {
            probe.frame_rate = numerator / denominator;
          }
        } else {
          probe.frame_rate = std::stod(value);
        }
      } catch (...) {
      }
    }
  }

  probe.ready =
    !probe.video_codec.empty() &&
    probe.width > 0 &&
    probe.height > 0 &&
    probe.file_size_bytes > 0;
  probe.reason = probe.ready ? "artifact-probed" : "artifact-probe-incomplete";
  probe.last_error.clear();
  return probe;
}

std::string build_host_capture_preview_command(
  const std::string& ffplay_path,
  const SurfaceAttachmentState& surface,
  const HostCaptureProcessState& host_capture_process) {
  if (ffplay_path.empty() || host_capture_process.output_path.empty()) {
    return {};
  }

  std::ostringstream command;
  command
    << quote_command_path(ffplay_path)
    << " -hide_banner -loglevel warning -fflags nobuffer -flags low_delay"
    << " -framedrop -sync ext"
    << " -window_title " << quote_command_path(surface.window_title)
    << " " << quote_command_path(host_capture_process.output_path);
  return command.str();
}

std::string build_peer_video_preview_command(
  const std::string& ffplay_path,
  const PeerState::PeerVideoReceiverRuntime& runtime) {
  if (ffplay_path.empty()) {
    return {};
  }

  const std::string codec = to_lower_copy(trim_copy(runtime.codec_path));
  const std::string input_format = codec == "h265" || codec == "hevc" ? "hevc" : "h264";

  std::ostringstream command;
  command
    << quote_command_path(ffplay_path)
    << " -hide_banner -loglevel warning -fflags nobuffer -flags low_delay"
    << " -framedrop -sync ext -probesize 32 -analyzeduration 0"
    << " -f " << input_format
    << " -window_title " << quote_command_path(runtime.window_title)
    << " -i pipe:0";
  return command.str();
}

void close_surface_attachment_handles(SurfaceAttachmentState& state) {
  if (state.thread_handle) {
    CloseHandle(state.thread_handle);
    state.thread_handle = nullptr;
  }
  if (state.process_handle) {
    CloseHandle(state.process_handle);
    state.process_handle = nullptr;
  }
}

void close_peer_video_receiver_handles(PeerState::PeerVideoReceiverRuntime& runtime) {
  begin_close_peer_video_receiver_runtime(runtime);
  stop_peer_av_sync_runtime(runtime, true);
  reset_peer_audio_decoder_runtime(runtime);
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.surface_attached = false;
  runtime.process_id = 0;
}

void refresh_peer_video_receiver_runtime(PeerState::PeerVideoReceiverRuntime& runtime) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = runtime.surface;
  }

  if (!surface) {
    return;
  }

  const NativeVideoSurfaceSnapshot snapshot = surface->snapshot();
  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.surface_attached = snapshot.attached;
  runtime.launch_attempted = snapshot.launch_attempted;
  runtime.running = snapshot.running;
  runtime.decoder_ready = snapshot.decoder_ready;
  runtime.process_id = snapshot.process_id;
  runtime.decoded_frames_rendered = snapshot.decoded_frames_rendered;
  runtime.frame_interval_stddev_ms = snapshot.frame_interval_stddev_ms;
  runtime.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
  runtime.codec_path = snapshot.codec_path;
  runtime.preview_surface_backend = snapshot.preview_surface_backend;
  runtime.decoder_backend = snapshot.decoder_backend;
  runtime.implementation = snapshot.implementation;
  runtime.window_title = snapshot.window_title;
  runtime.embedded_parent_debug = snapshot.embedded_parent_debug;
  runtime.surface_window_debug = snapshot.surface_window_debug;
  runtime.reason = snapshot.reason;
  runtime.last_error = snapshot.last_error;
#ifdef _WIN32
  runtime.thread_id = snapshot.thread_id;
#endif
}

bool start_peer_video_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  PeerState::PeerVideoReceiverRuntime& runtime,
  std::string* error) {
  (void)ffmpeg;
  refresh_peer_video_receiver_runtime(runtime);

  std::string window_title;
  std::string codec_path;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    window_title = "VDS Native Viewer - " + (runtime.surface_id.empty() ? "peer-video" : runtime.surface_id);
    codec_path = runtime.codec_path.empty() ? "h264" : runtime.codec_path;
    runtime.window_title = window_title;
    runtime.command_line.clear();
    runtime.closing = false;
    runtime.pending_video_annexb_bytes.clear();
    runtime.startup_video_decoder_config_au.clear();
    runtime.startup_waiting_for_random_access = true;
    runtime.launch_attempted = true;
    runtime.last_start_attempt_at_unix_ms = current_time_millis();
    runtime.last_error.clear();
    runtime.reason = "peer-video-surface-starting";
  }

  NativeVideoSurfaceConfig config;
  config.surface_id = runtime.surface_id;
  config.window_title = window_title;
  config.codec = codec_path;
  config.layout = runtime.surface_layout;

  std::string create_error;
  auto surface = create_native_video_surface(config, &create_error);
  if (!surface) {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface_attached = false;
    runtime.running = false;
    runtime.decoder_ready = false;
    runtime.last_error = create_error;
    runtime.reason = "peer-video-surface-start-failed";
    if (error) {
      *error = create_error;
    }
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface = surface;
    runtime.last_start_success_at_unix_ms = current_time_millis();
  }

  refresh_peer_video_receiver_runtime(runtime);
  if (error) {
    error->clear();
  }
  return true;
}

bool is_peer_video_surface_shutdown_reason(const std::string& reason) {
  return reason == "peer-closed" ||
    reason == "surface-detached" ||
    reason == "surface-reattach" ||
    reason == "surface-destroyed" ||
    reason == "surface-window-closed" ||
    reason == "native-surface-stopped";
}

bool restart_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, std::string* error) {
  stop_peer_video_surface_attachment(runtime, "peer-video-surface-auto-restart");
  const FfmpegProbeResult unused_ffmpeg;
  return start_peer_video_surface_attachment(unused_ffmpeg, runtime, error);
}

void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = std::move(runtime.surface);
  }

  if (surface) {
    surface->close(reason);
  }

  std::lock_guard<std::mutex> lock(runtime.mutex);
  runtime.surface_attached = false;
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.process_id = 0;
  runtime.pending_video_annexb_bytes.clear();
  runtime.startup_video_decoder_config_au.clear();
  runtime.startup_waiting_for_random_access = true;
  runtime.av_sync_cv.notify_all();
  runtime.reason = reason;
  runtime.last_stop_at_unix_ms = current_time_millis();
}

bool update_peer_video_surface_layout(
  PeerState::PeerVideoReceiverRuntime& runtime,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.surface_layout = layout;
    surface = runtime.surface;
  }

  if (!surface) {
    if (error) {
      error->clear();
    }
    return true;
  }

  return surface->update_layout(layout, error);
}

void refresh_surface_attachment_state(SurfaceAttachmentState& state) {
  if (state.live_preview_runtime) {
    const NativeLivePreviewSnapshot snapshot = state.live_preview_runtime->snapshot();
    state.attached = snapshot.attached;
    state.launch_attempted = snapshot.launch_attempted;
    state.running = snapshot.running;
    state.waiting_for_artifact = snapshot.waiting_for_artifact;
    state.decoder_ready = snapshot.decoder_ready;
    state.decoded_frames_rendered = snapshot.decoded_frames_rendered;
    state.frame_interval_stddev_ms = snapshot.frame_interval_stddev_ms;
    state.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
    state.process_id = snapshot.process_id;
    state.preview_surface_backend = snapshot.preview_surface_backend;
    state.decoder_backend = snapshot.decoder_backend;
    state.codec_path = snapshot.codec_path;
    state.implementation = snapshot.implementation;
    state.media_path = snapshot.media_path;
    state.window_title = snapshot.window_title;
    state.embedded_parent_debug = snapshot.embedded_parent_debug;
    state.surface_window_debug = snapshot.surface_window_debug;
    state.reason = snapshot.reason;
    state.last_error = snapshot.last_error;
    state.command_line.clear();
    return;
  }

  if (state.preview_runtime) {
    const NativeArtifactPreviewSnapshot snapshot = state.preview_runtime->snapshot();
    state.attached = snapshot.attached;
    state.launch_attempted = snapshot.launch_attempted;
    state.running = snapshot.running;
    state.waiting_for_artifact = snapshot.waiting_for_artifact;
    state.decoder_ready = snapshot.decoder_ready;
    state.decoded_frames_rendered = snapshot.decoded_frames_rendered;
    state.frame_interval_stddev_ms = 0.0;
    state.last_decoded_frame_at_unix_ms = snapshot.last_decoded_frame_at_unix_ms;
    state.process_id = snapshot.process_id;
    state.preview_surface_backend = snapshot.preview_surface_backend;
    state.decoder_backend = snapshot.decoder_backend;
    state.codec_path = snapshot.codec_path;
    state.implementation = snapshot.implementation;
    state.media_path = snapshot.media_path;
    state.window_title = snapshot.window_title;
    state.reason = snapshot.reason;
    state.last_error = snapshot.last_error;
    state.command_line.clear();
    return;
  }

  if (!state.process_handle) {
    return;
  }

  DWORD exit_code = STILL_ACTIVE;
  if (!GetExitCodeProcess(state.process_handle, &exit_code)) {
    state.running = false;
    state.last_error = format_windows_error(GetLastError());
    state.reason = "surface-process-state-read-failed";
    close_surface_attachment_handles(state);
    state.process_id = 0;
    return;
  }

  if (exit_code == STILL_ACTIVE) {
    state.running = true;
    return;
  }

  state.running = false;
  state.last_exit_code = static_cast<int>(exit_code);
  state.reason = "surface-process-exited";
  close_surface_attachment_handles(state);
  state.process_id = 0;
}

void sync_surface_attachment_from_peer_runtime(
  SurfaceAttachmentState& state,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime) {
  if (!runtime) {
    return;
  }

  refresh_peer_video_receiver_runtime(*runtime);

  std::lock_guard<std::mutex> lock(runtime->mutex);
  state.attached = runtime->surface_attached;
  state.launch_attempted = runtime->launch_attempted;
  state.running = runtime->running;
  state.waiting_for_artifact = false;
  state.decoder_ready = runtime->decoder_ready;
  state.decoded_frames_rendered = runtime->decoded_frames_rendered;
  state.frame_interval_stddev_ms = runtime->frame_interval_stddev_ms;
  state.last_decoded_frame_at_unix_ms = runtime->last_decoded_frame_at_unix_ms;
  state.process_id = runtime->process_id;
  state.last_exit_code = runtime->last_exit_code;
  state.preview_surface_backend = runtime->preview_surface_backend;
  state.decoder_backend = runtime->decoder_backend;
  state.codec_path = runtime->codec_path;
  state.implementation = runtime->implementation;
  state.window_title = runtime->window_title;
  state.embedded_parent_debug = runtime->embedded_parent_debug;
  state.surface_window_debug = runtime->surface_window_debug;
  state.reason = runtime->reason;
  state.last_error = runtime->last_error;
  state.command_line = runtime->command_line;
  state.surface_layout = runtime->surface_layout;
  state.last_start_attempt_at_unix_ms = runtime->last_start_attempt_at_unix_ms;
  state.last_start_success_at_unix_ms = runtime->last_start_success_at_unix_ms;
  state.last_stop_at_unix_ms = runtime->last_stop_at_unix_ms;
}

SurfaceAttachmentState start_surface_attachment(
  const FfmpegProbeResult& ffmpeg,
  const HostCapturePlan& host_capture_plan,
  const HostCaptureProcessState& host_capture_process,
  const HostCaptureArtifactProbe& host_capture_artifact,
  SurfaceAttachmentState state) {
  (void)ffmpeg;
  state.attached = true;
  state.preview_runtime.reset();
  state.live_preview_runtime.reset();
  state.preview_surface_backend = "native-win32-gdi";
  state.decoder_backend = "none";
  state.decoder_ready = false;
  state.decoded_frames_rendered = 0;
  state.frame_interval_stddev_ms = 0.0;
  state.last_decoded_frame_at_unix_ms = -1;
  state.codec_path = host_capture_artifact.video_codec.empty() ? "h264" : to_lower_copy(host_capture_artifact.video_codec);
  state.implementation = host_capture_plan.capture_backend == "wgc"
    ? "wgc-live-preview"
    : "ffmpeg-native-artifact-preview";
  state.media_path = host_capture_plan.capture_backend == "wgc"
    ? host_capture_plan.input_target
    : host_capture_process.output_path;
  state.manifest_path = host_capture_process.manifest_path;
  state.window_title = "VDS Native Preview - " + (state.surface_id.empty() ? "surface" : state.surface_id);
  state.command_line.clear();
  state.last_start_attempt_at_unix_ms = current_time_millis();
  state.waiting_for_artifact = false;

  if (!is_host_capture_surface_target(state.target)) {
    state.reason = "surface-target-not-supported";
    state.last_error = "Only the host-capture artifact target is implemented for native surface attachment.";
    return state;
  }

  if (host_capture_plan.capture_backend == "wgc") {
    state.launch_attempted = true;
    NativeLivePreviewConfig config;
    config.surface_id = state.surface_id;
    config.window_title = state.window_title;
    config.target_kind = host_capture_plan.capture_kind == "display" ? "display" : "window";
    config.display_id = host_capture_plan.capture_display_id.empty() ? "0" : host_capture_plan.capture_display_id;
    config.window_handle = host_capture_plan.capture_handle;
    config.capture_state = host_capture_plan.capture_state;
    config.layout = state.surface_layout;

    std::string preview_error;
    state.live_preview_runtime = create_native_live_preview(config, &preview_error);
    if (!state.live_preview_runtime) {
      state.reason = "surface-live-preview-start-failed";
      state.last_error = preview_error;
      return state;
    }

    state.running = true;
    state.waiting_for_artifact = false;
    state.last_start_success_at_unix_ms = current_time_millis();
    refresh_surface_attachment_state(state);
    return state;
  }

  if (host_capture_process.output_path.empty()) {
    state.waiting_for_artifact = true;
    state.reason = "surface-waiting-for-artifact-path";
    state.last_error = "Host capture artifact path is not available yet.";
    return state;
  }

  if (!host_capture_artifact.ready) {
    state.waiting_for_artifact = true;
    state.reason = "surface-waiting-for-artifact-ready";
    state.last_error = host_capture_artifact.last_error.empty()
      ? "Host capture artifact is not decodable yet."
      : host_capture_artifact.last_error;
    return state;
  }

  state.launch_attempted = true;
  wait_for_path_to_exist(host_capture_process.output_path, 2000);
  NativeArtifactPreviewConfig config;
  config.surface_id = state.surface_id;
  config.window_title = state.window_title;
  config.media_path = state.media_path;
  config.codec = state.codec_path;
  config.layout = state.surface_layout;

  std::string preview_error;
  state.preview_runtime = create_native_artifact_preview(config, &preview_error);
  if (!state.preview_runtime) {
    state.reason = "surface-preview-start-failed";
    state.last_error = preview_error;
    return state;
  }

  state.running = true;
  state.waiting_for_artifact = false;
  state.last_start_success_at_unix_ms = current_time_millis();
  refresh_surface_attachment_state(state);
  return state;
}

void stop_surface_attachment(SurfaceAttachmentState& state, const std::string& reason) {
  refresh_surface_attachment_state(state);
  if (state.live_preview_runtime) {
    state.live_preview_runtime->close(reason);
    state.live_preview_runtime.reset();
    state.running = false;
    state.waiting_for_artifact = false;
    state.process_id = 0;
    state.reason = reason;
    state.last_stop_at_unix_ms = current_time_millis();
    return;
  }
  if (state.preview_runtime) {
    state.preview_runtime->close(reason);
    state.preview_runtime.reset();
    state.running = false;
    state.waiting_for_artifact = false;
    state.process_id = 0;
    state.reason = reason;
    state.last_stop_at_unix_ms = current_time_millis();
    return;
  }

  if (state.process_handle && state.running) {
    TerminateProcess(state.process_handle, 0);
    WaitForSingleObject(state.process_handle, 2000);
  }

  close_surface_attachment_handles(state);
  state.running = false;
  state.waiting_for_artifact = false;
  state.process_id = 0;
  state.reason = reason;
  state.last_stop_at_unix_ms = current_time_millis();
}

bool update_surface_attachment_layout(
  SurfaceAttachmentState& state,
  const NativeEmbeddedSurfaceLayout& layout,
  std::string* error) {
  state.surface_layout = layout;

  if (state.peer_runtime) {
    const bool updated = update_peer_video_surface_layout(*state.peer_runtime, layout, error);
    sync_surface_attachment_from_peer_runtime(state, state.peer_runtime);
    return updated;
  }

  if (state.live_preview_runtime) {
    const bool updated = state.live_preview_runtime->update_layout(layout, error);
    refresh_surface_attachment_state(state);
    return updated;
  }

  if (state.preview_runtime) {
    const bool updated = state.preview_runtime->update_layout(layout, error);
    refresh_surface_attachment_state(state);
    return updated;
  }

  if (error) {
    error->clear();
  }
  return true;
}

void refresh_host_capture_process_state(HostCaptureProcessState& state) {
  if (!state.output_path.empty()) {
    try {
      if (fs::exists(state.output_path)) {
        state.output_bytes = static_cast<unsigned long long>(fs::file_size(state.output_path));
      } else {
        state.output_bytes = 0;
      }
    } catch (...) {
    }
  }

  state.updated_at_unix_ms = current_time_millis();

  if (!state.process_handle) {
    return;
  }

  DWORD exit_code = STILL_ACTIVE;
  if (!GetExitCodeProcess(state.process_handle, &exit_code)) {
    state.running = false;
    state.last_error = format_windows_error(GetLastError());
    state.reason = "host-capture-process-state-read-failed";
    close_host_capture_process_handles(state);
    state.process_id = 0;
    return;
  }

  if (exit_code == STILL_ACTIVE) {
    state.running = true;
    return;
  }

  state.running = false;
  state.last_exit_code = static_cast<int>(exit_code);
  state.reason = "host-capture-process-exited";
  state.stopped_at_unix_ms = current_time_millis();
  close_host_capture_process_handles(state);
  state.process_id = 0;
}

void stop_host_capture_process(
  HostCaptureProcessState& state,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureArtifactProbe& artifact_probe,
  const std::string& reason) {
  refresh_host_capture_process_state(state);
  const bool already_stopped =
    !state.running &&
    !state.process_handle &&
    state.stopped_at_unix_ms > 0;

  if (state.process_handle && state.running) {
    TerminateProcess(state.process_handle, 0);
    WaitForSingleObject(state.process_handle, 2000);
  }

  close_host_capture_process_handles(state);
  state.running = false;
  state.process_id = 0;
  if (!(already_stopped && reason == "agent-shutdown")) {
    state.reason = reason;
    state.stopped_at_unix_ms = current_time_millis();
    state.updated_at_unix_ms = state.stopped_at_unix_ms;
  }
  if (state.preserve_output && !(already_stopped && reason == "agent-shutdown")) {
    persist_host_capture_process_manifest(pipeline, plan, state, artifact_probe);
  }
  if (!state.preserve_output && !state.output_path.empty()) {
    try {
      if (!state.output_directory.empty()) {
        fs::remove_all(state.output_directory);
      } else {
        fs::remove(state.output_path);
      }
      state.output_directory.clear();
      state.output_path.clear();
      state.manifest_path.clear();
      state.output_bytes = 0;
    } catch (...) {
    }
  }
}
#else
void refresh_host_capture_process_state(HostCaptureProcessState&) {}
void refresh_surface_attachment_state(SurfaceAttachmentState&) {}
HostCaptureArtifactProbe probe_host_capture_artifact(
  const FfmpegProbeResult&,
  const HostCaptureProcessState& host_capture_process,
  HostCaptureArtifactProbe previous_probe = {}) {
  HostCaptureArtifactProbe probe = previous_probe;
  probe.media_path = host_capture_process.output_path;
  probe.available = false;
  probe.ready = false;
  probe.reason = "artifact-probe-unsupported-platform";
  probe.last_error = "Host capture artifact probing is only implemented on Windows.";
  return probe;
}
void stop_host_capture_process(
  HostCaptureProcessState& state,
  const HostPipelineState&,
  const HostCapturePlan&,
  const HostCaptureArtifactProbe&,
  const std::string& reason) {
  state.running = false;
  state.process_id = 0;
  state.reason = reason;
}
SurfaceAttachmentState start_surface_attachment(
  const FfmpegProbeResult&,
  const HostCapturePlan&,
  const HostCaptureProcessState&,
  const HostCaptureArtifactProbe&,
  SurfaceAttachmentState state) {
  state.attached = true;
  state.preview_surface_backend = "native-window-embedding";
  state.decoder_backend = "none";
  state.decoder_ready = false;
  state.decoded_frames_rendered = 0;
  state.last_decoded_frame_at_unix_ms = -1;
  state.reason = "surface-unsupported-platform";
  state.last_error = "Native preview surfaces are only implemented on Windows.";
  return state;
}
void stop_surface_attachment(SurfaceAttachmentState& state, const std::string& reason) {
  state.running = false;
  state.process_id = 0;
  state.reason = reason;
}
void refresh_peer_video_receiver_runtime(PeerState::PeerVideoReceiverRuntime&) {}
bool start_peer_video_surface_attachment(
  const FfmpegProbeResult&,
  PeerState::PeerVideoReceiverRuntime&,
  std::string* error) {
  if (error) {
    *error = "peer-video-surface-is-only-implemented-on-windows";
  }
  return false;
}
void stop_peer_video_surface_attachment(PeerState::PeerVideoReceiverRuntime& runtime, const std::string& reason) {
  runtime.surface_attached = false;
  runtime.running = false;
  runtime.decoder_ready = false;
  runtime.reason = reason;
}
void sync_surface_attachment_from_peer_runtime(
  SurfaceAttachmentState&,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>&) {}
#endif

CommandResult run_command_capture(const std::string& command) {
  CommandResult result;

#ifdef _WIN32
  FILE* pipe = _popen(command.c_str(), "r");
#else
  FILE* pipe = popen(command.c_str(), "r");
#endif

  if (!pipe) {
    return result;
  }

  result.launched = true;
  char buffer[4096];
  while (std::fgets(buffer, static_cast<int>(sizeof(buffer)), pipe) != nullptr) {
    result.output += buffer;
  }

#ifdef _WIN32
  result.exit_code = _pclose(pipe);
#else
  result.exit_code = pclose(pipe);
#endif

  return result;
}

bool command_failed_to_resolve(const CommandResult& result) {
  if (!result.launched) {
    return true;
  }

  const std::string output = to_lower_copy(result.output);
  return output.find("is not recognized") != std::string::npos ||
    output.find("not found") != std::string::npos ||
    output.find("no such file") != std::string::npos;
}

std::vector<std::string> collect_flag_list(const std::string& output) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  for (const std::string& raw_line : split_lines(output)) {
    const std::string line = trim_copy(raw_line);
    if (line.empty()) {
      continue;
    }

    const std::string lowered = to_lower_copy(line);
    if (lowered == "hardware acceleration methods:" || lowered.rfind("ffmpeg version", 0) == 0) {
      continue;
    }

    if (line.find(' ') != std::string::npos || line.find('\t') != std::string::npos) {
      continue;
    }

    if (seen.insert(line).second) {
      values.push_back(line);
    }
  }
  return values;
}

std::vector<std::string> collect_codec_names(
  const std::string& output,
  const std::vector<std::string>& keywords) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  const std::regex codec_pattern("^\\s*[A-Z\\.]{6}\\s+([^\\s]+)");

  for (const std::string& raw_line : split_lines(output)) {
    std::smatch match;
    if (!std::regex_search(raw_line, match, codec_pattern)) {
      continue;
    }

    const std::string name = match[1].str();
    const std::string lowered = to_lower_copy(name);
    const bool matches = std::any_of(keywords.begin(), keywords.end(), [&](const std::string& keyword) {
      return lowered.find(keyword) != std::string::npos;
    });

    if (matches && seen.insert(name).second) {
      values.push_back(name);
    }
  }

  return values;
}

CommandResult run_ffmpeg_encoder_self_test(
  const FfmpegProbeResult& ffmpeg,
  const std::string& video_encoder,
  const std::string& audio_encoder);

int video_encoder_probe_priority(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.find("_nvenc") != std::string::npos) {
    return 10;
  }
  if (normalized.find("_amf") != std::string::npos) {
    return 20;
  }
  if (normalized.find("_qsv") != std::string::npos) {
    return 30;
  }
  if (normalized.find("_d3d12va") != std::string::npos) {
    return 40;
  }
  if (normalized.find("_mf") != std::string::npos) {
    return 50;
  }
  if (normalized == "libx264" || normalized == "libx265") {
    return 90;
  }
  if (normalized == "libopenh264") {
    return 95;
  }
  return 100;
}

bool encoder_supports_low_latency(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  return is_hardware_video_encoder(normalized) ||
    normalized == "libx264" ||
    normalized == "libx265" ||
    normalized == "libopenh264";
}

AVHWDeviceType required_hw_device_type_for_encoder(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.find("_d3d12va") != std::string::npos) {
    return AV_HWDEVICE_TYPE_D3D12VA;
  }
  return AV_HWDEVICE_TYPE_NONE;
}

bool codec_supports_hw_device(const AVCodec* codec, AVHWDeviceType device_type) {
  if (!codec || device_type == AV_HWDEVICE_TYPE_NONE) {
    return false;
  }

  for (int index = 0;; ++index) {
    const AVCodecHWConfig* config = avcodec_get_hw_config(codec, index);
    if (!config) {
      return false;
    }
    if ((config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) == 0) {
      continue;
    }
    if (config->device_type == device_type) {
      return true;
    }
  }
}

AVPixelFormat select_probe_pixel_format(const AVCodec* codec) {
  if (!codec) {
    return AV_PIX_FMT_NONE;
  }

  const void* supported_configs = nullptr;
  int supported_config_count = 0;
  if (avcodec_get_supported_config(
    nullptr,
    codec,
    AV_CODEC_CONFIG_PIX_FORMAT,
    0,
    &supported_configs,
    &supported_config_count
  ) < 0 || !supported_configs || supported_config_count <= 0) {
    return AV_PIX_FMT_NONE;
  }

  const auto* pixel_formats = static_cast<const AVPixelFormat*>(supported_configs);
  AVPixelFormat first_supported = AV_PIX_FMT_NONE;
  for (int index = 0; index < supported_config_count; ++index) {
    const AVPixelFormat format = pixel_formats[index];
    if (first_supported == AV_PIX_FMT_NONE) {
      first_supported = format;
    }
    if (format == AV_PIX_FMT_NV12) {
      return format;
    }
  }

  for (int index = 0; index < supported_config_count; ++index) {
    const AVPixelFormat format = pixel_formats[index];
    if (format == AV_PIX_FMT_YUV420P || format == AV_PIX_FMT_YUVJ420P) {
      return format;
    }
  }

  return first_supported;
}

bool fill_probe_test_frame(AVFrame* frame, std::string* error) {
  if (!frame) {
    if (error) {
      *error = "encoder-frame-missing";
    }
    return false;
  }

  if (frame->format == AV_PIX_FMT_NV12) {
    for (int y = 0; y < frame->height; ++y) {
      std::memset(frame->data[0] + (y * frame->linesize[0]), 0x10, static_cast<std::size_t>(frame->width));
    }

    for (int y = 0; y < frame->height / 2; ++y) {
      std::memset(frame->data[1] + (y * frame->linesize[1]), 0x80, static_cast<std::size_t>(frame->width));
    }
    return true;
  }

  if (frame->format == AV_PIX_FMT_YUV420P || frame->format == AV_PIX_FMT_YUVJ420P) {
    for (int y = 0; y < frame->height; ++y) {
      std::memset(frame->data[0] + (y * frame->linesize[0]), 0x10, static_cast<std::size_t>(frame->width));
    }
    for (int y = 0; y < frame->height / 2; ++y) {
      std::memset(frame->data[1] + (y * frame->linesize[1]), 0x80, static_cast<std::size_t>(frame->width / 2));
      std::memset(frame->data[2] + (y * frame->linesize[2]), 0x80, static_cast<std::size_t>(frame->width / 2));
    }
    return true;
  }

  if (error) {
    *error = "unsupported-probe-pixel-format";
  }
  return false;
}

VideoEncoderProbeResult run_video_encoder_probe(const std::string& video_encoder) {
  VideoEncoderProbeResult probe;
  probe.name = trim_copy(video_encoder);
  probe.hardware = is_hardware_video_encoder(probe.name);
  probe.supports_low_latency = encoder_supports_low_latency(probe.name);
  probe.priority = video_encoder_probe_priority(probe.name);

  const AVCodec* codec = avcodec_find_encoder_by_name(probe.name.c_str());
  if (!codec) {
    probe.reason = "encoder-missing";
    probe.error = "avcodec-find-encoder-by-name-failed";
    return probe;
  }

  probe.exists = true;

  AVBufferRef* device_ref = nullptr;
  AVCodecContext* codec_context = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* packet = nullptr;

  const AVHWDeviceType device_type = required_hw_device_type_for_encoder(probe.name);
  if (device_type != AV_HWDEVICE_TYPE_NONE) {
    probe.requires_hw_device = true;
    probe.hw_device_type = av_hwdevice_get_type_name(device_type);

    if (!codec_supports_hw_device(codec, device_type)) {
      probe.reason = "encoder-hw-device-unsupported";
      probe.error = "encoder-does-not-support-hw-device-context";
      return probe;
    }

    const int hw_result = av_hwdevice_ctx_create(&device_ref, device_type, nullptr, nullptr, 0);
    if (hw_result < 0 || !device_ref) {
      probe.reason = "hardware-device-unavailable";
      probe.error = hw_result < 0 ? ffmpeg_error_string(hw_result) : "av-hwdevice-ctx-create-failed";
      if (device_ref) {
        av_buffer_unref(&device_ref);
      }
      return probe;
    }

    probe.hw_device_ready = true;
  }

  codec_context = avcodec_alloc_context3(codec);
  if (!codec_context) {
    probe.reason = "encoder-context-allocation-failed";
    probe.error = "avcodec-alloc-context3-failed";
    av_buffer_unref(&device_ref);
    return probe;
  }

  codec_context->width = 640;
  codec_context->height = 480;
  codec_context->time_base = AVRational { 1, 30 };
  codec_context->framerate = AVRational { 30, 1 };
  codec_context->bit_rate = 1000000;
  codec_context->pix_fmt = select_probe_pixel_format(codec);
  codec_context->gop_size = 30;
  codec_context->max_b_frames = 0;
  codec_context->flags |= AV_CODEC_FLAG_LOW_DELAY;

  if (codec_context->pix_fmt == AV_PIX_FMT_NONE) {
    probe.reason = "encoder-pixel-format-unsupported";
    probe.error = "encoder-has-no-supported-probe-pixel-format";
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  if (device_ref) {
    codec_context->hw_device_ctx = av_buffer_ref(device_ref);
    if (!codec_context->hw_device_ctx) {
      probe.reason = "encoder-hw-device-attach-failed";
      probe.error = "av-buffer-ref-failed";
      avcodec_free_context(&codec_context);
      av_buffer_unref(&device_ref);
      return probe;
    }
  }

  const int open_result = avcodec_open2(codec_context, codec, nullptr);
  if (open_result < 0) {
    probe.reason = "encoder-open-failed";
    probe.error = ffmpeg_error_string(open_result);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  probe.open_succeeded = true;

  frame = av_frame_alloc();
  packet = av_packet_alloc();
  if (!frame || !packet) {
    probe.reason = "encoder-frame-allocation-failed";
    probe.error = "av-frame-or-packet-allocation-failed";
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  frame->format = codec_context->pix_fmt;
  frame->width = codec_context->width;
  frame->height = codec_context->height;

  int buffer_result = av_frame_get_buffer(frame, 32);
  if (buffer_result < 0) {
    probe.reason = "encoder-frame-buffer-failed";
    probe.error = ffmpeg_error_string(buffer_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  buffer_result = av_frame_make_writable(frame);
  if (buffer_result < 0) {
    probe.reason = "encoder-frame-not-writable";
    probe.error = ffmpeg_error_string(buffer_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  std::string fill_error;
  if (!fill_probe_test_frame(frame, &fill_error)) {
    probe.reason = "encoder-test-frame-fill-failed";
    probe.error = fill_error;
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }
  frame->pts = 0;

  int send_result = avcodec_send_frame(codec_context, frame);
  if (send_result < 0) {
    probe.reason = "encoder-send-frame-failed";
    probe.error = ffmpeg_error_string(send_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  const int flush_result = avcodec_send_frame(codec_context, nullptr);
  if (flush_result < 0 && flush_result != AVERROR_EOF) {
    probe.reason = "encoder-flush-failed";
    probe.error = ffmpeg_error_string(flush_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  for (int attempt = 0; attempt < 5; ++attempt) {
    const int receive_result = avcodec_receive_packet(codec_context, packet);
    if (receive_result == 0) {
      if (packet->size > 0) {
        probe.output_succeeded = true;
        probe.validated = true;
        probe.reason = "encoder-self-test-passed";
        probe.error.clear();
        av_packet_unref(packet);
        break;
      }

      av_packet_unref(packet);
      continue;
    }

    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      continue;
    }

    probe.reason = "encoder-receive-packet-failed";
    probe.error = ffmpeg_error_string(receive_result);
    break;
  }

  if (!probe.validated && probe.reason.empty()) {
    probe.reason = "encoder-self-test-no-output";
    probe.error = "encoded-packet-not-produced";
  }

  av_frame_free(&frame);
  av_packet_free(&packet);
  avcodec_free_context(&codec_context);
  av_buffer_unref(&device_ref);
  return probe;
}

std::string select_preferred_audio_encoder(const std::vector<std::string>& audio_encoders) {
  if (std::find(audio_encoders.begin(), audio_encoders.end(), "libopus") != audio_encoders.end()) {
    return "libopus";
  }
  if (std::find(audio_encoders.begin(), audio_encoders.end(), "opus") != audio_encoders.end()) {
    return "opus";
  }
  return {};
}

std::vector<std::string> collect_ffmpeg_devices(const std::string& output, bool demuxing_supported) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  bool in_device_table = false;

  for (const std::string& raw_line : split_lines(output)) {
    const std::string trimmed = trim_copy(raw_line);
    if (trimmed == "---") {
      in_device_table = true;
      continue;
    }

    if (!in_device_table) {
      continue;
    }

    std::stringstream line_stream(trimmed);
    std::string flags;
    std::string name;
    line_stream >> flags >> name;
    if (flags.empty() || name.empty()) {
      continue;
    }

    const bool supports_demuxing = flags.find('D') != std::string::npos;
    const bool supports_muxing = flags.find('E') != std::string::npos;
    if ((demuxing_supported && !supports_demuxing) || (!demuxing_supported && !supports_muxing)) {
      continue;
    }

    if (name == "=") {
      continue;
    }

    if (seen.insert(name).second) {
      values.push_back(name);
    }
  }

  return values;
}

std::vector<std::string> build_ffmpeg_candidates(const std::string& agent_binary_path) {
  std::vector<std::string> candidates;
  std::set<std::string> seen;

  const auto append_candidate = [&](const std::string& candidate) {
    if (!candidate.empty() && seen.insert(candidate).second) {
      candidates.push_back(candidate);
    }
  };

#ifdef _WIN32
  char* env_path = nullptr;
  std::size_t env_length = 0;
  if (_dupenv_s(&env_path, &env_length, "VDS_FFMPEG_PATH") == 0 && env_path) {
    append_candidate(env_path);
    std::free(env_path);
  }
#else
  if (const char* env_path = std::getenv("VDS_FFMPEG_PATH")) {
    append_candidate(env_path);
  }
#endif

  if (!agent_binary_path.empty()) {
    const fs::path agent_path(agent_binary_path);
    const fs::path agent_dir = agent_path.parent_path();
    append_candidate((agent_dir / "ffmpeg.exe").string());
    append_candidate((agent_dir / "ffmpeg" / "ffmpeg.exe").string());
    append_candidate((agent_dir / "ffmpeg" / "bin" / "ffmpeg.exe").string());
    append_candidate((agent_dir.parent_path() / "ffmpeg.exe").string());
    append_candidate((agent_dir.parent_path() / "ffmpeg" / "bin" / "ffmpeg.exe").string());
  }

  append_candidate("ffmpeg");
  return candidates;
}

std::string parse_ffmpeg_version(const std::string& output) {
  const std::regex version_pattern("ffmpeg version\\s+([^\\s]+)");
  std::smatch match;
  if (std::regex_search(output, match, version_pattern)) {
    return match[1].str();
  }

  return {};
}

FfmpegProbeResult probe_ffmpeg(const std::string& agent_binary_path) {
  FfmpegProbeResult probe;
  const std::vector<std::string> candidates = build_ffmpeg_candidates(agent_binary_path);

  for (const std::string& candidate : candidates) {
    const bool requires_existence_check =
      candidate.find('\\') != std::string::npos ||
      candidate.find('/') != std::string::npos ||
      candidate.find(':') != std::string::npos;

    if (requires_existence_check && !fs::exists(candidate)) {
      continue;
    }

    const std::string command_target = requires_existence_check ? quote_command_path(candidate) : candidate;
    const CommandResult version_result = run_command_capture(command_target + " -hide_banner -version 2>&1");
    const std::string parsed_version = parse_ffmpeg_version(version_result.output);

    if (command_failed_to_resolve(version_result)) {
      probe.error = "ffmpeg-binary-not-found";
      continue;
    }

    if (!version_result.launched || (version_result.exit_code != 0 && parsed_version.empty())) {
      if (!requires_existence_check && parsed_version.empty()) {
        probe.error = "ffmpeg-binary-not-found";
      } else {
        probe.error = trim_copy(version_result.output);
      }

      if (probe.error.empty()) {
        probe.error = "ffmpeg-version-probe-failed";
      }
      continue;
    }

    probe.available = true;
    probe.path = candidate;
    probe.version = parsed_version;

    const CommandResult hwaccels_result = run_command_capture(command_target + " -hide_banner -hwaccels 2>&1");
    if (hwaccels_result.launched && hwaccels_result.exit_code == 0) {
      probe.hwaccels = collect_flag_list(hwaccels_result.output);
    }

    const CommandResult bsfs_result = run_command_capture(command_target + " -hide_banner -bsfs 2>&1");
    if (bsfs_result.launched && bsfs_result.exit_code == 0) {
      probe.bitstream_filters = collect_flag_list(bsfs_result.output);
      probe.h264_metadata_bsf_available =
        std::find(probe.bitstream_filters.begin(), probe.bitstream_filters.end(), "h264_metadata") != probe.bitstream_filters.end();
      probe.hevc_metadata_bsf_available =
        std::find(probe.bitstream_filters.begin(), probe.bitstream_filters.end(), "hevc_metadata") != probe.bitstream_filters.end();
    }

    const CommandResult devices_result = run_command_capture(command_target + " -hide_banner -devices 2>&1");
    if (devices_result.launched && !trim_copy(devices_result.output).empty()) {
      probe.input_devices = collect_ffmpeg_devices(devices_result.output, true);
    }

    const std::vector<std::string> capability_probe_encoders = {
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_d3d12va",
      "h264_mf",
      "libx264",
      "libopenh264",
      "hevc_nvenc",
      "hevc_amf",
      "hevc_qsv",
      "hevc_d3d12va",
      "hevc_mf",
      "libx265"
    };

    const CommandResult encoders_result = run_command_capture(command_target + " -hide_banner -encoders 2>&1");
    if (encoders_result.launched && encoders_result.exit_code == 0) {
      probe.video_encoders = collect_codec_names(encoders_result.output, { "264", "265", "hevc" });
      probe.audio_encoders = collect_codec_names(encoders_result.output, { "opus" });
    }

    for (const std::string& encoder : capability_probe_encoders) {
      VideoEncoderProbeResult validation = run_video_encoder_probe(encoder);
      probe.video_encoder_probes.push_back(validation);
      if (validation.validated) {
        probe.validated_video_encoders.push_back(encoder);
      }
    }

    const CommandResult decoders_result = run_command_capture(command_target + " -hide_banner -decoders 2>&1");
    if (decoders_result.launched && decoders_result.exit_code == 0) {
      probe.video_decoders = collect_codec_names(decoders_result.output, { "264", "265", "hevc" });
      probe.audio_decoders = collect_codec_names(decoders_result.output, { "opus" });
    }

    probe.error.clear();
    return probe;
  }

  if (probe.error.empty()) {
    probe.error = "ffmpeg-binary-not-found";
  }

  return probe;
}

std::string ffmpeg_probe_json(const FfmpegProbeResult& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"path\":\"" << json_escape(probe.path) << "\""
    << ",\"version\":\"" << json_escape(probe.version) << "\""
    << ",\"hwaccels\":" << json_array_from_strings(probe.hwaccels)
    << ",\"bitstreamFilters\":" << json_array_from_strings(probe.bitstream_filters)
    << ",\"inputDevices\":" << json_array_from_strings(probe.input_devices)
    << ",\"videoEncoders\":" << json_array_from_strings(probe.video_encoders)
    << ",\"validatedVideoEncoders\":" << json_array_from_strings(probe.validated_video_encoders)
    << ",\"videoEncoderProbes\":" << json_array_from_video_encoder_probes(probe.video_encoder_probes)
    << ",\"videoDecoders\":" << json_array_from_strings(probe.video_decoders)
    << ",\"audioEncoders\":" << json_array_from_strings(probe.audio_encoders)
    << ",\"audioDecoders\":" << json_array_from_strings(probe.audio_decoders)
    << ",\"h264MetadataBsfAvailable\":" << (probe.h264_metadata_bsf_available ? "true" : "false")
    << ",\"hevcMetadataBsfAvailable\":" << (probe.hevc_metadata_bsf_available ? "true" : "false")
    << ",\"error\":\"" << json_escape(probe.error) << "\""
    << "}";
  return payload.str();
}

std::string audio_session_json(const AudioSessionState& session) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (session.ready ? "true" : "false")
    << ",\"running\":" << (session.running ? "true" : "false")
    << ",\"captureActive\":" << (session.capture_active ? "true" : "false")
    << ",\"platformSupported\":" << (session.platform_supported ? "true" : "false")
    << ",\"deviceEnumeratorAvailable\":" << (session.device_enumerator_available ? "true" : "false")
    << ",\"renderDeviceCount\":" << session.render_device_count
    << ",\"pid\":" << session.pid
    << ",\"processName\":\"" << json_escape(session.process_name) << "\""
    << ",\"backendMode\":\"" << json_escape(session.backend_mode) << "\""
    << ",\"implementation\":\"" << json_escape(session.implementation) << "\""
    << ",\"lastError\":\"" << json_escape(session.last_error) << "\""
    << ",\"reason\":\"" << json_escape(session.reason) << "\""
    << ",\"sampleRate\":" << session.sample_rate
    << ",\"channelCount\":" << session.channel_count
    << ",\"bitsPerSample\":" << session.bits_per_sample
    << ",\"blockAlign\":" << session.block_align
    << ",\"bufferFrameCount\":" << session.buffer_frame_count
    << ",\"lastBufferFrames\":" << session.last_buffer_frames
    << ",\"packetsCaptured\":" << session.packets_captured
    << ",\"framesCaptured\":" << session.frames_captured
    << ",\"silentPackets\":" << session.silent_packets
    << ",\"activationAttempts\":" << session.activation_attempts
    << ",\"activationSuccesses\":" << session.activation_successes
    << "}";
  return payload.str();
}

std::string viewer_audio_playback_json(AgentRuntimeState::ViewerAudioPlaybackRuntime& runtime) {
  std::lock_guard<std::mutex> lock(runtime.mutex);

  std::ostringstream payload;
  payload
    << "{\"running\":" << (runtime.running ? "true" : "false")
    << ",\"ready\":" << (runtime.ready ? "true" : "false")
    << ",\"threadStarted\":" << (runtime.thread_started ? "true" : "false")
    << ",\"playbackPrimed\":" << (runtime.playback_primed ? "true" : "false")
    << ",\"passthroughMode\":" << (runtime.passthrough_mode ? "true" : "false")
    << ",\"queueDepth\":" << runtime.pcm_queue.size()
    << ",\"audioPacketsReceived\":" << runtime.audio_packets_received
    << ",\"audioBytesReceived\":" << runtime.audio_bytes_received
    << ",\"pcmFramesQueued\":" << runtime.pcm_frames_queued
    << ",\"pcmFramesPlayed\":" << runtime.pcm_frames_played
    << ",\"bufferedPcmFrames\":" << runtime.buffered_pcm_frames
    << ",\"targetBufferFrames\":" << runtime.target_buffer_frames
    << ",\"targetBufferMs\":" << ((runtime.target_buffer_frames * 1000u) / kViewerAudioSampleRate)
    << ",\"audioDelayMs\":" << runtime.passthrough_audio_delay_ms
    << ",\"softwareVolume\":" << runtime.software_volume
    << ",\"implementation\":\"" << json_escape(runtime.implementation) << "\""
    << ",\"reason\":\"" << json_escape(runtime.reason) << "\""
    << ",\"lastError\":\"" << json_escape(runtime.last_error) << "\""
    << "}";
  return payload.str();
}

bool contains_value(const std::vector<std::string>& values, const std::string& target) {
  return std::find(values.begin(), values.end(), target) != values.end();
}

const VideoEncoderProbeResult* find_video_encoder_probe(
  const FfmpegProbeResult& ffmpeg,
  const std::string& target) {
  const std::string normalized = to_lower_copy(trim_copy(target));
  for (const VideoEncoderProbeResult& probe : ffmpeg.video_encoder_probes) {
    if (to_lower_copy(trim_copy(probe.name)) == normalized) {
      return &probe;
    }
  }
  return nullptr;
}

bool encoder_exists_for_runtime(const FfmpegProbeResult& ffmpeg, const std::string& target) {
  if (contains_value(ffmpeg.video_encoders, target)) {
    return true;
  }
  const VideoEncoderProbeResult* probe = find_video_encoder_probe(ffmpeg, target);
  return probe && probe->exists;
}

std::string normalize_video_encoder_preference(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.empty() || normalized == "auto") {
    return {};
  }
  return normalized;
}

bool video_encoder_matches_codec(const std::string& encoder, const std::string& requested_codec) {
  const std::string lowered = to_lower_copy(trim_copy(encoder));
  if (lowered.empty()) {
    return false;
  }

  const bool wants_hevc = requested_codec == "h265" || requested_codec == "hevc";
  if (wants_hevc) {
    return lowered.find("265") != std::string::npos || lowered.find("hevc") != std::string::npos;
  }

  return lowered.find("264") != std::string::npos &&
    lowered.find("265") == std::string::npos &&
    lowered.find("hevc") == std::string::npos;
}

bool is_hardware_video_encoder(const std::string& encoder) {
  return encoder.find("_amf") != std::string::npos ||
    encoder.find("_mf") != std::string::npos ||
    encoder.find("_qsv") != std::string::npos ||
    encoder.find("_nvenc") != std::string::npos ||
    encoder.find("_d3d12va") != std::string::npos;
}

CommandResult run_ffmpeg_encoder_self_test(
  const FfmpegProbeResult& ffmpeg,
  const std::string& video_encoder,
  const std::string& audio_encoder) {
  CommandResult result;
  if (!ffmpeg.available || ffmpeg.path.empty() || video_encoder.empty() || audio_encoder.empty()) {
    return result;
  }

  (void)audio_encoder;
  const VideoEncoderProbeResult* cached_probe = find_video_encoder_probe(ffmpeg, video_encoder);
  const VideoEncoderProbeResult probe = cached_probe
    ? *cached_probe
    : run_video_encoder_probe(video_encoder);
  result.launched = probe.exists;
  result.exit_code = probe.validated ? 0 : 1;
  result.output = probe.error.empty() ? probe.reason : (probe.reason + ": " + probe.error);
  return result;
}

std::string host_pipeline_json(const HostPipelineState& pipeline) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (pipeline.ready ? "true" : "false")
    << ",\"hardware\":" << (pipeline.hardware ? "true" : "false")
    << ",\"validated\":" << (pipeline.validated ? "true" : "false")
    << ",\"preferHardware\":" << (pipeline.prefer_hardware ? "true" : "false")
    << ",\"requestedVideoCodec\":\"" << json_escape(pipeline.requested_video_codec) << "\""
    << ",\"requestedVideoEncoder\":\"" << json_escape(pipeline.requested_video_encoder) << "\""
    << ",\"requestedPreset\":\"" << json_escape(pipeline.requested_preset) << "\""
    << ",\"requestedTune\":\"" << json_escape(pipeline.requested_tune) << "\""
    << ",\"selectedVideoEncoder\":\"" << json_escape(pipeline.selected_video_encoder) << "\""
    << ",\"videoEncoderBackend\":\"" << json_escape(pipeline.video_encoder_backend) << "\""
    << ",\"selectedAudioEncoder\":\"" << json_escape(pipeline.selected_audio_encoder) << "\""
    << ",\"implementation\":\"" << json_escape(pipeline.implementation) << "\""
    << ",\"reason\":\"" << json_escape(pipeline.reason) << "\""
    << ",\"validationReason\":\"" << json_escape(pipeline.validation_reason) << "\""
    << ",\"lastError\":\"" << json_escape(pipeline.last_error) << "\""
    << "}";
  return payload.str();
}

std::string wgc_capture_probe_json(const WgcCaptureProbe& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"implemented\":" << (probe.implemented ? "true" : "false")
    << ",\"platformSupported\":" << (probe.platform_supported ? "true" : "false")
    << ",\"implementation\":\"" << json_escape(probe.implementation) << "\""
    << ",\"reason\":\"" << json_escape(probe.reason) << "\""
    << ",\"lastError\":\"" << json_escape(probe.last_error) << "\""
    << "}";
  return payload.str();
}

std::string host_capture_plan_json(const HostCapturePlan& plan) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (plan.ready ? "true" : "false")
    << ",\"validated\":" << (plan.validated ? "true" : "false")
    << ",\"captureKind\":\"" << json_escape(plan.capture_kind) << "\""
    << ",\"captureState\":\"" << json_escape(plan.capture_state) << "\""
    << ",\"preferredCaptureBackend\":\"" << json_escape(plan.preferred_capture_backend) << "\""
    << ",\"captureBackend\":\"" << json_escape(plan.capture_backend) << "\""
    << ",\"captureFallbackReason\":\"" << json_escape(plan.capture_fallback_reason) << "\""
    << ",\"captureHandle\":\"" << json_escape(plan.capture_handle) << "\""
    << ",\"captureDisplayId\":\"" << json_escape(plan.capture_display_id) << "\""
    << ",\"width\":" << plan.width
    << ",\"height\":" << plan.height
    << ",\"frameRate\":" << plan.frame_rate
    << ",\"bitrateKbps\":" << plan.bitrate_kbps
    << ",\"inputWidth\":" << plan.input_width
    << ",\"inputHeight\":" << plan.input_height
    << ",\"inputFormat\":\"" << json_escape(plan.input_format) << "\""
    << ",\"inputTarget\":\"" << json_escape(plan.input_target) << "\""
    << ",\"codecPath\":\"" << json_escape(plan.codec_path) << "\""
    << ",\"implementation\":\"" << json_escape(plan.implementation) << "\""
    << ",\"reason\":\"" << json_escape(plan.reason) << "\""
    << ",\"validationReason\":\"" << json_escape(plan.validation_reason) << "\""
    << ",\"lastError\":\"" << json_escape(plan.last_error) << "\""
    << ",\"commandPreview\":\"" << json_escape(plan.command_preview) << "\""
    << "}";
  return payload.str();
}

std::string host_capture_process_json(HostCaptureProcessState& state) {
  refresh_host_capture_process_state(state);

  std::ostringstream payload;
  payload
    << "{\"enabled\":" << (state.enabled ? "true" : "false")
    << ",\"launchAttempted\":" << (state.launch_attempted ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"preserveOutput\":" << (state.preserve_output ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"outputBytes\":" << state.output_bytes
    << ",\"lastExitCode\":";

  if (state.last_exit_code == std::numeric_limits<int>::min()) {
    payload << "null";
  } else {
    payload << state.last_exit_code;
  }

  payload
    << ",\"implementation\":\"" << json_escape(state.implementation) << "\""
    << ",\"outputMode\":\"" << json_escape(state.output_mode) << "\""
    << ",\"container\":\"" << json_escape(state.container) << "\""
    << ",\"sessionId\":\"" << json_escape(state.session_id) << "\""
    << ",\"outputDirectory\":\"" << json_escape(state.output_directory) << "\""
    << ",\"outputPath\":\"" << json_escape(state.output_path) << "\""
    << ",\"manifestPath\":\"" << json_escape(state.manifest_path) << "\""
    << ",\"reason\":\"" << json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << json_escape(state.command_line) << "\""
    << ",\"startedAtMs\":";
  append_nullable_int64(payload, state.started_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"stoppedAtMs\":";
  append_nullable_int64(payload, state.stopped_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"ready\":" << (probe.ready ? "true" : "false")
    << ",\"fileSizeBytes\":" << probe.file_size_bytes
    << ",\"width\":" << probe.width
    << ",\"height\":" << probe.height
    << ",\"frameRate\":" << std::fixed << std::setprecision(3) << probe.frame_rate
    << ",\"lastProbeAtMs\":";
  append_nullable_int64(payload, probe.last_probe_at_unix_ms);
  payload
    << ",\"mediaPath\":\"" << json_escape(probe.media_path) << "\""
    << ",\"formatName\":\"" << json_escape(probe.format_name) << "\""
    << ",\"videoCodec\":\"" << json_escape(probe.video_codec) << "\""
    << ",\"pixelFormat\":\"" << json_escape(probe.pixel_format) << "\""
    << ",\"reason\":\"" << json_escape(probe.reason) << "\""
    << ",\"lastError\":\"" << json_escape(probe.last_error) << "\""
    << "}";
  return payload.str();
}

void append_video_encoder_runtime_flags(std::ostringstream& command, const HostPipelineState& pipeline);

std::string build_ffmpeg_host_capture_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureProcessState& process_state) {
  if (!ffmpeg.available || ffmpeg.path.empty() || pipeline.selected_video_encoder.empty()) {
    return {};
  }

  std::ostringstream command;
  command << quote_command_path(ffmpeg.path) << " -hide_banner -loglevel error -nostats -nostdin";

  if (plan.capture_backend == "wgc") {
    if (plan.input_width <= 0 || plan.input_height <= 0) {
      return {};
    }
    command
      << " -f rawvideo -pix_fmt bgra"
      << " -video_size " << plan.input_width << "x" << plan.input_height
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i pipe:0";
  } else {
    if (plan.input_format.empty() || plan.input_target.empty()) {
      return {};
    }
    command
      << " -f " << plan.input_format
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i " << quote_command_path(plan.input_target);
  }

  command << " -c:v " << pipeline.selected_video_encoder;

  if (plan.width > 0 && plan.height > 0) {
    command
      << " -vf scale=" << plan.width << ":" << plan.height
      << ":force_original_aspect_ratio=decrease"
      << ",pad=" << plan.width << ":" << plan.height << ":(ow-iw)/2:(oh-ih)/2:color=black"
      << ",setsar=1";
  }

  if (plan.bitrate_kbps > 0) {
    command << " -b:v " << plan.bitrate_kbps << "k";
  }

  const int normalized_frame_rate = plan.frame_rate > 0 ? plan.frame_rate : 60;
  const int gop_size = std::max(1, normalized_frame_rate * 2);
  command << " -g " << gop_size;

  append_video_encoder_runtime_flags(command, pipeline);

  if (process_state.enabled && process_state.container == "mpegts" && !process_state.output_path.empty()) {
    command << " -an -flush_packets 1 -muxdelay 0 -muxpreload 0 -mpegts_flags +resend_headers -f mpegts " << quote_command_path(process_state.output_path);
  } else {
    command << " -an -f null -";
  }
  return command.str();
}

bool is_h264_video_encoder(const std::string& encoder) {
  const std::string lowered = to_lower_copy(encoder);
  return lowered.find("264") != std::string::npos;
}

bool is_h265_video_encoder(const std::string& encoder) {
  const std::string lowered = to_lower_copy(encoder);
  return lowered.find("265") != std::string::npos || lowered.find("hevc") != std::string::npos;
}

int normalize_host_output_dimension(int value, int fallback) {
  return value > 0 ? value : fallback;
}

#ifdef _WIN32
struct DisplayDimensionLookupContext {
  int target_index = 0;
  int current_index = 0;
  RECT bounds {};
  std::wstring device_name;
  bool found = false;
};

BOOL CALLBACK enum_display_dimension_proc(HMONITOR monitor, HDC, LPRECT, LPARAM context_value) {
  auto* context = reinterpret_cast<DisplayDimensionLookupContext*>(context_value);
  if (!context || context->found) {
    return TRUE;
  }

  if (context->current_index == context->target_index) {
    MONITORINFOEXW monitor_info {};
    monitor_info.cbSize = sizeof(monitor_info);
    if (GetMonitorInfoW(monitor, &monitor_info)) {
      context->bounds = monitor_info.rcMonitor;
      context->device_name = monitor_info.szDevice;
      context->found = true;
    }
    return FALSE;
  }

  context->current_index += 1;
  return TRUE;
}

bool resolve_wgc_display_dimensions(const std::string& display_id, int* width, int* height, std::string* error) {
  if (!width || !height) {
    if (error) {
      *error = "wgc-display-dimension-output-missing";
    }
    return false;
  }

  char* parse_end = nullptr;
  const unsigned long monitor_index = std::strtoul(display_id.c_str(), &parse_end, 10);
  if (!parse_end || *parse_end != '\0') {
    if (error) {
      *error = "wgc-display-id-must-be-a-numeric-monitor-index";
    }
    return false;
  }

  DisplayDimensionLookupContext context;
  context.target_index = static_cast<int>(monitor_index);
  EnumDisplayMonitors(nullptr, nullptr, &enum_display_dimension_proc, reinterpret_cast<LPARAM>(&context));
  if (!context.found) {
    if (error) {
      *error = "wgc-display-monitor-not-found";
    }
    return false;
  }

  DEVMODEW display_mode {};
  display_mode.dmSize = sizeof(display_mode);
  if (!context.device_name.empty() &&
      EnumDisplaySettingsW(context.device_name.c_str(), ENUM_CURRENT_SETTINGS, &display_mode) &&
      display_mode.dmPelsWidth > 0 &&
      display_mode.dmPelsHeight > 0) {
    *width = static_cast<int>(display_mode.dmPelsWidth);
    *height = static_cast<int>(display_mode.dmPelsHeight);
  } else {
    *width = std::max(0, static_cast<int>(context.bounds.right - context.bounds.left));
    *height = std::max(0, static_cast<int>(context.bounds.bottom - context.bounds.top));
  }

  if (*width <= 0 || *height <= 0) {
    if (error) {
      *error = "wgc-display-monitor-bounds-empty";
    }
    return false;
  }

  return true;
}

UINT get_window_dpi_or_default(HWND hwnd) {
  using GetDpiForWindowFn = UINT (WINAPI*)(HWND);
  static const auto get_dpi_for_window = reinterpret_cast<GetDpiForWindowFn>(
    GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow")
  );
  if (!get_dpi_for_window || !hwnd) {
    return 96;
  }

  const UINT dpi = get_dpi_for_window(hwnd);
  return dpi == 0 ? 96 : dpi;
}

bool get_window_capture_rect(HWND hwnd, RECT* rect) {
  if (!hwnd || !rect || !IsWindow(hwnd)) {
    return false;
  }

  if (IsIconic(hwnd)) {
    WINDOWPLACEMENT placement {};
    placement.length = sizeof(placement);
    if (GetWindowPlacement(hwnd, &placement)) {
      const RECT normal_rect = placement.rcNormalPosition;
      if (normal_rect.right > normal_rect.left &&
          normal_rect.bottom > normal_rect.top) {
        *rect = normal_rect;
        return true;
      }
    }
  }

  using DwmGetWindowAttributeFn = HRESULT (WINAPI*)(HWND, DWORD, PVOID, DWORD);
  static const auto dwm_get_window_attribute = reinterpret_cast<DwmGetWindowAttributeFn>(
    []() -> FARPROC {
      HMODULE module = LoadLibraryW(L"dwmapi.dll");
      return module ? GetProcAddress(module, "DwmGetWindowAttribute") : nullptr;
    }()
  );

  constexpr DWORD kDwmwaExtendedFrameBounds = 9;
  if (dwm_get_window_attribute) {
    RECT extended_rect {};
    if (SUCCEEDED(dwm_get_window_attribute(
          hwnd,
          kDwmwaExtendedFrameBounds,
          &extended_rect,
          static_cast<DWORD>(sizeof(extended_rect)))) &&
        extended_rect.right > extended_rect.left &&
        extended_rect.bottom > extended_rect.top) {
      *rect = extended_rect;
      return true;
    }
  }

  RECT window_rect {};
  if (GetWindowRect(hwnd, &window_rect) &&
      window_rect.right > window_rect.left &&
      window_rect.bottom > window_rect.top) {
    *rect = window_rect;
    return true;
  }

  return false;
}

bool resolve_wgc_window_dimensions(const std::string& capture_handle, int* width, int* height, std::string* error) {
  if (!width || !height) {
    if (error) {
      *error = "wgc-window-dimension-output-missing";
    }
    return false;
  }

  char* parse_end = nullptr;
  const unsigned long long hwnd_value = std::strtoull(capture_handle.c_str(), &parse_end, 10);
  if (!parse_end || *parse_end != '\0' || hwnd_value == 0) {
    if (error) {
      *error = "wgc-window-handle-invalid";
    }
    return false;
  }

  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd_value));
  if (!IsWindow(hwnd)) {
    if (error) {
      *error = "wgc-window-handle-not-found";
    }
    return false;
  }

  RECT capture_rect {};
  if (!get_window_capture_rect(hwnd, &capture_rect)) {
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  *width = std::max(0, static_cast<int>(capture_rect.right - capture_rect.left));
  *height = std::max(0, static_cast<int>(capture_rect.bottom - capture_rect.top));
  if (*width <= 0 || *height <= 0) {
    if (error) {
      *error = "wgc-window-capture-rect-empty";
    }
    return false;
  }

  return true;
}
#endif

std::string infer_video_encoder_backend(const std::string& encoder) {
  const std::string lowered = to_lower_copy(trim_copy(encoder));
  if (lowered.empty()) {
    return "none";
  }
  if (lowered.find("_amf") != std::string::npos) {
    return "amf";
  }
  if (lowered.find("_nvenc") != std::string::npos) {
    return "nvenc";
  }
  if (lowered.find("_qsv") != std::string::npos) {
    return "qsv";
  }
  if (lowered.find("_mf") != std::string::npos) {
    return "mf";
  }
  if (lowered.find("_vaapi") != std::string::npos) {
    return "vaapi";
  }
  if (lowered.find("_vulkan") != std::string::npos) {
    return "vulkan";
  }
  if (lowered.find("_d3d12va") != std::string::npos) {
    return "d3d12va";
  }
  if (lowered.rfind("libx264", 0) == 0 || lowered.rfind("libx265", 0) == 0 || lowered.rfind("libopenh264", 0) == 0) {
    return "software";
  }
  return "unknown";
}

std::string normalize_host_encoder_preset(const std::string& preset) {
  const std::string lowered = to_lower_copy(trim_copy(preset));
  if (lowered == "quality" || lowered == "speed") {
    return lowered;
  }
  return "balanced";
}

std::string normalize_host_encoder_tune(const std::string& tune) {
  const std::string lowered = to_lower_copy(trim_copy(tune));
  if (lowered == "fastdecode" || lowered == "zerolatency") {
    return lowered;
  }
  return {};
}

std::vector<std::string> build_preferred_video_encoder_list(const std::string& requested_codec, bool prefer_hardware) {
  const bool wants_hevc = requested_codec == "h265" || requested_codec == "hevc";
  if (wants_hevc) {
    if (prefer_hardware) {
      return {
        "hevc_nvenc",
        "hevc_amf",
        "hevc_qsv",
        "hevc_d3d12va",
        "hevc_mf",
        "libx265"
      };
    }

    return {
      "libx265"
    };
  }

  if (prefer_hardware) {
    return {
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_d3d12va",
      "h264_mf",
      "libx264",
      "libopenh264"
    };
  }

  return {
    "libx264",
    "libopenh264"
  };
}

std::vector<std::string> build_candidate_video_encoder_list(
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder) {
  const std::string manual_encoder = normalize_video_encoder_preference(requested_video_encoder);
  if (prefer_hardware && !manual_encoder.empty() && video_encoder_matches_codec(manual_encoder, requested_codec)) {
    return { manual_encoder };
  }

  return build_preferred_video_encoder_list(requested_codec, prefer_hardware);
}

void append_video_encoder_runtime_flags(std::ostringstream& command, const HostPipelineState& pipeline) {
  const std::string preset = normalize_host_encoder_preset(pipeline.requested_preset);
  const std::string tune = normalize_host_encoder_tune(pipeline.requested_tune);
  const std::string encoder = to_lower_copy(trim_copy(pipeline.selected_video_encoder));

  if (encoder == "h264_amf" || encoder == "hevc_amf") {
    const std::string amf_quality =
      preset == "quality" ? "quality" : (preset == "speed" ? "speed" : "balanced");
    command
      << " -usage " << (tune == "zerolatency" ? "ultralowlatency" : "lowlatency")
      << " -quality " << amf_quality
      << " -rc cbr -bf 0";
    return;
  }

  if (encoder == "h264_nvenc" || encoder == "hevc_nvenc") {
    const std::string nvenc_preset =
      preset == "quality" ? "p7" : (preset == "speed" ? "p1" : "p4");
    command << " -preset " << nvenc_preset;
    if (tune == "zerolatency") {
      command << " -tune ull";
    }
    command << " -rc cbr -bf 0";
    return;
  }

  if (encoder == "libx264" || encoder == "libx265") {
    const std::string software_preset =
      preset == "quality" ? "slow" : (preset == "speed" ? "ultrafast" : "medium");
    command << " -preset " << software_preset;
    if (!tune.empty()) {
      command << " -tune " << tune;
    }
    if (encoder == "libx264") {
      command << " -bf 0";
    } else {
      command << " -x265-params bframes=0:rc-lookahead=0";
    }
    return;
  }

  if (encoder == "libopenh264") {
    command << " -rc_mode bitrate -bf 0";
  }
}

std::string build_ffmpeg_peer_video_sender_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan) {
  if (!ffmpeg.available || ffmpeg.path.empty() || !plan.ready || !plan.validated) {
    return {};
  }

  const std::string codec = normalize_video_codec(plan.codec_path, normalize_video_codec(pipeline.requested_video_codec));
  if ((codec == "h265" && !is_h265_video_encoder(pipeline.selected_video_encoder)) ||
      (codec != "h265" && !is_h264_video_encoder(pipeline.selected_video_encoder))) {
    return {};
  }

  std::ostringstream command;
  command << quote_command_path(ffmpeg.path) << " -hide_banner -loglevel error -nostats -nostdin";

  if (plan.capture_backend == "wgc") {
    if (plan.input_width <= 0 || plan.input_height <= 0) {
      return {};
    }
    command
      << " -f rawvideo -pix_fmt bgra"
      << " -video_size " << plan.input_width << "x" << plan.input_height
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i pipe:0";
  } else {
    command
      << " -f " << plan.input_format
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i " << quote_command_path(plan.input_target);
  }

  command << " -an -c:v " << pipeline.selected_video_encoder;

  if (plan.width > 0 && plan.height > 0) {
    command
      << " -vf scale=" << plan.width << ":" << plan.height
      << ":force_original_aspect_ratio=decrease"
      << ",pad=" << plan.width << ":" << plan.height << ":(ow-iw)/2:(oh-ih)/2:color=black"
      << ",setsar=1";
  }

  if (plan.bitrate_kbps > 0) {
    command << " -b:v " << plan.bitrate_kbps << "k";
  }

  const int normalized_frame_rate = plan.frame_rate > 0 ? plan.frame_rate : 60;
  const int gop_size = std::max(1, normalized_frame_rate);
  command << " -g " << gop_size;
  command << " -force_key_frames " << quote_command_path("expr:gte(t,n_forced*1)");

  append_video_encoder_runtime_flags(command, pipeline);

  if (codec == "h265") {
    // Several Windows HEVC hardware encoders already emit AUD in Annex B output,
    // and hevc_metadata can fail to initialize before the first VPS/SPS is available.
    command << " -f hevc pipe:1";
  } else {
    command << " -bsf:v h264_metadata=aud=insert -f h264 pipe:1";
  }
  return command.str();
}

HostPipelineState select_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune) {
  HostPipelineState pipeline;
  pipeline.prefer_hardware = prefer_hardware;
  pipeline.requested_video_codec = requested_codec.empty() ? "h264" : to_lower_copy(requested_codec);
  pipeline.requested_video_encoder = normalize_video_encoder_preference(requested_video_encoder);
  pipeline.requested_preset = normalize_host_encoder_preset(requested_preset);
  pipeline.requested_tune = normalize_host_encoder_tune(requested_tune);
  pipeline.selected_audio_encoder = select_preferred_audio_encoder(ffmpeg.audio_encoders);

  if (!ffmpeg.available) {
    pipeline.reason = "ffmpeg-unavailable";
    pipeline.video_encoder_backend = "none";
    return pipeline;
  }

  if (pipeline.requested_video_codec == "h265" || pipeline.requested_video_codec == "hevc") {
    pipeline.requested_video_codec = "h265";
  } else {
    pipeline.requested_video_codec = "h264";
  }

  const std::vector<std::string> preferred_video_encoders = build_candidate_video_encoder_list(
    pipeline.requested_video_codec,
    pipeline.prefer_hardware,
    pipeline.requested_video_encoder
  );

  for (const std::string& encoder : preferred_video_encoders) {
    if (encoder_exists_for_runtime(ffmpeg, encoder)) {
      pipeline.selected_video_encoder = encoder;
      pipeline.video_encoder_backend = infer_video_encoder_backend(encoder);
      break;
    }
  }

  if (pipeline.selected_video_encoder.empty()) {
    pipeline.reason = "video-encoder-unavailable";
    pipeline.video_encoder_backend = "none";
    pipeline.validation_reason = "video-encoder-unavailable";
    return pipeline;
  }

  if (pipeline.selected_audio_encoder.empty()) {
    pipeline.reason = "audio-encoder-unavailable";
    pipeline.validation_reason = "audio-encoder-unavailable";
    return pipeline;
  }

  pipeline.hardware = is_hardware_video_encoder(pipeline.selected_video_encoder);
  pipeline.reason = pipeline.requested_video_encoder.empty()
    ? (pipeline.hardware ? "hardware-pipeline-selected" : "software-pipeline-selected")
    : (pipeline.hardware ? "manual-hardware-pipeline-selected" : "manual-software-pipeline-selected");
  pipeline.validation_reason = "pipeline-selection-only";
  return pipeline;
}

HostPipelineState select_and_validate_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune) {
  HostPipelineState base_pipeline = select_host_pipeline(
    ffmpeg,
    requested_codec,
    prefer_hardware,
    requested_video_encoder,
    requested_preset,
    requested_tune
  );
  if (!ffmpeg.available || base_pipeline.selected_audio_encoder.empty()) {
    return base_pipeline;
  }

  const std::string normalized_codec = base_pipeline.requested_video_codec.empty()
    ? "h264"
    : base_pipeline.requested_video_codec;

  const std::vector<std::string> preferred_video_encoders = build_candidate_video_encoder_list(
    normalized_codec,
    base_pipeline.prefer_hardware,
    base_pipeline.requested_video_encoder
  );

  std::string last_validation_error;
  for (const std::string& encoder : preferred_video_encoders) {
    if (!encoder_exists_for_runtime(ffmpeg, encoder)) {
      continue;
    }

    CommandResult validation = run_ffmpeg_encoder_self_test(ffmpeg, encoder, base_pipeline.selected_audio_encoder);
    if (validation.launched && validation.exit_code == 0) {
      base_pipeline.selected_video_encoder = encoder;
      base_pipeline.video_encoder_backend = infer_video_encoder_backend(encoder);
      base_pipeline.hardware = is_hardware_video_encoder(encoder);
      base_pipeline.ready = true;
      base_pipeline.validated = true;
      base_pipeline.reason = base_pipeline.requested_video_encoder.empty()
        ? (base_pipeline.hardware ? "hardware-pipeline-validated" : "software-pipeline-validated")
        : (base_pipeline.hardware ? "manual-hardware-pipeline-validated" : "manual-software-pipeline-validated");
      base_pipeline.validation_reason = "encoder-self-test-passed";
      base_pipeline.last_error.clear();
      return base_pipeline;
    }

    last_validation_error = trim_copy(validation.output);
    if (last_validation_error.empty()) {
      last_validation_error = "encoder-self-test-failed";
    }
  }

  base_pipeline.ready = false;
  base_pipeline.validated = false;
  base_pipeline.validation_reason = "encoder-self-test-failed";
  base_pipeline.last_error = last_validation_error;
  if (
    base_pipeline.reason == "hardware-pipeline-selected" ||
    base_pipeline.reason == "software-pipeline-selected" ||
    base_pipeline.reason == "manual-hardware-pipeline-selected" ||
    base_pipeline.reason == "manual-software-pipeline-selected"
  ) {
    base_pipeline.reason = "pipeline-selected-but-not-validated";
  }
  return base_pipeline;
}

AudioSessionState build_audio_session_state(const AudioBackendProbe& probe) {
  AudioSessionState session;
  session.ready = probe.ready;
  session.running = false;
  session.capture_active = false;
  session.platform_supported = probe.platform_supported;
  session.device_enumerator_available = probe.device_enumerator_available;
  session.render_device_count = probe.render_device_count;
  session.backend_mode = probe.backend_mode;
  session.implementation = probe.implementation;
  session.reason = probe.reason;
  session.last_error = probe.last_error;
  return session;
}

AudioSessionState build_audio_session_state(const WasapiSessionStatus& status) {
  AudioSessionState session;
  session.ready = status.ready;
  session.running = status.running;
  session.capture_active = status.capture_active;
  session.platform_supported = status.platform_supported;
  session.device_enumerator_available = status.device_enumerator_available;
  session.render_device_count = status.render_device_count;
  session.pid = status.pid;
  session.process_name = status.process_name;
  session.backend_mode = status.backend_mode;
  session.implementation = status.implementation;
  session.last_error = status.last_error;
  session.reason = status.reason;
  session.sample_rate = status.sample_rate;
  session.channel_count = status.channel_count;
  session.bits_per_sample = status.bits_per_sample;
  session.block_align = status.block_align;
  session.buffer_frame_count = status.buffer_frame_count;
  session.last_buffer_frames = status.last_buffer_frames;
  session.packets_captured = status.packets_captured;
  session.frames_captured = status.frames_captured;
  session.silent_packets = status.silent_packets;
  session.activation_attempts = status.activation_attempts;
  session.activation_successes = status.activation_successes;
  return session;
}

AudioBackendProbe build_audio_backend_probe(const WasapiProbeResult& probe) {
  AudioBackendProbe result;
  result.ready = probe.platform_supported && probe.device_enumerator_available;
  result.backend_mode = probe.backend_mode;
  result.implementation = probe.implementation;
  result.reason = probe.reason;
  result.last_error = probe.last_error;
  result.platform_supported = probe.platform_supported;
  result.device_enumerator_available = probe.device_enumerator_available;
  result.render_device_count = probe.render_device_count;
  return result;
}

HostCapturePlan build_host_capture_plan(
  const FfmpegProbeResult& ffmpeg,
  const WgcCaptureProbe& wgc_capture,
  const HostPipelineState& pipeline,
  const HostCaptureProcessState& process_state,
  const std::string& capture_kind,
  const std::string& capture_state,
  const std::string& capture_title,
  const std::string& capture_hwnd,
  const std::string& capture_display_id,
  int width,
  int height,
  int frame_rate,
  int bitrate_kbps) {
  HostCapturePlan plan;
  plan.capture_kind = capture_kind.empty() ? "window" : to_lower_copy(capture_kind);
  plan.capture_state = capture_state.empty() ? "normal" : to_lower_copy(capture_state);
  plan.preferred_capture_backend = "wgc";
  plan.capture_backend = "wgc";
  plan.capture_fallback_reason.clear();
  plan.capture_handle = trim_copy(capture_hwnd);
  if (plan.capture_handle.empty()) {
    plan.capture_handle = resolve_window_handle_from_title(capture_title);
  }
  plan.capture_display_id = trim_copy(capture_display_id);
  if (plan.capture_display_id.empty()) {
    plan.capture_display_id = "0";
  }
  plan.width = normalize_host_output_dimension(width, 1920);
  plan.height = normalize_host_output_dimension(height, 1080);
  plan.frame_rate = frame_rate > 0 ? frame_rate : 60;
  plan.bitrate_kbps = bitrate_kbps > 0 ? bitrate_kbps : 10000;
  plan.codec_path = pipeline.requested_video_codec.empty()
    ? "h264"
    : to_lower_copy(pipeline.requested_video_codec);

  if (!ffmpeg.available) {
    plan.reason = "ffmpeg-unavailable";
    plan.last_error = ffmpeg.error;
    return plan;
  }

  if (!pipeline.ready || !pipeline.validated || pipeline.selected_video_encoder.empty()) {
    plan.reason = "host-pipeline-not-ready";
    plan.last_error = pipeline.last_error;
    return plan;
  }

  if (!wgc_capture.available) {
    plan.reason = "wgc-backend-unavailable";
    plan.last_error = wgc_capture.last_error.empty()
      ? (wgc_capture.reason.empty() ? "WGC capture backend is not available." : wgc_capture.reason)
      : wgc_capture.last_error;
    return plan;
  }

  const bool is_display_like =
    plan.capture_kind == "display" ||
    plan.capture_state == "display";
  const bool has_capture_hwnd = !plan.capture_handle.empty();
  const bool can_use_wgc_window = !is_display_like && has_capture_hwnd && wgc_capture.window_capture_supported;

  if (is_display_like) {
    if (wgc_capture.display_capture_supported) {
      plan.input_format = "rawvideo";
      plan.input_target = "wgc-display:" + plan.capture_display_id;
      plan.implementation = "windows-graphics-capture";
      plan.reason = "display-wgc-capture-planned";
      plan.ready = true;
      return plan;
    }

    plan.reason = "wgc-display-capture-not-supported";
    plan.last_error = "Selected display target requires WGC, but display capture is not supported on this system.";
    return plan;
  } else if (can_use_wgc_window) {
    plan.input_format = "rawvideo";
    plan.input_target = "wgc-window:" + plan.capture_handle;
    plan.implementation = "windows-graphics-capture";
    plan.reason = plan.capture_state == "minimized"
      ? "minimized-window-wgc-capture-planned"
      : "window-wgc-capture-planned";
  } else if (!has_capture_hwnd) {
    plan.reason = "wgc-window-handle-missing";
    plan.last_error = capture_title.empty()
      ? "Window capture now requires a real HWND for the WGC authority path."
      : "Window capture title could not be resolved to a real HWND for the WGC authority path.";
    return plan;
  } else {
    plan.reason = "wgc-window-capture-not-supported";
    plan.last_error = "Selected window target requires WGC, but window capture is not supported on this system.";
    return plan;
  }

  plan.ready = true;
  plan.command_preview = build_ffmpeg_host_capture_command(ffmpeg, pipeline, plan, process_state);
  return plan;
}

CommandResult run_ffmpeg_capture_self_test(const FfmpegProbeResult& ffmpeg, const HostCapturePlan& plan) {
  CommandResult result;
  if (!ffmpeg.available || ffmpeg.path.empty() || !plan.ready || plan.input_format.empty() || plan.input_target.empty()) {
    return result;
  }

  const std::string ffmpeg_command = quote_command_path(ffmpeg.path);
  const std::string command =
    ffmpeg_command +
    " -hide_banner -loglevel error" +
    " -f " + plan.input_format +
    " -framerate " + std::to_string(plan.frame_rate > 0 ? std::min(plan.frame_rate, 5) : 5) +
    " -i " + quote_command_path(plan.input_target) +
    " -frames:v 1 -f null - 2>&1";
  return run_command_capture(command);
}

WgcFrameSourceConfig build_wgc_frame_source_config(const HostCapturePlan& plan) {
  WgcFrameSourceConfig config;
  const std::string capture_kind = to_lower_copy(plan.capture_kind);
  if (capture_kind == "window" && !trim_copy(plan.capture_handle).empty()) {
    config.target_kind = "window";
    config.window_handle = trim_copy(plan.capture_handle);
  } else {
    config.target_kind = "display";
    config.display_id = plan.capture_display_id.empty() ? "0" : plan.capture_display_id;
  }
  return config;
}

HostCapturePlan validate_host_capture_plan(const FfmpegProbeResult& ffmpeg, HostCapturePlan plan) {
  (void)ffmpeg;
  if (!plan.ready) {
    plan.validation_reason = plan.reason;
    return plan;
  }

  if (plan.capture_backend == "wgc") {
    emit_breadcrumb(
      "validateHostCapturePlan:wgc:before-resolve-dimensions target=" + plan.input_target +
      " codec=" + plan.codec_path +
      " size=" + std::to_string(plan.width) + "x" + std::to_string(plan.height) +
      " fps=" + std::to_string(plan.frame_rate));
#ifdef _WIN32
    const bool is_display_like =
      plan.capture_kind == "display" ||
      plan.capture_state == "display" ||
      plan.input_target.rfind("wgc-display:", 0) == 0;
    int resolved_width = 0;
    int resolved_height = 0;
    std::string resolve_error;
    const bool resolved = is_display_like
      ? resolve_wgc_display_dimensions(
          plan.capture_display_id.empty() ? "0" : plan.capture_display_id,
          &resolved_width,
          &resolved_height,
          &resolve_error)
      : resolve_wgc_window_dimensions(plan.capture_handle, &resolved_width, &resolved_height, &resolve_error);
    if (!resolved) {
      plan.validated = false;
      plan.validation_reason = "wgc-capture-dimensions-unavailable";
      plan.last_error = resolve_error.empty()
        ? "WGC capture validation could not resolve input dimensions."
        : resolve_error;
      emit_breadcrumb(
        "validateHostCapturePlan:wgc:resolve-dimensions-failed reason=" +
        plan.validation_reason + " error=" + plan.last_error);
      return plan;
    }

    plan.input_width = resolved_width;
    plan.input_height = resolved_height;
    plan.validated = true;
    plan.validation_reason = "wgc-capture-dimensions-resolved";
    plan.command_preview =
      (is_display_like
        ? "wgc-display:" + (plan.capture_display_id.empty() ? "0" : plan.capture_display_id)
        : "wgc-window:" + plan.capture_handle) +
      " -> ffmpeg-stdin";
    plan.last_error.clear();
    emit_breadcrumb(
      "validateHostCapturePlan:wgc:after-resolve-dimensions size=" +
      std::to_string(plan.input_width) + "x" + std::to_string(plan.input_height));
    return plan;
#else
    plan.validated = false;
    plan.validation_reason = "wgc-capture-validation-unsupported";
    plan.last_error = "WGC capture validation requires Windows.";
    return plan;
#endif
  }

  plan.validated = false;
  plan.validation_reason = "capture-self-test-not-supported";
  plan.last_error = "Only WGC-backed host capture plans are valid in the current rewrite path.";
  return plan;
}

HostCaptureProcessState start_host_capture_process(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  HostCaptureProcessState state) {
  const auto finish = [&](HostCaptureProcessState final_state) {
    const HostCaptureArtifactProbe artifact_probe = probe_host_capture_artifact(ffmpeg, final_state);
    persist_host_capture_process_manifest(pipeline, plan, final_state, artifact_probe);
    return final_state;
  };
  state.command_line = build_ffmpeg_host_capture_command(ffmpeg, pipeline, plan, state);

  if (!state.enabled) {
    return finish(state);
  }

  if (plan.capture_backend == "wgc") {
    state.launch_attempted = true;
    state.running = false;
    state.reason = "host-capture-process-skipped-for-wgc";
    state.last_error.clear();
    state.command_line.clear();
    return finish(state);
  }

  state.launch_attempted = true;

  if (!plan.ready || !plan.validated || state.command_line.empty()) {
    state.reason = "host-capture-process-plan-not-ready";
    state.last_error = !plan.last_error.empty()
      ? plan.last_error
      : "Host capture plan is not validated yet, so the FFmpeg host capture process was not started.";
    return finish(state);
  }

#ifdef _WIN32
  SECURITY_ATTRIBUTES security_attributes{};
  security_attributes.nLength = sizeof(security_attributes);
  security_attributes.bInheritHandle = TRUE;

  HANDLE nul_handle = CreateFileW(
    L"NUL",
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security_attributes,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr
  );

  if (nul_handle == INVALID_HANDLE_VALUE) {
    state.reason = "host-capture-process-stdio-open-failed";
    state.last_error = format_windows_error(GetLastError());
    return finish(state);
  }

  STARTUPINFOW startup_info{};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = nul_handle;
  startup_info.hStdOutput = nul_handle;
  startup_info.hStdError = nul_handle;

  PROCESS_INFORMATION process_info{};
  std::wstring command_line = utf8_to_wide(state.command_line);
  if (command_line.empty()) {
    CloseHandle(nul_handle);
    state.reason = "host-capture-process-command-conversion-failed";
    state.last_error = "Failed to convert FFmpeg host capture command line to UTF-16.";
    return finish(state);
  }

  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  const BOOL created = CreateProcessW(
    nullptr,
    mutable_command.data(),
    nullptr,
    nullptr,
    TRUE,
    CREATE_NO_WINDOW,
    nullptr,
    nullptr,
    &startup_info,
    &process_info
  );

  CloseHandle(nul_handle);

  if (!created) {
    state.reason = "host-capture-process-launch-failed";
    state.last_error = format_windows_error(GetLastError());
    return finish(state);
  }

  state.running = true;
  state.process_id = static_cast<unsigned long>(process_info.dwProcessId);
  state.process_handle = process_info.hProcess;
  state.thread_handle = process_info.hThread;
  state.started_at_unix_ms = current_time_millis();
  state.updated_at_unix_ms = state.started_at_unix_ms;
  state.stopped_at_unix_ms = 0;
  state.reason = "host-capture-process-running";
  return finish(state);
#else
  state.reason = "host-capture-process-unsupported-platform";
  state.last_error = "Native FFmpeg host capture process lifecycle is only implemented on Windows.";
  return finish(state);
#endif
}

void refresh_host_capture_runtime(AgentRuntimeState& state) {
#ifdef _WIN32
  if (state.host_session_running &&
      state.host_window_restore_placeholder_active &&
      state.host_capture_plan.capture_backend == "wgc" &&
      to_lower_copy(state.host_capture_plan.capture_kind) == "window" &&
      !state.host_capture_plan.capture_handle.empty()) {
    const WindowCaptureAvailability availability =
      query_window_capture_availability(state.host_capture_plan.capture_handle);
    if (availability == WindowCaptureAvailability::minimized) {
      state.host_capture_state = "minimized";
      state.host_capture_plan.capture_state = "minimized";
      state.host_capture_plan.reason = "minimized-window-wgc-capture-planned";
      state.host_capture_plan.last_error.clear();
    } else if (availability == WindowCaptureAvailability::normal) {
      state.host_capture_state = "normal";
      state.host_capture_plan.capture_state = "normal";
      state.host_window_restore_placeholder_active = false;
      if (state.host_capture_plan.reason == "minimized-window-wgc-capture-planned" ||
          state.host_capture_plan.reason == "window-capture-target-unavailable") {
        state.host_capture_plan.reason = "window-wgc-capture-planned";
      }
      state.host_capture_plan.last_error.clear();
      state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
    } else {
      state.host_capture_plan.reason = "window-capture-target-unavailable";
      state.host_capture_plan.last_error = "Selected window is no longer available.";
    }
  }
#endif
  refresh_host_capture_process_state(state.host_capture_process);
  state.host_capture_artifact = probe_host_capture_artifact(
    state.ffmpeg,
    state.host_capture_process,
    state.host_capture_artifact
  );
  persist_host_capture_process_manifest(
    state.host_pipeline,
    state.host_capture_plan,
    state.host_capture_process,
    state.host_capture_artifact
  );
  for (auto& entry : state.attached_surfaces) {
    refresh_surface_attachment_state(entry.second);
    SurfaceAttachmentState& surface = entry.second;
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      continue;
    }

    const bool should_wait_for_artifact =
      state.host_session_running &&
      !surface.running &&
      surface.waiting_for_artifact &&
      state.host_capture_artifact.ready;
    const bool should_restart_exited_surface =
      state.host_session_running &&
      !surface.running &&
      !surface.waiting_for_artifact &&
      state.host_capture_artifact.ready &&
      (surface.reason == "surface-process-exited" ||
        surface.reason == "artifact-preview-stopped");

    if (!should_wait_for_artifact && !should_restart_exited_surface) {
      continue;
    }

    if (surface.running) {
      stop_surface_attachment(surface, "surface-auto-restart");
    }
    surface.restart_count += 1;
    surface = start_surface_attachment(
      state.ffmpeg,
      state.host_capture_plan,
      state.host_capture_process,
      state.host_capture_artifact,
      surface
    );
  }
}

void perform_host_video_sender_soft_refresh(AgentRuntimeState& state) {
  if (!state.host_session_running) {
    return;
  }

  bool attempted = false;
  bool all_succeeded = true;
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream" || !peer.transport_session) {
      continue;
    }
    if (!peer.media_binding.runtime || !peer.media_binding.runtime->soft_refresh_requested.load()) {
      continue;
    }

    attempted = true;
    state.host_capture_plan = validate_host_capture_plan(state.ffmpeg, state.host_capture_plan);
    if (!state.host_capture_plan.ready || !state.host_capture_plan.validated) {
      all_succeeded = false;
      peer.media_binding.reason = "peer-media-soft-refresh-waiting-for-valid-plan";
      peer.media_binding.last_error = state.host_capture_plan.last_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
      continue;
    }
    std::string refresh_error;
    if (!attach_host_video_media_binding(state, peer, &refresh_error, true)) {
      peer.media_binding.attached = false;
      peer.media_binding.sender_configured = false;
      peer.media_binding.active = false;
      peer.media_binding.reason = "peer-media-soft-refresh-failed";
      peer.media_binding.last_error = refresh_error;
      peer.media_binding.updated_at_unix_ms = current_time_millis();
      all_succeeded = false;
      emit_breadcrumb(
        std::string("hostVideoSenderRefresh:failed peer=") + peer.peer_id +
        " error=" + refresh_error);
    } else {
      emit_breadcrumb(std::string("hostVideoSenderRefresh:done peer=") + peer.peer_id);
    }
  }

  if (!attempted || all_succeeded) {
    state.host_video_sender_refresh_requested = false;
    state.host_video_sender_refresh_reason.clear();
  }
}

void stop_all_surface_attachments(AgentRuntimeState& state, const std::string& reason) {
  for (auto& entry : state.attached_surfaces) {
    if (entry.second.peer_runtime) {
      stop_peer_video_surface_attachment(*entry.second.peer_runtime, reason);
    } else {
      stop_surface_attachment(entry.second, reason);
    }
  }
}

void restart_host_capture_surface_attachments(AgentRuntimeState& state) {
  for (auto& entry : state.attached_surfaces) {
    SurfaceAttachmentState& surface = entry.second;
    if (!surface.attached || !is_host_capture_surface_target(surface.target)) {
      continue;
    }
    stop_surface_attachment(surface, "host-capture-surface-restart");
    surface.restart_count += 1;
    surface = start_surface_attachment(
      state.ffmpeg,
      state.host_capture_plan,
      state.host_capture_process,
      state.host_capture_artifact,
      surface
    );
  }
}

void refresh_peer_transport_runtime(AgentRuntimeState& state) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.receiver_runtime) {
      refresh_peer_video_receiver_runtime(*peer.receiver_runtime);
      {
        std::lock_guard<std::mutex> lock(peer.receiver_runtime->mutex);
        if (!peer.receiver_runtime->running) {
          peer.receiver_runtime->decoder_ready = false;
        }
      }
      update_peer_decoder_state_from_runtime(peer.receiver_runtime, peer.transport_session);
    }
    if (peer.transport_session) {
      peer.transport = get_peer_transport_snapshot(peer.transport_session);
      peer.has_remote_description = peer.transport.remote_description_set;
      peer.remote_candidate_count = peer.transport.remote_candidate_count;
    } else {
      peer.transport.available = state.peer_transport_backend.available;
      peer.transport.transport_ready = state.peer_transport_backend.transport_ready;
      peer.transport.media_plane_ready = state.peer_transport_backend.media_plane_ready;
      if (peer.transport.reason.empty()) {
        peer.transport.reason = state.peer_transport_backend.reason;
      }
    }
    peer.media_binding.sender_configured = peer.transport.video_track_configured;
    peer.media_binding.active = peer.transport.video_track_open;
    if (peer.transport.video_track_configured && peer.media_binding.reason == "peer-media-not-attached") {
      peer.media_binding.reason = "peer-media-configured";
    }
    refresh_peer_media_binding(peer);
    peer.media_binding.updated_at_unix_ms = current_time_millis();
  }
}

bool attach_host_video_media_binding(AgentRuntimeState& state, PeerState& peer, std::string* error, bool force_restart) {
  emit_breadcrumb(
    std::string("attachHostVideoMediaBinding:start peer=") + peer.peer_id +
    " codec=" + normalize_video_codec(state.host_codec) +
    " forceRestart=" + (force_restart ? "true" : "false") +
    " sessionRunning=" + (state.host_session_running ? "true" : "false"));
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!state.host_session_running || !state.host_capture_plan.ready) {
    if (error) {
      *error = "host-session-not-ready-for-video-binding";
    }
    return false;
  }

  PeerVideoTrackConfig config;
  config.enabled = true;
  config.codec = normalize_video_codec(state.host_codec);
  config.mid = "video";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-video";
  config.source = state.host_capture_plan.capture_backend == "wgc"
    ? "host-session-video"
    : (state.host_capture_artifact.ready ? "host-capture-artifact" : "host-capture-plan");
  config.width = state.host_width;
  config.height = state.host_height;
  config.frame_rate = state.host_frame_rate;
  config.bitrate_kbps = state.host_bitrate_kbps;

  const bool config_matches_current =
    peer.media_binding.attached &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == config.source &&
    peer.media_binding.codec == config.codec &&
    peer.media_binding.width == config.width &&
    peer.media_binding.height == config.height &&
    peer.media_binding.frame_rate == config.frame_rate &&
    peer.media_binding.bitrate_kbps == config.bitrate_kbps;

  const bool already_attached =
    !force_restart &&
    peer.media_binding.attached &&
    peer.media_binding.runtime &&
    peer.transport.video_track_configured &&
    config_matches_current;

  if (already_attached) {
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.sender_configured = peer.transport.video_track_configured;
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = state.host_pipeline.video_encoder_backend;
    peer.media_binding.implementation = "wgc-ffmpeg-libdatachannel-video-track";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "peer-media-attached"
      : "peer-video-sender-waiting-for-video-track-open";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    if (error) {
      error->clear();
    }
    return true;
  }

  const bool restart_sender_only =
    force_restart &&
    config_matches_current &&
    peer.transport.video_track_configured;

  if (peer.media_binding.runtime) {
    std::string stop_error;
    if (!stop_peer_video_sender(peer, "peer-media-reconfigure", &stop_error)) {
      if (error) {
        *error = stop_error;
      }
      return false;
    }
  }

  std::string attach_error;
  if (!restart_sender_only) {
    if (!configure_peer_transport_video_sender(peer.transport_session, config, &attach_error)) {
      if (error) {
        *error = attach_error;
      }
      return false;
    }
    emit_breadcrumb(std::string("attachHostVideoMediaBinding:after-configure-transport peer=") + peer.peer_id);
  } else {
    emit_breadcrumb(std::string("attachHostVideoMediaBinding:restarting-sender-only peer=") + peer.peer_id);
  }

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.sender_configured = peer.transport.video_track_configured;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = config.width;
  peer.media_binding.height = config.height;
  peer.media_binding.frame_rate = config.frame_rate;
  peer.media_binding.bitrate_kbps = config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = config.source;
  peer.media_binding.codec = config.codec;
  peer.media_binding.video_encoder_backend = state.host_pipeline.video_encoder_backend;
  peer.media_binding.implementation = "wgc-ffmpeg-libdatachannel-video-track";
  peer.media_binding.reason = "peer-media-configured";
  peer.media_binding.last_error.clear();
  peer.media_binding.attached_at_unix_ms = current_time_millis();
  peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
  peer.media_binding.detached_at_unix_ms = 0;

  if (!start_peer_video_sender(state.ffmpeg, state.host_pipeline, state.host_capture_plan, peer, &attach_error)) {
    peer.media_binding.reason = "peer-video-sender-start-failed";
    peer.media_binding.last_error = attach_error;
    clear_peer_transport_video_sender(peer.transport_session, nullptr);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.attached = false;
    peer.media_binding.sender_configured = false;
    peer.media_binding.active = false;
    if (error) {
      *error = attach_error;
    }
    return false;
  }
  emit_breadcrumb(std::string("attachHostVideoMediaBinding:after-start-sender peer=") + peer.peer_id);

  if ((!force_restart || !peer.transport.audio_track_configured) &&
      state.audio_session.capture_active &&
      state.audio_session.ready) {
    configure_host_audio_sender(state, peer, nullptr);
  }

  peer.media_binding.reason = "peer-media-attached";
  emit_breadcrumb(std::string("attachHostVideoMediaBinding:done peer=") + peer.peer_id);
  return true;
}

bool configure_host_audio_sender(AgentRuntimeState& state, PeerState& peer, std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  if (!state.audio_session.capture_active || !state.audio_session.ready) {
    if (error) {
      *error = "audio-session-not-ready";
    }
    return false;
  }

  PeerAudioTrackConfig config;
  config.enabled = true;
  config.codec = "opus";
  config.mid = "audio";
  config.stream_id = "vds-host-stream";
  config.track_id = peer.peer_id + "-audio";
  config.source = "host-process-loopback";
  config.sample_rate = kTransportAudioSampleRate;
  config.channel_count = kTransportAudioChannelCount;
  config.payload_type = 111;
  config.bitrate_kbps = kTransportAudioBitrateKbps;

  if (!configure_peer_transport_audio_sender(peer.transport_session, config, error)) {
    return false;
  }

  register_host_audio_transport_session(peer.transport_session);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  return true;
}

bool attach_relay_video_media_binding(
  AgentRuntimeState& state,
  PeerState& peer,
  const std::string& source,
  std::string* error) {
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  const std::string upstream_peer_id = extract_peer_id_from_media_source(source);
  if (upstream_peer_id.empty()) {
    if (error) {
      *error = "relay-source-invalid";
    }
    return false;
  }
  if (upstream_peer_id == peer.peer_id) {
    if (error) {
      *error = "relay-source-self-reference";
    }
    return false;
  }

  auto upstream_it = state.peers.find(upstream_peer_id);
  if (upstream_it == state.peers.end()) {
    if (error) {
      *error = "relay-upstream-peer-not-found";
    }
    return false;
  }

  PeerState& upstream_peer = upstream_it->second;
  if (!upstream_peer.transport_session || !upstream_peer.transport.video_receiver_configured) {
    if (error) {
      *error = "relay-upstream-not-ready";
    }
    return false;
  }

  const std::string upstream_video_codec = to_lower_copy(
    upstream_peer.transport.codec_path.empty() ? upstream_peer.transport.video_codec : upstream_peer.transport.codec_path
  );
  if (upstream_video_codec != "h264" && upstream_video_codec != "h265" && upstream_video_codec != "hevc") {
    if (error) {
      *error = "relay-upstream-video-codec-unsupported";
    }
    return false;
  }

  PeerVideoTrackConfig video_config;
  video_config.enabled = true;
  video_config.codec = normalize_video_codec(upstream_video_codec);
  video_config.mid = "video";
  video_config.stream_id = "vds-relay-stream";
  video_config.track_id = peer.peer_id + "-video";
  video_config.source = source;
  video_config.width = upstream_peer.media_binding.width > 0 ? upstream_peer.media_binding.width : 1920;
  video_config.height = upstream_peer.media_binding.height > 0 ? upstream_peer.media_binding.height : 1080;
  video_config.frame_rate = upstream_peer.media_binding.frame_rate > 0 ? upstream_peer.media_binding.frame_rate : 60;
  video_config.bitrate_kbps =
    upstream_peer.media_binding.bitrate_kbps > 0 ? upstream_peer.media_binding.bitrate_kbps : 10000;

  const std::string upstream_audio_codec = to_lower_copy(upstream_peer.transport.audio_codec);
  const bool audio_enabled =
    upstream_peer.transport.audio_receiver_configured &&
    (upstream_audio_codec == "opus" || upstream_audio_codec == "pcmu");

  const bool already_attached =
    peer.media_binding.attached &&
    peer.transport.video_track_configured &&
    peer.media_binding.kind == "video" &&
    peer.media_binding.source == source &&
    peer.media_binding.codec == video_config.codec &&
    peer.media_binding.width == video_config.width &&
    peer.media_binding.height == video_config.height &&
    peer.media_binding.frame_rate == video_config.frame_rate &&
    peer.media_binding.bitrate_kbps == video_config.bitrate_kbps &&
    peer.transport.audio_track_configured == audio_enabled;

  if (already_attached) {
    register_relay_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
    peer.media_binding.sender_configured = peer.transport.video_track_configured;
    peer.media_binding.active = peer.transport.video_track_open;
    peer.media_binding.video_encoder_backend = "relay-copy";
    peer.media_binding.implementation = "peer-transport-relay-track";
    peer.media_binding.reason = peer.transport.video_track_open
      ? "relay-media-attached"
      : "relay-video-sender-waiting-for-video-track-open";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    if (error) {
      error->clear();
    }
    return true;
  }

  if (!configure_peer_transport_video_sender(peer.transport_session, video_config, error)) {
    return false;
  }

  if (audio_enabled) {
    PeerAudioTrackConfig audio_config;
    audio_config.enabled = true;
    audio_config.codec = upstream_audio_codec;
    audio_config.mid = "audio";
    audio_config.stream_id = "vds-relay-stream";
    audio_config.track_id = peer.peer_id + "-audio";
    audio_config.source = source;
    audio_config.sample_rate = upstream_audio_codec == "opus" ? static_cast<int>(kTransportAudioSampleRate) : 8000;
    audio_config.channel_count = upstream_audio_codec == "opus" ? static_cast<int>(kTransportAudioChannelCount) : 1;
    audio_config.payload_type = upstream_audio_codec == "opus" ? 111 : 0;
    audio_config.bitrate_kbps = upstream_audio_codec == "opus" ? static_cast<int>(kTransportAudioBitrateKbps) : 64;
    if (!configure_peer_transport_audio_sender(peer.transport_session, audio_config, error)) {
      clear_peer_transport_video_sender(peer.transport_session, nullptr);
      return false;
    }
  } else {
    clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  }

  unregister_relay_subscriber(peer.peer_id);
  register_relay_subscriber(upstream_peer_id, peer.peer_id, peer.transport_session, audio_enabled);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = true;
  peer.media_binding.sender_configured = peer.transport.video_track_configured;
  peer.media_binding.active = peer.transport.video_track_open;
  peer.media_binding.width = video_config.width;
  peer.media_binding.height = video_config.height;
  peer.media_binding.frame_rate = video_config.frame_rate;
  peer.media_binding.bitrate_kbps = video_config.bitrate_kbps;
  peer.media_binding.kind = "video";
  peer.media_binding.source = source;
  peer.media_binding.codec = video_config.codec;
  peer.media_binding.video_encoder_backend = "relay-copy";
  peer.media_binding.implementation = "peer-transport-relay-track";
  peer.media_binding.reason = "relay-media-attached";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.frames_sent = 0;
  peer.media_binding.bytes_sent = 0;
  peer.media_binding.attached_at_unix_ms = current_time_millis();
  peer.media_binding.updated_at_unix_ms = peer.media_binding.attached_at_unix_ms;
  peer.media_binding.detached_at_unix_ms = 0;
  return true;
}

void clear_host_audio_sender(PeerState& peer) {
  if (!peer.transport_session) {
    return;
  }

  unregister_host_audio_transport_session(peer.transport_session);
  clear_peer_transport_audio_sender(peer.transport_session, nullptr);
  peer.transport = get_peer_transport_snapshot(peer.transport_session);
}

void refresh_host_audio_senders(AgentRuntimeState& state) {
  for (auto& entry : state.peers) {
    PeerState& peer = entry.second;
    if (peer.role != "host-downstream" || !peer.transport_session) {
      continue;
    }

    const bool had_audio_track = peer.transport.audio_track_configured;
    if (state.audio_session.capture_active && state.audio_session.ready) {
      configure_host_audio_sender(state, peer, nullptr);
    } else {
      clear_host_audio_sender(peer);
    }

    const bool has_audio_track = peer.transport.audio_track_configured;
    if (peer.initiator && had_audio_track != has_audio_track) {
      std::string negotiate_error;
      if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
        peer.transport = get_peer_transport_snapshot(peer.transport_session);
        peer.transport.last_error = negotiate_error;
        peer.transport.reason = "peer-audio-renegotiation-failed";
      }
    }
  }
}

bool detach_peer_media_binding(PeerState& peer, std::string* error) {
  unregister_relay_subscriber(peer.peer_id);
  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-media-detached", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  if (!peer.transport_session) {
    peer.media_binding.attached = false;
    peer.media_binding.sender_configured = false;
    peer.media_binding.active = false;
    peer.media_binding.reason = "peer-media-detached";
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
    return true;
  }

  std::string detach_error;
  if (!clear_peer_transport_video_sender(peer.transport_session, &detach_error)) {
    if (error) {
      *error = detach_error;
    }
    return false;
  }
  clear_host_audio_sender(peer);

  peer.transport = get_peer_transport_snapshot(peer.transport_session);
  peer.media_binding.attached = false;
  peer.media_binding.sender_configured = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-media-detached";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  return true;
}

bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error) {
  emit_breadcrumb(
    std::string("preparePeerMediaBinding:start peer=") +
    peer.peer_id +
    " role=" + peer.role +
    " attached=" + (peer.media_binding.attached ? "true" : "false")
  );
  unregister_relay_subscriber(peer.peer_id);
  unregister_host_audio_transport_session(peer.transport_session);

  std::string stop_error;
  if (!stop_peer_video_sender(peer, "peer-closing", &stop_error)) {
    if (error) {
      *error = stop_error;
    }
    return false;
  }

  peer.media_binding.attached = false;
  peer.media_binding.sender_configured = false;
  peer.media_binding.active = false;
  peer.media_binding.reason = "peer-closing";
  peer.media_binding.last_error.clear();
  peer.media_binding.command_line.clear();
  peer.media_binding.process_id = 0;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  emit_breadcrumb(std::string("preparePeerMediaBinding:done peer=") + peer.peer_id);
  if (error) {
    error->clear();
  }
  return true;
}

#ifdef _WIN32
void close_peer_video_sender_handles(PeerState::PeerVideoSenderRuntime& runtime) {
  if (runtime.thread_handle) {
    CloseHandle(runtime.thread_handle);
    runtime.thread_handle = nullptr;
  }
  if (runtime.process_handle) {
    CloseHandle(runtime.process_handle);
    runtime.process_handle = nullptr;
  }
  if (runtime.stdin_write_handle) {
    CloseHandle(runtime.stdin_write_handle);
    runtime.stdin_write_handle = nullptr;
  }
  if (runtime.stdout_read_handle) {
    CloseHandle(runtime.stdout_read_handle);
    runtime.stdout_read_handle = nullptr;
  }
}

size_t find_next_annexb_start_code(const std::vector<std::uint8_t>& data, size_t start_offset) {
  if (data.size() < 4 || start_offset >= data.size()) {
    return std::string::npos;
  }

  for (size_t index = start_offset; index + 3 < data.size(); ++index) {
    if (data[index] != 0 || data[index + 1] != 0) {
      continue;
    }

    if (index + 3 < data.size() && data[index + 2] == 0 && data[index + 3] == 1) {
      return index;
    }

    if (data[index + 2] == 1 && (index == 0 || data[index - 1] != 0)) {
      return index;
    }
  }

  return std::string::npos;
}

size_t annexb_start_code_size(const std::vector<std::uint8_t>& data, size_t offset) {
  if (offset + 3 >= data.size()) {
    return 0;
  }
  if (data[offset] == 0 && data[offset + 1] == 0) {
    if (data[offset + 2] == 1) {
      return 3;
    }
    if (offset + 3 < data.size() && data[offset + 2] == 0 && data[offset + 3] == 1) {
      return 4;
    }
  }
  return 0;
}

size_t find_next_h264_aud_offset(const std::vector<std::uint8_t>& data, size_t start_offset) {
  size_t offset = start_offset;
  while (true) {
    offset = find_next_annexb_start_code(data, offset);
    if (offset == std::string::npos) {
      return offset;
    }

    const size_t start_code_size = annexb_start_code_size(data, offset);
    if (start_code_size == 0 || offset + start_code_size >= data.size()) {
      return std::string::npos;
    }

    const std::uint8_t nal_type = data[offset + start_code_size] & 0x1F;
    if (nal_type == 9) {
      return offset;
    }

    offset += start_code_size;
  }
}

size_t find_next_h265_aud_offset(const std::vector<std::uint8_t>& data, size_t start_offset) {
  size_t offset = start_offset;
  while (true) {
    offset = find_next_annexb_start_code(data, offset);
    if (offset == std::string::npos) {
      return offset;
    }

    const size_t start_code_size = annexb_start_code_size(data, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= data.size()) {
      return std::string::npos;
    }

    const std::uint8_t nal_type = (data[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type == 35) {
      return offset;
    }

    offset += start_code_size;
  }
}

bool h265_vcl_nal_is_first_slice_segment(
  const std::vector<std::uint8_t>& data,
  size_t offset,
  size_t start_code_size) {
  const size_t payload_offset = offset + start_code_size + 2;
  if (payload_offset >= data.size()) {
    return false;
  }

  return (data[payload_offset] & 0x80) != 0;
}

std::string normalize_video_codec(const std::string& codec, const std::string& fallback) {
  const std::string normalized = to_lower_copy(trim_copy(codec));
  if (normalized == "h265" || normalized == "hevc") {
    return "h265";
  }
  if (normalized == "h264") {
    return "h264";
  }
  return fallback;
}

bool h264_access_unit_has_vcl_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type >= 1 && nal_type <= 5) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h264_access_unit_has_decoder_config_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type == 7 || nal_type == 8) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h264_access_unit_has_idr_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = access_unit[offset + start_code_size] & 0x1F;
    if (nal_type == 5) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_vcl_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type <= 31) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_decoder_config_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type == 32 || nal_type == 33 || nal_type == 34) {
      return true;
    }

    offset += start_code_size;
  }
}

bool h265_access_unit_has_random_access_nal(const std::vector<std::uint8_t>& access_unit) {
  size_t offset = 0;
  while (true) {
    offset = find_next_annexb_start_code(access_unit, offset);
    if (offset == std::string::npos) {
      return false;
    }

    const size_t start_code_size = annexb_start_code_size(access_unit, offset);
    if (start_code_size == 0 || offset + start_code_size + 1 >= access_unit.size()) {
      return false;
    }

    const std::uint8_t nal_type = (access_unit[offset + start_code_size] >> 1) & 0x3F;
    if (nal_type >= 16 && nal_type <= 21) {
      return true;
    }

    offset += start_code_size;
  }
}

bool should_emit_h264_access_unit(const std::vector<std::uint8_t>& access_unit) {
  return h264_access_unit_has_vcl_nal(access_unit) ||
    h264_access_unit_has_decoder_config_nal(access_unit);
}

bool should_emit_h265_access_unit(const std::vector<std::uint8_t>& access_unit) {
  return h265_access_unit_has_vcl_nal(access_unit) ||
    h265_access_unit_has_decoder_config_nal(access_unit);
}

bool should_emit_video_access_unit(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? should_emit_h265_access_unit(access_unit)
    : should_emit_h264_access_unit(access_unit);
}

bool video_access_unit_has_decoder_config_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? h265_access_unit_has_decoder_config_nal(access_unit)
    : h264_access_unit_has_decoder_config_nal(access_unit);
}

bool video_access_unit_has_random_access_nal(
  const std::string& codec,
  const std::vector<std::uint8_t>& access_unit) {
  return normalize_video_codec(codec) == "h265"
    ? h265_access_unit_has_random_access_nal(access_unit)
    : h264_access_unit_has_idr_nal(access_unit);
}

bool video_bootstrap_is_complete(
  const std::string& codec,
  const std::vector<std::uint8_t>& decoder_config_au,
  const std::vector<std::uint8_t>& random_access_au) {
  if (decoder_config_au.empty() || random_access_au.empty()) {
    return false;
  }

  const std::string normalized_codec = normalize_video_codec(codec);
  return video_access_unit_has_decoder_config_nal(normalized_codec, decoder_config_au) &&
    video_access_unit_has_random_access_nal(normalized_codec, random_access_au);
}

std::vector<std::vector<std::uint8_t>> extract_annexb_h264_access_units(
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  std::vector<std::vector<std::uint8_t>> access_units;

  while (true) {
    size_t first_aud = find_next_h264_aud_offset(buffer, 0);
    if (first_aud == std::string::npos) {
      if (!flush && buffer.size() > (1024 * 1024)) {
        buffer.clear();
      }
      break;
    }

    if (first_aud > 0) {
      buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(first_aud));
      first_aud = 0;
    }

    const size_t second_aud = find_next_h264_aud_offset(buffer, 4);
    if (second_aud == std::string::npos) {
      if (flush && !buffer.empty()) {
        if (should_emit_h264_access_unit(buffer)) {
          access_units.push_back(buffer);
        }
        buffer.clear();
      }
      break;
    }

    std::vector<std::uint8_t> access_unit(
      buffer.begin(),
      buffer.begin() + static_cast<std::ptrdiff_t>(second_aud)
    );
    if (should_emit_h264_access_unit(access_unit)) {
      access_units.push_back(std::move(access_unit));
    }
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(second_aud));
  }

  return access_units;
}

std::vector<std::vector<std::uint8_t>> extract_annexb_h265_access_units(
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  std::vector<std::vector<std::uint8_t>> access_units;
  std::vector<size_t> nal_offsets;
  size_t search_offset = 0;
  while (true) {
    const size_t nal_offset = find_next_annexb_start_code(buffer, search_offset);
    if (nal_offset == std::string::npos) {
      break;
    }
    nal_offsets.push_back(nal_offset);
    search_offset = nal_offset + 3;
  }

  if (nal_offsets.empty()) {
    if (!flush && buffer.size() > (1024 * 1024)) {
      buffer.clear();
    }
    return access_units;
  }

  const size_t parsable_nal_count = flush
    ? nal_offsets.size()
    : (nal_offsets.size() > 1 ? nal_offsets.size() - 1 : 0);
  if (parsable_nal_count == 0) {
    if (!flush && nal_offsets.front() > 0) {
      buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(nal_offsets.front()));
    }
    return access_units;
  }

  size_t current_access_unit_start = std::string::npos;
  bool current_access_unit_has_vcl = false;

  for (size_t index = 0; index < parsable_nal_count; ++index) {
    const size_t nal_offset = nal_offsets[index];
    const size_t nal_end = (index + 1 < nal_offsets.size()) ? nal_offsets[index + 1] : buffer.size();
    const size_t start_code_size = annexb_start_code_size(buffer, nal_offset);
    if (start_code_size == 0 || nal_offset + start_code_size + 1 >= nal_end) {
      continue;
    }

    const std::uint8_t nal_type = (buffer[nal_offset + start_code_size] >> 1) & 0x3F;
    const bool is_aud = nal_type == 35;
    const bool is_vcl = nal_type <= 31;
    const bool is_first_slice = is_vcl &&
      h265_vcl_nal_is_first_slice_segment(buffer, nal_offset, start_code_size);

    if (current_access_unit_start == std::string::npos) {
      current_access_unit_start = nal_offset;
    } else if ((is_aud || is_first_slice) && current_access_unit_has_vcl) {
      std::vector<std::uint8_t> access_unit(
        buffer.begin() + static_cast<std::ptrdiff_t>(current_access_unit_start),
        buffer.begin() + static_cast<std::ptrdiff_t>(nal_offset)
      );
      if (should_emit_h265_access_unit(access_unit)) {
        access_units.push_back(std::move(access_unit));
      }
      current_access_unit_start = nal_offset;
      current_access_unit_has_vcl = false;
    }

    if (is_vcl) {
      current_access_unit_has_vcl = true;
    }
  }

  if (flush) {
    if (current_access_unit_start != std::string::npos &&
        current_access_unit_start < buffer.size()) {
      std::vector<std::uint8_t> access_unit(
        buffer.begin() + static_cast<std::ptrdiff_t>(current_access_unit_start),
        buffer.end()
      );
      if (should_emit_h265_access_unit(access_unit)) {
        access_units.push_back(std::move(access_unit));
      }
    }
    buffer.clear();
    return access_units;
  }

  const size_t retain_offset = current_access_unit_start != std::string::npos
    ? current_access_unit_start
    : nal_offsets[parsable_nal_count];
  if (retain_offset > 0) {
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(retain_offset));
  }
  return access_units;
}

std::vector<std::vector<std::uint8_t>> extract_annexb_video_access_units(
  const std::string& codec,
  std::vector<std::uint8_t>& buffer,
  bool flush) {
  return normalize_video_codec(codec) == "h265"
    ? extract_annexb_h265_access_units(buffer, flush)
    : extract_annexb_h264_access_units(buffer, flush);
}

bool start_peer_video_sender(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  PeerState& peer,
  std::string* error) {
  emit_breadcrumb(
    std::string("startPeerVideoSender:start peer=") + peer.peer_id +
    " codec=" + normalize_video_codec(plan.codec_path, normalize_video_codec(pipeline.requested_video_codec)) +
    " backend=" + plan.capture_backend);
  if (!peer.transport_session) {
    if (error) {
      *error = "peer-transport-session-missing";
    }
    return false;
  }

  const std::string command_line = build_ffmpeg_peer_video_sender_command(ffmpeg, pipeline, plan);
  if (command_line.empty()) {
    if (error) {
      *error = "ffmpeg-peer-video-sender-command-unavailable";
    }
    return false;
  }
  emit_breadcrumb(std::string("startPeerVideoSender:after-build-command peer=") + peer.peer_id);

  auto runtime = std::make_shared<PeerState::PeerVideoSenderRuntime>();
  runtime->launch_attempted = true;
  runtime->command_line = command_line;
  runtime->codec_path = normalize_video_codec(plan.codec_path, normalize_video_codec(pipeline.requested_video_codec));
  runtime->frame_interval_us = static_cast<unsigned long long>(
    std::max(1, 1000000 / std::max(1, plan.frame_rate > 0 ? plan.frame_rate : 60))
  );
  runtime->next_frame_timestamp_us = 0;
  runtime->source_backend = plan.capture_backend;

  const bool use_wgc_source = plan.capture_backend == "wgc";
  const WgcFrameSourceConfig wgc_source_config = build_wgc_frame_source_config(plan);
  const bool use_window_restore_placeholder =
    use_wgc_source &&
    wgc_source_config.target_kind == "window" &&
    plan.capture_state == "minimized" &&
    !wgc_source_config.window_handle.empty();
  const int source_frame_width = std::max(1, plan.input_width);
  const int source_frame_height = std::max(1, plan.input_height);

  SECURITY_ATTRIBUTES security_attributes{};
  security_attributes.nLength = sizeof(security_attributes);
  security_attributes.bInheritHandle = TRUE;

  HANDLE stdin_read = nullptr;
  HANDLE stdin_write = nullptr;
  HANDLE stdout_read = nullptr;
  HANDLE stdout_write = nullptr;
  if (use_wgc_source) {
    if (!CreatePipe(&stdin_read, &stdin_write, &security_attributes, 0)) {
      if (error) {
        *error = format_windows_error(GetLastError());
      }
      return false;
    }
    SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0);
  }

  if (!CreatePipe(&stdout_read, &stdout_write, &security_attributes, 0)) {
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);

  HANDLE nul_handle = CreateFileW(
    L"NUL",
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security_attributes,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr
  );
  if (nul_handle == INVALID_HANDLE_VALUE) {
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    CloseHandle(stdout_write);
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  STARTUPINFOW startup_info{};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = stdin_read ? stdin_read : nul_handle;
  startup_info.hStdOutput = stdout_write;
  startup_info.hStdError = nul_handle;

  PROCESS_INFORMATION process_info{};
  std::wstring command_line_wide = utf8_to_wide(command_line);
  if (command_line_wide.empty()) {
    CloseHandle(nul_handle);
    if (stdin_read) {
      CloseHandle(stdin_read);
    }
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    CloseHandle(stdout_write);
    if (error) {
      *error = "failed to convert peer video sender command line to UTF-16";
    }
    return false;
  }

  std::vector<wchar_t> mutable_command(command_line_wide.begin(), command_line_wide.end());
  mutable_command.push_back(L'\0');

  const BOOL created = CreateProcessW(
    nullptr,
    mutable_command.data(),
    nullptr,
    nullptr,
    TRUE,
    CREATE_NO_WINDOW,
    nullptr,
    nullptr,
    &startup_info,
    &process_info
  );

  CloseHandle(nul_handle);
  if (stdin_read) {
    CloseHandle(stdin_read);
  }
  CloseHandle(stdout_write);

  if (!created) {
    if (stdin_write) {
      CloseHandle(stdin_write);
    }
    CloseHandle(stdout_read);
    if (error) {
      *error = format_windows_error(GetLastError());
    }
    return false;
  }

  runtime->running = true;
  runtime->process_id = static_cast<unsigned long>(process_info.dwProcessId);
  runtime->process_handle = process_info.hProcess;
  runtime->thread_handle = process_info.hThread;
  runtime->stdin_write_handle = stdin_write;
  runtime->stdout_read_handle = stdout_read;
  runtime->started_at_unix_ms = current_time_millis();
  runtime->updated_at_unix_ms = runtime->started_at_unix_ms;
  runtime->reason = "peer-video-sender-running";
  emit_breadcrumb(
    std::string("startPeerVideoSender:after-create-process peer=") + peer.peer_id +
    " pid=" + std::to_string(runtime->process_id));

  if (use_wgc_source && runtime->stdin_write_handle) {
    struct SourceStartState {
      std::mutex mutex;
      std::condition_variable condition;
      bool complete = false;
      bool success = false;
      std::string error;
    };

    auto source_start_state = std::make_shared<SourceStartState>();
    HANDLE stdin_write_handle = runtime->stdin_write_handle;
    const std::string source_peer_id = peer.peer_id;
    runtime->source_thread = std::thread([
      runtime,
      wgc_source_config,
      source_start_state,
      stdin_write_handle,
      source_peer_id,
      use_window_restore_placeholder,
      source_frame_width,
      source_frame_height
    ]() {
      emit_breadcrumb(std::string("startPeerVideoSender:source-thread-begin peer=") + source_peer_id);

      auto finish_start = [&](bool success, const std::string& error_message) {
        std::lock_guard<std::mutex> lock(source_start_state->mutex);
        if (source_start_state->complete) {
          return;
        }
        source_start_state->complete = true;
        source_start_state->success = success;
        source_start_state->error = error_message;
        source_start_state->condition.notify_all();
      };

      const auto update_runtime_state = [&](const std::string& reason, const std::string& last_error, bool running) {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = reason;
        runtime->last_error = last_error;
        runtime->running = running;
        runtime->updated_at_unix_ms = current_time_millis();
      };

      const auto write_bgra_frame = [&](const std::vector<std::uint8_t>& bytes) -> bool {
        std::size_t total_written = 0;
        while (total_written < bytes.size() && !runtime->stop_requested.load()) {
          DWORD chunk_written = 0;
          const DWORD chunk_size = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - total_written, 1u << 20));
          const BOOL wrote = WriteFile(
            stdin_write_handle,
            bytes.data() + total_written,
            chunk_size,
            &chunk_written,
            nullptr
          );
          if (!wrote || chunk_written == 0) {
            update_runtime_state("peer-video-source-write-failed", format_windows_error(GetLastError()), false);
            return false;
          }
          total_written += static_cast<std::size_t>(chunk_written);
        }
        return !runtime->stop_requested.load();
      };

      const auto wait_for_next_placeholder_deadline = [&](std::int64_t* deadline_us) -> bool {
        const std::int64_t now_us = current_time_micros_steady();
        if (*deadline_us <= 0) {
          *deadline_us = now_us;
        }
        const bool slept = sleep_until_steady_us(*deadline_us, &runtime->stop_requested);
        *deadline_us += static_cast<std::int64_t>(runtime->frame_interval_us);
        return slept;
      };

      const auto try_create_wgc_source = [&]() -> std::shared_ptr<WgcFrameSource> {
        std::string source_error;
        emit_breadcrumb(std::string("startPeerVideoSender:source-before-create peer=") + source_peer_id);
        std::shared_ptr<WgcFrameSource> created = create_wgc_frame_source(wgc_source_config, &source_error);
        emit_breadcrumb(
          std::string("startPeerVideoSender:source-after-create peer=") + source_peer_id +
          " ok=" + (created ? "true" : "false"));
        if (!created) {
          update_runtime_state(
            "peer-video-source-start-failed",
            source_error.empty() ? "failed to create wgc frame source for peer video sender" : source_error,
            false
          );
        }
        return created;
      };

      std::shared_ptr<WgcFrameSource> wgc_source;
      bool placeholder_mode_active = use_window_restore_placeholder;
      bool refresh_pending = false;
      std::int64_t next_placeholder_deadline_us = -1;
      const int placeholder_width = std::max(1, source_frame_width);
      const int placeholder_height = std::max(1, source_frame_height);
      std::vector<std::uint8_t> placeholder_frame;
      const auto ensure_placeholder_frame = [&]() -> const std::vector<std::uint8_t>& {
        if (placeholder_frame.empty()) {
          placeholder_frame = build_window_restore_placeholder_frame_bgra(
            placeholder_width,
            placeholder_height
          );
        }
        return placeholder_frame;
      };
      const std::uint64_t min_frame_interval_100ns =
        std::max<std::uint64_t>(1, runtime->frame_interval_us) * 10;
      std::uint64_t next_source_timestamp_100ns = 0;
      auto next_source_time = std::chrono::steady_clock::time_point {};
      const auto source_frame_interval = std::chrono::microseconds(runtime->frame_interval_us);

      if (use_window_restore_placeholder) {
#ifdef _WIN32
        const WindowCaptureAvailability availability =
          query_window_capture_availability(wgc_source_config.window_handle);
        if (availability == WindowCaptureAvailability::minimized) {
          finish_start(true, "");
          update_runtime_state("peer-video-sender-waiting-for-window-restore", "", true);
        } else if (availability == WindowCaptureAvailability::unavailable) {
          const std::string missing_target_error = "Selected window is no longer available for capture.";
          finish_start(false, missing_target_error);
          update_runtime_state("peer-video-source-target-unavailable", missing_target_error, false);
          return;
        }
#endif
      }

      if (!source_start_state->complete) {
        wgc_source = try_create_wgc_source();
        if (!wgc_source) {
          finish_start(false, runtime->last_error.empty()
            ? "failed to create wgc frame source for peer video sender"
            : runtime->last_error);
          return;
        }
        finish_start(true, "");
      }

      while (!runtime->stop_requested.load()) {
        if (refresh_pending) {
          sleep_until_steady_us(
            current_time_micros_steady() + 100000,
            &runtime->stop_requested
          );
          continue;
        }
        if (placeholder_mode_active) {
#ifdef _WIN32
          const WindowCaptureAvailability availability =
            query_window_capture_availability(wgc_source_config.window_handle);
          if (availability == WindowCaptureAvailability::unavailable) {
            update_runtime_state(
              "peer-video-source-target-unavailable",
              "Selected window is no longer available for capture.",
              false
            );
            break;
          }
          if (availability == WindowCaptureAvailability::minimized) {
            if (wgc_source) {
              wgc_source->close();
              wgc_source.reset();
            }
            update_runtime_state("peer-video-sender-waiting-for-window-restore", "", true);
            if (!wait_for_next_placeholder_deadline(&next_placeholder_deadline_us)) {
              break;
            }
            const auto& current_placeholder_frame = ensure_placeholder_frame();
            if (!current_placeholder_frame.empty()) {
              {
                std::lock_guard<std::mutex> lock(runtime->mutex);
                runtime->source_frames_captured += 1;
                runtime->source_bytes_captured += static_cast<unsigned long long>(current_placeholder_frame.size());
                runtime->updated_at_unix_ms = current_time_millis();
              }
              if (!write_bgra_frame(current_placeholder_frame)) {
                break;
              }
            }
            continue;
          }
          if (availability == WindowCaptureAvailability::normal) {
            runtime->soft_refresh_requested.store(true);
            update_runtime_state("peer-video-sender-refresh-pending", "", false);
            refresh_pending = true;
            continue;
          }
#endif
        }

        if (!wgc_source) {
          wgc_source = try_create_wgc_source();
          if (!wgc_source) {
            if (placeholder_mode_active) {
              sleep_until_steady_us(
                current_time_micros_steady() + 250000,
                &runtime->stop_requested
              );
              continue;
            }
            break;
          }
          next_placeholder_deadline_us = -1;
          next_source_timestamp_100ns = 0;
          next_source_time = std::chrono::steady_clock::time_point {};
          placeholder_mode_active = false;
        }

        WgcFrameCpuBuffer frame;
        std::string frame_error;
        if (!wgc_source->wait_for_frame_bgra(250, &frame, &frame_error)) {
          if (runtime->stop_requested.load()) {
            break;
          }
          if (frame_error == "wgc-frame-timeout" || frame_error == "wgc-frame-pool-recreated") {
            continue;
          }
          update_runtime_state("peer-video-source-frame-failed", frame_error, false);
          break;
        }

        const bool frame_geometry_changed =
          frame.width != source_frame_width ||
          frame.height != source_frame_height ||
          frame.stride != (source_frame_width * 4);
        if (!placeholder_mode_active && frame_geometry_changed) {
          emit_breadcrumb(
            std::string("startPeerVideoSender:geometry-change-refresh peer=") + source_peer_id +
            " old=" + std::to_string(source_frame_width) + "x" + std::to_string(source_frame_height) +
            " new=" + std::to_string(frame.width) + "x" + std::to_string(frame.height) +
            " stride=" + std::to_string(frame.stride));
          runtime->soft_refresh_requested.store(true);
          update_runtime_state("peer-video-sender-refresh-pending", "", false);
          if (wgc_source) {
            wgc_source->close();
            wgc_source.reset();
          }
          refresh_pending = true;
          continue;
        }

        {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->source_frames_captured += 1;
          runtime->source_bytes_captured += static_cast<unsigned long long>(frame.bgra.size());
          runtime->source_copy_resource_us_total += frame.copy_resource_us;
          runtime->source_map_us_total += frame.map_us;
          runtime->source_memcpy_us_total += frame.memcpy_us;
          runtime->source_total_readback_us_total += frame.total_readback_us;
          runtime->updated_at_unix_ms = current_time_millis();
        }

        if (frame.timestamp_100ns > 0) {
          if (next_source_timestamp_100ns == 0) {
            next_source_timestamp_100ns = frame.timestamp_100ns;
          }
          if (frame.timestamp_100ns < next_source_timestamp_100ns) {
            continue;
          }
          do {
            next_source_timestamp_100ns += min_frame_interval_100ns;
          } while (next_source_timestamp_100ns <= frame.timestamp_100ns);
        } else {
          const auto now = std::chrono::steady_clock::now();
          if (next_source_time == std::chrono::steady_clock::time_point {}) {
            next_source_time = now;
          }
          if (now < next_source_time) {
            continue;
          }
          do {
            next_source_time += source_frame_interval;
          } while (next_source_time <= now);
        }

        if (!write_bgra_frame(frame.bgra)) {
          break;
        }
        update_runtime_state("peer-video-sender-running", "", true);
      }

      if (stdin_write_handle) {
        CloseHandle(stdin_write_handle);
        if (runtime->stdin_write_handle == stdin_write_handle) {
          runtime->stdin_write_handle = nullptr;
        }
      }
      if (wgc_source) {
        wgc_source->close();
      }
    });

    {
      std::unique_lock<std::mutex> lock(source_start_state->mutex);
      source_start_state->condition.wait(lock, [&source_start_state]() {
        return source_start_state->complete;
      });
      if (!source_start_state->success) {
        runtime->stop_requested.store(true);
        if (runtime->stdin_write_handle) {
          CloseHandle(runtime->stdin_write_handle);
          runtime->stdin_write_handle = nullptr;
        }
        if (runtime->process_handle) {
          TerminateProcess(runtime->process_handle, 0);
          WaitForSingleObject(runtime->process_handle, 2000);
        }
        if (runtime->source_thread.joinable()) {
          runtime->source_thread.join();
        }
        close_peer_video_sender_handles(*runtime);
        if (error) {
          *error = source_start_state->error;
        }
        return false;
      }
    }
    emit_breadcrumb(std::string("startPeerVideoSender:source-ready peer=") + peer.peer_id);
  }

  const std::shared_ptr<PeerTransportSession> transport_session = peer.transport_session;
  runtime->pump_thread = std::thread([runtime, transport_session]() {
    std::vector<std::uint8_t> read_buffer(64 * 1024);
    const std::string codec_path = normalize_video_codec(runtime->codec_path);

    const auto cache_video_bootstrap_access_unit = [&runtime, &codec_path](const std::vector<std::uint8_t>& access_unit) {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      if (video_access_unit_has_decoder_config_nal(codec_path, access_unit)) {
        runtime->cached_video_decoder_config_au = access_unit;
        runtime->pending_video_bootstrap = true;
      }
      if (video_access_unit_has_random_access_nal(codec_path, access_unit)) {
        runtime->cached_video_random_access_au = access_unit;
        runtime->pending_video_bootstrap = true;
      }
    };

    const auto send_video_access_unit = [&runtime, &transport_session, &codec_path](
      const std::vector<std::uint8_t>& access_unit,
      std::string* error) -> bool {
      std::int64_t target_send_us = -1;
      std::int64_t now_us = current_time_micros_steady();
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (runtime->next_frame_send_deadline_steady_us <= 0) {
          runtime->next_frame_send_deadline_steady_us = now_us;
        } else {
          runtime->next_frame_send_deadline_steady_us += static_cast<std::int64_t>(runtime->frame_interval_us);
          if (runtime->next_frame_send_deadline_steady_us < now_us) {
            runtime->next_frame_send_deadline_steady_us = now_us;
          }
        }
        target_send_us = runtime->next_frame_send_deadline_steady_us;
      }

      if (target_send_us > 0 && !sleep_until_steady_us(target_send_us, &runtime->stop_requested)) {
        if (error) {
          *error = "peer-video-sender-stopped";
        }
        return false;
      }

      now_us = current_time_micros_steady();
      std::uint64_t timestamp_us = 0;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (runtime->last_frame_sent_at_steady_us > 0 && now_us > runtime->last_frame_sent_at_steady_us) {
          runtime->next_frame_timestamp_us += static_cast<unsigned long long>(
            std::min<std::int64_t>(now_us - runtime->last_frame_sent_at_steady_us, 1000000)
          );
        }
        timestamp_us = runtime->next_frame_timestamp_us;
      }

      if (!send_peer_transport_video_frame(transport_session, access_unit, codec_path, timestamp_us, error)) {
        return false;
      }

      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->last_frame_sent_at_steady_us = now_us;
      runtime->frames_sent += 1;
      runtime->bytes_sent += static_cast<unsigned long long>(access_unit.size());
      runtime->reason = "peer-video-sender-running";
      runtime->last_error.clear();
      runtime->updated_at_unix_ms = current_time_millis();
      return true;
    };

    const auto flush_video_bootstrap_access_units = [&runtime, &send_video_access_unit, &codec_path](std::string* error) -> bool {
      std::vector<std::uint8_t> decoder_config_au;
      std::vector<std::uint8_t> random_access_au;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        if (!runtime->pending_video_bootstrap) {
          return true;
        }
        decoder_config_au = runtime->cached_video_decoder_config_au;
        random_access_au = runtime->cached_video_random_access_au;
      }

      if (!video_bootstrap_is_complete(codec_path, decoder_config_au, random_access_au)) {
        return true;
      }

      if (!decoder_config_au.empty()) {
        if (!send_video_access_unit(decoder_config_au, error)) {
          return false;
        }
      }

      if (!random_access_au.empty() && random_access_au != decoder_config_au) {
        if (!send_video_access_unit(random_access_au, error)) {
          return false;
        }
      }

      std::lock_guard<std::mutex> lock(runtime->mutex);
      runtime->pending_video_bootstrap = false;
      return true;
    };

    while (true) {
      DWORD bytes_read = 0;
      const BOOL ok = ReadFile(
        runtime->stdout_read_handle,
        read_buffer.data(),
        static_cast<DWORD>(read_buffer.size()),
        &bytes_read,
        nullptr
      );

      if (!ok || bytes_read == 0) {
        break;
      }

      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->pending_video_annexb_bytes.insert(
          runtime->pending_video_annexb_bytes.end(),
          read_buffer.begin(),
          read_buffer.begin() + static_cast<std::ptrdiff_t>(bytes_read)
        );
      }

      std::vector<std::vector<std::uint8_t>> access_units;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        access_units = extract_annexb_video_access_units(codec_path, runtime->pending_video_annexb_bytes, false);
      }
      for (auto& access_unit : access_units) {
        const PeerTransportSnapshot transport_snapshot = get_peer_transport_snapshot(transport_session);
        const bool access_unit_has_decoder_config =
          video_access_unit_has_decoder_config_nal(codec_path, access_unit);
        const bool access_unit_has_random_access =
          video_access_unit_has_random_access_nal(codec_path, access_unit);
        if (!transport_snapshot.remote_description_set || transport_snapshot.connection_state != "connected") {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-peer-connected";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }
        if (!transport_snapshot.video_track_open) {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-video-track-open";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }

        if (access_unit_has_decoder_config || access_unit_has_random_access) {
          cache_video_bootstrap_access_unit(access_unit);
        }

        bool pending_bootstrap = false;
        bool bootstrap_complete = false;
        {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          pending_bootstrap = runtime->pending_video_bootstrap;
          bootstrap_complete = video_bootstrap_is_complete(
            codec_path,
            runtime->cached_video_decoder_config_au,
            runtime->cached_video_random_access_au
          );
        }
        if (pending_bootstrap && !bootstrap_complete) {
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->reason = "peer-video-sender-waiting-for-bootstrap";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }

        std::string send_error;
        if (!flush_video_bootstrap_access_units(&send_error) ||
            (!(access_unit_has_decoder_config || access_unit_has_random_access) &&
             !send_video_access_unit(access_unit, &send_error))) {
          if (send_error.find("Track is closed") != std::string::npos) {
            cache_video_bootstrap_access_unit(access_unit);
            std::lock_guard<std::mutex> lock(runtime->mutex);
            runtime->last_error = send_error;
            runtime->reason = "peer-video-sender-waiting-for-video-track-open";
            runtime->updated_at_unix_ms = current_time_millis();
            continue;
          }
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->last_error = send_error;
          runtime->reason = "peer-video-frame-send-failed";
          runtime->running = false;
          runtime->updated_at_unix_ms = current_time_millis();
          return;
        }
      }
    }

    std::vector<std::vector<std::uint8_t>> remaining_access_units;
    {
      std::lock_guard<std::mutex> lock(runtime->mutex);
      remaining_access_units = extract_annexb_video_access_units(codec_path, runtime->pending_video_annexb_bytes, true);
    }
    for (auto& access_unit : remaining_access_units) {
      const PeerTransportSnapshot transport_snapshot = get_peer_transport_snapshot(transport_session);
      const bool access_unit_has_decoder_config =
        video_access_unit_has_decoder_config_nal(codec_path, access_unit);
      const bool access_unit_has_random_access =
        video_access_unit_has_random_access_nal(codec_path, access_unit);
      if (!transport_snapshot.remote_description_set || transport_snapshot.connection_state != "connected") {
        cache_video_bootstrap_access_unit(access_unit);
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-peer-connected";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }
      if (!transport_snapshot.video_track_open) {
        cache_video_bootstrap_access_unit(access_unit);
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-video-track-open";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }

      if (access_unit_has_decoder_config || access_unit_has_random_access) {
        cache_video_bootstrap_access_unit(access_unit);
      }

      bool pending_bootstrap = false;
      bool bootstrap_complete = false;
      {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        pending_bootstrap = runtime->pending_video_bootstrap;
        bootstrap_complete = video_bootstrap_is_complete(
          codec_path,
          runtime->cached_video_decoder_config_au,
          runtime->cached_video_random_access_au
        );
      }
      if (pending_bootstrap && !bootstrap_complete) {
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->reason = "peer-video-sender-waiting-for-bootstrap";
        runtime->updated_at_unix_ms = current_time_millis();
        continue;
      }

      std::string send_error;
      if (!flush_video_bootstrap_access_units(&send_error) ||
          (!(access_unit_has_decoder_config || access_unit_has_random_access) &&
           !send_video_access_unit(access_unit, &send_error))) {
        if (send_error.find("Track is closed") != std::string::npos) {
          cache_video_bootstrap_access_unit(access_unit);
          std::lock_guard<std::mutex> lock(runtime->mutex);
          runtime->last_error = send_error;
          runtime->reason = "peer-video-sender-waiting-for-video-track-open";
          runtime->updated_at_unix_ms = current_time_millis();
          continue;
        }
        std::lock_guard<std::mutex> lock(runtime->mutex);
        runtime->last_error = send_error;
        runtime->reason = "peer-video-frame-send-failed";
        runtime->running = false;
        runtime->updated_at_unix_ms = current_time_millis();
        return;
      }
    }

    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->running = false;
    runtime->updated_at_unix_ms = current_time_millis();
    if (runtime->reason == "peer-video-sender-running") {
      runtime->reason = "peer-video-sender-pipe-closed";
    }
  });

  peer.media_binding.runtime = runtime;
  peer.media_binding.process_id = runtime->process_id;
  peer.media_binding.command_line = runtime->command_line;
  peer.media_binding.source_frames_captured = 0;
  peer.media_binding.source_bytes_captured = 0;
  peer.media_binding.avg_source_copy_resource_us = 0;
  peer.media_binding.avg_source_map_us = 0;
  peer.media_binding.avg_source_memcpy_us = 0;
  peer.media_binding.avg_source_total_readback_us = 0;
  peer.media_binding.frames_sent = 0;
  peer.media_binding.bytes_sent = 0;
  emit_breadcrumb(std::string("startPeerVideoSender:done peer=") + peer.peer_id);
  return true;
}

void refresh_peer_media_binding(PeerState& peer) {
  if (!peer.media_binding.runtime) {
    RelaySubscriberState relay_state;
    if (query_relay_subscriber_state(peer.peer_id, &relay_state)) {
      peer.media_binding.process_id = 0;
      peer.media_binding.source_frames_captured = 0;
      peer.media_binding.source_bytes_captured = 0;
      peer.media_binding.avg_source_copy_resource_us = 0;
      peer.media_binding.avg_source_map_us = 0;
      peer.media_binding.avg_source_memcpy_us = 0;
      peer.media_binding.avg_source_total_readback_us = 0;
      peer.media_binding.frames_sent = relay_state.frames_sent;
      peer.media_binding.bytes_sent = relay_state.bytes_sent;
      peer.media_binding.command_line.clear();
      peer.media_binding.active =
        peer.transport.connection_state == "connected" &&
        peer.transport.video_track_open;
      peer.media_binding.last_error = relay_state.last_error;
      if (!relay_state.reason.empty()) {
        peer.media_binding.reason = relay_state.reason;
      }
    }
    return;
  }

  auto& runtime = *peer.media_binding.runtime;
  if (runtime.process_handle) {
    DWORD exit_code = STILL_ACTIVE;
    if (GetExitCodeProcess(runtime.process_handle, &exit_code)) {
      if (exit_code != STILL_ACTIVE) {
        runtime.running = false;
        runtime.last_exit_code = static_cast<int>(exit_code);
        runtime.stopped_at_unix_ms = current_time_millis();
        if (runtime.reason == "peer-video-sender-running") {
          runtime.reason = "peer-video-sender-exited";
        }
      }
    }
  }

  std::lock_guard<std::mutex> lock(runtime.mutex);
  peer.media_binding.process_id = runtime.process_id;
  peer.media_binding.source_frames_captured = runtime.source_frames_captured;
  peer.media_binding.source_bytes_captured = runtime.source_bytes_captured;
  if (runtime.source_frames_captured > 0) {
    peer.media_binding.avg_source_copy_resource_us =
      runtime.source_copy_resource_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_map_us =
      runtime.source_map_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_memcpy_us =
      runtime.source_memcpy_us_total / runtime.source_frames_captured;
    peer.media_binding.avg_source_total_readback_us =
      runtime.source_total_readback_us_total / runtime.source_frames_captured;
  } else {
    peer.media_binding.avg_source_copy_resource_us = 0;
    peer.media_binding.avg_source_map_us = 0;
    peer.media_binding.avg_source_memcpy_us = 0;
    peer.media_binding.avg_source_total_readback_us = 0;
  }
  peer.media_binding.frames_sent = runtime.frames_sent;
  peer.media_binding.bytes_sent = runtime.bytes_sent;
  peer.media_binding.command_line = runtime.command_line;
  peer.media_binding.active =
    runtime.running &&
    peer.transport.connection_state == "connected" &&
    peer.transport.video_track_open;
  peer.media_binding.last_error = runtime.last_error;
  if (!runtime.reason.empty()) {
    peer.media_binding.reason = runtime.reason;
  }
}

bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error) {
  emit_breadcrumb(
    std::string("stopPeerVideoSender:start peer=") +
    peer.peer_id +
    " reason=" + reason +
    " hasRuntime=" + (peer.media_binding.runtime ? "true" : "false")
  );
  if (!peer.media_binding.runtime) {
    peer.media_binding.process_id = 0;
    peer.media_binding.source_frames_captured = 0;
    peer.media_binding.source_bytes_captured = 0;
    peer.media_binding.avg_source_copy_resource_us = 0;
    peer.media_binding.avg_source_map_us = 0;
    peer.media_binding.avg_source_memcpy_us = 0;
    peer.media_binding.avg_source_total_readback_us = 0;
    peer.media_binding.active = false;
    peer.media_binding.reason = reason;
    peer.media_binding.updated_at_unix_ms = current_time_millis();
    emit_breadcrumb(std::string("stopPeerVideoSender:done-no-runtime peer=") + peer.peer_id);
    return true;
  }

  auto runtime = peer.media_binding.runtime;

  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->reason = reason;
    runtime->updated_at_unix_ms = current_time_millis();
  }

  runtime->stop_requested.store(true);

  if (runtime->process_handle) {
    TerminateProcess(runtime->process_handle, 0);
    WaitForSingleObject(runtime->process_handle, 2000);
  }

  if (runtime->source_thread.joinable()) {
    runtime->source_thread.join();
  }

  if (runtime->pump_thread.joinable()) {
    runtime->pump_thread.join();
  }

  close_peer_video_sender_handles(*runtime);

  peer.media_binding.process_id = 0;
  peer.media_binding.source_frames_captured = 0;
  peer.media_binding.source_bytes_captured = 0;
  peer.media_binding.avg_source_copy_resource_us = 0;
  peer.media_binding.avg_source_map_us = 0;
  peer.media_binding.avg_source_memcpy_us = 0;
  peer.media_binding.avg_source_total_readback_us = 0;
  peer.media_binding.active = false;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.detached_at_unix_ms = peer.media_binding.updated_at_unix_ms;
  peer.media_binding.runtime.reset();
  emit_breadcrumb(std::string("stopPeerVideoSender:done peer=") + peer.peer_id);
  if (error) {
    error->clear();
  }
  return true;
}

void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime,
  const std::shared_ptr<PeerTransportSession>& transport_session) {
  if (!transport_session || !runtime) {
    return;
  }

  std::lock_guard<std::mutex> lock(runtime->mutex);
  set_peer_transport_decoder_state(
    transport_session,
    runtime->decoder_ready,
    runtime->decoded_frames_rendered,
    runtime->last_decoded_frame_at_unix_ms,
    runtime->decoder_backend,
    nullptr
  );
}

bool submit_scheduled_video_unit_to_surface(
  const std::string& peer_id,
  PeerState::PeerVideoReceiverRuntime& runtime,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec_path,
  std::string* warning_message) {
  std::shared_ptr<NativeVideoSurface> surface;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    surface = runtime.surface;
  }

  if (!surface) {
    if (warning_message) {
      *warning_message = "peer-video-surface-missing";
    }
    return false;
  }

  const NativeVideoSurfaceSnapshot snapshot = surface->snapshot();
  if (snapshot.reason == "native-decoder-send-failed" ||
      snapshot.reason == "native-decoder-receive-failed" ||
      snapshot.reason == "native-decoder-transfer-failed") {
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      runtime.running = false;
      runtime.decoder_ready = false;
      runtime.pending_video_annexb_bytes.clear();
      runtime.startup_video_decoder_config_au.clear();
      runtime.startup_waiting_for_random_access = true;
      runtime.scheduled_video_queue.clear();
      runtime.scheduled_audio_queue.clear();
      runtime.av_sync_anchor_initialized = false;
      runtime.reason = "peer-video-surface-decoder-recovering";
      runtime.last_error = snapshot.last_error;
    }

    std::string restart_error;
    if (!restart_peer_video_surface_attachment(runtime, &restart_error)) {
      if (warning_message) {
        *warning_message = restart_error.empty() ? snapshot.last_error : restart_error;
      }
      return false;
    }

    refresh_peer_video_receiver_runtime(runtime);
    if (warning_message) {
      *warning_message = snapshot.last_error.empty()
        ? "peer-video-surface-decoder-restarted"
        : snapshot.last_error;
    }
    return false;
  }

  std::string submit_error;
  if (surface->submit_encoded_frame(frame, codec_path, &submit_error)) {
    return true;
  }

  if (submit_error == "native-video-surface-not-running") {
    std::string runtime_reason;
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      runtime_reason = runtime.reason;
    }

    if (is_peer_video_surface_shutdown_reason(runtime_reason)) {
      if (warning_message) {
        *warning_message = runtime_reason;
      }
      return false;
    }

    std::string restart_error;
    if (restart_peer_video_surface_attachment(runtime, &restart_error)) {
      std::shared_ptr<NativeVideoSurface> restarted_surface;
      {
        std::lock_guard<std::mutex> lock(runtime.mutex);
        restarted_surface = runtime.surface;
        runtime.reason = "peer-video-surface-running";
        runtime.last_error.clear();
      }

      if (restarted_surface && restarted_surface->submit_encoded_frame(frame, codec_path, &submit_error)) {
        return true;
      }
    }

    if (!restart_error.empty()) {
      submit_error = restart_error;
    }
  }

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    runtime.running = false;
    runtime.decoder_ready = false;
    runtime.pending_video_annexb_bytes.clear();
    runtime.startup_video_decoder_config_au.clear();
    runtime.startup_waiting_for_random_access = true;
    runtime.reason = "peer-video-surface-submit-failed";
    runtime.last_error = submit_error;
  }
  if (warning_message) {
    *warning_message = submit_error;
  }
  emit_event(
    "warning",
    std::string("{\"scope\":\"surface\",\"peerId\":\"") + json_escape(peer_id) +
      "\",\"message\":\"" + json_escape(submit_error) +
      "\",\"reason\":\"peer-video-surface-submit-failed\"}"
  );
  return false;
}

void consume_remote_peer_video_frame(
  const std::string& peer_id,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime_ptr,
  const std::shared_ptr<PeerTransportSession>& transport_session,
  const std::vector<std::uint8_t>& frame,
  const std::string& codec,
  std::uint32_t rtp_timestamp) {
  if (!runtime_ptr) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(runtime_ptr->mutex);
    if (runtime_ptr->closing) {
      return;
    }
  }

  auto& runtime = *runtime_ptr;
  std::string codec_path;
  std::vector<std::vector<std::uint8_t>> decode_units;
  std::vector<std::vector<std::uint8_t>> relay_decode_units;

  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.closing) {
      return;
    }
    runtime.codec_path = normalize_video_codec(codec);
    runtime.remote_frames_received += 1;
    runtime.remote_bytes_received += static_cast<unsigned long long>(frame.size());
    runtime.last_remote_frame_at_unix_ms = current_time_millis();
    codec_path = runtime.codec_path;

    if (codec_path == "h264" || codec_path == "h265") {
      const bool frame_has_annexb_start_code = find_next_annexb_start_code(frame, 0) != std::string::npos;
      if (runtime.pending_video_annexb_bytes.empty() && frame_has_annexb_start_code) {
        if (should_emit_video_access_unit(codec_path, frame)) {
          decode_units.push_back(frame);
        }
      } else {
        runtime.pending_video_annexb_bytes.insert(
          runtime.pending_video_annexb_bytes.end(),
          frame.begin(),
          frame.end()
        );
        decode_units = extract_annexb_video_access_units(codec_path, runtime.pending_video_annexb_bytes, false);
      }
    } else {
      decode_units.push_back(frame);
    }
  }
  relay_decode_units = decode_units;

  if (codec_path == "h264" || codec_path == "h265") {
    std::vector<std::vector<std::uint8_t>> startup_units;
    bool waiting_for_random_access = false;
    {
      std::lock_guard<std::mutex> lock(runtime.mutex);
      if (runtime.closing) {
        return;
      }
      if (runtime.startup_waiting_for_random_access) {
        for (const auto& decode_unit : decode_units) {
          if (video_access_unit_has_decoder_config_nal(codec_path, decode_unit)) {
            runtime.startup_video_decoder_config_au = decode_unit;
          }
          if (!video_access_unit_has_random_access_nal(codec_path, decode_unit)) {
            continue;
          }
          if (!video_bootstrap_is_complete(
                codec_path,
                runtime.startup_video_decoder_config_au,
                decode_unit)) {
            continue;
          }

          runtime.scheduled_video_queue.clear();
          runtime.scheduled_audio_queue.clear();
          runtime.av_sync_anchor_initialized = false;
          runtime.startup_waiting_for_random_access = false;
          if (!runtime.startup_video_decoder_config_au.empty()) {
            startup_units.push_back(runtime.startup_video_decoder_config_au);
          }
          if (startup_units.empty() || startup_units.back() != decode_unit) {
            startup_units.push_back(decode_unit);
          }
          runtime.reason = "peer-av-sync-video-bootstrap-random-access";
          break;
        }

        if (runtime.startup_waiting_for_random_access) {
          runtime.dropped_video_units += static_cast<unsigned long long>(decode_units.size());
          runtime.reason = "peer-av-sync-waiting-for-random-access";
          waiting_for_random_access = true;
        }
      }
    }

    if (waiting_for_random_access) {
      fanout_relay_video_units(peer_id, codec_path, relay_decode_units, rtp_timestamp);
      refresh_peer_video_receiver_runtime(runtime);
      update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
      return;
    }

    if (!startup_units.empty()) {
      decode_units = std::move(startup_units);
    }
  }

  fanout_relay_video_units(peer_id, codec_path, relay_decode_units, rtp_timestamp);
  bool local_playback_enabled = false;
  bool passthrough_enabled = false;
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.closing) {
      return;
    }
    local_playback_enabled = runtime.local_playback_enabled;
    passthrough_enabled = runtime.passthrough_playback_enabled;
  }

  if (!local_playback_enabled) {
    refresh_peer_video_receiver_runtime(runtime);
    update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
    return;
  }

  if (passthrough_enabled) {
    for (const auto& decode_unit : decode_units) {
      std::string warning_message;
      const bool submitted = submit_scheduled_video_unit_to_surface(
        peer_id,
        runtime,
        decode_unit,
        codec_path,
        &warning_message
      );
      std::lock_guard<std::mutex> lock(runtime.mutex);
      runtime.scheduled_video_units += 1;
      if (submitted) {
        runtime.submitted_video_units += 1;
        runtime.av_sync_last_video_lateness_us = 0;
        runtime.reason = "peer-video-passthrough-submitted";
      } else {
        runtime.dropped_video_units += 1;
        runtime.reason = "peer-video-passthrough-dropped";
        if (!warning_message.empty()) {
          runtime.last_error = warning_message;
        }
      }
    }
    refresh_peer_video_receiver_runtime(runtime);
    update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
    (void)peer_id;
    return;
  }

  ensure_peer_av_sync_runtime(runtime, g_agent_runtime_for_audio->viewer_audio_playback);
  {
    std::lock_guard<std::mutex> lock(runtime.mutex);
    if (runtime.closing) {
      return;
    }
    for (const auto& decode_unit : decode_units) {
      PeerState::PeerVideoReceiverRuntime::ScheduledVideoUnit unit;
      unit.remote_timestamp_us = rtp_timestamp_to_us(rtp_timestamp, kPeerAvSyncVideoClockRate);
      unit.local_arrival_us = current_time_micros_steady();
      unit.codec = codec_path;
      unit.bytes = decode_unit;
      runtime.scheduled_video_queue.push_back(std::move(unit));
      runtime.scheduled_video_units += 1;
    }
    while (runtime.scheduled_video_queue.size() > kPeerAvSyncMaxQueuedVideoUnits) {
      runtime.scheduled_video_queue.pop_front();
      runtime.dropped_video_units += 1;
      runtime.reason = "peer-av-sync-video-overflow";
    }
    runtime.reason = "peer-av-sync-video-queued";
    runtime.av_sync_cv.notify_all();
  }

  refresh_peer_video_receiver_runtime(runtime);
  update_peer_decoder_state_from_runtime(runtime_ptr, transport_session);
  (void)peer_id;
}
#else
bool start_peer_video_sender(
  const FfmpegProbeResult&,
  const HostPipelineState&,
  const HostCapturePlan&,
  PeerState&,
  std::string* error) {
  if (error) {
    *error = "peer-video-sender-is-only-implemented-on-windows";
  }
  return false;
}

void refresh_peer_media_binding(PeerState&) {}

bool stop_peer_video_sender(PeerState& peer, const std::string& reason, std::string* error) {
  peer.media_binding.active = false;
  peer.media_binding.reason = reason;
  peer.media_binding.updated_at_unix_ms = current_time_millis();
  peer.media_binding.runtime.reset();
  if (error) {
    error->clear();
  }
  return true;
}
void update_peer_decoder_state_from_runtime(
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>&,
  const std::shared_ptr<PeerTransportSession>&) {}
bool submit_scheduled_video_unit_to_surface(
  const std::string&,
  PeerState::PeerVideoReceiverRuntime&,
  const std::vector<std::uint8_t>&,
  const std::string&,
  std::string* warning_message) {
  if (warning_message) {
    *warning_message = "peer-video-surface-is-only-implemented-on-windows";
  }
  return false;
}
void consume_remote_peer_video_frame(
  const std::string&,
  const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>&,
  const std::shared_ptr<PeerTransportSession>&,
  const std::vector<std::uint8_t>&,
  const std::string&,
  std::uint32_t) {}
#endif

std::string peer_transport_backend_json(const PeerTransportBackendInfo& backend) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (backend.available ? "true" : "false")
    << ",\"transportReady\":" << (backend.transport_ready ? "true" : "false")
    << ",\"mediaPlaneReady\":" << (backend.media_plane_ready ? "true" : "false")
    << ",\"videoTrackSupport\":" << (backend.video_track_support ? "true" : "false")
    << ",\"audioTrackSupport\":" << (backend.audio_track_support ? "true" : "false")
    << ",\"backend\":\"" << json_escape(backend.backend) << "\""
    << ",\"implementation\":\"" << json_escape(backend.implementation) << "\""
    << ",\"mode\":\"" << json_escape(backend.mode) << "\""
    << ",\"reason\":\"" << json_escape(backend.reason) << "\""
    << ",\"lastError\":\"" << json_escape(backend.last_error) << "\""
    << ",\"iceServers\":[";

  for (size_t index = 0; index < backend.ice_servers.size(); ++index) {
    if (index > 0) {
      payload << ",";
    }
    payload << "\"" << json_escape(backend.ice_servers[index]) << "\"";
  }

  payload << "]}";
  return payload.str();
}

std::string peer_transport_snapshot_json(const PeerTransportSnapshot& snapshot) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (snapshot.available ? "true" : "false")
    << ",\"transportReady\":" << (snapshot.transport_ready ? "true" : "false")
    << ",\"mediaPlaneReady\":" << (snapshot.media_plane_ready ? "true" : "false")
    << ",\"videoTrackSupport\":" << (snapshot.video_track_support ? "true" : "false")
    << ",\"audioTrackSupport\":" << (snapshot.audio_track_support ? "true" : "false")
    << ",\"videoTrackConfigured\":" << (snapshot.video_track_configured ? "true" : "false")
    << ",\"audioTrackConfigured\":" << (snapshot.audio_track_configured ? "true" : "false")
    << ",\"videoReceiverConfigured\":" << (snapshot.video_receiver_configured ? "true" : "false")
    << ",\"audioReceiverConfigured\":" << (snapshot.audio_receiver_configured ? "true" : "false")
    << ",\"videoTrackOpen\":" << (snapshot.video_track_open ? "true" : "false")
    << ",\"audioTrackOpen\":" << (snapshot.audio_track_open ? "true" : "false")
    << ",\"decoderReady\":" << (snapshot.decoder_ready ? "true" : "false")
    << ",\"remoteVideoTrackAttached\":" << (snapshot.remote_video_track_attached ? "true" : "false")
    << ",\"remoteAudioTrackAttached\":" << (snapshot.remote_audio_track_attached ? "true" : "false")
    << ",\"localDescriptionCreated\":" << (snapshot.local_description_created ? "true" : "false")
    << ",\"remoteDescriptionSet\":" << (snapshot.remote_description_set ? "true" : "false")
    << ",\"dataChannelRequested\":" << (snapshot.data_channel_requested ? "true" : "false")
    << ",\"dataChannelOpen\":" << (snapshot.data_channel_open ? "true" : "false")
    << ",\"closed\":" << (snapshot.closed ? "true" : "false")
    << ",\"localCandidateCount\":" << snapshot.local_candidate_count
    << ",\"remoteCandidateCount\":" << snapshot.remote_candidate_count
    << ",\"remoteTrackCount\":" << snapshot.remote_track_count
    << ",\"bytesSent\":" << snapshot.bytes_sent
    << ",\"bytesReceived\":" << snapshot.bytes_received
    << ",\"videoFramesSent\":" << snapshot.video_frames_sent
    << ",\"videoBytesSent\":" << snapshot.video_bytes_sent
    << ",\"audioFramesSent\":" << snapshot.audio_frames_sent
    << ",\"audioBytesSent\":" << snapshot.audio_bytes_sent
    << ",\"remoteVideoFramesReceived\":" << snapshot.remote_video_frames_received
    << ",\"remoteVideoBytesReceived\":" << snapshot.remote_video_bytes_received
    << ",\"remoteAudioFramesReceived\":" << snapshot.remote_audio_frames_received
    << ",\"remoteAudioBytesReceived\":" << snapshot.remote_audio_bytes_received
    << ",\"decodedFramesRendered\":" << snapshot.decoded_frames_rendered
    << ",\"connectionState\":\"" << json_escape(snapshot.connection_state) << "\""
    << ",\"iceState\":\"" << json_escape(snapshot.ice_state) << "\""
    << ",\"gatheringState\":\"" << json_escape(snapshot.gathering_state) << "\""
    << ",\"signalingState\":\"" << json_escape(snapshot.signaling_state) << "\""
    << ",\"localDescriptionType\":\"" << json_escape(snapshot.local_description_type) << "\""
    << ",\"dataChannelLabel\":\"" << json_escape(snapshot.data_channel_label) << "\""
    << ",\"videoMid\":\"" << json_escape(snapshot.video_mid) << "\""
    << ",\"audioMid\":\"" << json_escape(snapshot.audio_mid) << "\""
    << ",\"videoCodec\":\"" << json_escape(snapshot.video_codec) << "\""
    << ",\"audioCodec\":\"" << json_escape(snapshot.audio_codec) << "\""
    << ",\"codecPath\":\"" << json_escape(snapshot.codec_path) << "\""
    << ",\"videoDecoderBackend\":\"" << json_escape(snapshot.video_decoder_backend) << "\""
    << ",\"videoSource\":\"" << json_escape(snapshot.video_source) << "\""
    << ",\"selectedLocalCandidate\":\"" << json_escape(snapshot.selected_local_candidate) << "\""
    << ",\"selectedRemoteCandidate\":\"" << json_escape(snapshot.selected_remote_candidate) << "\""
    << ",\"reason\":\"" << json_escape(snapshot.reason) << "\""
    << ",\"lastError\":\"" << json_escape(snapshot.last_error) << "\""
    << ",\"roundTripTimeMs\":";

  append_nullable_int64(payload, snapshot.round_trip_time_ms);
  payload << ",\"createdAtMs\":";
  append_nullable_int64(payload, snapshot.created_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  append_nullable_int64(payload, snapshot.updated_at_unix_ms);
  payload << ",\"lastVideoFrameAtMs\":";
  append_nullable_int64(payload, snapshot.last_video_frame_at_unix_ms);
  payload << ",\"lastRemoteVideoFrameAtMs\":";
  append_nullable_int64(payload, snapshot.last_remote_video_frame_at_unix_ms);
  payload << ",\"lastDecodedFrameAtMs\":";
  append_nullable_int64(payload, snapshot.last_decoded_frame_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string peer_media_binding_json(const PeerState::MediaBindingState& state) {
  std::ostringstream payload;
  payload
    << "{\"attached\":" << (state.attached ? "true" : "false")
    << ",\"senderConfigured\":" << (state.sender_configured ? "true" : "false")
    << ",\"active\":" << (state.active ? "true" : "false")
    << ",\"processId\":" << state.process_id
    << ",\"sourceFramesCaptured\":" << state.source_frames_captured
    << ",\"sourceBytesCaptured\":" << state.source_bytes_captured
    << ",\"avgSourceCopyResourceUs\":" << state.avg_source_copy_resource_us
    << ",\"avgSourceMapUs\":" << state.avg_source_map_us
    << ",\"avgSourceMemcpyUs\":" << state.avg_source_memcpy_us
    << ",\"avgSourceTotalReadbackUs\":" << state.avg_source_total_readback_us
    << ",\"framesSent\":" << state.frames_sent
    << ",\"bytesSent\":" << state.bytes_sent
    << ",\"width\":" << state.width
    << ",\"height\":" << state.height
    << ",\"frameRate\":" << state.frame_rate
    << ",\"bitrateKbps\":" << state.bitrate_kbps
    << ",\"kind\":\"" << json_escape(state.kind) << "\""
    << ",\"source\":\"" << json_escape(state.source) << "\""
    << ",\"codec\":\"" << json_escape(state.codec) << "\""
    << ",\"codecPath\":\"" << json_escape(state.codec) << "\""
    << ",\"videoEncoderBackend\":\"" << json_escape(state.video_encoder_backend) << "\""
    << ",\"implementation\":\"" << json_escape(state.implementation) << "\""
    << ",\"reason\":\"" << json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << json_escape(state.command_line) << "\""
    << ",\"attachedAtMs\":";
  append_nullable_int64(payload, state.attached_at_unix_ms);
  payload << ",\"updatedAtMs\":";
  append_nullable_int64(payload, state.updated_at_unix_ms);
  payload << ",\"detachedAtMs\":";
  append_nullable_int64(payload, state.detached_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string capabilities_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"platform\":\"win32\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"videoCodecs\":[\"h264\",\"h265\"]"
    << ",\"audioCodecs\":[\"opus\",\"pcmu\"]"
    << ",\"captureModes\":[\"window\",\"display\"]"
    << ",\"audioModes\":[\"process\",\"none\"]"
    << ",\"surfaceTargets\":[\"host-capture-artifact\",\"peer-video:<peerId>\"]"
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"peerMethods\":[\"createPeer\",\"closePeer\",\"setRemoteDescription\",\"addRemoteIceCandidate\",\"attachPeerMediaSource\",\"detachPeerMediaSource\",\"attachSurface\",\"updateSurface\",\"detachSurface\",\"setViewerVolume\",\"getViewerVolume\",\"getStats\"]"
    << ",\"implementation\":\"scaffold\""
    << ",\"ffmpeg\":" << ffmpeg_probe_json(state.ffmpeg)
    << "}";
  return payload.str();
}

std::string build_status_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"ready\":true"
    << ",\"state\":\"scaffold\""
    << ",\"implementation\":\"stub\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"peerCount\":" << state.peers.size()
    << ",\"surfaceCount\":" << state.attached_surfaces.size()
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"ffmpeg\":" << ffmpeg_probe_json(state.ffmpeg)
    << ",\"message\":\"Native media-agent control plane is running. libdatachannel transport is "
    << (state.peer_transport_backend.transport_ready ? "available" : "not available")
    << ", while native decode/render is still pending before the media plane can be considered ready.\"}";
  return payload.str();
}

std::string build_agent_ready_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << json_escape(VDS_MEDIA_AGENT_NAME) << "\""
    << ",\"version\":\"" << json_escape(VDS_MEDIA_AGENT_VERSION) << "\""
    << ",\"implementation\":\"stub\""
    << ",\"transport\":\"native-webrtc\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerDriverReady\":true"
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"wgcCapture\":" << wgc_capture_probe_json(state.wgc_capture_backend)
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"ffmpeg\":" << ffmpeg_probe_json(state.ffmpeg)
    << "}";
  return payload.str();
}

std::string peer_video_receiver_runtime_json(const std::shared_ptr<PeerState::PeerVideoReceiverRuntime>& runtime) {
  if (!runtime) {
    return "null";
  }

  refresh_peer_video_receiver_runtime(*runtime);
  std::lock_guard<std::mutex> lock(runtime->mutex);

  std::ostringstream payload;
  payload
    << "{\"surfaceAttached\":" << (runtime->surface_attached ? "true" : "false")
    << ",\"running\":" << (runtime->running ? "true" : "false")
    << ",\"decoderReady\":" << (runtime->decoder_ready ? "true" : "false")
    << ",\"remoteFramesReceived\":" << runtime->remote_frames_received
    << ",\"remoteBytesReceived\":" << runtime->remote_bytes_received
    << ",\"scheduledVideoUnits\":" << runtime->scheduled_video_units
    << ",\"scheduledAudioBlocks\":" << runtime->scheduled_audio_blocks
    << ",\"submittedVideoUnits\":" << runtime->submitted_video_units
    << ",\"dispatchedAudioBlocks\":" << runtime->dispatched_audio_blocks
    << ",\"droppedVideoUnits\":" << runtime->dropped_video_units
    << ",\"droppedAudioBlocks\":" << runtime->dropped_audio_blocks
    << ",\"queuedVideoUnits\":" << runtime->scheduled_video_queue.size()
    << ",\"queuedAudioBlocks\":" << runtime->scheduled_audio_queue.size()
    << ",\"avSyncRunning\":" << (runtime->av_sync_running ? "true" : "false")
    << ",\"avSyncAnchorInitialized\":" << (runtime->av_sync_anchor_initialized ? "true" : "false")
    << ",\"targetLatencyMs\":" << (runtime->av_sync_target_latency_us / 1000)
    << ",\"lastVideoLatenessMs\":" << (runtime->av_sync_last_video_lateness_us / 1000.0)
    << ",\"lastAudioLatenessMs\":" << (runtime->av_sync_last_audio_lateness_us / 1000.0)
    << ",\"codecPath\":\"" << json_escape(runtime->codec_path) << "\""
    << ",\"reason\":\"" << json_escape(runtime->reason) << "\""
    << ",\"lastError\":\"" << json_escape(runtime->last_error) << "\""
    << ",\"surface\":\"" << json_escape(runtime->surface_id) << "\""
    << ",\"target\":\"" << json_escape(runtime->target) << "\""
    << "}";
  return payload.str();
}

std::string relay_subscriber_runtime_json(const std::string& peer_id) {
  RelaySubscriberState relay_state;
  if (!query_relay_subscriber_state(peer_id, &relay_state)) {
    return "null";
  }

  std::ostringstream payload;
  payload
    << "{\"upstreamPeerId\":\"" << json_escape(relay_state.upstream_peer_id) << "\""
    << ",\"audioEnabled\":" << (relay_state.audio_enabled ? "true" : "false")
    << ",\"pendingVideoBootstrap\":" << (relay_state.pending_video_bootstrap ? "true" : "false")
    << ",\"bootstrapSnapshotSent\":" << (relay_state.bootstrap_snapshot_sent ? "true" : "false")
    << ",\"framesSent\":" << relay_state.frames_sent
    << ",\"bytesSent\":" << relay_state.bytes_sent
    << ",\"lastVideoTimestampUs\":" << relay_state.last_video_timestamp_us
    << ",\"reason\":\"" << json_escape(relay_state.reason) << "\""
    << ",\"lastError\":\"" << json_escape(relay_state.last_error) << "\""
    << ",\"updatedAtMs\":";
  append_nullable_int64(payload, relay_state.updated_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string build_peer_state_json(const PeerState& peer, const std::string& state) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << json_escape(peer.peer_id) << "\""
    << ",\"role\":\"" << json_escape(peer.role) << "\""
    << ",\"initiator\":" << (peer.initiator ? "true" : "false")
    << ",\"state\":\"" << json_escape(state) << "\""
    << ",\"driver\":\"" << json_escape(peer.transport.transport_ready ? "libdatachannel-native-webrtc" : "stub-native-media-agent") << "\""
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
    << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
    << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
    << ",\"relaySubscriberRuntime\":" << relay_subscriber_runtime_json(peer.peer_id)
    << "}";
  return payload.str();
}

std::string build_host_session_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"running\":" << (state.host_session_running ? "true" : "false")
    << ",\"captureTargetId\":\"" << json_escape(state.host_capture_target_id) << "\""
    << ",\"requestedCodec\":\"" << json_escape(state.host_requested_codec) << "\""
    << ",\"codec\":\"" << json_escape(state.host_codec) << "\""
    << ",\"effectiveCodec\":\"" << json_escape(state.host_codec) << "\""
    << ",\"downgradeReason\":\"\""
    << ",\"pipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"capturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"captureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"captureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"implementation\":\"stub\"}";
  return payload.str();
}

std::string build_peer_result_json(const PeerState& peer) {
  std::ostringstream payload;
  payload
    << "{\"peerId\":\"" << json_escape(peer.peer_id) << "\""
    << ",\"role\":\"" << json_escape(peer.role) << "\""
    << ",\"initiator\":" << (peer.initiator ? "true" : "false")
    << ",\"transportReady\":" << (peer.transport.transport_ready ? "true" : "false")
    << ",\"implementation\":\"" << json_escape(peer.transport.transport_ready ? "libdatachannel" : "stub") << "\""
    << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
    << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
    << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
    << "}";
  return payload.str();
}

std::string surface_attachment_json(SurfaceAttachmentState& state) {
  if (is_peer_video_surface_target(state.target)) {
    sync_surface_attachment_from_peer_runtime(state, state.peer_runtime);
  } else {
    refresh_surface_attachment_state(state);
  }

  NativeLivePreviewSnapshot live_preview_snapshot;
  const bool has_live_preview_snapshot = static_cast<bool>(state.live_preview_runtime);
  if (has_live_preview_snapshot) {
    live_preview_snapshot = state.live_preview_runtime->snapshot();
  }

  std::ostringstream payload;
  payload
    << "{\"attached\":" << (state.attached ? "true" : "false")
    << ",\"launchAttempted\":" << (state.launch_attempted ? "true" : "false")
    << ",\"running\":" << (state.running ? "true" : "false")
    << ",\"waitingForArtifact\":" << (state.waiting_for_artifact ? "true" : "false")
    << ",\"decoderReady\":" << (state.decoder_ready ? "true" : "false")
    << ",\"restartCount\":" << state.restart_count
    << ",\"decodedFramesRendered\":" << state.decoded_frames_rendered
    << ",\"frameIntervalStddevMs\":" << state.frame_interval_stddev_ms
    << ",\"avgCopyResourceUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_copy_resource_us : 0)
    << ",\"avgMapUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_map_us : 0)
    << ",\"avgMemcpyUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_memcpy_us : 0)
    << ",\"avgTotalReadbackUs\":" << (has_live_preview_snapshot ? live_preview_snapshot.avg_total_readback_us : 0)
    << ",\"surface\":\"" << json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << json_escape(state.target) << "\""
    << ",\"processId\":" << state.process_id
    << ",\"lastExitCode\":";

  if (state.last_exit_code == std::numeric_limits<int>::min()) {
    payload << "null";
  } else {
    payload << state.last_exit_code;
  }

  payload
    << ",\"previewSurfaceBackend\":\"" << json_escape(state.preview_surface_backend) << "\""
    << ",\"decoderBackend\":\"" << json_escape(state.decoder_backend) << "\""
    << ",\"codecPath\":\"" << json_escape(state.codec_path) << "\""
    << ",\"implementation\":\"" << json_escape(state.implementation) << "\""
    << ",\"layout\":" << surface_layout_json(state.surface_layout)
    << ",\"mediaPath\":\"" << json_escape(state.media_path) << "\""
    << ",\"manifestPath\":\"" << json_escape(state.manifest_path) << "\""
    << ",\"windowTitle\":\"" << json_escape(state.window_title) << "\""
    << ",\"embeddedParentDebug\":\"" << json_escape(state.embedded_parent_debug) << "\""
    << ",\"surfaceWindowDebug\":\"" << json_escape(state.surface_window_debug) << "\""
    << ",\"reason\":\"" << json_escape(state.reason) << "\""
    << ",\"lastError\":\"" << json_escape(state.last_error) << "\""
    << ",\"commandLine\":\"" << json_escape(state.command_line) << "\""
    << ",\"lastStartAttemptAtMs\":";
  append_nullable_int64(payload, state.last_start_attempt_at_unix_ms);
  payload << ",\"lastStartSuccessAtMs\":";
  append_nullable_int64(payload, state.last_start_success_at_unix_ms);
  payload << ",\"lastStopAtMs\":";
  append_nullable_int64(payload, state.last_stop_at_unix_ms);
  payload << ",\"lastDecodedFrameAtMs\":";
  append_nullable_int64(payload, state.last_decoded_frame_at_unix_ms);
  payload << "}";
  return payload.str();
}

std::string build_surface_result_json(SurfaceAttachmentState& state) {
  std::ostringstream payload;
  payload
    << "{\"surface\":\"" << json_escape(state.surface_id) << "\""
    << ",\"target\":\"" << json_escape(state.target) << "\""
    << ",\"attachment\":" << surface_attachment_json(state)
    << ",\"implementation\":\"" << json_escape(state.implementation) << "\"}";
  return payload.str();
}

std::string build_surface_attachments_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload << "[";
  bool first = true;
  for (auto& entry : state.attached_surfaces) {
    if (!first) {
      payload << ",";
    }
    first = false;
    payload << surface_attachment_json(entry.second);
  }
  payload << "]";
  return payload.str();
}

std::string build_stats_json(AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"implementation\":\"stub\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"peerTransport\":" << peer_transport_backend_json(state.peer_transport_backend)
    << ",\"hostSessionRunning\":" << (state.host_session_running ? "true" : "false")
    << ",\"audioBackend\":" << audio_session_json(state.audio_session)
    << ",\"viewerAudioPlayback\":" << viewer_audio_playback_json(state.viewer_audio_playback)
    << ",\"hostPipeline\":" << host_pipeline_json(state.host_pipeline)
    << ",\"hostCapturePlan\":" << host_capture_plan_json(state.host_capture_plan)
    << ",\"hostCaptureProcess\":" << host_capture_process_json(state.host_capture_process)
    << ",\"hostCaptureArtifact\":" << host_capture_artifact_json(state.host_capture_artifact)
    << ",\"ffmpeg\":" << ffmpeg_probe_json(state.ffmpeg)
    << ",\"surfaces\":" << build_surface_attachments_json(state)
    << ",\"peers\":[";

  bool first = true;
  for (const auto& entry : state.peers) {
    if (!first) {
      payload << ",";
    }
    first = false;

    const PeerState& peer = entry.second;
    payload
      << "{\"peerId\":\"" << json_escape(peer.peer_id) << "\""
      << ",\"role\":\"" << json_escape(peer.role) << "\""
      << ",\"initiator\":" << (peer.initiator ? "true" : "false")
      << ",\"remoteDescription\":" << (peer.has_remote_description ? "true" : "false")
      << ",\"remoteCandidateCount\":" << peer.remote_candidate_count
      << ",\"mediaBinding\":" << peer_media_binding_json(peer.media_binding)
      << ",\"peerTransport\":" << peer_transport_snapshot_json(peer.transport)
      << ",\"receiverRuntime\":" << peer_video_receiver_runtime_json(peer.receiver_runtime)
      << ",\"relaySubscriberRuntime\":" << relay_subscriber_runtime_json(peer.peer_id)
      << "}";
  }

  payload << "]}";
  return payload.str();
}

}  // namespace

int main(int argc, char* argv[]) {
  std::ios::sync_with_stdio(false);
  set_wasapi_event_callback(emit_wasapi_backend_event);
  set_wasapi_pcm_packet_callback(emit_wasapi_pcm_packet);

  AgentRuntimeState runtime_state;
  g_agent_runtime_for_audio = &runtime_state;
  runtime_state.peer_transport_backend = get_peer_transport_backend_info();
  const std::string agent_binary_path = argc > 0 && argv[0] ? argv[0] : "";
  runtime_state.ffmpeg = probe_ffmpeg(agent_binary_path);
  runtime_state.wgc_capture_backend = probe_wgc_capture_backend();
  runtime_state.audio_backend_probe = build_audio_backend_probe(probe_wasapi_backend());
  runtime_state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
  runtime_state.host_capture_process = build_host_capture_process_state();
  runtime_state.host_pipeline = select_and_validate_host_pipeline(
    runtime_state.ffmpeg,
    runtime_state.host_codec,
    runtime_state.host_hardware_acceleration,
    runtime_state.host_video_encoder_preference,
    runtime_state.host_encoder_preset,
    runtime_state.host_encoder_tune
  );
  runtime_state.host_capture_plan = build_host_capture_plan(
    runtime_state.ffmpeg,
    runtime_state.wgc_capture_backend,
    runtime_state.host_pipeline,
    runtime_state.host_capture_process,
    runtime_state.host_capture_kind,
    runtime_state.host_capture_state,
    runtime_state.host_capture_title,
    runtime_state.host_capture_hwnd,
    runtime_state.host_capture_display_id,
    runtime_state.host_width,
    runtime_state.host_height,
    runtime_state.host_frame_rate,
    runtime_state.host_bitrate_kbps
  );
  runtime_state.host_capture_plan = validate_host_capture_plan(runtime_state.ffmpeg, runtime_state.host_capture_plan);
  refresh_host_capture_runtime(runtime_state);

  emit_event("agent-ready", build_agent_ready_json(runtime_state));

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    const int id = extract_id(line);
    const std::string method = extract_method(line);
    if (id < 0 || method.empty()) {
      write_json_line(build_error_payload(id < 0 ? 0 : id, "BAD_REQUEST", "Invalid JSON-RPC payload"));
      continue;
    }

    if (method == "ping") {
      write_json_line(build_result_payload(id, R"json({"ok":true,"name":"vds-media-agent","implementation":"stub"})json"));
      continue;
    }

    if (method == "getStatus") {
      runtime_state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
      refresh_host_capture_runtime(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      perform_host_video_sender_soft_refresh(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      write_json_line(build_result_payload(id, build_status_json(runtime_state)));
      continue;
    }

    if (method == "getCapabilities") {
      runtime_state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
      refresh_host_capture_runtime(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      perform_host_video_sender_soft_refresh(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      write_json_line(build_result_payload(id, capabilities_json(runtime_state)));
      continue;
    }

    if (method == "listCaptureTargets") {
      write_json_line(build_result_payload(id, "[]"));
      continue;
    }

    if (method == "getAudioBackendStatus") {
      runtime_state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
      write_json_line(build_result_payload(id, audio_session_json(runtime_state.audio_session)));
      continue;
    }

    if (method == "startAudioSession") {
      const int pid = extract_int_value(line, "pid", 0);
      const std::string process_name = extract_string_value(line, "processName");
      runtime_state.audio_session = build_audio_session_state(start_wasapi_process_loopback_session(pid, process_name));
      refresh_host_audio_senders(runtime_state);

      emit_event(
        "media-state",
        std::string("{\"state\":\"audio-session-started\",\"pid\":") +
          std::to_string(runtime_state.audio_session.pid) +
          ",\"processName\":\"" + json_escape(runtime_state.audio_session.process_name) +
          "\",\"backendMode\":\"" + json_escape(runtime_state.audio_session.backend_mode) +
          "\",\"implementation\":\"" + json_escape(runtime_state.audio_session.implementation) +
          "\",\"reason\":\"" + json_escape(runtime_state.audio_session.reason) +
          "\",\"ready\":" + (runtime_state.audio_session.ready ? "true" : "false") +
          ",\"captureActive\":" + (runtime_state.audio_session.capture_active ? "true" : "false") +
          ",\"sampleRate\":" + std::to_string(runtime_state.audio_session.sample_rate) +
          ",\"channelCount\":" + std::to_string(runtime_state.audio_session.channel_count) +
          ",\"packetsCaptured\":" + std::to_string(runtime_state.audio_session.packets_captured) +
          ",\"transportReady\":" + std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      if (runtime_state.audio_session.capture_active && !runtime_state.audio_session.ready) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"audio\",\"message\":\"WASAPI process-loopback capture started, but the native audio session is not ready for transport. The stream will fall back to video-only sharing.\",\"backendMode\":\"") +
            json_escape(runtime_state.audio_session.backend_mode) + "\"}"
        );
      } else if (!runtime_state.audio_session.last_error.empty()) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"audio\",\"message\":\"") +
            json_escape(runtime_state.audio_session.last_error) +
            "\",\"backendMode\":\"" + json_escape(runtime_state.audio_session.backend_mode) + "\"}"
        );
      }
      write_json_line(build_result_payload(id, audio_session_json(runtime_state.audio_session)));
      continue;
    }

    if (method == "stopAudioSession") {
      runtime_state.audio_session = build_audio_session_state(stop_wasapi_process_loopback_session());
      reset_host_audio_transport_sessions();
      refresh_host_audio_senders(runtime_state);
      emit_event(
        "media-state",
        std::string("{\"state\":\"audio-session-stopped\",\"backendMode\":\"") +
          json_escape(runtime_state.audio_session.backend_mode) +
          "\",\"implementation\":\"" + json_escape(runtime_state.audio_session.implementation) +
          "\",\"reason\":\"" + json_escape(runtime_state.audio_session.reason) +
          "\",\"ready\":" + (runtime_state.audio_session.ready ? "true" : "false") +
          ",\"captureActive\":" + (runtime_state.audio_session.capture_active ? "true" : "false") +
          ",\"transportReady\":" + std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      write_json_line(build_result_payload(id, audio_session_json(runtime_state.audio_session)));
      continue;
    }

    if (method == "startHostSession") {
      emit_breadcrumb("startHostSession:begin");
      stop_all_surface_attachments(runtime_state, "host-session-restart");
      emit_breadcrumb("startHostSession:after-stop-all-surfaces");
      stop_host_capture_process(
        runtime_state.host_capture_process,
        runtime_state.host_pipeline,
        runtime_state.host_capture_plan,
        runtime_state.host_capture_artifact,
        "host-session-restart"
      );
      emit_breadcrumb("startHostSession:after-stop-host-capture-process");
      runtime_state.host_session_running = true;
      runtime_state.host_capture_target_id = extract_string_value(line, "captureTargetId");
      runtime_state.host_capture_source_id = extract_string_value(line, "sourceId");
      runtime_state.host_capture_kind = extract_string_value(line, "captureKind");
      runtime_state.host_capture_state = extract_string_value(line, "captureState");
      runtime_state.host_capture_title = extract_string_value(line, "captureTitle");
      runtime_state.host_capture_hwnd = extract_string_value(line, "captureHwnd");
      runtime_state.host_capture_display_id = extract_string_value(line, "displayId");
      runtime_state.host_window_restore_placeholder_active = false;
      runtime_state.host_video_sender_refresh_requested = false;
      runtime_state.host_video_sender_refresh_reason.clear();
      runtime_state.host_requested_codec = normalize_video_codec(
        extract_string_value(line, "requestedCodec"),
        normalize_video_codec(extract_string_value(line, "codec"))
      );
      runtime_state.host_codec = runtime_state.host_requested_codec;
      runtime_state.host_hardware_acceleration = extract_bool_value(line, "hardwareAcceleration", true);
      runtime_state.host_video_encoder_preference = normalize_video_encoder_preference(
        extract_string_value(line, "videoEncoderPreference")
      );
      runtime_state.host_encoder_preset = normalize_host_encoder_preset(extract_string_value(line, "encoderPreset"));
      runtime_state.host_encoder_tune = normalize_host_encoder_tune(extract_string_value(line, "encoderTune"));
      runtime_state.host_width = normalize_host_output_dimension(
        extract_int_value(line, "width", 1920),
        1920
      );
      runtime_state.host_height = normalize_host_output_dimension(
        extract_int_value(line, "height", 1080),
        1080
      );
      runtime_state.host_frame_rate = extract_int_value(line, "frameRate", 60);
      runtime_state.host_bitrate_kbps = extract_int_value(line, "bitrateKbps", 10000);
      if (runtime_state.host_capture_kind.empty()) {
        runtime_state.host_capture_kind =
          runtime_state.host_capture_target_id.rfind("screen:", 0) == 0 ? "display" : "window";
      }
      if (runtime_state.host_capture_state.empty()) {
        runtime_state.host_capture_state = runtime_state.host_capture_kind == "display" ? "display" : "normal";
      }
      runtime_state.host_window_restore_placeholder_active =
        runtime_state.host_capture_kind == "window" &&
        runtime_state.host_capture_state == "minimized";
      if (runtime_state.host_codec.empty()) {
        runtime_state.host_codec = "h264";
      }
      if (runtime_state.host_requested_codec.empty()) {
        runtime_state.host_requested_codec = runtime_state.host_codec;
      }
      runtime_state.host_capture_process = build_host_capture_process_state();
      emit_breadcrumb(
        std::string("startHostSession:config-applied target=") +
        runtime_state.host_capture_target_id +
        " codec=" + runtime_state.host_codec +
        " size=" + std::to_string(runtime_state.host_width) + "x" + std::to_string(runtime_state.host_height) +
        " fps=" + std::to_string(runtime_state.host_frame_rate)
      );
      runtime_state.host_pipeline = select_and_validate_host_pipeline(
        runtime_state.ffmpeg,
        runtime_state.host_codec,
        runtime_state.host_hardware_acceleration,
        runtime_state.host_video_encoder_preference,
        runtime_state.host_encoder_preset,
        runtime_state.host_encoder_tune
      );
      emit_breadcrumb("startHostSession:after-select-pipeline");
      runtime_state.host_capture_plan = build_host_capture_plan(
        runtime_state.ffmpeg,
        runtime_state.wgc_capture_backend,
        runtime_state.host_pipeline,
        runtime_state.host_capture_process,
        runtime_state.host_capture_kind,
        runtime_state.host_capture_state,
        runtime_state.host_capture_title,
        runtime_state.host_capture_hwnd,
        runtime_state.host_capture_display_id,
        runtime_state.host_width,
        runtime_state.host_height,
        runtime_state.host_frame_rate,
        runtime_state.host_bitrate_kbps
      );
      emit_breadcrumb("startHostSession:after-build-capture-plan");
      runtime_state.host_capture_plan = validate_host_capture_plan(runtime_state.ffmpeg, runtime_state.host_capture_plan);
      emit_breadcrumb("startHostSession:after-validate-capture-plan");
      runtime_state.host_capture_process = start_host_capture_process(
        runtime_state.ffmpeg,
        runtime_state.host_pipeline,
        runtime_state.host_capture_plan,
        runtime_state.host_capture_process
      );
      emit_breadcrumb("startHostSession:after-start-host-capture-process");
      refresh_host_capture_runtime(runtime_state);
      emit_breadcrumb("startHostSession:after-refresh-host-capture-runtime");
      restart_host_capture_surface_attachments(runtime_state);
      emit_breadcrumb("startHostSession:after-restart-surface-attachments");
      for (auto& entry : runtime_state.peers) {
        PeerState& peer = entry.second;
        if (peer.role != "host-downstream") {
          continue;
        }

        std::string attach_error;
        if (!attach_host_video_media_binding(runtime_state, peer, &attach_error)) {
          peer.media_binding.attached = false;
          peer.media_binding.sender_configured = false;
          peer.media_binding.active = false;
          peer.media_binding.reason = "peer-media-attach-failed";
          peer.media_binding.last_error = attach_error;
          peer.media_binding.updated_at_unix_ms = current_time_millis();
        } else if (peer.initiator && peer.transport_session) {
          std::string negotiate_error;
          if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
            peer.transport = get_peer_transport_snapshot(peer.transport_session);
            peer.transport.last_error = negotiate_error;
            peer.transport.reason = "peer-local-description-failed";
            peer.media_binding.reason = "peer-local-description-failed";
            peer.media_binding.last_error = negotiate_error;
            peer.media_binding.updated_at_unix_ms = current_time_millis();
          }
        } else {
          emit_event("peer-state", build_peer_state_json(peer, "media-source-attached"));
        }
      }
      emit_breadcrumb("startHostSession:before-result");

      emit_event(
        "media-state",
        std::string("{\"state\":\"host-session-started\",\"captureTargetId\":\"") +
          json_escape(runtime_state.host_capture_target_id) +
          "\",\"requestedCodec\":\"" + json_escape(runtime_state.host_requested_codec) +
          "\",\"codec\":\"" + json_escape(runtime_state.host_codec) +
          "\",\"effectiveCodec\":\"" + json_escape(runtime_state.host_codec) +
          "\",\"downgradeReason\":\"" +
          "\",\"pipeline\":" + host_pipeline_json(runtime_state.host_pipeline) +
          ",\"capturePlan\":" + host_capture_plan_json(runtime_state.host_capture_plan) +
          ",\"captureProcess\":" + host_capture_process_json(runtime_state.host_capture_process) +
          ",\"implementation\":\"stub\",\"transportReady\":" +
          std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      if ((!runtime_state.host_capture_plan.ready || !runtime_state.host_capture_plan.validated) &&
          !runtime_state.host_capture_plan.last_error.empty()) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"host-capture\",\"message\":\"") +
            json_escape(runtime_state.host_capture_plan.last_error) +
            "\",\"reason\":\"" + json_escape(runtime_state.host_capture_plan.reason) + "\"}"
        );
      }
      if (runtime_state.host_capture_process.enabled &&
          !runtime_state.host_capture_process.running &&
          !runtime_state.host_capture_process.last_error.empty()) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"host-capture-process\",\"message\":\"") +
            json_escape(runtime_state.host_capture_process.last_error) +
            "\",\"reason\":\"" + json_escape(runtime_state.host_capture_process.reason) + "\"}"
        );
      }
      write_json_line(build_result_payload(id, build_host_session_json(runtime_state)));
      continue;
    }

    if (method == "stopHostSession") {
      emit_breadcrumb("stopHostSession:begin");
      stop_all_surface_attachments(runtime_state, "host-session-stopped");
      emit_breadcrumb("stopHostSession:after-stop-all-surfaces");
      for (auto& entry : runtime_state.peers) {
        PeerState& peer = entry.second;
        if (peer.role == "host-downstream") {
          std::string detach_error;
          if (!detach_peer_media_binding(peer, &detach_error)) {
            peer.media_binding.reason = "peer-media-detach-failed";
            peer.media_binding.last_error = detach_error;
            peer.media_binding.updated_at_unix_ms = current_time_millis();
          } else if (peer.initiator && peer.transport_session) {
            std::string negotiate_error;
            if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
              peer.transport = get_peer_transport_snapshot(peer.transport_session);
              peer.transport.last_error = negotiate_error;
              peer.transport.reason = "peer-local-description-failed";
              peer.media_binding.reason = "peer-local-description-failed";
              peer.media_binding.last_error = negotiate_error;
              peer.media_binding.updated_at_unix_ms = current_time_millis();
            }
          }
        }
      }
      emit_breadcrumb("stopHostSession:after-detach-host-downstream-peers");
      stop_host_capture_process(
        runtime_state.host_capture_process,
        runtime_state.host_pipeline,
        runtime_state.host_capture_plan,
        runtime_state.host_capture_artifact,
        "host-session-stopped"
      );
      emit_breadcrumb("stopHostSession:after-stop-host-capture-process");
      runtime_state.host_session_running = false;
      runtime_state.host_capture_target_id.clear();
      runtime_state.host_capture_source_id.clear();
      runtime_state.host_capture_title.clear();
      runtime_state.host_capture_hwnd.clear();
      runtime_state.host_capture_display_id.clear();
      runtime_state.host_window_restore_placeholder_active = false;
      runtime_state.host_video_sender_refresh_requested = false;
      runtime_state.host_video_sender_refresh_reason.clear();
      runtime_state.host_requested_codec = "h264";
      runtime_state.host_codec = "h264";
      runtime_state.host_hardware_acceleration = true;
      runtime_state.host_encoder_preset = "balanced";
      runtime_state.host_encoder_tune.clear();
      runtime_state.host_capture_kind = "window";
      runtime_state.host_capture_state = "normal";
      runtime_state.host_width = 1920;
      runtime_state.host_height = 1080;
      runtime_state.host_frame_rate = 60;
      runtime_state.host_bitrate_kbps = 10000;
      runtime_state.host_pipeline = select_and_validate_host_pipeline(
        runtime_state.ffmpeg,
        runtime_state.host_codec,
        runtime_state.host_hardware_acceleration,
        runtime_state.host_video_encoder_preference,
        runtime_state.host_encoder_preset,
        runtime_state.host_encoder_tune
      );
      runtime_state.host_capture_plan = build_host_capture_plan(
        runtime_state.ffmpeg,
        runtime_state.wgc_capture_backend,
        runtime_state.host_pipeline,
        runtime_state.host_capture_process,
        runtime_state.host_capture_kind,
        runtime_state.host_capture_state,
        runtime_state.host_capture_title,
        runtime_state.host_capture_hwnd,
        runtime_state.host_capture_display_id,
        runtime_state.host_width,
        runtime_state.host_height,
        runtime_state.host_frame_rate,
        runtime_state.host_bitrate_kbps
      );
      runtime_state.host_capture_plan = validate_host_capture_plan(runtime_state.ffmpeg, runtime_state.host_capture_plan);
      emit_breadcrumb("stopHostSession:before-result");
      emit_event(
        "media-state",
        std::string("{\"state\":\"host-session-stopped\",\"captureProcess\":") +
          host_capture_process_json(runtime_state.host_capture_process) +
          ",\"implementation\":\"stub\",\"transportReady\":" +
          std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      write_json_line(build_result_payload(id, build_host_session_json(runtime_state)));
      continue;
    }

    if (method == "createPeer") {
      PeerState peer;
      peer.peer_id = extract_string_value(line, "peerId");
      peer.role = extract_string_value(line, "role");
      peer.initiator = extract_bool_value(line, "initiator");
      emit_breadcrumb(
        std::string("createPeer:begin peer=") + peer.peer_id +
        " role=" + peer.role +
        " initiator=" + (peer.initiator ? "true" : "false"));
      if (peer.peer_id.empty()) {
        write_json_line(build_error_payload(id, "BAD_REQUEST", "peerId is required"));
        continue;
      }

      peer.transport.available = runtime_state.peer_transport_backend.available;
      peer.transport.transport_ready = runtime_state.peer_transport_backend.transport_ready;
      peer.transport.reason = runtime_state.peer_transport_backend.reason;
      peer.receiver_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime>();
      peer.receiver_runtime->peer_id = peer.peer_id;
      peer.receiver_runtime->local_playback_enabled = peer.role == "viewer-upstream";
      peer.receiver_runtime->passthrough_playback_enabled =
        peer.receiver_runtime->local_playback_enabled &&
        runtime_state.viewer_playback_mode == "passthrough";

      if (runtime_state.peer_transport_backend.transport_ready) {
        auto receiver_runtime = peer.receiver_runtime;
        auto transport_session_holder = std::make_shared<std::weak_ptr<PeerTransportSession>>();
        PeerTransportCallbacks callbacks;
        callbacks.on_local_description = [peer_id = peer.peer_id](const std::string& type, const std::string& sdp) {
          emit_event(
            "signal",
            std::string("{\"peerId\":\"") + json_escape(peer_id) +
              "\",\"targetId\":\"" + json_escape(peer_id) +
              "\",\"type\":\"" + json_escape(type) +
              "\",\"sdp\":{\"type\":\"" + json_escape(type) +
              "\",\"sdp\":\"" + json_escape(sdp) +
              "\"},\"transportReady\":true}"
          );
        };
        callbacks.on_local_candidate = [peer_id = peer.peer_id](const std::string& candidate, const std::string& sdp_mid) {
          emit_event(
            "signal",
            std::string("{\"peerId\":\"") + json_escape(peer_id) +
              "\",\"targetId\":\"" + json_escape(peer_id) +
              "\",\"type\":\"candidate\",\"candidate\":{\"candidate\":\"" + json_escape(candidate) +
              "\",\"sdpMid\":\"" + json_escape(sdp_mid) +
              "\",\"sdpMLineIndex\":0},\"transportReady\":true}"
          );
        };
        callbacks.on_state_change = [
          peer_id = peer.peer_id,
          role = peer.role,
          initiator = peer.initiator
        ](const PeerTransportSnapshot& snapshot, const std::string& logical_state) {
          PeerState event_peer;
          event_peer.peer_id = peer_id;
          event_peer.role = role;
          event_peer.initiator = initiator;
          event_peer.transport = snapshot;
          emit_event("peer-state", build_peer_state_json(event_peer, logical_state));
        };
        callbacks.on_warning = [peer_id = peer.peer_id](const std::string& message) {
          emit_event(
            "warning",
            std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer_id) +
              "\",\"message\":\"" + json_escape(message) + "\"}"
          );
        };
        callbacks.on_remote_video_frame = [
          peer_id = peer.peer_id,
          receiver_runtime,
          transport_session_holder
        ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
          consume_remote_peer_video_frame(
            peer_id,
            receiver_runtime,
            transport_session_holder->lock(),
            frame,
            codec,
            rtp_timestamp
          );
        };
        callbacks.on_remote_audio_frame = [
          &runtime_state,
          peer_id = peer.peer_id,
          receiver_runtime
        ](const std::vector<std::uint8_t>& frame, const std::string& codec, std::uint32_t rtp_timestamp) {
          consume_remote_peer_audio_frame(runtime_state.viewer_audio_playback, peer_id, receiver_runtime, frame, codec, rtp_timestamp);
        };

        std::string peer_create_error;
        peer.transport_session = create_peer_transport_session(peer.peer_id, peer.initiator, callbacks, &peer_create_error);
        *transport_session_holder = peer.transport_session;
        if (peer.transport_session) {
          peer.transport = get_peer_transport_snapshot(peer.transport_session);
          emit_breadcrumb(std::string("createPeer:after-create-transport peer=") + peer.peer_id);
        } else {
          peer.transport.transport_ready = false;
          peer.transport.reason = "peer-create-failed";
          peer.transport.last_error = peer_create_error;
        }
      }

      if (peer.transport_session && peer.role == "host-downstream" && runtime_state.host_session_running) {
        std::string attach_error;
        if (!attach_host_video_media_binding(runtime_state, peer, &attach_error)) {
          peer.media_binding.attached = false;
          peer.media_binding.sender_configured = false;
          peer.media_binding.active = false;
          peer.media_binding.reason = "peer-media-attach-failed";
          peer.media_binding.last_error = attach_error;
          peer.media_binding.updated_at_unix_ms = current_time_millis();
        }
      }

      const bool should_negotiate_immediately =
        peer.transport_session &&
        peer.initiator &&
        (peer.role != "host-downstream" || peer.media_binding.attached);

      if (should_negotiate_immediately) {
        std::string negotiate_error;
        if (!ensure_peer_transport_local_description(peer.transport_session, &negotiate_error)) {
          peer.transport = get_peer_transport_snapshot(peer.transport_session);
          peer.transport.last_error = negotiate_error;
          peer.transport.reason = "peer-local-description-failed";
          if (peer.media_binding.reason == "peer-media-not-attached") {
            peer.media_binding.reason = "peer-local-description-failed";
            peer.media_binding.last_error = negotiate_error;
            peer.media_binding.updated_at_unix_ms = current_time_millis();
          }
        }
      }

      runtime_state.peers[peer.peer_id] = peer;
      refresh_peer_transport_runtime(runtime_state);
      emit_event("peer-state", build_peer_state_json(peer, "created"));
      if (!peer.transport.transport_ready && !peer.transport.last_error.empty()) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"peer\",\"peerId\":\"") + json_escape(peer.peer_id) +
            "\",\"message\":\"" + json_escape(peer.transport.last_error) + "\"}"
        );
      }
      emit_breadcrumb(std::string("createPeer:before-result peer=") + peer.peer_id);
      write_json_line(build_result_payload(id, build_peer_result_json(runtime_state.peers[peer.peer_id])));
      continue;
    }

    if (method == "closePeer") {
      const std::string peer_id = extract_string_value(line, "peerId");
      emit_breadcrumb(std::string("closePeer:begin peer=") + peer_id);
      auto it = runtime_state.peers.find(peer_id);
      if (it != runtime_state.peers.end()) {
        for (auto surface_it = runtime_state.attached_surfaces.begin(); surface_it != runtime_state.attached_surfaces.end();) {
          if (surface_it->second.peer_id == peer_id) {
            if (surface_it->second.peer_runtime) {
              stop_peer_video_surface_attachment(*surface_it->second.peer_runtime, "peer-closed");
            } else {
              stop_surface_attachment(surface_it->second, "peer-closed");
            }
            surface_it = runtime_state.attached_surfaces.erase(surface_it);
            continue;
          }
          ++surface_it;
        }
        emit_breadcrumb(std::string("closePeer:after-stop-surfaces peer=") + peer_id);

        std::string detach_error;
        if (!prepare_peer_media_binding_for_transport_close(it->second, &detach_error)) {
          it->second.media_binding.reason = "peer-media-close-prepare-failed";
          it->second.media_binding.last_error = detach_error;
        }
        emit_breadcrumb(std::string("closePeer:after-prepare-media-binding peer=") + peer_id);
        if (it->second.receiver_runtime) {
          begin_close_peer_video_receiver_runtime(*it->second.receiver_runtime);
        }
        emit_breadcrumb(std::string("closePeer:after-begin-close-receiver-runtime peer=") + peer_id);
        close_peer_transport_session(it->second.transport_session);
        emit_breadcrumb(std::string("closePeer:after-close-transport-session peer=") + peer_id);
        if (it->second.receiver_runtime) {
          close_peer_video_receiver_handles(*it->second.receiver_runtime);
        }
        emit_breadcrumb(std::string("closePeer:after-close-receiver-handles peer=") + peer_id);
        if (it->second.role == "viewer-upstream") {
          clear_relay_upstream_bootstrap_state(peer_id);
        }
        if (it->second.role == "viewer-upstream") {
          stop_viewer_audio_playback_runtime(runtime_state.viewer_audio_playback);
        }
        emit_breadcrumb(std::string("closePeer:after-stop-viewer-audio peer=") + peer_id);
        it->second.transport.closed = true;
        it->second.transport.data_channel_open = false;
        it->second.transport.connection_state = "closed";
        it->second.transport.ice_state = "closed";
        it->second.transport.signaling_state = "closed";
        it->second.transport.reason = "peer-closed";
        it->second.transport.updated_at_unix_ms = current_time_millis();
        emit_event("peer-state", build_peer_state_json(it->second, "closed"));
        runtime_state.peers.erase(it);
        emit_breadcrumb(std::string("closePeer:after-erase peer=") + peer_id);
      }

      write_json_line(
        build_result_payload(
          id,
          std::string("{\"closed\":true,\"implementation\":\"") +
            json_escape(runtime_state.peer_transport_backend.transport_ready ? "libdatachannel" : "stub") +
            "\"}"
        )
      );
      continue;
    }

    if (method == "setRemoteDescription") {
      const std::string peer_id = extract_string_value(line, "peerId");
      const std::string description_type = extract_string_value(line, "type");
      const std::string sdp = extract_string_value(line, "sdp");
      auto it = runtime_state.peers.find(peer_id);
      if (it == runtime_state.peers.end()) {
        write_json_line(build_error_payload(id, "PEER_NOT_FOUND", "Peer has not been created"));
        continue;
      }

      if (it->second.transport_session) {
        std::string set_description_error;
        if (!set_peer_transport_remote_description(
              it->second.transport_session,
              description_type.empty() ? "offer" : description_type,
              sdp,
              &set_description_error)) {
          write_json_line(build_error_payload(id, "NATIVE_TRANSPORT_ERROR", set_description_error));
          continue;
        }
        it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
      }

      it->second.has_remote_description = true;
      if (!it->second.transport_session) {
        emit_event("peer-state", build_peer_state_json(it->second, "remote-description-set"));
      }
      write_json_line(
        build_result_payload(
          id,
          std::string("{\"ok\":true,\"implementation\":\"") +
            json_escape(it->second.transport.transport_ready ? "libdatachannel" : "stub") + "\"}"
        )
      );
      continue;
    }

    if (method == "addRemoteIceCandidate") {
      const std::string peer_id = extract_string_value(line, "peerId");
      const std::string candidate = extract_string_value(line, "candidate");
      const std::string sdp_mid = extract_string_value(line, "sdpMid");
      auto it = runtime_state.peers.find(peer_id);
      if (it == runtime_state.peers.end()) {
        write_json_line(build_error_payload(id, "PEER_NOT_FOUND", "Peer has not been created"));
        continue;
      }

      if (it->second.transport_session) {
        std::string add_candidate_error;
        if (!add_peer_transport_remote_candidate(
              it->second.transport_session,
              candidate,
              sdp_mid,
              &add_candidate_error)) {
          write_json_line(build_error_payload(id, "NATIVE_TRANSPORT_ERROR", add_candidate_error));
          continue;
        }
        it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
      }

      it->second.remote_candidate_count += 1;
      if (!it->second.transport_session) {
        emit_event("peer-state", build_peer_state_json(it->second, "remote-candidate-added"));
      }
      write_json_line(
        build_result_payload(
          id,
          std::string("{\"ok\":true,\"implementation\":\"") +
            json_escape(it->second.transport.transport_ready ? "libdatachannel" : "stub") + "\"}"
        )
      );
      continue;
    }

    if (method == "attachPeerMediaSource") {
      const std::string peer_id = extract_string_value(line, "peerId");
      const std::string source = extract_string_value(line, "source");
      emit_breadcrumb(
        std::string("attachPeerMediaSource:begin peer=") + peer_id +
        " source=" + source);
      auto it = runtime_state.peers.find(peer_id);
      if (it == runtime_state.peers.end()) {
        write_json_line(build_error_payload(id, "PEER_NOT_FOUND", "Peer has not been created"));
        continue;
      }

      if (!source.empty() &&
          source != "host-session-video" &&
          source != "host-capture-artifact" &&
          !is_peer_video_media_source(source)) {
        write_json_line(
          build_error_payload(
            id,
            "BAD_REQUEST",
            "Only host-session-video, host-capture-artifact, and peer-video:<peerId> are currently supported"
          )
        );
        continue;
      }

      const bool was_attached = it->second.media_binding.attached;
      const bool had_video_track_configured = it->second.transport.video_track_configured;
      const bool had_audio_track_configured = it->second.transport.audio_track_configured;
      const std::string previous_source = it->second.media_binding.source;
      const std::string previous_codec = it->second.media_binding.codec;
      const int previous_width = it->second.media_binding.width;
      const int previous_height = it->second.media_binding.height;
      const int previous_frame_rate = it->second.media_binding.frame_rate;
      const int previous_bitrate_kbps = it->second.media_binding.bitrate_kbps;

      std::string attach_error;
      const bool attach_ok = is_peer_video_media_source(source)
        ? attach_relay_video_media_binding(runtime_state, it->second, source, &attach_error)
        : attach_host_video_media_binding(runtime_state, it->second, &attach_error);
      if (!attach_ok) {
        it->second.media_binding.attached = false;
        it->second.media_binding.sender_configured = false;
        it->second.media_binding.active = false;
        it->second.media_binding.reason = "peer-media-attach-failed";
        it->second.media_binding.last_error = attach_error;
        it->second.media_binding.updated_at_unix_ms = current_time_millis();
        write_json_line(build_error_payload(id, "MEDIA_SOURCE_ATTACH_FAILED", attach_error));
        continue;
      }

      const bool attachment_requires_negotiation =
        !was_attached ||
        previous_source != it->second.media_binding.source ||
        previous_codec != it->second.media_binding.codec ||
        previous_width != it->second.media_binding.width ||
        previous_height != it->second.media_binding.height ||
        previous_frame_rate != it->second.media_binding.frame_rate ||
        previous_bitrate_kbps != it->second.media_binding.bitrate_kbps ||
        had_video_track_configured != it->second.transport.video_track_configured ||
        had_audio_track_configured != it->second.transport.audio_track_configured;

      if (it->second.transport_session &&
          (it->second.initiator || is_peer_video_media_source(source)) &&
          attachment_requires_negotiation) {
        std::string negotiate_error;
        if (!ensure_peer_transport_local_description(it->second.transport_session, &negotiate_error)) {
          it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
          it->second.transport.last_error = negotiate_error;
          it->second.transport.reason = "peer-local-description-failed";
          it->second.media_binding.reason = "peer-local-description-failed";
          it->second.media_binding.last_error = negotiate_error;
          it->second.media_binding.updated_at_unix_ms = current_time_millis();
          write_json_line(build_error_payload(id, "MEDIA_SOURCE_ATTACH_FAILED", negotiate_error));
          continue;
        }
      }

      refresh_peer_transport_runtime(runtime_state);
      emit_event("peer-state", build_peer_state_json(it->second, "media-source-attached"));
      emit_breadcrumb(std::string("attachPeerMediaSource:before-result peer=") + peer_id);
      write_json_line(build_result_payload(id, build_peer_result_json(it->second)));
      continue;
    }

    if (method == "detachPeerMediaSource") {
      const std::string peer_id = extract_string_value(line, "peerId");
      auto it = runtime_state.peers.find(peer_id);
      if (it == runtime_state.peers.end()) {
        write_json_line(build_error_payload(id, "PEER_NOT_FOUND", "Peer has not been created"));
        continue;
      }

      std::string detach_error;
      if (!detach_peer_media_binding(it->second, &detach_error)) {
        it->second.media_binding.reason = "peer-media-detach-failed";
        it->second.media_binding.last_error = detach_error;
        it->second.media_binding.updated_at_unix_ms = current_time_millis();
        write_json_line(build_error_payload(id, "MEDIA_SOURCE_DETACH_FAILED", detach_error));
        continue;
      }

      if (it->second.initiator && it->second.transport_session) {
        std::string negotiate_error;
        if (!ensure_peer_transport_local_description(it->second.transport_session, &negotiate_error)) {
          it->second.transport = get_peer_transport_snapshot(it->second.transport_session);
          it->second.transport.last_error = negotiate_error;
          it->second.transport.reason = "peer-local-description-failed";
          it->second.media_binding.reason = "peer-local-description-failed";
          it->second.media_binding.last_error = negotiate_error;
          it->second.media_binding.updated_at_unix_ms = current_time_millis();
        }
      }

      refresh_peer_transport_runtime(runtime_state);
      emit_event("peer-state", build_peer_state_json(it->second, "media-source-detached"));
      write_json_line(build_result_payload(id, build_peer_result_json(it->second)));
      continue;
    }

    if (method == "attachSurface") {
      const std::string surface = extract_string_value(line, "surface");
      const std::string target = extract_string_value(line, "target");
      const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(line);
      if (surface.empty()) {
        write_json_line(build_error_payload(id, "BAD_REQUEST", "surface is required"));
        continue;
      }

      auto existing = runtime_state.attached_surfaces.find(surface);
      if (existing != runtime_state.attached_surfaces.end()) {
        if (existing->second.peer_runtime) {
          stop_peer_video_surface_attachment(*existing->second.peer_runtime, "surface-reattach");
        } else {
          stop_surface_attachment(existing->second, "surface-reattach");
        }
      }

      SurfaceAttachmentState attachment;
      attachment.surface_id = surface;
      attachment.target = target;
      attachment.surface_layout = layout;
      if (is_peer_video_surface_target(target)) {
        const std::string peer_id = extract_peer_id_from_surface_target(target);
        auto peer_it = runtime_state.peers.find(peer_id);
        if (peer_it == runtime_state.peers.end()) {
          write_json_line(build_error_payload(id, "PEER_NOT_FOUND", "Peer has not been created"));
          continue;
        }

        if (!peer_it->second.receiver_runtime) {
          peer_it->second.receiver_runtime = std::make_shared<PeerState::PeerVideoReceiverRuntime>();
          peer_it->second.receiver_runtime->peer_id = peer_id;
          peer_it->second.receiver_runtime->local_playback_enabled =
            peer_it->second.role == "viewer-upstream";
          peer_it->second.receiver_runtime->passthrough_playback_enabled =
            peer_it->second.receiver_runtime->local_playback_enabled &&
            runtime_state.viewer_playback_mode == "passthrough";
        }

        attachment.peer_id = peer_id;
        attachment.peer_runtime = peer_it->second.receiver_runtime;
        {
          std::lock_guard<std::mutex> lock(peer_it->second.receiver_runtime->mutex);
          peer_it->second.receiver_runtime->surface_id = surface;
          peer_it->second.receiver_runtime->target = target;
          peer_it->second.receiver_runtime->surface_layout = layout;
          peer_it->second.receiver_runtime->codec_path =
            peer_it->second.transport.codec_path.empty() ? "h264" : peer_it->second.transport.codec_path;
        }

        std::string surface_error;
        if (!start_peer_video_surface_attachment(runtime_state.ffmpeg, *peer_it->second.receiver_runtime, &surface_error)) {
          sync_surface_attachment_from_peer_runtime(attachment, peer_it->second.receiver_runtime);
          attachment.last_error = surface_error;
          attachment.reason = "peer-video-surface-start-failed";
          if (peer_it->second.receiver_runtime) {
            std::lock_guard<std::mutex> lock(peer_it->second.receiver_runtime->mutex);
            peer_it->second.receiver_runtime->last_error = surface_error;
            peer_it->second.receiver_runtime->reason = "peer-video-surface-start-failed";
          }
        } else {
          sync_surface_attachment_from_peer_runtime(attachment, peer_it->second.receiver_runtime);
        }
        update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
      } else {
        attachment = start_surface_attachment(
          runtime_state.ffmpeg,
          runtime_state.host_capture_plan,
          runtime_state.host_capture_process,
          runtime_state.host_capture_artifact,
          attachment
        );
      }

      if (!attachment.running) {
        const std::string attach_error = attachment.last_error.empty()
          ? "Native embedded surface failed to start."
          : attachment.last_error;
        if (attachment.peer_runtime) {
          stop_peer_video_surface_attachment(*attachment.peer_runtime, "surface-attach-failed");
          auto peer_it = runtime_state.peers.find(attachment.peer_id);
          if (peer_it != runtime_state.peers.end()) {
            update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
          }
        } else {
          stop_surface_attachment(attachment, "surface-attach-failed");
        }
        write_json_line(build_error_payload(id, "SURFACE_ATTACH_FAILED", attach_error));
        continue;
      }

      runtime_state.attached_surfaces[surface] = attachment;
      emit_event(
        "media-state",
        std::string("{\"state\":\"surface-attached\",\"surface\":\"") + json_escape(surface) +
          "\",\"target\":\"" + json_escape(target) +
          "\",\"attachment\":" + surface_attachment_json(runtime_state.attached_surfaces[surface]) +
          ",\"implementation\":\"" + json_escape(runtime_state.attached_surfaces[surface].implementation) + "\",\"transportReady\":" +
          std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      if (!runtime_state.attached_surfaces[surface].running &&
          !runtime_state.attached_surfaces[surface].last_error.empty()) {
        emit_event(
          "warning",
          std::string("{\"scope\":\"surface\",\"surface\":\"") + json_escape(surface) +
            "\",\"message\":\"" + json_escape(runtime_state.attached_surfaces[surface].last_error) +
            "\",\"reason\":\"" + json_escape(runtime_state.attached_surfaces[surface].reason) + "\"}"
        );
      }
      write_json_line(build_result_payload(id, build_surface_result_json(runtime_state.attached_surfaces[surface])));
      continue;
    }

    if (method == "setViewerVolume") {
      const int pid = extract_int_value(line, "pid", 0);
      const float requested_volume = static_cast<float>(extract_double_value(line, "volume", 1.0));
      {
        std::lock_guard<std::mutex> lock(runtime_state.viewer_audio_playback.mutex);
        if (runtime_state.viewer_audio_playback.thread_started || runtime_state.viewer_audio_playback.ready) {
          runtime_state.viewer_audio_playback.software_volume =
            std::max(0.0f, std::min(1.0f, requested_volume));

          std::ostringstream payload;
          payload
            << "{\"pid\":0"
            << ",\"volume\":" << runtime_state.viewer_audio_playback.software_volume
            << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
          write_json_line(build_result_payload(id, payload.str()));
          continue;
        }
      }

      float effective_volume = 0.0f;
      std::string volume_error;
      if (!set_wasapi_render_session_volume_for_pid(pid, requested_volume, &effective_volume, &volume_error)) {
        write_json_line(build_error_payload(id, "VIEWER_VOLUME_SET_FAILED", volume_error));
        continue;
      }

      std::ostringstream payload;
      payload
        << "{\"pid\":" << pid
        << ",\"volume\":" << effective_volume
        << ",\"implementation\":\"native-wasapi-render-session-volume\"}";
      write_json_line(build_result_payload(id, payload.str()));
      continue;
    }

    if (method == "setViewerPlaybackMode") {
      const std::string requested_mode = to_lower_copy(extract_string_value(line, "mode"));
      const std::string normalized_mode = requested_mode == "passthrough" ? "passthrough" : "synced";
      runtime_state.viewer_playback_mode = normalized_mode;
      {
        std::lock_guard<std::mutex> lock(runtime_state.viewer_audio_playback.mutex);
        runtime_state.viewer_audio_playback.passthrough_mode = normalized_mode == "passthrough";
        runtime_state.viewer_audio_playback.target_buffer_frames =
          normalized_mode == "passthrough" ? 0u : kViewerAudioStartupBufferFrames;
        runtime_state.viewer_audio_playback.playback_primed = false;
        runtime_state.viewer_audio_playback.reason =
          normalized_mode == "passthrough" ? "viewer-audio-passthrough-ready" : "viewer-audio-buffering";
        runtime_state.viewer_audio_playback.cv.notify_all();
      }
      for (auto& entry : runtime_state.peers) {
        if (!entry.second.receiver_runtime) {
          continue;
        }
        std::lock_guard<std::mutex> lock(entry.second.receiver_runtime->mutex);
        entry.second.receiver_runtime->passthrough_playback_enabled =
          entry.second.receiver_runtime->local_playback_enabled &&
          normalized_mode == "passthrough";
      }
      std::ostringstream payload;
      payload
        << "{\"mode\":\"" << json_escape(normalized_mode) << "\""
        << ",\"implementation\":\"viewer-playback-mode\"}";
      write_json_line(build_result_payload(id, payload.str()));
      continue;
    }

    if (method == "setViewerAudioDelay") {
      const int requested_delay_ms = extract_int_value(line, "delayMs", 0);
      const unsigned int normalized_delay_ms = static_cast<unsigned int>(std::max(0, std::min(300, requested_delay_ms)));
      runtime_state.viewer_audio_delay_ms = normalized_delay_ms;
      {
        std::lock_guard<std::mutex> lock(runtime_state.viewer_audio_playback.mutex);
        runtime_state.viewer_audio_playback.passthrough_audio_delay_ms = normalized_delay_ms;
        runtime_state.viewer_audio_playback.cv.notify_all();
      }
      std::ostringstream payload;
      payload
        << "{\"delayMs\":" << normalized_delay_ms
        << ",\"implementation\":\"viewer-audio-delay\"}";
      write_json_line(build_result_payload(id, payload.str()));
      continue;
    }

    if (method == "getViewerVolume") {
      const int pid = extract_int_value(line, "pid", 0);
      {
        std::lock_guard<std::mutex> lock(runtime_state.viewer_audio_playback.mutex);
        if (runtime_state.viewer_audio_playback.thread_started || runtime_state.viewer_audio_playback.ready) {
          std::ostringstream payload;
          payload
            << "{\"pid\":0"
            << ",\"volume\":" << runtime_state.viewer_audio_playback.software_volume
            << ",\"implementation\":\"native-viewer-audio-software-volume\"}";
          write_json_line(build_result_payload(id, payload.str()));
          continue;
        }
      }

      float effective_volume = 0.0f;
      std::string volume_error;
      if (!get_wasapi_render_session_volume_for_pid(pid, &effective_volume, &volume_error)) {
        write_json_line(build_error_payload(id, "VIEWER_VOLUME_GET_FAILED", volume_error));
        continue;
      }

      std::ostringstream payload;
      payload
        << "{\"pid\":" << pid
        << ",\"volume\":" << effective_volume
        << ",\"implementation\":\"native-wasapi-render-session-volume\"}";
      write_json_line(build_result_payload(id, payload.str()));
      continue;
    }

    if (method == "updateSurface") {
      const std::string surface = extract_string_value(line, "surface");
      const NativeEmbeddedSurfaceLayout layout = build_surface_layout_from_json(line);
      auto attachment = runtime_state.attached_surfaces.find(surface);
      if (attachment == runtime_state.attached_surfaces.end()) {
        write_json_line(build_error_payload(id, "SURFACE_NOT_FOUND", "Surface is not attached"));
        continue;
      }

      std::string layout_error;
      if (!update_surface_attachment_layout(attachment->second, layout, &layout_error)) {
        write_json_line(build_error_payload(id, "SURFACE_UPDATE_FAILED", layout_error.empty() ? "surface-update-failed" : layout_error));
        continue;
      }

      emit_event(
        "media-state",
        std::string("{\"state\":\"surface-updated\",\"surface\":\"") + json_escape(surface) +
          "\",\"attachment\":" + surface_attachment_json(attachment->second) +
          ",\"implementation\":\"" + json_escape(attachment->second.implementation) + "\",\"transportReady\":" +
          std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      write_json_line(build_result_payload(id, build_surface_result_json(attachment->second)));
      continue;
    }

    if (method == "detachSurface") {
      const std::string surface = extract_string_value(line, "surface");
      auto attachment = runtime_state.attached_surfaces.find(surface);
      if (attachment != runtime_state.attached_surfaces.end()) {
        if (attachment->second.peer_runtime) {
          stop_peer_video_surface_attachment(*attachment->second.peer_runtime, "surface-detached");
          auto peer_it = runtime_state.peers.find(attachment->second.peer_id);
          if (peer_it != runtime_state.peers.end()) {
            update_peer_decoder_state_from_runtime(peer_it->second.receiver_runtime, peer_it->second.transport_session);
          }
        } else {
          stop_surface_attachment(attachment->second, "surface-detached");
        }
      }
      emit_event(
        "media-state",
        std::string("{\"state\":\"surface-detached\",\"surface\":\"") + json_escape(surface) +
          "\",\"implementation\":\"stub\",\"transportReady\":" +
          std::string(runtime_state.peer_transport_backend.transport_ready ? "true" : "false") + "}"
      );
      if (attachment != runtime_state.attached_surfaces.end()) {
        runtime_state.attached_surfaces.erase(attachment);
      }
      write_json_line(build_result_payload(id, R"json({"detached":true,"implementation":"stub"})json"));
      continue;
    }

    if (method == "getStats") {
      runtime_state.audio_session = build_audio_session_state(get_wasapi_process_loopback_session_status());
      refresh_host_capture_runtime(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      perform_host_video_sender_soft_refresh(runtime_state);
      refresh_peer_transport_runtime(runtime_state);
      write_json_line(build_result_payload(id, build_stats_json(runtime_state)));
      continue;
    }

    write_json_line(build_error_payload(id, "NOT_IMPLEMENTED", "Method not implemented in scaffold"));
  }

  stop_all_surface_attachments(runtime_state, "agent-shutdown");
  for (auto& entry : runtime_state.peers) {
    if (entry.second.receiver_runtime) {
      close_peer_video_receiver_handles(*entry.second.receiver_runtime);
    }
  }
  reset_host_audio_transport_sessions();
  stop_viewer_audio_playback_runtime(runtime_state.viewer_audio_playback);
  for (auto& entry : runtime_state.peers) {
    close_peer_transport_session(entry.second.transport_session);
  }
  stop_host_capture_process(
    runtime_state.host_capture_process,
    runtime_state.host_pipeline,
    runtime_state.host_capture_plan,
    runtime_state.host_capture_artifact,
    "agent-shutdown"
  );
  return 0;
}
