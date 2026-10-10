#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>

#include "media_audio.h"
#include "native_video_surface.h"
#include "viewer_audio_playback.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/log.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
}

namespace {

using SteadyClock = std::chrono::steady_clock;
constexpr int kWidth = 160;
constexpr int kHeight = 96;
constexpr int kFps = 30;
// 60 fps allows 250ms of a normal PES plus the observed audio device lead
// (at most the separate 500ms sustained-backlog guard) and two codec slots.
constexpr unsigned int kEncodedQueueLimit = 47;
constexpr unsigned int kDecodedQueueLimit = 2;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void ffmpeg_check(int result, const std::string& operation) {
  if (result >= 0) return;
  char message[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(result, message, sizeof(message));
  throw std::runtime_error(operation + ": " + message);
}

struct ContextDeleter { void operator()(AVCodecContext* value) const { avcodec_free_context(&value); } };
struct FrameDeleter { void operator()(AVFrame* value) const { av_frame_free(&value); } };
struct PacketDeleter { void operator()(AVPacket* value) const { av_packet_free(&value); } };
using CodecContext = std::unique_ptr<AVCodecContext, ContextDeleter>;
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
using Packet = std::unique_ptr<AVPacket, PacketDeleter>;

class HighResolutionWaiter {
 public:
  HighResolutionWaiter() {
    timer_ = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    require(timer_ != nullptr, "high-resolution waitable timer is required for reproducible hidden-window paint sampling");
  }
  ~HighResolutionWaiter() { if (timer_) CloseHandle(timer_); }
  HighResolutionWaiter(const HighResolutionWaiter&) = delete;
  HighResolutionWaiter& operator=(const HighResolutionWaiter&) = delete;
  void wait_for(std::chrono::microseconds duration) {
    if (duration.count() <= 0) return;
    LARGE_INTEGER due{};
    due.QuadPart = -duration.count() * 10;
    require(SetWaitableTimerEx(timer_, &due, 0, nullptr, nullptr, nullptr, 0) != FALSE,
      "arm high-resolution fixture timer");
    require(WaitForSingleObject(timer_, 500) == WAIT_OBJECT_0, "high-resolution fixture wait exceeded 500 ms");
  }
 private:
  HANDLE timer_ = nullptr;
};

struct EncodedAccessUnit {
  std::vector<std::uint8_t> bytes;
  std::int64_t pts = AV_NOPTS_VALUE;
  bool keyframe = false;
  bool configuration = false;
  int frame_rate = kFps;
};

bool has_annex_b_nal(const std::vector<std::uint8_t>& bytes, int type) {
  for (std::size_t i = 0; i + 3 < bytes.size(); ++i) {
    std::size_t payload = 0;
    if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1) payload = i + 3;
    else if (i + 4 < bytes.size() && bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1) payload = i + 4;
    if (payload && payload < bytes.size() && (bytes[payload] & 0x1f) == type) return true;
  }
  return false;
}

std::pair<EncodedAccessUnit, EncodedAccessUnit> split_parameter_sets(const EncodedAccessUnit& unit) {
  EncodedAccessUnit config;
  EncodedAccessUnit picture;
  config.pts = picture.pts = unit.pts;
  config.frame_rate = picture.frame_rate = unit.frame_rate;
  config.configuration = true;
  picture.keyframe = unit.keyframe;
  auto next_start = [&](std::size_t offset) {
    for (std::size_t i = offset; i + 3 < unit.bytes.size(); ++i) {
      if (unit.bytes[i] == 0 && unit.bytes[i + 1] == 0 &&
          (unit.bytes[i + 2] == 1 || (unit.bytes[i + 2] == 0 && unit.bytes[i + 3] == 1))) return i;
    }
    return unit.bytes.size();
  };
  for (std::size_t start = next_start(0); start < unit.bytes.size();) {
    const auto header = start + (unit.bytes[start + 2] == 1 ? 3 : 4);
    require(header < unit.bytes.size(), "fixture contains a truncated Annex B NAL");
    const auto end = next_start(header + 1);
    const auto type = unit.bytes[header] & 0x1f;
    auto& output = type == 7 || type == 8 ? config.bytes : picture.bytes;
    output.insert(output.end(), unit.bytes.begin() + static_cast<std::ptrdiff_t>(start), unit.bytes.begin() + static_cast<std::ptrdiff_t>(end));
    start = end;
  }
  require(has_annex_b_nal(config.bytes, 7) && has_annex_b_nal(config.bytes, 8), "split fixture requires both SPS and PPS");
  require(has_annex_b_nal(picture.bytes, 5) && !has_annex_b_nal(picture.bytes, 7) && !has_annex_b_nal(picture.bytes, 8),
    "split fixture IDR must omit all parameter sets");
  return {std::move(config), std::move(picture)};
}

std::vector<EncodedAccessUnit> encode_h264(int frame_count, int frame_rate = kFps, int b_frames = 2,
    int width = kWidth, int height = kHeight) {
  const AVCodec* encoder = avcodec_find_encoder_by_name("libx264");
  require(encoder != nullptr, "required FFmpeg libx264 encoder is unavailable; the native integration fixture cannot be skipped");
  CodecContext context(avcodec_alloc_context3(encoder));
  Frame frame(av_frame_alloc());
  Packet packet(av_packet_alloc());
  require(context && frame && packet, "unable to allocate H264 encoder fixture");
  context->width = width;
  context->height = height;
  context->pix_fmt = AV_PIX_FMT_YUV420P;
  context->time_base = {1, frame_rate};
  context->framerate = {frame_rate, 1};
  context->bit_rate = 300000;
  context->gop_size = 24;
  context->max_b_frames = b_frames;
  context->thread_count = 1;
  ffmpeg_check(av_opt_set(context->priv_data, "preset", "veryfast", 0), "set H264 encoder preset");
  const std::string x264_options = "bframes=" + std::to_string(b_frames) +
    ":b-adapt=0:scenecut=0:keyint=24:min-keyint=24:repeat-headers=1:annexb=1:rc-lookahead=0:sync-lookahead=0";
  ffmpeg_check(av_opt_set(context->priv_data, "x264-params", x264_options.c_str(), 0), "set H264 fixture options");
  ffmpeg_check(avcodec_open2(context.get(), encoder, nullptr), "open H264 encoder");
  frame->width = width;
  frame->height = height;
  frame->format = context->pix_fmt;
  ffmpeg_check(av_frame_get_buffer(frame.get(), 32), "allocate H264 source frame");

  std::vector<EncodedAccessUnit> output;
  auto receive = [&]() {
    for (;;) {
      const int result = avcodec_receive_packet(context.get(), packet.get());
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
      ffmpeg_check(result, "receive H264 access unit");
      require(packet->size > 0 && packet->pts != AV_NOPTS_VALUE, "H264 encoder must emit a nonempty access unit with presentation time");
      EncodedAccessUnit unit;
      unit.bytes.assign(packet->data, packet->data + packet->size);
      unit.pts = packet->pts;
      unit.frame_rate = frame_rate;
      unit.keyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;
      unit.configuration = has_annex_b_nal(unit.bytes, 7) && has_annex_b_nal(unit.bytes, 8);
      output.push_back(std::move(unit));
      av_packet_unref(packet.get());
    }
  };
  for (int index = 0; index < frame_count; ++index) {
    ffmpeg_check(av_frame_make_writable(frame.get()), "make H264 source writable");
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        frame->data[0][y * frame->linesize[0] + x] = static_cast<std::uint8_t>(32 + ((x + y + index * 3) % 176));
      }
    }
    for (int y = 0; y < height / 2; ++y) {
      std::memset(frame->data[1] + y * frame->linesize[1], 84 + index % 24, width / 2);
      std::memset(frame->data[2] + y * frame->linesize[2], 154 - index % 24, width / 2);
    }
    frame->pts = index;
    ffmpeg_check(avcodec_send_frame(context.get(), frame.get()), "submit H264 source frame");
    receive();
  }
  ffmpeg_check(avcodec_send_frame(context.get(), nullptr), "flush H264 encoder");
  receive();
  require(output.size() == static_cast<std::size_t>(frame_count), "H264 fixture must emit exactly one access unit per source frame");
  require(output.front().keyframe && output.front().configuration && has_annex_b_nal(output.front().bytes, 5), "H264 fixture must begin with Annex B SPS/PPS and IDR");
  bool reordered = false;
  for (std::size_t i = 1; i < output.size(); ++i) reordered = reordered || output[i].pts < output[i - 1].pts;
  require(b_frames == 0 || reordered, "B-frame fixture must contain reordered presentation timestamps from real encoding");
  return output;
}

