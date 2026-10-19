#pragma once

#include "wgc_capture.h"
#include <atomic>
#include <mutex>
#include <unordered_map>

// A latest-frame mailbox, not a queue. Preview never waits on encoding or owns
// capture lifetime. Buffers are writable only when no reader still holds them.
namespace vds::media_agent {
inline std::string capture_frame_key(const WgcFrameSourceConfig& config) {
  return config.target_kind + "\n" +
    (config.target_kind == "window" ? config.window_handle : config.display_id) +
    "\n" + (config.with_cursor ? "cursor" : "no-cursor") +
    "\n" + (config.with_border ? "border" : "no-border");
}

class SharedCaptureFrames {
 public:
  std::shared_ptr<WgcFrameCpuBuffer> acquire() {
    for (const auto& buffer : pool_) if (buffer.use_count() == 1) return buffer;
    auto buffer = std::make_shared<WgcFrameCpuBuffer>();
    pool_.push_back(buffer);
    return buffer;
  }
  void publish(const std::shared_ptr<WgcFrameCpuBuffer>& frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    latest_ = frame;
    published_at_ = std::chrono::steady_clock::now();
  }
  std::shared_ptr<const WgcFrameCpuBuffer> latest() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!active.load() || std::chrono::steady_clock::now() - published_at_ > std::chrono::seconds(1)) return {};
    return latest_;
  }
  std::atomic<bool> active { true };
  int frame_rate = 0;
 private:
  mutable std::mutex mutex_;
  std::vector<std::shared_ptr<WgcFrameCpuBuffer>> pool_;
  std::shared_ptr<const WgcFrameCpuBuffer> latest_;
  std::chrono::steady_clock::time_point published_at_{};
};

inline std::mutex shared_capture_registry_mutex;
inline std::unordered_multimap<std::string, std::weak_ptr<SharedCaptureFrames>> shared_capture_registry;

inline void register_shared_capture(const WgcFrameSourceConfig& config,
    const std::shared_ptr<SharedCaptureFrames>& frames) {
  frames->frame_rate = config.frame_rate;
  std::lock_guard<std::mutex> lock(shared_capture_registry_mutex);
  for (auto it = shared_capture_registry.begin(); it != shared_capture_registry.end();) {
    if (it->second.expired()) it = shared_capture_registry.erase(it); else ++it;
  }
  shared_capture_registry.emplace(capture_frame_key(config), frames);
}

inline std::shared_ptr<const WgcFrameCpuBuffer> find_shared_capture_frame(const WgcFrameSourceConfig& config) {
  std::lock_guard<std::mutex> lock(shared_capture_registry_mutex);
  const auto range = shared_capture_registry.equal_range(capture_frame_key(config));
  for (auto it = range.first; it != range.second; ++it) {
    if (auto frames = it->second.lock()) {
      // Preserve a preview requesting a faster cadence than this producer.
      if (frames->frame_rate >= config.frame_rate) if (auto frame = frames->latest()) return frame;
    }
  }
  return {};
}
}  // namespace vds::media_agent
