#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "json_protocol.h"
#include "host_pipeline.h"
#include "obs_ingest_state.h"
#include "platform_utils.h"
#include "surface_target.h"
#include "video_access_unit.h"

namespace {

int g_failed_assertions = 0;

void expect_true(bool condition, const std::string& label) {
  if (condition) {
    return;
  }
  ++g_failed_assertions;
  std::cerr << "FAIL: " << label << '\n';
}

void expect_eq(const std::string& actual, const std::string& expected, const std::string& label) {
  if (actual == expected) {
    return;
  }
  ++g_failed_assertions;
  std::cerr << "FAIL: " << label << "\n  expected: " << expected << "\n  actual:   " << actual << '\n';
}

void expect_eq_int(int actual, int expected, const std::string& label) {
  if (actual == expected) {
    return;
  }
  ++g_failed_assertions;
  std::cerr << "FAIL: " << label << "\n  expected: " << expected << "\n  actual:   " << actual << '\n';
}

void test_json_protocol() {
  using namespace vds::media_agent;

  const std::string escaped = json_escape("quote\" slash\\ newline\n tab\t");
  expect_eq(escaped, "quote\\\" slash\\\\ newline\\n tab\\t", "json_escape handles common escapes");
  expect_eq(json_unescape(escaped), "quote\" slash\\ newline\n tab\t", "json_unescape reverses common escapes");
  expect_eq(trim_copy(" \t hello \r\n"), "hello", "trim_copy trims ASCII whitespace");
  expect_eq_int(extract_id(R"json({"jsonrpc":"2.0","id":42,"method":"ping"})json"), 42, "extract_id reads numeric id");
  expect_eq(extract_method(R"json({"jsonrpc":"2.0","method":"getStatus","id":1})json"), "getStatus", "extract_method reads method");
  expect_eq(extract_string_value(R"json({"peerId":"peer-1","source":"peer-video:abc"})json", "source"), "peer-video:abc", "extract_string_value reads string");
  expect_eq_int(extract_int_value(R"json({"port":61080})json", "port", 0), 61080, "extract_int_value reads int");
  expect_true(extract_bool_value(R"json({"refresh":true})json", "refresh", false), "extract_bool_value reads true");
  expect_eq(json_array_from_strings({"a", "b\"c"}), R"json(["a","b\"c"])json", "json_array_from_strings escapes values");
}

void test_obs_ingest_state() {
  expect_true(is_valid_obs_ingest_port(kMinObsIngestPort), "OBS min port is valid");
  expect_true(is_valid_obs_ingest_port(kMaxObsIngestPort), "OBS max port is valid");
  expect_true(!is_valid_obs_ingest_port(kMinObsIngestPort - 1), "OBS below min port is invalid");
  expect_eq_int(resolve_requested_obs_ingest_port(0), kDefaultObsIngestPort, "OBS default port resolves from zero");
  expect_eq_int(resolve_requested_obs_ingest_port(61081), 61081, "OBS explicit port is preserved");
  expect_eq(build_obs_ingest_publish_url(61080), "srt://127.0.0.1:61080?mode=caller&transtype=live", "OBS publish URL");
  expect_eq(
    build_obs_ingest_listen_url(61080),
    "srt://127.0.0.1:61080?mode=listener&transtype=live&latency=120&rcvlatency=120&peerlatency=120",
    "OBS listen URL"
  );
}