void verify_encoded_fixture(const std::vector<EncodedAccessUnit>& units, bool require_b_frames = true) {
  const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_H264);
  require(decoder != nullptr, "H264 fixture reference decoder is unavailable");
  CodecContext context(avcodec_alloc_context3(decoder));
  Frame frame(av_frame_alloc());
  Packet packet(av_packet_alloc());
  require(context && frame && packet, "unable to allocate H264 fixture reference decoder");
  context->thread_count = 1;
  context->pkt_timebase = {1, units.front().frame_rate};
  ffmpeg_check(avcodec_open2(context.get(), decoder, nullptr), "open H264 fixture reference decoder");
  unsigned int decoded = 0;
  unsigned int b_frames = 0;
  std::int64_t last_pts = -1;
  auto receive = [&]() {
    for (;;) {
      const int result = avcodec_receive_frame(context.get(), frame.get());
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
      ffmpeg_check(result, "decode H264 fixture");
      require(frame->pts > last_pts, "H264 fixture reference decode must restore strictly increasing presentation time");
      last_pts = frame->pts;
      ++decoded;
      if (frame->pict_type == AV_PICTURE_TYPE_B) ++b_frames;
      av_frame_unref(frame.get());
    }
  };
  for (const auto& unit : units) {
    ffmpeg_check(av_new_packet(packet.get(), static_cast<int>(unit.bytes.size())), "allocate fixture reference packet");
    std::memcpy(packet->data, unit.bytes.data(), unit.bytes.size());
    packet->pts = unit.pts;
    ffmpeg_check(avcodec_send_packet(context.get(), packet.get()), "send fixture reference packet");
    av_packet_unref(packet.get());
    receive();
  }
  ffmpeg_check(avcodec_send_packet(context.get(), nullptr), "flush fixture reference decoder");
  receive();
  require(decoded == units.size() && (!require_b_frames || b_frames >= 20), "H264 fixture must fully decode and have its required picture types");
  std::cout << "fixture: H264 Annex B fps=" << units.front().frame_rate << ", packets=" << units.size() << ", decoded=" << decoded << ", B-pictures=" << b_frames << '\n';
}

