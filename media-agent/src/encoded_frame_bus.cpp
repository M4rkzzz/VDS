#include "encoded_frame_bus.h"

#include <utility>

void EncodedFrameBus::set_video_handler(VideoBatchHandler handler) {
  video_handler_ = std::move(handler);
}

void EncodedFrameBus::set_audio_handler(AudioFrameHandler handler) {
  audio_handler_ = std::move(handler);
}

void EncodedFrameBus::publish_video(const EncodedFrameBatch& batch) const {
  if (video_handler_) {
    video_handler_(batch);
  }
}

void EncodedFrameBus::publish_audio(const EncodedFrame& frame) const {
  if (audio_handler_) {
    audio_handler_(frame);
  }
}
