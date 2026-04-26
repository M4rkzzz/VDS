#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
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
#include "wgc_capture.h"

constexpr unsigned int kViewerAudioRuntimeDefaultChannelCount = 2;

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
    bool surface_attached = false;
    bool launch_attempted = false;
    bool running = false;
    bool decoder_ready = false;
    bool closing = false;
    bool local_playback_enabled = false;
    unsigned long process_id = 0;
    unsigned long long remote_frames_received = 0;
    unsigned long long remote_bytes_received = 0;
    unsigned long long decoded_frames_rendered = 0;
    unsigned long long scheduled_video_units = 0;
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
  std::string media_session_id;
  int media_manifest_version = 0;
  std::string expected_video_codec;
  std::string expected_audio_codec;
  std::string expected_video_payload_format;
  std::string expected_audio_payload_format;
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
  std::string requested_keyframe_policy = "1s";
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

struct ObsIngestState {
  bool prepared = false;
  bool waiting = false;
  bool ingest_connected = false;
  bool stream_running = false;
  bool video_ready = false;
  bool audio_ready = false;
  bool listener_active = false;
  bool local_only = true;
  int port = 0;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
  int audio_sample_rate = 48000;
  int audio_channel_count = 2;
  long long started_at_unix_ms = 0;
  long long connected_at_unix_ms = 0;
  long long last_packet_at_unix_ms = 0;
  long long ended_at_unix_ms = 0;
  unsigned long long video_packets_received = 0;
  unsigned long long audio_packets_received = 0;
  unsigned long long video_access_units_emitted = 0;
  unsigned long long audio_frames_forwarded = 0;
  std::string url;
  std::string listen_url;
  std::string video_codec = "h264";
  std::string audio_codec = "aac";
  std::string reason = "obs-ingest-idle";
  std::string last_error;
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::atomic<bool> stop_requested { false };
  mutable std::mutex mutex;
  std::thread worker;
};

struct AgentRuntimeState {
  std::string viewer_playback_mode = "passthrough";
  unsigned int viewer_audio_delay_ms = 0;
  bool host_session_running = false;
  std::string host_backend = "native";
  std::string host_capture_target_id;
  std::string host_requested_codec = "h264";
  std::string host_codec = "h264";
  bool host_hardware_acceleration = true;
  std::string host_video_encoder_preference;
  std::string host_encoder_preset = "balanced";
  std::string host_encoder_tune;
  std::string host_keyframe_policy = "1s";
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
  ObsIngestState obs_ingest;
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
    bool passthrough_mode = true;
    unsigned long long audio_packets_received = 0;
    unsigned long long audio_bytes_received = 0;
    unsigned long long pcm_frames_queued = 0;
    unsigned long long pcm_frames_played = 0;
    unsigned long long buffered_pcm_frames = 0;
    unsigned int target_buffer_frames = 0;
    unsigned int channel_count = kViewerAudioRuntimeDefaultChannelCount;
    unsigned int passthrough_audio_delay_ms = 0;
    float software_volume = 1.0f;
    std::string implementation = "native-waveout-opus-playback";
    std::string reason = "viewer-audio-passthrough-ready";
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
  struct QueuedCapturePacket {
    std::vector<unsigned char> bytes;
    unsigned int frames = 0;
    unsigned int sample_rate = 0;
    unsigned int channel_count = 0;
    unsigned int bits_per_sample = 0;
    unsigned int block_align = 0;
    bool silent = false;
  };
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<std::weak_ptr<PeerTransportSession>> sessions;
  std::deque<QueuedCapturePacket> capture_queue;
  unsigned long long next_timestamp_samples = 0;
  unsigned long long dropped_capture_packets = 0;
  std::deque<std::int16_t> pending_pcm;
  AVCodecContext* encoder_context = nullptr;
  AVPacket* encoder_packet = nullptr;
  int encoder_frame_size = 960;
  bool worker_started = false;
  bool stop_requested = false;
  std::thread worker;
  std::string last_error;
};

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