class OffscreenOwner {
 public:
  OffscreenOwner() {
    // An owned window synchronously sends messages to its owner during create.
    // Keep that owner's real message loop alive while the caller waits for the
    // production surface worker to start, as an Electron owner would do.
    worker_ = std::thread([this]() {
      const HWND window = CreateWindowExW(WS_EX_TOOLWINDOW, L"STATIC", L"VDS native playback integration owner",
        WS_POPUP, -32000, -32000, 32, 32, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        handle_ = window;
        thread_id_ = GetCurrentThreadId();
        started_ = true;
      }
      started_condition_.notify_one();
      if (!window) return;
      MSG message{};
      while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_APP + 59) {
          paused_.store(true);
          Sleep(static_cast<DWORD>(message.wParam));
          paused_.store(false);
          continue;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      DestroyWindow(window);
    });
    std::unique_lock<std::mutex> lock(mutex_);
    started_condition_.wait(lock, [this]() { return started_; });
    if (!handle_) {
      lock.unlock();
      worker_.join();
      throw std::runtime_error("unable to create hidden owner window for real GDI surface");
    }
    if (IsWindowVisible(handle_)) {
      lock.unlock();
      PostThreadMessageW(thread_id_, WM_QUIT, 0, 0);
      worker_.join();
      throw std::runtime_error("integration owner window must remain hidden");
    }
  }
  ~OffscreenOwner() {
    if (worker_.joinable()) {
      PostThreadMessageW(thread_id_, WM_QUIT, 0, 0);
      worker_.join();
    }
  }
  HWND handle() const { return handle_; }
  void pause_messages() {
    require(PostThreadMessageW(thread_id_, WM_APP + 59, 500, 0) != FALSE, "pause owned fixture message loop");
    const auto deadline = SteadyClock::now() + std::chrono::seconds(1);
    while (!paused_.load() && SteadyClock::now() < deadline) Sleep(1);
    require(paused_.load(), "owned fixture entered its temporary busy state");
  }
 private:
  std::atomic<bool> paused_{false};
  HWND handle_ = nullptr;
  DWORD thread_id_ = 0;
  bool started_ = false;
  std::thread worker_;
  std::mutex mutex_;
  std::condition_variable started_condition_;
};

struct SurfaceFixture {
  explicit SurfaceFixture(const std::string& name, unsigned int source_frame_rate = 0) {
    NativeVideoSurfaceConfig config;
    config.surface_id = name;
    config.window_title = "VDS native playback integration " + name;
    config.codec = "h264";
    config.frame_rate = source_frame_rate;
    config.layout.embedded = true;
    config.layout.visible = false;
    std::ostringstream owner_handle;
    owner_handle << "0x" << std::hex << reinterpret_cast<std::uintptr_t>(owner.handle());
    config.layout.parent_window_handle = owner_handle.str();
    config.layout.x = -32000;
    config.layout.y = -32000;
    config.layout.width = 32;
    config.layout.height = 24;
    config.on_keyframe_needed = [this](const std::string&) { keyframe_requests.fetch_add(1); };
    std::string error;
    surface = create_native_video_surface(config, &error);
    require(surface && error.empty(), "start real native video surface: " + error);
    const std::wstring title(config.window_title.begin(), config.window_title.end());
    window = FindWindowW(L"VDSNativeVideoSurfaceWindow", title.c_str());
    require(window != nullptr && !IsWindowVisible(window), "native test surface must exist as a hidden GDI window");
    const auto stats = surface->snapshot();
    require(stats.attached && stats.running && stats.decoder_ready, "native surface must start its real decoder and UI worker");
    require(stats.decoded_frames == 0 && stats.painted_frames == 0, "decoder startup must not be reported as decoded or painted video");
  }
  ~SurfaceFixture() { if (surface) surface->close("integration-fixture-destroyed"); }
  OffscreenOwner owner;
  std::atomic<unsigned int> keyframe_requests{0};
  std::shared_ptr<NativeVideoSurface> surface;
  HWND window = nullptr;
};

