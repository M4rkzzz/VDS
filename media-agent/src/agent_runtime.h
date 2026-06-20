#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
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
#endif

#include "native_surface_layout.h"
#include "peer_transport.h"
#include "wgc_capture.h"

constexpr unsigned int kViewerAudioRuntimeDefaultChannelCount = 2;

class NativeArtifactPreview;
class NativeLivePreview;
class NativeVideoSurface;

struct PeerState {
  struct PeerVideoSenderRuntime {
    bool running = false;
    unsigned long long source_frames_captured = 0;
    unsigned long long source_copy_resource_us_total = 0;
    unsigned long long source_map_us_total = 0;
    unsigned long long source_memcpy_us_total = 0;
    unsigned long long source_total_readback_us_total = 0;
    unsigned long long frames_sent = 0;
    unsigned long long next_frame_timestamp_us = 0;
    unsigned long long frame_interval_us = 16666;
    long long next_frame_send_deadline_steady_us = -1;
    long long last_frame_sent_at_steady_us = -1;
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
    bool running = false;
    bool decoder_ready = false;
    bool closing = false;
    bool local_playback_enabled = false;
    unsigned long process_id = 0;
    unsigned long long decoded_frames_rendered = 0;
    unsigned long long submitted_video_units = 0;
    unsigned long long dispatched_audio_blocks = 0;
    unsigned long long dropped_video_units = 0;
    unsigned long long dropped_audio_blocks = 0;
    double frame_interval_stddev_ms = 0.0;
    std::string peer_id;
    std::string surface_id;
    std::string target;
    std::string codec_path = "h264";
    std::string implementation = "ffmpeg-native-video-surface";
    std::string window_title;
    std::string embedded_parent_debug;
    std::string surface_window_debug;
    std::string reason = "peer-video-surface-idle";
    std::string last_error;
    std::shared_ptr<NativeVideoSurface> surface;
    std::shared_ptr<PeerAudioDecoderRuntime> audio_decoder_runtime;
    NativeEmbeddedSurfaceLayout surface_layout;
    std::vector<std::uint8_t> pending_video_annexb_bytes;
    std::vector<std::uint8_t> startup_video_decoder_config_au;
    bool startup_waiting_for_random_access = true;
    std::mutex mutex;
  };

  std::string peer_id;
  std::string role;
  bool initiator = false;
  std::string media_session_id;
  int media_manifest_version = 0;
  std::string expected_video_codec;
  std::string expected_audio_codec;
  struct MediaBindingState {
    bool attached = false;
    bool active = false;
    int width = 0;
    int height = 0;
    int frame_rate = 0;
    int bitrate_kbps = 0;
    std::string kind = "video";
    std::string source = "unbound";
    std::string codec = "h264";
    std::string video_encoder_backend = "none";
    std::string reason = "peer-media-not-attached";
    std::string last_error;
    unsigned long long source_frames_captured = 0;
    unsigned long long avg_source_copy_resource_us = 0;
    unsigned long long avg_source_map_us = 0;
    unsigned long long avg_source_memcpy_us = 0;
    unsigned long long avg_source_total_readback_us = 0;
    unsigned long long frames_sent = 0;
    std::shared_ptr<PeerVideoSenderRuntime> runtime;
  } media_binding;
  PeerTransportSnapshot transport;
  std::shared_ptr<PeerTransportSession> transport_session;
  std::shared_ptr<PeerVideoReceiverRuntime> receiver_runtime;
};

struct VideoEncoderProbeResult {
  std::string name;
  bool exists = false;
  bool hardware = false;
  bool validated = false;
  int priority = 0;
  std::string reason;
  std::string error;
};

struct FfmpegProbeResult {
  bool available = false;
  std::string path;
  std::string version;
  std::vector<std::string> video_encoders;
  std::vector<std::string> validated_video_encoders;
  std::vector<VideoEncoderProbeResult> video_encoder_probes;
  std::vector<std::string> audio_encoders;
  std::string error;
};

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

struct HostPipelineState {
  bool ready = false;
  bool hardware = false;
  bool validated = false;
  bool prefer_hardware = true;
  std::string requested_video_codec = "h264";
  std::string requested_video_encoder;
  std::string requested_preset = "balanced";
  std::string requested_tune;
  std::string requested_keyframe_policy = "2s";
  std::string selected_video_encoder;
  std::string video_encoder_backend = "none";
  std::string selected_audio_encoder;
  std::string reason = "pipeline-not-initialized";
  std::string validation_reason = "pipeline-not-validated";
  std::string last_error;
};

