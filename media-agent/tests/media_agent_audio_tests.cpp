#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>

#include "media_audio.h"
#include "obs_ingest_media.h"
#include "viewer_audio_playback.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/buffer.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
}

namespace {

int failed_assertions = 0;
int inspected_audio_packets = 0;
bool audio_packets_have_padding = true;

void expect_true(bool condition, const std::string& message) {
  if (!condition) {
    ++failed_assertions;
    std::cerr << "FAIL: " << message << '\n';
  }
}

std::vector<std::vector<std::uint8_t>> encode_audio(const std::string& codec_name) {
  std::vector<std::vector<std::uint8_t>> packets;
  const AVCodec* codec = avcodec_find_encoder_by_name(codec_name == "aac" ? "aac" : "libopus");
  expect_true(codec != nullptr, codec_name + " encoder is available");
  if (!codec) { return packets; }
  AVCodecContext* context = avcodec_alloc_context3(codec);
  AVFrame* frame = av_frame_alloc();
  AVPacket* packet = av_packet_alloc();
  if (!context || !frame || !packet) { std::abort(); }
  context->sample_rate = 48000;
  context->bit_rate = 128000;
  context->sample_fmt = codec_name == "aac" ? AV_SAMPLE_FMT_FLTP : AV_SAMPLE_FMT_S16;
  context->time_base = {1, 48000};
  av_channel_layout_default(&context->ch_layout, 2);
  expect_true(avcodec_open2(context, codec, nullptr) == 0, codec_name + " encoder opens");
  frame->format = context->sample_fmt;
  frame->sample_rate = context->sample_rate;
  frame->nb_samples = context->frame_size;
  av_channel_layout_copy(&frame->ch_layout, &context->ch_layout);
  expect_true(frame->nb_samples > 0 && av_frame_get_buffer(frame, 0) == 0,
    codec_name + " encoder frame is allocated");

  auto receive_packets = [&]() {
    while (avcodec_receive_packet(context, packet) == 0) {
      if (codec_name == "aac") {
        packets.push_back(build_adts_framed_aac(packet->data, static_cast<std::size_t>(packet->size), {}));
      } else {
        packets.emplace_back(packet->data, packet->data + packet->size);
      }
      av_packet_unref(packet);
    }
  };
  for (int block = 0; block < 4; ++block) {
    av_frame_make_writable(frame);
    for (int sample = 0; sample < frame->nb_samples; ++sample) {
      const double phase = 6.283185307179586 * 440.0 *
        static_cast<double>(block * frame->nb_samples + sample) / 48000.0;
      const float value = static_cast<float>(std::sin(phase) * 0.2);
      if (codec_name == "aac") {
        reinterpret_cast<float*>(frame->data[0])[sample] = value;
        reinterpret_cast<float*>(frame->data[1])[sample] = value;
      } else {
        auto* pcm = reinterpret_cast<std::int16_t*>(frame->data[0]);
        pcm[sample * 2] = pcm[sample * 2 + 1] = static_cast<std::int16_t>(value * 32767.0f);
      }
    }
    frame->pts = static_cast<std::int64_t>(block) * frame->nb_samples;
    expect_true(avcodec_send_frame(context, frame) == 0, codec_name + " frame is encoded");
    receive_packets();
  }
  avcodec_send_frame(context, nullptr);
  receive_packets();
  av_packet_free(&packet);
  av_frame_free(&frame);
  avcodec_free_context(&context);
  expect_true(packets.size() >= 3, codec_name + " produces encoded packets");
  return packets;
}

void test_audio_decoder(const std::string& codec_name) {
  const auto packets = encode_audio(codec_name);
  if (packets.empty()) { return; }
  auto runtime = std::make_shared<PeerVideoReceiverRuntime>();
  std::string error;
  auto first_pcm = decode_audio_to_pcm16(runtime, packets.front(), codec_name, &error);
  expect_true(!first_pcm.empty() && error.empty(), codec_name + " encoded packet decodes to stereo PCM");
  const auto empty_pcm = decode_audio_to_pcm16(runtime, {}, codec_name, &error);
  expect_true(empty_pcm.empty(), codec_name + " empty transport packet produces no audio");
  auto resumed_pcm = decode_audio_to_pcm16(runtime, packets[1], codec_name, &error);
  expect_true(!resumed_pcm.empty() && error.empty(), codec_name + " empty transport packet does not flush the decoder");
  bool has_signal = std::any_of(resumed_pcm.begin(), resumed_pcm.end(), [](std::int16_t value) {
    return value > 100 || value < -100;
  });
  expect_true(has_signal, codec_name + " decoded PCM contains the encoded signal");
  reset_peer_audio_decoder_runtime(*runtime);
  error.clear();
  const auto restarted_pcm = decode_audio_to_pcm16(runtime, packets.front(), codec_name, &error);
  expect_true(!restarted_pcm.empty() && error.empty(), codec_name + " decoder restarts after reset");
  reset_peer_audio_decoder_runtime(*runtime);
  reset_peer_audio_decoder_runtime(*runtime);
}

void test_playback_backpressure() {
  if (waveOutGetNumDevs() == 0) {
    std::cout << "SKIP: playback device is unavailable; codec regression still ran\n";
    return;
  }
  const float previous_volume = get_viewer_audio_software_volume();
  set_viewer_audio_software_volume(0.0f);
  set_viewer_audio_delay_ms(0);
  unsigned long long peak_buffered_frames = 0;
  unsigned int buffer_limit = 0;
  bool device_ready = false;
  for (int packet = 0; packet < 200; ++packet) {
    // A 20 ms silent block every millisecond exercises a real waveOut backlog.
    queue_viewer_audio_pcm_block(std::vector<std::int16_t>(960 * 2, 0));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    const auto snapshot = get_viewer_audio_playback_snapshot();
    device_ready = device_ready || snapshot.ready;
    buffer_limit = snapshot.max_buffered_pcm_frames;
    peak_buffered_frames = std::max(peak_buffered_frames,
      snapshot.queued_pcm_frames + snapshot.in_flight_pcm_frames);
  }
  const auto snapshot = get_viewer_audio_playback_snapshot();
  std::cout << "waveOut peak buffered frames=" << peak_buffered_frames
    << " limit=" << buffer_limit << " dropped=" << snapshot.dropped_pcm_frames << '\n';
  expect_true(device_ready, "the native playback device opens");
  expect_true(peak_buffered_frames <= buffer_limit, "waveOut and software queue together stay within the latency bound");
  expect_true(snapshot.dropped_pcm_frames > 0, "excess live audio drops old queued blocks");
  stop_viewer_audio_playback_runtime();
  const auto stopped = get_viewer_audio_playback_snapshot();
  expect_true(!viewer_audio_playback_is_active() && stopped.queued_pcm_frames == 0 &&
    stopped.in_flight_pcm_frames == 0, "stop clears device and software playback buffers");
  queue_viewer_audio_pcm_block(std::vector<std::int16_t>(960 * 2, 0));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  expect_true(get_viewer_audio_playback_snapshot().ready, "playback restarts after stop");
  stop_viewer_audio_playback_runtime();
  set_viewer_audio_software_volume(previous_volume);
}

} // namespace