std::string describe(const NativeVideoSurfaceSnapshot& stats) {
  std::ostringstream out;
  out << "running=" << stats.running << ", decoded=" << stats.decoded_frames << ", painted=" << stats.painted_frames
      << ", queued-encoded=" << stats.pending_encoded_frames << ", queued-decoded=" << stats.pending_decoded_frames
      << ", drop-encoded=" << stats.dropped_encoded_frames << ", drop-decoded=" << stats.dropped_decoded_frames
      << ", resets=" << stats.reference_chain_resets << ", needs-keyframe=" << stats.needs_keyframe
      << ", reason=" << stats.reason << ", error=" << stats.last_error;
  return out.str();
}

void inspect_queue_bounds(const NativeVideoSurfaceSnapshot& stats) {
  require(stats.pending_encoded_frames <= kEncodedQueueLimit, "encoded surface queue exceeded its time-based backlog limit: " + describe(stats));
  require(stats.pending_decoded_frames <= kDecodedQueueLimit, "decoded surface queue exceeded its 2-frame limit: " + describe(stats));
  require(stats.decoded_frames_rendered == stats.painted_frames, "rendered compatibility counter must count actual paints, not decoder outputs");
  require(stats.painted_frames <= stats.decoded_frames, "a video frame must not be counted as newly painted twice");
}

void pump_hidden_paint(SurfaceFixture& fixture) {
  require(IsWindow(fixture.window), "native surface window disappeared while playback was active");
  // Hidden windows are not painted by the desktop compositor. Exercise the
  // production WM_PAINT/GDI path explicitly; a successful message alone is not
  // playback proof, so callers also require a new painted_frames count.
  require(InvalidateRect(fixture.window, nullptr, FALSE) != FALSE, "invalidate hidden native surface");
  DWORD_PTR result = 0;
  require(SendMessageTimeoutW(fixture.window, WM_PAINT, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 500, &result) != 0,
    "native surface WM_PAINT did not complete within 500 ms");
  inspect_queue_bounds(fixture.surface->snapshot());
}

void wait_until(SurfaceFixture& fixture, const std::function<bool(const NativeVideoSurfaceSnapshot&)>& predicate,
    const std::string& description, std::chrono::milliseconds timeout = std::chrono::milliseconds(1800)) {
  const auto deadline = SteadyClock::now() + timeout;
  HighResolutionWaiter waiter;
  do {
    pump_hidden_paint(fixture);
    const auto stats = fixture.surface->snapshot();
    if (predicate(stats)) return;
    require(stats.running, "native surface stopped during " + description + ": " + describe(stats));
    waiter.wait_for(std::chrono::milliseconds(4));
  } while (SteadyClock::now() < deadline);
  throw std::runtime_error("timeout waiting for " + description + ": " + describe(fixture.surface->snapshot()));
}

MediaFrameTiming timing_for(const EncodedAccessUnit& unit, std::uint64_t sequence, const std::string& source_id) {
  require(unit.pts >= 0, "fixture presentation time must be nonnegative");
  MediaFrameTiming timing;
  timing.timestamp_us = static_cast<std::uint64_t>(av_rescale_q(unit.pts, {1, unit.frame_rate}, {1, 1000000}));
  timing.timestamp_valid = true;
  timing.sequence = sequence;
  timing.sequence_valid = true;
  timing.keyframe = unit.keyframe;
  timing.config = unit.configuration;
  timing.source_id = source_id;
  return timing;
}

void submit(SurfaceFixture& fixture, const EncodedAccessUnit& unit, std::uint64_t sequence, const std::string& source_id) {
  std::string error;
  const bool accepted = fixture.surface->submit_encoded_frame(unit.bytes, "h264", timing_for(unit, sequence, source_id), &error);
  require(accepted, "submit real H264 access unit: " + error);
  require(error.empty(), "accepted native H264 access unit left an error: " + error);
  inspect_queue_bounds(fixture.surface->snapshot());
}

void submit_paced(SurfaceFixture& fixture, const std::vector<EncodedAccessUnit>& units, std::size_t count,
    const std::string& source_id, std::uint64_t first_sequence = 1) {
  require(count <= units.size(), "paced fixture count exceeds encoded source");
  const auto began = SteadyClock::now();
  HighResolutionWaiter waiter;
  for (std::size_t i = 0; i < count; ++i) {
    submit(fixture, units[i], first_sequence + i, source_id);
    const auto deadline = began + std::chrono::microseconds(static_cast<std::int64_t>((i + 1) * 1000000 / units.front().frame_rate));
    while (SteadyClock::now() < deadline) {
      pump_hidden_paint(fixture);
      const auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(deadline - SteadyClock::now());
      waiter.wait_for(std::min(remaining, std::chrono::microseconds(500)));
    }
  }
}

void assert_closed(SurfaceFixture& fixture, const EncodedAccessUnit& unit) {
  const auto began = SteadyClock::now();
  fixture.surface->close("integration-close");
  require(SteadyClock::now() - began < std::chrono::seconds(2), "native surface shutdown exceeded two seconds");
  const auto closed = fixture.surface->snapshot();
  require(!closed.running && !closed.attached && !closed.decoder_ready, "closed native surface must stop decoder and UI worker");
  require(closed.pending_encoded_frames == 0 && closed.pending_decoded_frames == 0, "close must clear pending encoded and decoded surfaces");
  require(!IsWindow(fixture.window), "close must destroy the real surface HWND");
  std::string error;
  require(!fixture.surface->submit_encoded_frame(unit.bytes, "h264", timing_for(unit, 100000, "stale"), &error)
      && error == "native-video-surface-not-running", "old native surface must reject stale frames after close");
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  const auto later = fixture.surface->snapshot();
  require(later.decoded_frames == closed.decoded_frames && later.painted_frames == closed.painted_frames,
    "closed native surface must not decode or paint after shutdown");
  fixture.surface->close("integration-close-again");
}

