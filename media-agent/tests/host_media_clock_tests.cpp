#include "host_media_clock.h"
#include "peer_video_sender_state.h"
#include "video_bootstrap_helpers.h"

#include <cstdlib>
#include <iostream>

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}
}

int main() {
  using namespace vds::media_agent;
  HostMediaClockSnapshot clock;
  clock.epoch_steady_us = 1000000;
  clock.epoch_system_relative_100ns = 90000000;
  require(host_media_timestamp_us(clock, 1000000) == 0, "zero source PTS must be valid");
  require(host_media_timestamp_us(clock, 999999) == 0, "pre-epoch capture must clamp safely");
  require(host_media_timestamp_us(clock, 10000000) == 9000000, "late join must retain host source epoch");
  require(host_media_system_relative_timestamp_us(clock, 90500000) == 50000,
    "WGC capture timestamp must map to the same epoch as audio");

  const auto video_pts = host_media_timestamp_us(clock, 1100000);
  const auto audio_pts = host_media_packet_first_sample_us(host_media_timestamp_us(clock, 1110000), 480, 48000);
  require(video_pts == audio_pts, "capture completion time must not add audio packet duration to A/V offset");
  require(host_media_packet_first_sample_us(2000, 960, 48000) == 0, "audio capture near epoch must not underflow");
  require(host_media_samples_to_us(960, 48000) == 20000, "audio samples must use 48kHz time base");
  constexpr std::uint64_t long_pts = 5000000000000000ull;
  require(host_media_samples_to_us(host_media_us_to_samples(long_pts, 48000), 48000) == long_pts,
    "source clock conversion must not overflow an intermediate timestamp multiplication");

  require(host_media_next_synthetic_video_us(0, false, 16666, 9000000) == 9000000,
    "first internal-capture output must start at current host PTS");
  require(host_media_next_synthetic_video_us(9000000, true, 16666, 9020000) == 9016666,
    "normal synthesized cadence must preserve source frame interval");
  require(host_media_next_synthetic_video_us(9000000, true, 16666, 10000000) == 10000000,
    "capture stalls must not leave synthetic source clock arbitrarily behind");
  require(host_media_next_synthetic_video_us(9000000, true, 16666, 9000000) == 9000000,
    "buffered output must not invent source times in the future");

  const auto first = host_media_clock_snapshot();
  const auto same = host_media_clock_snapshot();
  require(!first.source_epoch.empty() && first.source_epoch.size() <= 128,
    "default host source epoch must be non-empty and fit the encoded protocol");
  require(first.source_epoch == same.source_epoch,
    "audio and video must expose the same host source epoch");
  require(first.generation == same.generation && first.epoch_steady_us == same.epoch_steady_us,
    "independent audio/video/late-peer consumers must share a stable epoch");
  reset_shared_host_media_clock();
  const auto next = host_media_clock_snapshot();
  require(next.generation == first.generation + 1 && next.epoch_steady_us >= first.epoch_steady_us,
    "host restart must explicitly advance clock generation");
  require(!next.source_epoch.empty() && next.source_epoch != first.source_epoch,
    "host restart must change the source epoch even within the same process");

  const std::vector<std::uint8_t> old_access_unit = {
    0, 0, 0, 1, 0x67, 0x11, 0, 0, 0, 1, 0x68, 0x22, 0, 0, 0, 1, 0x65, 0x33 };
  const std::vector<std::uint8_t> fresh_idr = { 0, 0, 0, 1, 0x65, 0x44 };
  const auto bootstrap = merge_video_decoder_config("h264", extract_video_decoder_config("h264", old_access_unit), fresh_idr);
  require(video_decoder_config_is_complete("h264", bootstrap), "fresh IDR bootstrap needs complete parameter sets");
  unsigned int pictures = 0;
  video_bootstrap_detail::visit_nals("h264", bootstrap, [&](unsigned int type, std::size_t, std::size_t) {
    if (type == 5) ++pictures;
  });
  require(pictures == 1 && bootstrap.back() == 0x44,
    "fresh bootstrap must not contain a cached old picture under the fresh picture's sequence");

  auto runtime = std::make_shared<PeerVideoSenderRuntime>();
  runtime->source_clock = host_media_clock_snapshot();
  const auto keyframe_handler = make_peer_video_sender_keyframe_request_handler(runtime);
  require(!runtime->soft_refresh_requested.load(), "new encoder must not start with an unsolicited refresh");
  require(keyframe_handler("waiting-for-first-idr") == "host-encoder-awaiting-bootstrap" &&
      !runtime->soft_refresh_requested.load(),
    "an encoder awaiting bootstrap must finish instead of restarting");
  runtime->soft_refresh_requested.store(true);
  require(keyframe_handler("waiting-with-geometry-refresh") == "host-encoder-awaiting-bootstrap" &&
      runtime->soft_refresh_requested.load(),
    "waiting for a keyframe must preserve a separately requested geometry refresh");
  runtime->soft_refresh_requested.store(false);
  runtime->pending_video_bootstrap = false;
  require(keyframe_handler("viewer-reference-chain-gap") == "host-encoder-refresh-requested" &&
      runtime->soft_refresh_requested.load(),
    "a received keyframe request must actually schedule the host encoder refresh");
  runtime->soft_refresh_requested.store(false);
  reset_shared_host_media_clock();
  require(keyframe_handler("request-for-previous-host-epoch") == "host-encoder-unavailable" &&
      !runtime->soft_refresh_requested.load(),
    "an old producer must reject keyframe requests after the host source epoch changes");
  runtime->source_clock = host_media_clock_snapshot();
  runtime->stop_requested.store(true);
  runtime->soft_refresh_requested.store(false);
  require(keyframe_handler("viewer-reference-chain-gap") == "host-encoder-unavailable" &&
      !runtime->soft_refresh_requested.load(),
    "an encoder being stopped must not accept late keyframe requests");
  runtime.reset();
  require(keyframe_handler("late-request") == "host-encoder-unavailable",
    "the transport handler must not retain or reopen an expired encoder runtime");

  std::cout << "host media source clock tests passed\n";
}