struct HostCapturePlan {
  bool ready = false;
  bool validated = false;
  std::string capture_kind = "window";
  std::string capture_state = "normal";
  std::string capture_backend = "gdigrab";
  std::string capture_handle;
  std::string capture_title;
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
  std::string reason = "capture-plan-not-initialized";
  std::string validation_reason = "capture-plan-not-validated";
  std::string last_error;
};

struct HostCaptureProcessState {
  bool enabled = false;
  bool running = false;
  bool preserve_output = false;
  unsigned long process_id = 0;
  unsigned long long output_bytes = 0;
  long long started_at_unix_ms = 0;
  long long updated_at_unix_ms = 0;
  long long stopped_at_unix_ms = 0;
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
  bool running = false;
  bool waiting_for_artifact = false;
  bool decoder_ready = false;
  unsigned long long decoded_frames_rendered = 0;
  double frame_interval_stddev_ms = 0.0;
  unsigned long process_id = 0;
  std::string surface_id;
  std::string target;
  std::string codec_path = "h264";
  std::string implementation = "ffmpeg-native-artifact-preview";
  std::string media_path;
  std::string window_title;
  std::string embedded_parent_debug;
  std::string surface_window_debug;
  std::string reason = "surface-not-attached";
  std::string last_error;
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
  bool ready = false;
  unsigned long long file_size_bytes = 0;
  int width = 0;
  int height = 0;
  std::string video_codec;
  std::string reason = "artifact-not-probed";
  std::string last_error;
};

struct ObsIngestState {
  bool prepared = false;
  bool waiting = false;
  bool ingest_connected = false;
  bool stream_running = false;
  int port = 0;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
  int audio_sample_rate = 48000;
  int audio_channel_count = 2;
  unsigned long long video_packets_received = 0;
  std::string url;
  std::string listen_url;
  std::string video_codec = "h264";
  std::string audio_codec = "aac";
  std::vector<std::uint8_t> pending_video_annexb_bytes;
  std::atomic<bool> stop_requested { false };
  mutable std::mutex mutex;
  std::thread worker;
};

struct AgentRuntimeState {
  bool host_session_running = false;
  std::string host_backend = "native";
  std::string host_capture_target_id;
  std::string host_requested_codec = "h264";
  std::string host_codec = "h264";
  bool host_hardware_acceleration = true;
  std::string host_video_encoder_preference;
  std::string host_encoder_preset = "balanced";
  std::string host_encoder_tune;
  std::string host_keyframe_policy = "2s";
  std::string host_capture_kind = "window";
  std::string host_capture_state = "normal";
  std::string host_capture_title;
  std::string host_capture_hwnd;
  std::string host_capture_display_id;
  bool host_window_restore_placeholder_active = false;
  int host_width = 1920;
  int host_height = 1080;
  int host_frame_rate = 60;
  int host_bitrate_kbps = 10000;
  std::map<std::string, PeerState> peers;
  std::map<std::string, SurfaceAttachmentState> attached_surfaces;
  PeerTransportBackendInfo peer_transport_backend;
  WgcCaptureProbe wgc_capture_backend;
  FfmpegProbeResult ffmpeg;
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
    unsigned long long buffered_pcm_frames = 0;
    unsigned int channel_count = kViewerAudioRuntimeDefaultChannelCount;
    unsigned int passthrough_audio_delay_ms = 0;
    float software_volume = 1.0f;
    std::mutex mutex;
    std::condition_variable cv;
    std::thread worker;
    std::deque<QueuedPcmBlock> pcm_queue;
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
  std::weak_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
  bool pending_video_bootstrap = true;
  bool bootstrap_snapshot_sent = false;
  unsigned long long frames_sent = 0;
  std::uint64_t video_sequence = 0;
  std::uint64_t audio_sequence = 0;
  std::string reason = "relay-subscriber-idle";
  std::string last_error;
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
  std::thread video_worker;
  std::map<std::string, std::vector<RelaySubscriberState>> subscribers_by_upstream_peer;
  std::map<std::string, RelayUpstreamVideoBootstrapState> video_bootstrap_by_upstream_peer;
  std::deque<QueuedRelayVideoDispatch> pending_video_dispatches;
  bool video_worker_started = false;
  bool video_worker_stop = false;
};

struct RelayDispatchTarget {
  std::string peer_id;
  std::shared_ptr<PeerTransportSession> session;
  bool audio_enabled = false;
};