void test_real_b_frame_paint(const std::vector<EncodedAccessUnit>& units) {
  SurfaceFixture fixture("b-frames");
  submit_paced(fixture, units, 48, "b-frame-source");
  wait_until(fixture, [](const auto& stats) { return stats.decoded_frames >= 42 && stats.painted_frames >= 36; },
    "real B-frame decode and GDI paint");
  const auto stats = fixture.surface->snapshot();
  require(stats.last_error.empty() && !stats.needs_keyframe, "paced valid B frames must preserve the reference chain: " + describe(stats));
  require(stats.dropped_encoded_frames == 0 && stats.reference_chain_resets == 0,
    "reordered B-frame PTS must not be treated as missing transport packets: " + describe(stats));
  std::cout << "paced-b-frames: " << describe(stats) << '\n';
  assert_closed(fixture, units.front());
}

void test_separate_configuration(const std::vector<EncodedAccessUnit>& units) {
  SurfaceFixture fixture("split-configuration");
  auto split = split_parameter_sets(units.front());
  submit(fixture, split.first, 1, "split-config-source");
  wait_until(fixture, [](const auto& stats) { return stats.pending_encoded_frames == 0; }, "separate SPS/PPS configuration consumption");
  const auto configured = fixture.surface->snapshot();
  require(configured.decoded_frames == 0 && configured.painted_frames == 0 && configured.last_error.empty(),
    "configuration-only AU must neither flush/error the decoder nor count as playback: " + describe(configured));
  auto pictures = units;
  pictures.front() = std::move(split.second);
  // CONFIG and its VCL picture share the transport sequence, as a cached
  // production bootstrap does. The IDR has no in-band SPS/PPS to hide bugs.
  submit_paced(fixture, pictures, 36, "split-config-source");
  wait_until(fixture, [](const auto& stats) { return stats.decoded_frames >= 30 && stats.painted_frames >= 24; },
    "separate cached configuration plus matching-sequence IDR and real GDI paints");
  const auto stats = fixture.surface->snapshot();
  require(stats.last_error.empty() && !stats.needs_keyframe && stats.dropped_encoded_frames == 0,
    "separate CONFIG/IDR bootstrap must preserve the reference chain: " + describe(stats));
  std::cout << "separate-config-and-idr: " << describe(stats) << '\n';
  assert_closed(fixture, units.front());
}

void test_burst_reference_recovery(const std::vector<EncodedAccessUnit>& units) {
  SurfaceFixture fixture("burst");
  for (std::size_t i = 0; i < units.size(); ++i) submit(fixture, units[i], i + 1, "burst-source");
  wait_until(fixture, [](const auto& stats) { return stats.dropped_encoded_frames > 0 && stats.reference_chain_resets > 0; },
    "bounded burst overload and reference-chain reset");

  const auto non_key = std::find_if(units.begin(), units.end(), [](const auto& unit) { return !unit.keyframe; });
  require(non_key != units.end(), "B-frame fixture must have a dependent access unit");
  submit(fixture, *non_key, units.size() + 17, "burst-source");
  wait_until(fixture, [](const auto& stats) { return stats.needs_keyframe; }, "sequence-gap keyframe gating");
  require(fixture.keyframe_requests.load() > 0, "native reference-chain recovery must request a new keyframe");
  const auto before_recovery = fixture.surface->snapshot();
  submit_paced(fixture, units, 36, "fresh-recovery-source");
  wait_until(fixture, [&](const auto& stats) {
    return !stats.needs_keyframe && stats.painted_frames >= before_recovery.painted_frames + 24;
  }, "new-source IDR recovery and resumed real GDI paint");
  const auto recovered = fixture.surface->snapshot();
  require(recovered.last_error.empty(), "valid IDR recovery must leave a healthy decoder: " + describe(recovered));
  std::cout << "burst-and-recovery: " << describe(recovered) << ", keyframe-requests=" << fixture.keyframe_requests.load() << '\n';
  assert_closed(fixture, units.front());
}

