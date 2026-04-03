#include "native_artifact_preview.h"

#include "native_video_surface.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
}

namespace fs = std::filesystem;

namespace {

long long current_time_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string ffmpeg_error_string(int error_code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(error_code, buffer, sizeof(buffer));
  return std::string(buffer);
}

std::string codec_name_from_id(AVCodecID codec_id) {
  switch (codec_id) {
    case AV_CODEC_ID_HEVC:
      return "h265";
    case AV_CODEC_ID_H264:
    default:
      return "h264";
  }
}

}  // namespace

class NativeArtifactPreview::Impl {
 public:
  explicit Impl(NativeArtifactPreviewConfig config)
      : config_(std::move(config)) {
    snapshot_.launch_attempted = true;
    snapshot_.codec_path = to_lower_ascii(config_.codec.empty() ? "h264" : config_.codec);
    snapshot_.window_title = config_.window_title;
    snapshot_.media_path = config_.media_path;
  }

  ~Impl() {
    stop("artifact-preview-destroyed");
  }

  bool start(std::string* error) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (worker_.joinable()) {
      return true;
    }

    stop_requested_ = false;
    start_complete_ = false;
    start_succeeded_ = false;
    start_error_.clear();
    worker_ = std::thread([this]() { thread_main(); });
    started_condition_.wait(lock, [this]() {
      return start_complete_;
    });

    if (!start_succeeded_) {
      const std::string failure = start_error_.empty() ? "native-artifact-preview-start-failed" : start_error_;
      lock.unlock();
      if (worker_.joinable()) {
        worker_.join();
      }
      if (error) {
        *error = failure;
      }
      return false;
    }