void test_host_pipeline_selection() {
  FfmpegProbeResult ffmpeg;
  ffmpeg.available = true;
  ffmpeg.path = "ffmpeg.exe";
  ffmpeg.video_encoders = {"libx264", "h264_nvenc", "libx265"};
  ffmpeg.audio_encoders = {"aac", "libopus"};

  expect_true(is_h264_video_encoder("h264_nvenc"), "h264 encoder detection");
  expect_true(is_h265_video_encoder("hevc_nvenc"), "h265 encoder detection");
  expect_eq(infer_video_encoder_backend("h264_nvenc"), "nvenc", "nvenc backend inference");
  expect_eq(infer_video_encoder_backend("libx264"), "software", "software backend inference");
  expect_eq(normalize_host_encoder_preset(" SPEED "), "speed", "host encoder preset normalization");
  expect_eq(normalize_host_encoder_preset("unknown"), "balanced", "host encoder preset fallback");
  expect_eq(normalize_host_encoder_tune("zerolatency"), "zerolatency", "host encoder tune normalization");
  expect_eq(normalize_host_encoder_tune("film"), "", "host encoder tune rejects unsupported value");
  expect_eq(normalize_host_keyframe_policy("500ms"), "0.5s", "host keyframe half-second normalization");
  expect_eq(normalize_host_keyframe_policy("allintra"), "all-intra", "host keyframe all-intra normalization");
  expect_eq(normalize_host_keyframe_policy("bad"), "1s", "host keyframe policy fallback");
  expect_eq(vds::media_agent::quote_command_path("C:\\tools\\ffmpeg.exe"), "C:\\tools\\ffmpeg.exe", "safe command path does not require quotes");
  expect_eq(vds::media_agent::quote_command_path("C:\\Program Files\\ffmpeg.exe"), "\"C:\\Program Files\\ffmpeg.exe\"", "path with spaces is quoted");
  expect_true(vds::media_agent::quote_command_path("C:\\bad|path\\ffmpeg.exe").find('|') != std::string::npos, "dangerous metachar path is contained in quotes");

  HostPipelineState hardware_pipeline = select_host_pipeline(ffmpeg, "h264", true, "", "quality", "zerolatency");
  expect_eq(hardware_pipeline.selected_video_encoder, "h264_nvenc", "hardware-preferred H.264 pipeline selects NVENC");
  expect_eq(hardware_pipeline.video_encoder_backend, "nvenc", "hardware-preferred H.264 pipeline backend");
  expect_eq(hardware_pipeline.selected_audio_encoder, "libopus", "host pipeline prefers libopus audio");
  expect_true(hardware_pipeline.hardware, "hardware-preferred H.264 pipeline is marked hardware");

  HostPipelineState software_pipeline = select_host_pipeline(ffmpeg, "h264", false, "", "speed", "");
  expect_eq(software_pipeline.selected_video_encoder, "libx264", "software-preferred H.264 pipeline selects libx264");
  expect_eq(software_pipeline.video_encoder_backend, "software", "software-preferred H.264 backend");

  HostPipelineState manual_pipeline = select_host_pipeline(ffmpeg, "h265", true, "libx265", "", "");
  expect_eq(manual_pipeline.selected_video_encoder, "libx265", "manual H.265 pipeline accepts matching encoder");
  expect_eq(manual_pipeline.requested_video_codec, "h265", "manual H.265 pipeline normalizes codec");

  HostPipelineState unavailable_pipeline = select_host_pipeline(ffmpeg, "h265", true, "hevc_nvenc", "", "");
  expect_eq(unavailable_pipeline.reason, "video-encoder-unavailable", "missing manual H.265 encoder reports unavailable");

  HostPipelineState keyframe_pipeline = software_pipeline;
  keyframe_pipeline.ready = true;
  keyframe_pipeline.validated = true;
  keyframe_pipeline.requested_keyframe_policy = "0.5s";
  HostCapturePlan keyframe_plan;
  keyframe_plan.ready = true;
  keyframe_plan.validated = true;
  keyframe_plan.capture_backend = "wgc";
  keyframe_plan.input_width = 1280;
  keyframe_plan.input_height = 720;
  keyframe_plan.frame_rate = 60;
  keyframe_plan.codec_path = "h264";
  const std::string keyframe_command = build_ffmpeg_peer_video_sender_command(ffmpeg, keyframe_pipeline, keyframe_plan);
  expect_true(keyframe_command.find(" -g 30") != std::string::npos, "0.5s keyframe policy maps to half-second GOP");
  expect_true(keyframe_command.find("n_forced*0.5") != std::string::npos, "0.5s keyframe policy maps force_key_frames");
}

void test_surface_target() {
  expect_true(is_host_capture_surface_target(" host-capture-preview "), "host capture target trims whitespace");
  expect_true(is_peer_video_surface_target("peer-video:viewer-1"), "peer video surface target");
  expect_true(is_peer_video_media_source("peer-video:viewer-1"), "peer video media source");
  expect_eq(extract_peer_id_from_surface_target("peer-video:Viewer-A"), "Viewer-A", "peer id preserves case");
  expect_eq(extract_peer_id_from_media_source("host-session-video"), "", "non-peer media source returns empty id");
}

void test_video_access_unit() {
  using namespace vds::media_agent;

  expect_eq(normalize_video_codec(" HEVC "), "h265", "HEVC normalizes to h265");
  expect_eq(normalize_video_codec("vp9", "h264"), "h264", "unknown codec falls back");

  const std::vector<std::uint8_t> h264_config = {
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80
  };
  const std::vector<std::uint8_t> h264_idr = {
    0x00, 0x00, 0x01, 0x65, 0x88, 0x84
  };
  expect_true(video_access_unit_has_decoder_config_nal("h264", h264_config), "H.264 config AU has SPS/PPS");
  expect_true(video_access_unit_has_random_access_nal("h264", h264_idr), "H.264 IDR is random access");
  expect_true(video_bootstrap_is_complete("h264", h264_config, h264_idr), "H.264 bootstrap is complete");

  std::vector<std::uint8_t> h264_buffer = {
    0x00, 0x00, 0x00, 0x01, 0x09, 0x10,
    0x00, 0x00, 0x00, 0x01, 0x65, 0x88,
    0x00, 0x00, 0x00, 0x01, 0x09, 0x10,
    0x00, 0x00, 0x00, 0x01, 0x41, 0x9a
  };
  const auto h264_units = extract_annexb_video_access_units("h264", h264_buffer, true);
  expect_eq_int(static_cast<int>(h264_units.size()), 2, "H.264 AUD-delimited access units extract on flush");
  expect_true(h264_buffer.empty(), "H.264 buffer is cleared after flush");

  const std::vector<std::uint8_t> h265_config = {
    0x00, 0x00, 0x00, 0x01, 0x40, 0x01,
    0x00, 0x00, 0x00, 0x01, 0x42, 0x01,
    0x00, 0x00, 0x00, 0x01, 0x44, 0x01
  };
  const std::vector<std::uint8_t> h265_idr = {
    0x00, 0x00, 0x00, 0x01, 0x26, 0x01, 0x80
  };
  expect_true(video_access_unit_has_decoder_config_nal("h265", h265_config), "H.265 config AU has VPS/SPS/PPS");
  expect_true(video_access_unit_has_random_access_nal("h265", h265_idr), "H.265 IDR is random access");
  expect_true(video_bootstrap_is_complete("h265", h265_config, h265_idr), "H.265 bootstrap is complete");
}

}  // namespace

int main() {
  test_json_protocol();
  test_obs_ingest_state();
  test_host_pipeline_selection();
  test_surface_target();
  test_video_access_unit();

  if (g_failed_assertions != 0) {
    std::cerr << g_failed_assertions << " unit test assertion(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "media-agent unit tests passed\n";
  return EXIT_SUCCESS;
}