void test_active_close_and_reopen(const std::vector<EncodedAccessUnit>& units) {
  SurfaceFixture old("reopen");
  std::atomic<bool> stop{false};
  std::atomic<bool> producer_failed{false};
  std::thread producer([&]() {
    for (std::size_t i = 0; i < units.size() && !stop.load(); ++i) {
      std::string error;
      const bool accepted = old.surface->submit_encoded_frame(units[i].bytes, "h264", timing_for(units[i], i + 1, "closing-source"), &error);
      if ((!accepted && error != "native-video-surface-not-running") || (accepted && !error.empty())) producer_failed.store(true);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  });
  try {
    std::this_thread::sleep_for(std::chrono::milliseconds(12));
    assert_closed(old, units.front());
  } catch (...) {
    stop.store(true);
    producer.join();
    throw;
  }
  stop.store(true);
  producer.join();
  require(!producer_failed.load(), "concurrent submit/close returned an unexpected decoder error");

  SurfaceFixture reopened("reopen");
  submit_paced(reopened, units, 36, "reopened-source");
  wait_until(reopened, [](const auto& stats) { return stats.painted_frames >= 24 && stats.decoded_frames >= 30; },
    "fresh decode and real paint after reopening the same surface ID");
  require(reopened.surface->snapshot().last_error.empty(), "reopened surface must not inherit an old decoder failure");
  std::cout << "close-and-reopen: " << describe(reopened.surface->snapshot()) << '\n';
  assert_closed(reopened, units.front());
}

void test_continuous_60fps_and_network_steps() {
  const auto units = encode_h264(240, 60, 0);
  verify_encoded_fixture(units, false);
  SurfaceFixture fixture("continuous-60fps");
  const auto epoch = SteadyClock::now();
  HighResolutionWaiter waiter;
  SteadyClock::time_point last_pump;
  std::int64_t max_pump_interval_us = 0;
  std::int64_t max_input_lateness_us = 0;
  auto pump_until = [&](SteadyClock::time_point deadline) {
    while (SteadyClock::now() < deadline) {
      const auto now = SteadyClock::now();
      if (last_pump != SteadyClock::time_point{}) {
        max_pump_interval_us = std::max(max_pump_interval_us,
          std::chrono::duration_cast<std::chrono::microseconds>(now - last_pump).count());
      }
      last_pump = now;
      pump_hidden_paint(fixture);
      const auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(deadline - SteadyClock::now());
      waiter.wait_for(std::min(remaining, std::chrono::microseconds(500)));
    }
  };
  auto range = [&](std::size_t begin, std::size_t end, std::chrono::microseconds network_baseline) {
    for (std::size_t i = begin; i < end; ++i) {
      const auto frame_time = std::chrono::microseconds(static_cast<std::int64_t>(i * 1000000 / 60));
      pump_until(epoch + frame_time + network_baseline);
      max_input_lateness_us = std::max(max_input_lateness_us,
        std::chrono::duration_cast<std::chrono::microseconds>(SteadyClock::now() - epoch - frame_time - network_baseline).count());
      // These are the original source PTS and continuous transport sequences.
      // Only local arrival time changes; neither connection nor source epoch is restarted.
      submit(fixture, units[i], i + 1, "continuous-60fps-source");
      pump_until(epoch + std::chrono::microseconds(static_cast<std::int64_t>((i + 1) * 1000000 / 60)) + network_baseline);
    }
  };
  range(0, 120, std::chrono::microseconds(0));
  const auto normal = fixture.surface->snapshot();
  require(normal.painted_frames >= 108, "continuous 60fps must actually paint at least 90% of 120 source frames: " + describe(normal));
  require(normal.dropped_encoded_frames == 0 && normal.reference_chain_resets == 0,
    "normal 60fps must not overload its compressed queue or reset references: " + describe(normal));

  range(120, 180, std::chrono::milliseconds(120));
  const auto step_120 = fixture.surface->snapshot();
  const auto painted_after_120 = step_120.painted_frames - normal.painted_frames;
  require(painted_after_120 >= 51, "same-epoch +120ms network step must recover at least 85% of its following 60 frames: " + describe(step_120));

  // A further +200ms step, on top of the first baseline, exercises the larger
  // recovery window rather than reducing the second step to only +80ms.
  range(180, 240, std::chrono::milliseconds(320));
  const auto step_200 = fixture.surface->snapshot();
  const auto painted_after_200 = step_200.painted_frames - step_120.painted_frames;
  require(painted_after_200 >= 51, "same-epoch +200ms network step must recover at least 85% of its following 60 frames: " + describe(step_200));
  require(step_200.dropped_encoded_frames == 0 && step_200.reference_chain_resets == 0 && !step_200.needs_keyframe && step_200.last_error.empty(),
    "network baseline recovery must preserve the connection/reference chain: " + describe(step_200));
  require(step_200.buffer_delay_ms >= 20 && step_200.buffer_delay_ms <= 60, "surface adaptation must remain within its 20-60ms buffer budget");
  std::cout << "continuous-60fps-and-steps: normal-paints=" << normal.painted_frames << "/120, +120ms-paints="
    << painted_after_120 << "/60, +200ms-paints=" << painted_after_200 << "/60, fixture-max-paint-pump-gap-ms="
    << static_cast<double>(max_pump_interval_us) / 1000.0 << ", fixture-max-input-lateness-ms="
    << static_cast<double>(max_input_lateness_us) / 1000.0 << ", " << describe(step_200) << '\n';
  assert_closed(fixture, units.front());
}

std::vector<std::vector<std::uint8_t>> encode_aac_fixture() {
  const auto* encoder = avcodec_find_encoder_by_name("aac");
  require(encoder != nullptr, "real AAC encoder is required for the synchronized PES-burst fixture");
  CodecContext context(avcodec_alloc_context3(encoder));
  Frame frame(av_frame_alloc());
  Packet packet(av_packet_alloc());
  require(context && frame && packet, "allocate real AAC fixture");
  context->sample_rate = 48000;
  context->bit_rate = 96000;
  context->sample_fmt = AV_SAMPLE_FMT_FLTP;
  context->time_base = {1, 48000};
  av_channel_layout_default(&context->ch_layout, 2);
  ffmpeg_check(avcodec_open2(context.get(), encoder, nullptr), "open AAC fixture encoder");
  frame->format = context->sample_fmt;
  frame->sample_rate = context->sample_rate;
  frame->nb_samples = context->frame_size;
  require(frame->nb_samples == 1024, "48k AAC fixture uses 1024-sample access units");
  ffmpeg_check(av_channel_layout_copy(&frame->ch_layout, &context->ch_layout), "copy AAC stereo layout");
  ffmpeg_check(av_frame_get_buffer(frame.get(), 0), "allocate AAC source frame");
  std::vector<std::vector<std::uint8_t>> packets;
  auto receive = [&]() {
    for (;;) {
      const int result = avcodec_receive_packet(context.get(), packet.get());
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
      ffmpeg_check(result, "receive AAC fixture packet");
      const auto length = static_cast<unsigned int>(packet->size + 7);
      require(length < 8192u, "AAC fixture fits one ADTS access unit");
      // AAC-LC, 48kHz, stereo, no CRC: the native production input is ADTS.
      std::vector<std::uint8_t> adts = {0xff, 0xf1, 0x4c,
        static_cast<std::uint8_t>(0x80u | (length >> 11)),
        static_cast<std::uint8_t>(length >> 3),
        static_cast<std::uint8_t>(((length & 7u) << 5) | 0x1fu), 0xfc};
      adts.insert(adts.end(), packet->data, packet->data + packet->size);
      packets.push_back(std::move(adts));
      av_packet_unref(packet.get());
    }
  };
  for (int index = 0; index < 4; ++index) {
    ffmpeg_check(av_frame_make_writable(frame.get()), "make AAC source writable");
    for (int channel = 0; channel < 2; ++channel) {
      std::memset(frame->data[channel], 0, static_cast<std::size_t>(frame->nb_samples) * sizeof(float));
    }
    frame->pts = static_cast<std::int64_t>(index) * frame->nb_samples;
    ffmpeg_check(avcodec_send_frame(context.get(), frame.get()), "encode AAC source frame");
    receive();
  }
  ffmpeg_check(avcodec_send_frame(context.get(), nullptr), "flush AAC fixture encoder");
  receive();
  require(packets.size() >= 4, "real AAC encoder produces complete ADTS packets");
  return packets;
}

void test_real_1080p60_synchronized_pes_bursts() {
  const auto units = encode_h264(280, 60, 0, 1920, 1080);
  verify_encoded_fixture(units, false);
  const auto aac = encode_aac_fixture();
  require(waveOutGetNumDevs() > 0, "real waveOut device is required for audio-master PES-burst verification");
  const std::string source = "common-av-pes-burst-source";
  auto receiver = std::make_shared<PeerVideoReceiverRuntime>();
  receiver->local_playback_enabled = true;
  receiver->startup_waiting_for_random_access = false;
  struct AudioCleanup {
    std::shared_ptr<PeerVideoReceiverRuntime> receiver;
    float volume;
    ~AudioCleanup() {
      stop_viewer_audio_playback_runtime();
      reset_peer_audio_decoder_runtime(*receiver);
      set_viewer_audio_software_volume(volume);
    }
  } cleanup{receiver, get_viewer_audio_software_volume()};
  set_viewer_audio_software_volume(0.0f);
  set_viewer_audio_delay_ms(0);
  const auto audio_before = get_viewer_audio_playback_snapshot();
  SurfaceFixture fixture("1080p60-common-av-pes-burst", 60);
  const auto began = SteadyClock::now();
  HighResolutionWaiter waiter;
  unsigned int audio_active_batches = 0;
  unsigned int peak_encoded = 0;
  unsigned int peak_ready = 0;
  std::uint64_t longest_batch_submit_us = 0;
  auto inspect = [&]() {
    const auto stats = fixture.surface->snapshot();
    inspect_queue_bounds(stats);
    peak_encoded = std::max(peak_encoded, stats.pending_encoded_frames);
    peak_ready = std::max(peak_ready, stats.pending_decoded_frames);
  };
  auto pump_until = [&](SteadyClock::time_point deadline) {
    while (SteadyClock::now() < deadline) {
      pump_hidden_paint(fixture);
      inspect();
      waiter.wait_for(std::min(std::chrono::duration_cast<std::chrono::microseconds>(deadline - SteadyClock::now()),
        std::chrono::microseconds(500)));
    }
  };
  for (std::size_t batch = 0; batch < 20; ++batch) {
    pump_until(began + std::chrono::microseconds((batch + 1) * 11 * 1024 * 1000000 / 48000));
    const auto clock = get_viewer_audio_playback_clock_snapshot();
    if (clock.valid && clock.source_id == source) ++audio_active_batches;
    for (std::size_t index = 0; index < 11; ++index) {
      MediaFrameTiming timing;
      timing.source_id = source;
      timing.timestamp_valid = timing.sequence_valid = true;
      timing.sequence = batch * 11 + index;
      timing.timestamp_us = timing.sequence * 1024 * 1000000 / 48000;
      require(queue_viewer_audio_encoded_frame(receiver, aac[index % aac.size()], "aac", timing),
        "enqueue real 235ms AAC PES batch without blocking media ingress");
    }
    const auto batch_start = SteadyClock::now();
    for (std::size_t index = 0; index < 14; ++index) {
      const auto packet_index = batch * 14 + index;
      std::string error;
      require(fixture.surface->submit_encoded_frame(units[packet_index].bytes, "h264",
        timing_for(units[packet_index], packet_index + 1, source), &error), "submit complete video PES batch: " + error);
      inspect();
    }
    longest_batch_submit_us = std::max(longest_batch_submit_us, static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(SteadyClock::now() - batch_start).count()));
  }
  pump_until(SteadyClock::now() + std::chrono::milliseconds(400));
  const auto stats = fixture.surface->snapshot();
  const auto audio_after = get_viewer_audio_playback_snapshot();
  require(audio_active_batches >= 18, "audio master must actually be active throughout the PES-burst trial");
  require(stats.decoded_frames == 280 && stats.dropped_encoded_frames == 0 && stats.reference_chain_resets == 0 &&
    !stats.needs_keyframe && stats.last_error.empty(), "normal synchronized PES batches must preserve every H264 reference: " + describe(stats));
  require(stats.painted_frames >= 252, "235ms synchronized 1080p60 batches must actually paint at least 90% of 280 frames: " + describe(stats));
  require(audio_after.dropped_pcm_frames == audio_before.dropped_pcm_frames &&
    audio_after.dropped_encoded_frames == audio_before.dropped_encoded_frames,
    "normal synchronized PES batches must preserve every AAC frame");
  {
    std::lock_guard<std::mutex> lock(receiver->mutex);
    require(receiver->dispatched_audio_blocks == 220, "all 220 real AAC packets must decode through the existing worker");
  }
  std::cout << "1080p60-common-av-pes-burst: painted=" << stats.painted_frames << "/280, active-audio-batches="
    << audio_active_batches << "/20, audio-decoded=220/220, peak-encoded=" << peak_encoded << ", peak-ready=" << peak_ready
    << ", longest-14-AU-ingress-ms=" << static_cast<double>(longest_batch_submit_us) / 1000.0 << ", " << describe(stats) << '\n';
  assert_closed(fixture, units.front());
}

}  // namespace