    if (error) {
      error->clear();
    }
    return true;
  }

  NativeArtifactPreviewSnapshot snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshot_;
  }

  bool update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
    std::shared_ptr<NativeVideoSurface> surface;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      config_.layout = layout;
      surface = surface_;
    }

    if (!surface) {
      if (error) {
        error->clear();
      }
      return true;
    }

    return surface->update_layout(layout, error);
  }

  void stop(const std::string& reason) {
    std::thread worker_to_join;
    std::shared_ptr<NativeVideoSurface> surface_to_close;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!worker_.joinable()) {
        snapshot_.attached = false;
        snapshot_.running = false;
        snapshot_.decoder_ready = false;
        if (!reason.empty()) {
          snapshot_.reason = reason;
        }
        if (surface_) {
          surface_->close(reason);
          surface_.reset();
        }
        return;
      }

      stop_requested_ = true;
      if (!reason.empty()) {
        stop_reason_ = reason;
      }
      surface_to_close = surface_;
      worker_to_join = std::move(worker_);
    }

    if (surface_to_close) {
      surface_to_close->close(reason);
    }

    if (worker_to_join.joinable()) {
      worker_to_join.join();
    }
  }

 private:
  void thread_main() {
    NativeVideoSurfaceConfig surface_config;
    surface_config.surface_id = config_.surface_id;
    surface_config.window_title = config_.window_title;
    surface_config.codec = config_.codec;
    surface_config.layout = config_.layout;

    std::string surface_error;
    auto created_surface = create_native_video_surface(surface_config, &surface_error);
    if (!created_surface) {
      fail_start(surface_error.empty() ? "native-artifact-preview-surface-start-failed" : surface_error);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      surface_ = created_surface;
      snapshot_.attached = true;
      snapshot_.running = true;
      snapshot_.waiting_for_artifact = false;
      snapshot_.reason = "artifact-preview-running";
      snapshot_.last_error.clear();
      start_complete_ = true;
      start_succeeded_ = true;
    }
    started_condition_.notify_all();

    while (!stop_requested_) {
      if (!wait_for_media_path()) {
        break;
      }

      AVFormatContext* format_context = nullptr;
      if (!open_input(&format_context)) {
        if (stop_requested_) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        continue;
      }

      read_packets(format_context);
      avformat_close_input(&format_context);

      if (!stop_requested_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(80));
      }
    }

    if (created_surface) {
      created_surface->close(stop_reason_.empty() ? "artifact-preview-stopped" : stop_reason_);
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      surface_.reset();
      snapshot_.attached = false;
      snapshot_.running = false;
      snapshot_.decoder_ready = false;
      snapshot_.waiting_for_artifact = false;
      snapshot_.reason = stop_reason_.empty() ? "artifact-preview-stopped" : stop_reason_;
    }
  }

  void fail_start(const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.attached = false;
    snapshot_.running = false;
    snapshot_.decoder_ready = false;
    snapshot_.reason = "artifact-preview-start-failed";
    snapshot_.last_error = message;
    start_error_ = message;
    start_complete_ = true;
    start_succeeded_ = false;
    started_condition_.notify_all();
  }

  bool wait_for_media_path() {
    if (config_.media_path.empty()) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.waiting_for_artifact = true;
      snapshot_.reason = "artifact-preview-path-missing";
      snapshot_.last_error = "Host capture artifact path is not available yet.";
      return false;
    }

    if (fs::exists(config_.media_path)) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.waiting_for_artifact = false;
      snapshot_.last_error.clear();
      return true;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.waiting_for_artifact = true;
    snapshot_.reason = "artifact-preview-waiting-for-path";
    snapshot_.last_error = "Host capture artifact path does not exist yet.";
    return false;
  }

  bool open_input(AVFormatContext** format_context) {
    const int open_result = avformat_open_input(format_context, config_.media_path.c_str(), nullptr, nullptr);
    if (open_result < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "artifact-preview-open-failed";
      snapshot_.last_error = ffmpeg_error_string(open_result);
      return false;
    }

    const int info_result = avformat_find_stream_info(*format_context, nullptr);
    if (info_result < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "artifact-preview-stream-info-failed";
      snapshot_.last_error = ffmpeg_error_string(info_result);
      return false;
    }

    video_stream_index_ = av_find_best_stream(*format_context, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (video_stream_index_ < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "artifact-preview-video-stream-missing";
      snapshot_.last_error = ffmpeg_error_string(video_stream_index_);
      return false;
    }

    AVStream* video_stream = (*format_context)->streams[video_stream_index_];
    active_codec_ = codec_name_from_id(static_cast<AVCodecID>(video_stream->codecpar->codec_id));
    if (last_byte_offset_ > 0 && (*format_context)->pb) {
      const std::int64_t seek_result = avio_seek((*format_context)->pb, last_byte_offset_, SEEK_SET);
      if (seek_result >= 0) {
        avformat_flush(*format_context);
      }
    }

    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.codec_path = active_codec_;
    snapshot_.reason = "artifact-preview-reading";
    snapshot_.last_error.clear();
    return true;
  }

  void read_packets(AVFormatContext* format_context) {
    AVPacket* packet = av_packet_alloc();
    if (!packet) {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.reason = "artifact-preview-packet-allocation-failed";
      snapshot_.last_error = "Unable to allocate AVPacket for artifact preview.";
      return;
    }

    while (!stop_requested_) {
      const int read_result = av_read_frame(format_context, packet);
      if (read_result == AVERROR_EOF || read_result == AVERROR(EAGAIN)) {
        {
          std::lock_guard<std::mutex> lock(mutex_);
          snapshot_.reason = "artifact-preview-waiting-for-growth";
          snapshot_.last_error.clear();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(80));
        break;
      }

      if (read_result < 0) {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot_.reason = "artifact-preview-read-failed";
        snapshot_.last_error = ffmpeg_error_string(read_result);
        break;
      }

      if (packet->stream_index == video_stream_index_ && packet->size > 0 && packet->pos >= last_byte_offset_) {
        std::vector<std::uint8_t> bytes(packet->data, packet->data + packet->size);
        std::string submit_error;
        if (surface_ && surface_->submit_encoded_frame(bytes, active_codec_, &submit_error)) {
          if (packet->pos >= 0) {
            last_byte_offset_ = packet->pos + packet->size;
          }
          sync_from_surface();
        } else {
          std::lock_guard<std::mutex> lock(mutex_);
          snapshot_.reason = "artifact-preview-submit-failed";
          snapshot_.last_error = submit_error.empty() ? "native-artifact-preview-submit-failed" : submit_error;
        }
      }

      av_packet_unref(packet);
    }

    av_packet_free(&packet);
  }

  void sync_from_surface() {
    if (!surface_) {
      return;
    }

    const NativeVideoSurfaceSnapshot surface_snapshot = surface_->snapshot();
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.attached = surface_snapshot.attached;
    snapshot_.running = surface_snapshot.running;
    snapshot_.decoder_ready = surface_snapshot.decoder_ready;
    snapshot_.decoded_frames_rendered = surface_snapshot.decoded_frames_rendered;
    snapshot_.last_decoded_frame_at_unix_ms = surface_snapshot.last_decoded_frame_at_unix_ms;
    snapshot_.process_id = surface_snapshot.process_id;
    snapshot_.preview_surface_backend = surface_snapshot.preview_surface_backend;
    snapshot_.decoder_backend = surface_snapshot.decoder_backend;
    snapshot_.codec_path = surface_snapshot.codec_path;
    snapshot_.window_title = surface_snapshot.window_title;
    if (surface_snapshot.reason == "native-frame-rendered") {
      snapshot_.reason = "artifact-preview-frame-rendered";
    } else {
      snapshot_.reason = surface_snapshot.reason;
    }
    snapshot_.last_error = surface_snapshot.last_error;
  }

  NativeArtifactPreviewConfig config_;
  mutable std::mutex mutex_;
  std::condition_variable started_condition_;
  std::thread worker_;
  bool stop_requested_ = false;
  bool start_complete_ = false;
  bool start_succeeded_ = false;
  std::string start_error_;
  std::string stop_reason_;
  std::shared_ptr<NativeVideoSurface> surface_;
  NativeArtifactPreviewSnapshot snapshot_;
  int video_stream_index_ = -1;
  std::string active_codec_ = "h264";
  std::int64_t last_byte_offset_ = 0;
};

NativeArtifactPreview::NativeArtifactPreview(NativeArtifactPreviewConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {}

NativeArtifactPreview::~NativeArtifactPreview() = default;

NativeArtifactPreviewSnapshot NativeArtifactPreview::snapshot() const {
  return impl_->snapshot();
}

bool NativeArtifactPreview::update_layout(const NativeEmbeddedSurfaceLayout& layout, std::string* error) {
  return impl_->update_layout(layout, error);
}

void NativeArtifactPreview::close(const std::string& reason) {
  impl_->stop(reason);
}

std::shared_ptr<NativeArtifactPreview> create_native_artifact_preview(
  const NativeArtifactPreviewConfig& config,
  std::string* error
) {
  auto preview = std::shared_ptr<NativeArtifactPreview>(new NativeArtifactPreview(config));
  if (!preview->impl_->start(error)) {
    return nullptr;
  }
  return preview;
}
