#include "host_media_clock.h"

#include <cstdlib>
#include <iostream>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
}

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}
}

int main() {
  const auto* encoder = avcodec_find_encoder_by_name("libopus");
  require(encoder != nullptr, "libopus must be available");
  auto* context = avcodec_alloc_context3(encoder);
  auto* packet = av_packet_alloc();
  require(context && packet, "encoder allocation failed");
  context->sample_rate = 48000;
  context->time_base = AVRational{ 1, 48000 };
  context->sample_fmt = AV_SAMPLE_FMT_S16;
  context->bit_rate = 128000;
  av_channel_layout_default(&context->ch_layout, 2);
  AVDictionary* options = nullptr;
  av_dict_set(&options, "application", "lowdelay", 0);
  av_dict_set(&options, "vbr", "off", 0);
  require(avcodec_open2(context, encoder, &options) == 0, "libopus open failed");
  av_dict_free(&options);

  // A viewer joining after 12 hours must still see the original source clock,
  // not a new zero-based encoder timeline or a 32-bit RTP-wrapped timestamp.
  const std::int64_t source_samples = 12ll * 3600 * 48000;
  std::uint64_t packet_count = 0;
  for (int input = 0; input < 6; ++input) {
    auto* frame = av_frame_alloc();
    require(frame != nullptr, "frame allocation failed");
    frame->nb_samples = context->frame_size;
    frame->format = context->sample_fmt;
    frame->sample_rate = context->sample_rate;
    frame->pts = source_samples + static_cast<std::int64_t>(input) * context->frame_size;
    require(av_channel_layout_copy(&frame->ch_layout, &context->ch_layout) == 0 && av_frame_get_buffer(frame, 0) == 0,
      "frame buffer failed");
    av_samples_set_silence(frame->data, 0, frame->nb_samples, 2, context->sample_fmt);
    require(avcodec_send_frame(context, frame) == 0, "encoder rejected source PTS");
    av_frame_free(&frame);
    while (avcodec_receive_packet(context, packet) == 0) {
      require(packet->pts != AV_NOPTS_VALUE, "Opus output lost source PTS");
      const auto mapped_samples = packet->pts + context->initial_padding;
      require(mapped_samples == source_samples + static_cast<std::int64_t>(packet_count) * context->frame_size,
        "Opus encoder delay must map back to the captured source sample");
      require(vds::media_agent::host_media_samples_to_us(mapped_samples, 48000) ==
        43200000000ull + packet_count * 20000,
        "encoded packet source PTS must remain 64-bit and advance once per packet");
      ++packet_count;
      av_packet_unref(packet);
    }
  }
  require(packet_count == 6, "lowdelay encoder did not emit one packet per submitted frame");
  av_packet_free(&packet);
  avcodec_free_context(&context);
  std::cout << "host Opus encoder source clock tests passed\n";
}
