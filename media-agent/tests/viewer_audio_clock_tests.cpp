#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "viewer_audio_timing.h"
#include "viewer_audio_packet_budget.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#include "media_audio.h"
#include "obs_ingest_media.h"
#include "viewer_audio_playback.h"
#include "time_utils.h"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
}
#endif

namespace {
unsigned int failures = 0;
unsigned int assertions = 0;
void check(bool ok, const std::string& message) {
  ++assertions;
  if (!ok) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
MediaFrameTiming timing(std::uint64_t pts, const std::string& source = "source/1") {
  MediaFrameTiming result;
  result.timestamp_us = pts;
  result.timestamp_valid = true;
  result.source_id = source;
  return result;
}

void test_timing_policy() {
  check(viewer_audio_packet_device_frames("opus", {0xf8}) == 960,
    "Opus 20 ms TOC reserves the actual normalized output duration");
  check(viewer_audio_packet_device_frames("opus", {0xfb, 0x3f}) == 0,
    "invalid Opus duration cannot bypass the PCM budget");
  check(viewer_audio_packet_device_frames("pcmu", std::vector<std::uint8_t>(160)) == 960,
    "PCMU reservation includes mono-to-stereo sample-rate conversion");
  check(viewer_audio_packet_device_frames("aac", {0xff, 0xf1}) == 0,
    "incomplete AAC ADTS packet is rejected without decoding");
  ViewerAudioTimingPlan plan;
  check(plan.deadline(timing(50000000000ULL), 1000000, 0) == 1020000,
    "64-bit source PTS anchors at 20 ms");
  check(plan.deadline(timing(50000020000ULL), 1020000, 100) == 1140000,
    "user audio delay is applied once to the source deadline");
  check(plan.discontinuous(timing(50000040000ULL, "other/2"), 1040000), "new source requests a reset");
  check(plan.discontinuous(timing(1), 1060000), "backwards source discontinuity resets");
  check(plan.discontinuous(timing(50004000000ULL), 1060000), "future timestamp jump resets");
  for (int interval = 1; interval <= 8; ++interval) {
    plan.deadline(timing(50000000000ULL + static_cast<std::uint64_t>(interval) * 100000),
      1000000 + interval * 100000 + 70000, 0);
  }
  check(plan.buffer_ms() == 60, "adaptive smoothing is capped at 60 ms");
  plan.deadline(timing(50005000000ULL), 6000000, 0);
  check(plan.buffer_ms() == 59, "stable smoothing decreases slowly");
  plan.reset();
  check(plan.buffer_ms() == 20, "reset clears the old source smoothing");
  check(plan.deadline({}, 1234, 50) == 51234, "legacy untimed audio uses arrival and explicit offset");
}

void test_device_clock() {
  for (const auto unit : {ViewerAudioPositionUnit::Samples, ViewerAudioPositionUnit::Bytes,
                          ViewerAudioPositionUnit::Milliseconds}) {
    ViewerAudioDeviceClock clock;
    clock.record_write(960, timing(0));
    clock.record_write(960, timing(20000));
    check(clock.observe(0, unit, 1000000), "zero device position is accepted");
    check(!clock.estimate(1000000).valid, "zero position alone never claims active audio");
    const auto raw = unit == ViewerAudioPositionUnit::Samples ? 480u :
      unit == ViewerAudioPositionUnit::Bytes ? 1920u : 10u;
    check(clock.observe(raw, unit, 1010000), "reported device position type is converted");
    auto estimate = clock.estimate(1015000);
    check(estimate.valid && estimate.timestamp_us == 15000 && estimate.source_id == "source/1",
      "device progress and monotonic interpolation preserve source time");
    check(clock.estimate(1025000).timestamp_us == 25000, "device position crosses contiguous PCM segments");
    check(!clock.estimate(1060000).valid, "stale output query invalidates the audio master clock");
    clock.observe(raw, unit, 1100000);
    check(!clock.estimate(1100000).valid, "stalled device cannot provide a synthetic progressing clock");
    clock.reset();
    check(!clock.estimate(1100000).valid, "reset removes the old source mapping");
  }
  ViewerAudioDeviceClock clock;
  clock.record_write(960, {});
  clock.observe(0, ViewerAudioPositionUnit::Samples, 0);
  clock.observe(480, ViewerAudioPositionUnit::Samples, 10000);
  check(!clock.estimate(10000).valid, "untimed PCM is playable without claiming synchronization");
  check(!clock.observe(1, ViewerAudioPositionUnit::Unsupported, 11000), "unsupported device units invalidate");
  clock.reset();
  clock.record_write(960, timing(50000000000ULL));
  clock.observe(0, ViewerAudioPositionUnit::Samples, 0);
  clock.observe(480, ViewerAudioPositionUnit::Samples, 10000);
  check(clock.estimate(10000).timestamp_us == 50000010000ULL, "PTS keeps its full 64-bit width");
  check(!clock.observe(100, ViewerAudioPositionUnit::Samples, 11000), "unexpected device rewind is rejected");
  check(!clock.estimate(11000).valid, "rewind does not leave a valid old clock");
  clock.reset();
  clock.record_write(960, timing(0));
  clock.observe(0, ViewerAudioPositionUnit::Samples, 0);
  clock.observe(960, ViewerAudioPositionUnit::Samples, 20000);
  check(!clock.estimate(20000).valid, "drained device has no active output clock");
  clock.reset();
  clock.record_write(0xfffffff0u, timing(0));
  clock.record_write(48000, timing(89478485000ULL));
  clock.observe(0xffffff00u, ViewerAudioPositionUnit::Samples, 1000);
  check(clock.observe(0x30u, ViewerAudioPositionUnit::Samples, 7333), "32-bit device sample wrap expands safely");
  check(clock.estimate(7333).valid, "sample wrap preserves an active mapped clock");
}

#ifdef _WIN32
std::vector<std::vector<std::uint8_t>> encode_packets(
  const std::string& name, int sample_rate = 48000, int channels = 2) {
  std::vector<std::vector<std::uint8_t>> packets;
  const auto* codec = avcodec_find_encoder_by_name(name == "aac" ? "aac" : "libopus");
  if (!codec) { check(false, name + " encoder exists"); return packets; }
  auto* context = avcodec_alloc_context3(codec);
  auto* frame = av_frame_alloc();
  auto* packet = av_packet_alloc();
  if (!context || !frame || !packet) { std::abort(); }
  context->sample_rate = sample_rate;
  context->bit_rate = 128000;
  context->sample_fmt = name == "aac" ? AV_SAMPLE_FMT_FLTP : AV_SAMPLE_FMT_S16;
  context->time_base = {1, sample_rate};
  av_channel_layout_default(&context->ch_layout, channels);
  check(avcodec_open2(context, codec, nullptr) == 0, name + " encoder opens");
  frame->format = context->sample_fmt;
  frame->sample_rate = context->sample_rate;
  frame->nb_samples = context->frame_size;
  av_channel_layout_copy(&frame->ch_layout, &context->ch_layout);
  if (frame->nb_samples <= 0 || av_frame_get_buffer(frame, 0) != 0) { std::abort(); }
  auto drain = [&]() {
    while (avcodec_receive_packet(context, packet) == 0) {
      if (name == "aac") {
        ParsedAacConfig config;
        config.sample_rate = sample_rate;
        constexpr int rates[] = {96000, 88200, 64000, 48000, 44100, 32000, 24000,
          22050, 16000, 12000, 11025, 8000, 7350};
        for (int index = 0; index < 13; ++index) {
          if (rates[index] == sample_rate) { config.sample_rate_index = index; }
        }
        config.channel_count = channels;
        packets.push_back(build_adts_framed_aac(packet->data, static_cast<std::size_t>(packet->size), config));
      } else { packets.emplace_back(packet->data, packet->data + packet->size); }
      av_packet_unref(packet);
    }
  };
  for (int index = 0; index < 4; ++index) {
    av_frame_make_writable(frame);
    const auto bytes = name == "aac" ? static_cast<std::size_t>(frame->nb_samples) * sizeof(float) :
      static_cast<std::size_t>(frame->nb_samples) * 2 * sizeof(std::int16_t);
    std::fill_n(frame->data[0], bytes, std::uint8_t{0});
    if (name == "aac" && channels == 2) { std::fill_n(frame->data[1], bytes, std::uint8_t{0}); }
    frame->pts = static_cast<std::int64_t>(index) * frame->nb_samples;
    check(avcodec_send_frame(context, frame) == 0, name + " silence encodes");
    drain();
  }
  avcodec_send_frame(context, nullptr);
  drain();
  av_packet_free(&packet);
  av_frame_free(&frame);
  avcodec_free_context(&context);
  return packets;
}

void test_resampled_aac() {
  const auto packets = encode_packets("aac", 44100, 1);
  auto runtime = std::make_shared<PeerVideoReceiverRuntime>();
  std::uint64_t output_frames = 0;
  std::size_t submitted = 0;
  for (std::size_t index = 0; index < packets.size(); ++index) {
    const auto pts = 50000000000ULL + index * 1024 * 1000000 / 44100;
    std::string error;
    const auto blocks = decode_audio_to_pcm_blocks(runtime, packets[index], "aac", timing(pts), &error);
    check(blocks.size() == 1 && error.empty(), "44.1 kHz mono AAC decodes through the existing FFmpeg resampler");
    if (!blocks.empty()) {
      const auto& block = blocks.front();
      check(block.pcm.size() % 2 == 0 && block.duration_us > 22000 && block.duration_us < 24000,
        "44.1 kHz PCM becomes 48 kHz stereo with normalized duration");
      check(block.timing.timestamp_valid && block.timing.timestamp_us <= pts &&
        pts - block.timing.timestamp_us < 1000,
        "source PTS accounts for resampler-held input without inventing a new source clock");
      output_frames += block.pcm.size() / 2;
      ++submitted;
    }
  }
  const auto expected_frames = submitted * 1024 * 48000 / 44100;
  check(output_frames <= expected_frames && expected_frames - output_frames <= 32,
    "fractional sample-rate conversion preserves stream duration with bounded filter delay");
  const auto stereo_packets = encode_packets("aac");
  if (!stereo_packets.empty()) {
    auto switched = decode_audio_to_pcm_blocks(runtime, stereo_packets.front(), "aac", timing(0, "source/next"), nullptr);
    check(switched.size() == 1 && switched.front().pcm.size() == 2048 &&
      switched.front().timing.timestamp_us == 0 && runtime->audio_decoder_runtime->resampler == nullptr,
      "source and format change discards old resampler delay and returns to the fast stereo path");
  }
  reset_peer_audio_decoder_runtime(*runtime);
  check(runtime->audio_decoder_runtime->resampler == nullptr &&
    runtime->audio_decoder_runtime->resampler_input_layout == nullptr,
    "decoder close releases resampler and layout resources");
}

void test_timed_codecs() {
  const auto pcmu = decode_audio_to_pcm_blocks({}, std::vector<std::uint8_t>(160, 0xff),
    "pcmu", timing(50000000000ULL), nullptr);
  check(pcmu.size() == 1 && pcmu.front().pcm.size() == 1920 && pcmu.front().duration_us == 20000,
    "PCMU 8 kHz mono converts to 48 kHz stereo with the correct duration");
  check(!pcmu.empty() && pcmu.front().timing.timestamp_us == 50000000000ULL,
    "PCMU preserves the source PTS");
  for (const auto& name : {std::string("opus"), std::string("aac")}) {
    auto packets = encode_packets(name);
    auto runtime = std::make_shared<PeerVideoReceiverRuntime>();
    check(packets.size() >= 3, name + " creates enough packets for PTS propagation");
    for (std::size_t index = 0; index < std::min<std::size_t>(3, packets.size()); ++index) {
      const auto pts = 50000000000ULL + index * (name == "aac" ? 21333ULL : 20000ULL);
      std::string error;
      auto blocks = decode_audio_to_pcm_blocks(runtime, packets[index], name, timing(pts), &error);
      check(blocks.size() == 1 && error.empty(), name + " timed packet decodes independently");
      if (!blocks.empty()) {
        check(blocks.front().timing.timestamp_valid && blocks.front().timing.timestamp_us == pts,
          name + " AVPacket PTS reaches AVFrame without RTP narrowing");
        check(blocks.front().timing.source_id == "source/1" && blocks.front().duration_us > 0,
          name + " PCM includes source and decoded duration");
      }
    }
    if (!packets.empty()) {
      std::string stale_error;
      auto stale = decode_audio_to_pcm_blocks(runtime, packets.front(), name,
        timing(50000000000ULL), &stale_error);
      check(stale.empty() && stale_error == "audio-decoder-stale-packet",
        name + " rejects stale or duplicate compressed packets before the codec");
      auto restarted = decode_audio_to_pcm_blocks(runtime, packets.front(), name, timing(7, "source/2"), nullptr);
      check(restarted.size() == 1 && restarted.front().timing.timestamp_us == 7 &&
        restarted.front().timing.source_id == "source/2", name + " new source flushes old decoder timing");
      auto invalid = decode_audio_to_pcm_blocks(runtime, packets.front(), name,
        timing(std::numeric_limits<std::uint64_t>::max()), nullptr);
      check(invalid.empty(), name + " rejects PTS outside FFmpeg's signed domain");
      auto sequence_timing = timing(100000, "sequence/1");
      sequence_timing.timestamp_valid = false;
      sequence_timing.sequence_valid = true;
      sequence_timing.sequence = 960;
      auto first_sequence = decode_audio_to_pcm_blocks(runtime, packets.front(), name, sequence_timing, nullptr);
      sequence_timing.sequence = 959;
      auto old_sequence = decode_audio_to_pcm_blocks(runtime, packets.front(), name, sequence_timing, &stale_error);
      check(!first_sequence.empty() && old_sequence.empty() && stale_error == "audio-decoder-stale-packet",
        name + " rejects stale sample sequence without assuming sequence increments by one");
    }
    reset_peer_audio_decoder_runtime(*runtime);
  }
}

void test_device_source_lifecycle() {
  if (waveOutGetNumDevs() == 0) { std::cout << "SKIP: no waveOut device for timed lifecycle\n"; return; }
  const auto old_volume = get_viewer_audio_software_volume();
  set_viewer_audio_software_volume(0.0f);
  set_viewer_audio_delay_ms(0);
  bool heard_clock = false;
  std::uint64_t last_pts = 0;
  for (std::uint64_t index = 0; index < 12; ++index) {
    queue_viewer_audio_pcm_block(std::vector<std::int16_t>(1920), timing(50000000000ULL + index * 20000));
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const auto clock = get_viewer_audio_playback_clock_snapshot();
    if (clock.valid) {
      check(clock.source_id == "source/1" && clock.timestamp_us >= last_pts,
        "actual waveOut reports monotonic source progress");
      last_pts = clock.timestamp_us;
      heard_clock = true;
    }
  }
  check(heard_clock, "actual device progress establishes a source clock");
  stop_viewer_audio_playback_source("other/9");
  check(viewer_audio_playback_is_active(), "closing an unrelated peer does not stop viewer audio");
  queue_viewer_audio_pcm_block(std::vector<std::int16_t>(1920), timing(0, "source/2"));
  const auto switched = get_viewer_audio_playback_clock_snapshot();
  check(!switched.valid || switched.source_id == "source/2", "source replacement invalidates the old device mapping");
  stop_viewer_audio_playback_source("source/2");
  const auto stopped = get_viewer_audio_playback_snapshot();
  check(!viewer_audio_playback_is_active() && !get_viewer_audio_playback_clock_snapshot().valid &&
    stopped.queued_pcm_frames == 0 && stopped.in_flight_pcm_frames == 0,
    "source stop releases the device, queue, and source clock");
  queue_viewer_audio_pcm_block(std::vector<std::int16_t>(1920), timing(0, "source/2/epoch=123"));
  stop_viewer_audio_playback_source("source/20");
  check(viewer_audio_playback_is_active(), "source prefix similarity cannot stop another receiver");
  stop_viewer_audio_playback_source("source/2");
  check(!viewer_audio_playback_is_active(), "receiver source stop includes its current wire epoch");
  for (int index = 0; index < 5; ++index) {
    queue_viewer_audio_pcm_block(std::vector<std::int16_t>(1920), timing(0));
    stop_viewer_audio_playback_source("source/1");
  }
  check(!viewer_audio_playback_is_active(), "rapid source start/stop does not leave a worker running");
  set_viewer_audio_software_volume(old_volume);
}

void test_deferred_aac_bursts() {
  if (waveOutGetNumDevs() == 0) { std::cout << "SKIP: no waveOut device for deferred AAC bursts\n"; return; }
  const auto packets = encode_packets("aac");
  if (packets.empty()) { return; }
  const auto previous_volume = get_viewer_audio_software_volume();
  set_viewer_audio_software_volume(0.0f);
  set_viewer_audio_delay_ms(0);
  auto receiver = std::make_shared<PeerVideoReceiverRuntime>();
  receiver->local_playback_enabled = true;
  receiver->startup_waiting_for_random_access = false;
  const auto before = get_viewer_audio_playback_snapshot();
  const auto started = std::chrono::steady_clock::now();
  std::uint64_t sequence = 0;
  std::uint64_t last_heard_pts = 0;
  unsigned int valid_observations = 0;
  unsigned long long peak_pcm = 0;
  auto inspect = [&]() {
    const auto snapshot = get_viewer_audio_playback_snapshot();
    const auto total = snapshot.queued_pcm_frames + snapshot.in_flight_pcm_frames;
    peak_pcm = std::max(peak_pcm, total);
    check(total <= snapshot.max_buffered_pcm_frames && snapshot.in_flight_pcm_frames <= 2880,
      "deferred decoding and scheduled PCM share the unchanged software/device budget");
    check(snapshot.queued_encoded_frames <= 24, "deferred compressed queue remains bounded");
    const auto clock = get_viewer_audio_playback_clock_snapshot();
    if (clock.valid && clock.source_id == "burst/1") {
      check(clock.timestamp_us >= last_heard_pts, "continuous AAC bursts keep the heard source clock monotonic");
      last_heard_pts = clock.timestamp_us;
      ++valid_observations;
    }
  };
  for (unsigned int round = 0; round < 10; ++round) {
    const auto deadline = started + std::chrono::microseconds(round * 11ULL * 1024 * 1000000 / 48000);
    while (std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      inspect();
    }
    for (unsigned int packet = 0; packet < 11; ++packet, ++sequence) {
      auto metadata = timing(sequence * 1024 * 1000000 / 48000, "burst/1");
      metadata.sequence_valid = true;
      metadata.sequence = sequence;
      check(queue_viewer_audio_encoded_frame(receiver, packets[packet % packets.size()], "aac", metadata),
        "complete AAC bursts are accepted without blocking ingress on PCM pressure");
    }
  }
  const auto final_deadline = started + std::chrono::milliseconds(2700);
  while (std::chrono::steady_clock::now() < final_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    inspect();
  }
  const auto after = get_viewer_audio_playback_snapshot();
  {
    std::lock_guard<std::mutex> lock(receiver->mutex);
    check(receiver->dispatched_audio_blocks == 110, "ten 11-AAC bursts decode every packet");
  }
  check(after.dropped_pcm_frames == before.dropped_pcm_frames &&
    after.dropped_encoded_frames == before.dropped_encoded_frames,
    "235 ms PES bursts cause zero PCM or compressed overflow loss");
  check(valid_observations > 100 && last_heard_pts > 2000000,
    "actual waveOut progresses through the continuous burst stream");
  std::cout << "deferred AAC bursts: packets=110 peak_pcm=" << peak_pcm << " clock_observations="
    << valid_observations << " pcm_dropped=" << after.dropped_pcm_frames - before.dropped_pcm_frames << '\n';
  stop_viewer_audio_playback_source("burst/1");
  reset_peer_audio_decoder_runtime(*receiver);

  // Simulate a short receiver lock stall, then a stall past the coded age limit.
  auto slow = std::make_shared<PeerVideoReceiverRuntime>();
  slow->local_playback_enabled = true;
  slow->startup_waiting_for_random_access = false;
  {
    std::unique_lock<std::mutex> lock(slow->mutex);
    for (unsigned int index = 0; index < 11; ++index) {
      check(queue_viewer_audio_encoded_frame(slow, packets[index % packets.size()], "aac",
        timing(index * 1024ULL * 1000000 / 48000, "slow/1")), "temporarily blocked receiver queues input");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  {
    std::lock_guard<std::mutex> lock(slow->mutex);
    check(slow->dispatched_audio_blocks == 11, "short receiver contention resumes all deferred work");
  }
  stop_viewer_audio_playback_source("slow/1");
  reset_peer_audio_decoder_runtime(*slow);
  {
    std::unique_lock<std::mutex> lock(slow->mutex);
    check(queue_viewer_audio_encoded_frame(slow, packets.front(), "aac", timing(0, "expired/1")),
      "age-limit fixture accepts a valid AU");
    std::this_thread::sleep_for(std::chrono::milliseconds(560));
    check(get_viewer_audio_playback_snapshot().queued_encoded_frames == 0,
      "stalled receiver cannot retain compressed work past 500 ms");
    // Worker uses try_lock, so stop can join even when this receiver is locked.
    stop_viewer_audio_playback_source("expired/1");
  }
  check(!viewer_audio_playback_is_active(), "joining a stalled decoder worker has no lock deadlock");
  for (int index = 0; index < 5; ++index) {
    auto metadata = timing(0, "rapid/epoch=1");
    check(queue_viewer_audio_encoded_frame(slow, packets.front(), "aac", metadata), "rapid encoded ingress starts");
    stop_viewer_audio_playback_source("rapid");
  }
  reset_peer_audio_decoder_runtime(*slow);
  check(!viewer_audio_playback_is_active() && get_viewer_audio_playback_snapshot().queued_encoded_frames == 0,
    "rapid source close clears compressed work and prevents decoder resurrection");
  set_viewer_audio_software_volume(previous_volume);
}

void test_legal_audio_blob_formats() {
  const auto low_rate = encode_packets("aac", 8000, 1);
  const auto normal = encode_packets("aac");
  if (low_rate.empty() || normal.empty()) { return; }
  check(viewer_audio_packet_device_frames("aac", low_rate.front()) == 6144,
    "legal AAC 8 kHz 128 ms access unit is recognized without a 120 ms format ban");
  check(viewer_audio_packet_device_frames("pcmu", std::vector<std::uint8_t>(1600)) == 9600,
    "legal 200 ms PCMU payload is recognized as a blob, not rejected as an oversized unit");
  const auto pcmu_large = decode_audio_to_pcm_blocks({}, std::vector<std::uint8_t>(10000, 0xff),
    "pcmu", timing(0), nullptr);
  check(pcmu_large.size() == 1 && pcmu_large.front().duration_us == 1250000,
    "PCMU decoding no longer imposes an arbitrary one-second format restriction");
  std::vector<std::uint8_t> joined;
  for (unsigned int index = 0; index < 11; ++index) {
    const auto& packet = normal[index % normal.size()];
    joined.insert(joined.end(), packet.begin(), packet.end());
  }
  check(viewer_audio_packet_device_frames("aac", joined) == 11264,
    "eleven ADTS access units remain valid in one 235 ms blob");
  if (waveOutGetNumDevs() == 0) { std::cout << "SKIP: no waveOut device for legal blob playback\n"; return; }
  const auto old_volume = get_viewer_audio_software_volume();
  set_viewer_audio_software_volume(0.0f);
  set_viewer_audio_delay_ms(0);
  auto play_blob = [&](const std::string& source, const std::string& codec,
                       const std::vector<std::uint8_t>& bytes, unsigned int units,
                       unsigned int duration_ms, bool expect_soft, bool timed = true) {
    auto receiver = std::make_shared<PeerVideoReceiverRuntime>();
    receiver->local_playback_enabled = true;
    receiver->startup_waiting_for_random_access = false;
    const auto before = get_viewer_audio_playback_snapshot();
    auto metadata = timing(0, source);
    metadata.timestamp_valid = timed;
    metadata.sequence_valid = true;
    metadata.sequence = 1;
    check(queue_viewer_audio_encoded_frame(receiver, bytes, codec, metadata), source + " valid blob enters playback");
    unsigned long long peak_frames = 0;
    bool observed_clock = false;
    const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(duration_ms + 180);
    while (std::chrono::steady_clock::now() < until) {
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
      const auto snapshot = get_viewer_audio_playback_snapshot();
      const auto total = snapshot.queued_pcm_frames + snapshot.in_flight_pcm_frames;
      peak_frames = std::max(peak_frames, total);
      check(snapshot.in_flight_pcm_frames <= 2880 && total <= snapshot.max_buffered_pcm_frames,
        source + " one-unit soft allowance never expands the device queue");
      check(snapshot.queued_encoded_frames <= 1, source + " tail stays in one cursor-backed compressed blob");
      const auto clock = get_viewer_audio_playback_clock_snapshot();
      observed_clock = observed_clock || (clock.valid && clock.source_id == source);
    }
    const auto after = get_viewer_audio_playback_snapshot();
    {
      std::lock_guard<std::mutex> lock(receiver->mutex);
      check(receiver->dispatched_audio_blocks == units, source + " every internal unit reaches playback");
    }
    check(after.dropped_pcm_frames == before.dropped_pcm_frames &&
      after.dropped_encoded_frames == before.dropped_encoded_frames,
      source + " legal audio duration causes no PCM or coded loss");
    check(observed_clock == timed && after.queued_encoded_frames == 0 && after.queued_pcm_frames == 0 &&
      after.in_flight_pcm_frames == 0, source + " actual device plays the entire blob and drains");
    check(after.max_buffered_pcm_frames == 5760, source + " temporary allowance returns to the 120 ms target");
    if (expect_soft) { check(peak_frames > 5760 && peak_frames <= 6144, source + " large AU gets a finite soft allowance"); }
    std::cout << "legal blob " << source << " units=" << units << " peak_pcm=" << peak_frames << " dropped=0\n";
    stop_viewer_audio_playback_source(source);
    reset_peer_audio_decoder_runtime(*receiver);
  };
  play_blob("aac8k/1", "aac", low_rate.front(), 1, 128, true);
  std::vector<std::uint8_t> low_rate_joined;
  for (std::size_t index = 0; index < std::min<std::size_t>(3, low_rate.size()); ++index) {
    low_rate_joined.insert(low_rate_joined.end(), low_rate[index].begin(), low_rate[index].end());
  }
  play_blob("aac8k3/1", "aac", low_rate_joined, 3, 384, false);
  play_blob("pcmu200/1", "pcmu", std::vector<std::uint8_t>(1600, 0xff), 10, 200, false);
  play_blob("adts235/1", "aac", joined, 11, 235, false);
  play_blob("pcmu1250/1", "pcmu", std::vector<std::uint8_t>(10000, 0xff), 63, 1250, false);
  play_blob("pcmu-rtp/1", "pcmu", std::vector<std::uint8_t>(10000, 0xff), 63, 1250, false, false);
  {
    auto wire = std::make_shared<PeerVideoReceiverRuntime>();
    wire->local_playback_enabled = true;
    wire->startup_waiting_for_random_access = false;
    auto metadata = timing(0, "wire/1");
    metadata.sequence_valid = true;
    metadata.sequence = 7;
    check(queue_viewer_audio_encoded_frame(wire, joined, "aac", metadata), "wire sequence accepts a complete multi-AU blob once");
    metadata.timestamp_us = 5000000;
    check(!queue_viewer_audio_encoded_frame(wire, joined, "aac", metadata),
      "duplicate wire sequence is rejected even if its timestamp claims to be newer");
    metadata.timestamp_us = 11ULL * 1024 * 1000000 / 48000;
    metadata.sequence = 8;
    check(queue_viewer_audio_encoded_frame(wire, normal.front(), "aac", metadata),
      "next genuine wire sequence follows cursor-based internal timestamps");
    std::this_thread::sleep_for(std::chrono::milliseconds(450));
    {
      std::lock_guard<std::mutex> lock(wire->mutex);
      check(wire->dispatched_audio_blocks == 12, "wire de-duplication does not reject subunits sharing the original blob sequence");
    }
    stop_viewer_audio_playback_source("wire/1");
    reset_peer_audio_decoder_runtime(*wire);
  }
  auto receiver = std::make_shared<PeerVideoReceiverRuntime>();
  receiver->local_playback_enabled = true;
  receiver->startup_waiting_for_random_access = false;
  check(queue_viewer_audio_encoded_frame(receiver, std::vector<std::uint8_t>(10000, 0xff),
    "pcmu", timing(0, "cancel/epoch=1")), "long legal blob can be cancelled during playback");
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  {
    std::lock_guard<std::mutex> lock(receiver->mutex);
    receiver->closing = true;
    receiver->local_playback_enabled = false;
  }
  stop_viewer_audio_playback_source("cancel");
  const auto cancelled = get_viewer_audio_playback_snapshot();
  check(!viewer_audio_playback_is_active() && cancelled.queued_encoded_frames == 0 &&
    cancelled.queued_pcm_frames == 0 && cancelled.in_flight_pcm_frames == 0,
    "cancel releases the blob cursor, scheduled PCM and device without an old callback resurrection");
  reset_peer_audio_decoder_runtime(*receiver);
  auto large = std::make_shared<PeerVideoReceiverRuntime>();
  large->local_playback_enabled = true;
  large->startup_waiting_for_random_access = false;
  check(queue_viewer_audio_encoded_frame(large, std::vector<std::uint8_t>(1024 * 1024 + 160, 0xff),
    "pcmu", timing(0, "large-coded/1")),
    "one validated compressed blob may exceed the memory target without a new format restriction");
  stop_viewer_audio_playback_source("large-coded/1");
  reset_peer_audio_decoder_runtime(*large);
  set_viewer_audio_software_volume(old_volume);
}
#endif
} // namespace

int main() {
  test_timing_policy();
  test_device_clock();
#ifdef _WIN32
  av_log_set_level(AV_LOG_ERROR);
  test_timed_codecs();
  test_resampled_aac();
  test_device_source_lifecycle();
  test_deferred_aac_bursts();
  test_legal_audio_blob_formats();
#endif
  std::cout << "viewer audio clock: " << assertions << " assertions, " << failures << " failures\n";
  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