int main() {
  std::cout << std::unitbuf;
  av_log_set_level(AV_LOG_ERROR);
  try {
    {
      SurfaceFixture fixture("input-owner-busy");
      fixture.owner.pause_messages();
      DWORD_PTR result = 0;
      require(SendMessageTimeoutW(fixture.window, WM_MOUSEACTIVATE, 0, 0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 100, &result) != 0,
        "native input must not synchronously wait for or attach the Electron owner's input queue");
      require(!IsWindowVisible(fixture.owner.handle()), "clicking an inactive surface must not reveal a hidden owner");
    }
    {
      SurfaceFixture fixture("input-visible-owner-busy");
      ShowWindowAsync(fixture.owner.handle(), SW_SHOWNOACTIVATE);
      const auto deadline = SteadyClock::now() + std::chrono::seconds(1);
      while (!IsWindowVisible(fixture.owner.handle()) && SteadyClock::now() < deadline) Sleep(1);
      require(IsWindowVisible(fixture.owner.handle()), "offscreen input owner is visible without activation");
      fixture.owner.pause_messages();
      DWORD_PTR result = 0;
      require(SendMessageTimeoutW(fixture.window, WM_MOUSEACTIVATE, 0, 0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 100, &result) != 0,
        "visible busy owner must not block the native mouse activation handler");
    }
    const auto units = encode_h264(180);
    verify_encoded_fixture(units);
    test_real_b_frame_paint(units);
    test_separate_configuration(units);
    test_burst_reference_recovery(units);
    test_active_close_and_reopen(units);
    test_continuous_60fps_and_network_steps();
    test_real_1080p60_synchronized_pes_bursts();
    std::cout << "native playback surface integration passed: real H264/B-frame decode, separate CONFIG/IDR bootstrap, hidden-window GDI paints, bounded burst recovery, concurrent close/reopen, sustained 60fps and same-epoch network steps.\n"
      << "This verifies software/GDI submission; physical display visibility, VSync and audible playback were not measured.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "native playback surface integration FAILED: " << error.what() << '\n';
    return 1;
  }
}