// Observe the packet at the FFmpeg boundary, then call the actual DLL decoder.
// This checks the SDK's required zero padding without reading outside a vector.
extern "C" int avcodec_send_packet(AVCodecContext* context, const AVPacket* packet) {
  using SendPacket = int (*)(AVCodecContext*, const AVPacket*);
  static const SendPacket actual_send_packet = []() {
    const std::string dll_name = "avcodec-" + std::to_string(LIBAVCODEC_VERSION_MAJOR) + ".dll";
    const HMODULE module = GetModuleHandleA(dll_name.c_str());
    return reinterpret_cast<SendPacket>(module ? GetProcAddress(module, "avcodec_send_packet") : nullptr);
  }();
  if (!actual_send_packet) { std::abort(); }
  if (packet && packet->data && packet->size > 0 && context->codec_type == AVMEDIA_TYPE_AUDIO) {
    ++inspected_audio_packets;
    if (!packet->buf || packet->buf->size < static_cast<std::size_t>(packet->size) + AV_INPUT_BUFFER_PADDING_SIZE) {
      audio_packets_have_padding = false;
    } else {
      for (int index = 0; index < AV_INPUT_BUFFER_PADDING_SIZE; ++index) {
        if (packet->data[packet->size + index] != 0) { audio_packets_have_padding = false; }
      }
    }
  }
  return actual_send_packet(context, packet);
}

int main() {
  av_log_set_level(AV_LOG_ERROR);
  test_audio_decoder("opus");
  test_audio_decoder("aac");
  expect_true(inspected_audio_packets >= 6 && audio_packets_have_padding,
    "audio decoder packets own the zero padding required by FFmpeg");
  test_playback_backpressure();
  if (failed_assertions != 0) { return EXIT_FAILURE; }
  std::cout << "media-agent audio tests passed\n";
  return EXIT_SUCCESS;
}
