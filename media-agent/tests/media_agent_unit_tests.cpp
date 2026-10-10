#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "agent_runtime.h"
#include "json_protocol.h"
#include "host_pipeline.h"
#include "obs_ingest_state.h"
#include "platform_utils.h"
#include "peer_stun_config.h"
#include "runtime_registry.h"
#include "session_registries.h"
#include "session_owner_activation.h"
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
  expect_eq(normalize_host_keyframe_policy("2s"), "2s", "host keyframe two-second normalization");
  expect_eq(normalize_host_keyframe_policy("bad"), "2s", "host keyframe policy fallback");
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
  // A forced I picture need not be a random-access IDR. Late viewers and
  // reference-chain recovery require the latter, beyond the very first frame.
  for (const std::string encoder : {"h264_amf", "hevc_amf", "h264_nvenc", "hevc_nvenc"}) {
    keyframe_pipeline.selected_video_encoder = encoder;
    keyframe_pipeline.requested_video_codec = encoder.find("hevc") == 0 ? "h265" : "h264";
    keyframe_plan.codec_path = keyframe_pipeline.requested_video_codec;
    const std::string command = build_ffmpeg_peer_video_sender_command(ffmpeg, keyframe_pipeline, keyframe_plan);
    const std::string flag = encoder.find("amf") != std::string::npos ? " -forced_idr 1" : " -forced-idr 1";
    expect_true(command.find(flag) != std::string::npos, "hardware forced keyframes must be random-access IDR");
    expect_true(command.find(" -g 30") != std::string::npos, "IDR recovery preserves selected GOP policy");
  }
}

void test_surface_target() {
  expect_true(is_host_capture_surface_target(" host-capture-preview "), "host capture target trims whitespace");
  expect_true(is_peer_video_surface_target("peer-video:viewer-1"), "peer video surface target");
  expect_true(is_peer_video_media_source("peer-video:viewer-1"), "peer video media source");
  expect_eq(extract_peer_id_from_surface_target("peer-video:Viewer-A"), "Viewer-A", "peer id preserves case");
  expect_eq(extract_peer_id_from_media_source("host-session-video"), "", "non-peer media source returns empty id");
}

void test_session_registries() {
  HostSessionRegistry host_registry;
  AudioSessionRegistry audio_registry;
  ObsIngestSessionRegistry obs_registry;

  expect_eq(host_registry.active_session_id(), "host-default", "host registry default active session id");
  expect_eq(audio_registry.active_session_id(), "audio-default", "audio registry default active session id");
  expect_eq(obs_registry.active_session_id(), "obs-ingest-default", "OBS registry default active session id");

  host_registry.active_session().capture_target_id = "host-session-test";
  audio_registry.active_session().backend_mode = "audio-session-test";
  obs_registry.active_session().video_codec = "obs-session-test";

  expect_eq(host_registry.active_session().capture_target_id, "host-session-test", "host active session keeps default state");
  expect_eq(audio_registry.active_session().backend_mode, "audio-session-test", "audio active session keeps default state");
  expect_eq(obs_registry.active_session().video_codec, "obs-session-test", "OBS active session keeps default state");

  host_registry.ensure_session("host-secondary").capture_target_id = "host-secondary-target";
  audio_registry.ensure_session("audio-secondary").backend_mode = "audio-secondary-backend";
  obs_registry.ensure_session("obs-secondary").video_codec = "obs-secondary-codec";
  expect_eq_int(static_cast<int>(host_registry.session_count()), 2, "host registry tracks secondary session");
  expect_eq_int(static_cast<int>(audio_registry.session_count()), 2, "audio registry tracks secondary session");
  expect_eq_int(static_cast<int>(obs_registry.session_count()), 2, "OBS registry tracks secondary session");

  expect_true(host_registry.activate_session("host-secondary"), "host registry activates secondary session");
  expect_true(audio_registry.activate_session("audio-secondary"), "audio registry activates secondary session");
  expect_true(obs_registry.activate_session("obs-secondary"), "OBS registry activates secondary session");
  expect_eq(host_registry.active_session_id(), "host-secondary", "host active id switches to secondary");
  expect_eq(audio_registry.active_session_id(), "audio-secondary", "audio active id switches to secondary");
  expect_eq(obs_registry.active_session_id(), "obs-secondary", "OBS active id switches to secondary");
  expect_eq(host_registry.active_session().capture_target_id, "host-secondary-target", "host active session returns secondary state");
  expect_eq(audio_registry.active_session().backend_mode, "audio-secondary-backend", "audio active session returns secondary state");
  expect_eq(obs_registry.active_session().video_codec, "obs-secondary-codec", "OBS active session returns secondary state");
  expect_true(!host_registry.activate_session(""), "host registry rejects empty active session id");
  expect_eq(host_registry.active_session_id(), "host-secondary", "failed host activation keeps active id");

  AgentRuntimeState runtime_state;
  expect_true(vds::media_agent::activate_host_session(runtime_state, "media-session-unit"), "runtime activates host session id");
  expect_true(vds::media_agent::activate_audio_session(runtime_state, "media-session-unit"), "runtime activates audio session id");
  expect_true(vds::media_agent::activate_obs_ingest_session(runtime_state, "media-session-unit"), "runtime activates OBS session id");
  expect_eq(vds::media_agent::active_host_session_id(runtime_state), "media-session-unit", "runtime host active id switches");
  expect_eq(vds::media_agent::active_audio_session_id(runtime_state), "media-session-unit", "runtime audio active id switches");
  expect_eq(vds::media_agent::active_obs_ingest_session_id(runtime_state), "media-session-unit", "runtime OBS active id switches");
  expect_eq_int(static_cast<int>(vds::media_agent::host_session_count(runtime_state)), 2, "runtime host session count tracks activated id");
  expect_eq_int(static_cast<int>(vds::media_agent::audio_session_count(runtime_state)), 2, "runtime audio session count tracks activated id");
  expect_eq_int(static_cast<int>(vds::media_agent::obs_ingest_session_count(runtime_state)), 2, "runtime OBS session count tracks activated id");
  expect_true(!vds::media_agent::activate_host_session(runtime_state, ""), "runtime host rejects empty session id");
  expect_eq(vds::media_agent::active_host_session_id(runtime_state), "media-session-unit", "runtime failed host activation keeps active id");
}

void test_peer_stun_config() {
  using namespace vds::media_agent;
  for (const std::string& server : {
      "stun:stun.linphone.org:3478", "stun:stun.cloudflare.com", "stun:127.0.0.1:1",
      "stun:[2001:db8::1]:65535", "stun:[::1]", "stun:[::ffff:127.0.0.1]:3478"}) {
    expect_true(is_valid_peer_stun_server(server), "valid STUN URI is accepted: " + server);
  }
  for (const std::string& server : {
      "", "stun:", "turn:relay.example.com:3478", "turns:relay.example.com:5349",
      "relay:relay.example.com:3478", "stun://example.com:3478", "stun:user@example.com",
      "stun:example.com/path", "stun:example.com?transport=tcp", "stun:example.com#relay",
      "stun:example.com:0", "stun:example.com:65536", "stun:example.com:abc",
      "stun:example.com:", "stun:bad..example.com", "stun:-bad.example.com",
      "stun:example.com\n", "stun:[:::]:3478", "stun:2001:db8::1"}) {
    expect_true(!is_valid_peer_stun_server(server), "invalid/relay STUN URI is rejected: " + server);
  }
  expect_true(!is_valid_peer_stun_server("stun:" + std::string(252, 'a')), "oversized STUN URI is rejected");
  std::string server;
  expect_true(parse_peer_stun_server_request("{}", &server) && server.empty(), "absent STUN option preserves defaults");
  expect_true(parse_peer_stun_server_request(R"json({"stunServer":"stun:stun.linphone.org:3478"})json", &server) &&
    server == "stun:stun.linphone.org:3478", "request preserves the selected STUN server");
  expect_true(!parse_peer_stun_server_request(R"json({"stunServer":""})json", &server), "explicit empty STUN option is rejected");
  expect_true(!parse_peer_stun_server_request(R"json({"stunServer":null})json", &server), "non-string STUN option is rejected");
  expect_true(parse_peer_stun_server_request(R"json({"metadata":{"stunServer":"turn:ignored.example:3478"}})json", &server) &&
    server.empty(), "nested STUN fields cannot configure the transport");
  expect_true(!parse_peer_stun_server_request(R"json({"stunServer":"stun:one.example","stunServer":"stun:two.example"})json", &server),
    "duplicate top-level STUN option is rejected");
  std::vector<std::string> servers;
  const std::string rpc_pool = R"json({"id":1,"method":"createPeer","params":{"peerId":"rpc-peer","stunServer":"stun:127.0.0.1:3478","stunServers":["stun:127.0.0.1:3478","stun:[::1]:3478"]}})json";
  expect_true(parse_peer_stun_server_request(rpc_pool, &server) && server == "stun:127.0.0.1:3478",
    "real JSON-RPC params preserves the selected single STUN server");
  expect_true(parse_peer_stun_servers_request(rpc_pool, &servers) &&
    servers == std::vector<std::string>({"stun:127.0.0.1:3478", "stun:[::1]:3478"}),
    "real JSON-RPC params preserves the STUN pool and IPv6 brackets");
  expect_true(parse_peer_stun_server_request(R"json({"params":{"metadata":{"stunServer":"turn:ignored.example"}}})json", &server) && server.empty(),
    "params does not recursively read arbitrary nested single STUN fields");
  expect_true(parse_peer_stun_servers_request(R"json({"params":{"metadata":{"stunServers":["turn:ignored.example"]}}})json", &servers) && servers.empty(),
    "params does not recursively read arbitrary nested STUN pools");
  expect_true(parse_peer_stun_server_request(R"json({"params":{}})json", &server) && server.empty(), "empty params keeps single STUN defaults");
  expect_true(parse_peer_stun_servers_request(R"json({"params":{}})json", &servers) && servers.empty(), "empty params keeps STUN pool defaults");
  for (const std::string& request : {
      R"json({"params":null})json", R"json({"params":[]})json", R"json({"params":true})json", R"json({"params":"{}"})json",
      R"json({"params":{},"params":{}})json", R"json({"params":{},"stunServer":"stun:one.example"})json",
      R"json({"params":{},"stunServers":[]})json",
      R"json({"params":{"stunServer":"stun:one.example"},"stunServer":"stun:one.example"})json",
      R"json({"params":{"stunServers":["stun:one.example"]},"stunServers":["stun:one.example"]})json"}) {
    server = "stun:unchanged.example";
    servers = {"stun:unchanged.example"};
    expect_true(!parse_peer_stun_server_request(request, &server) && server.empty(), "invalid or ambiguous params cannot select single STUN: " + request);
    expect_true(!parse_peer_stun_servers_request(request, &servers) && servers.empty(), "invalid or ambiguous params cannot select STUN pool: " + request);
  }
  for (const std::string& request : {
      R"json({"params":{"stunServer":"turn:relay.example"}})json", R"json({"params":{"stunServer":null}})json",
      R"json({"params":{"stunServer":3478}})json", R"json({"params":{"stunServer":""}})json",
      R"json({"params":{"stunServer":"stun:one.example","stunServer":"stun:one.example"}})json"}) {
    expect_true(!parse_peer_stun_server_request(request, &server) && server.empty(), "invalid single STUN in params is rejected: " + request);
  }
  expect_true(parse_peer_stun_servers_request("{}", &servers) && servers.empty(), "absent STUN pool preserves defaults");
  expect_true(parse_peer_stun_servers_request(R"json({"stunServers":[]})json", &servers) && servers.empty(), "empty STUN pool is valid");
  expect_true(parse_peer_stun_servers_request(R"json({"stunServer":"stun:one.example","stunServers":[]})json", &servers),
    "single STUN option remains compatible with an empty pool");
  expect_true(parse_peer_stun_servers_request(R"json({"stunServers":["stun:[2001:db8::1]:3478","stun:[::1]","stun:three.example","stun:four.example:65535"]})json", &servers) &&
    servers == std::vector<std::string>({"stun:[2001:db8::1]:3478", "stun:[::1]", "stun:three.example", "stun:four.example:65535"}),
    "four-entry STUN pool preserves IPv6 brackets and order");
  expect_true(parse_peer_stun_servers_request(R"json({"stunServers":["stun:one.example","stun:one.example","stun:two.example"]})json", &servers) &&
    servers == std::vector<std::string>({"stun:one.example", "stun:two.example"}), "STUN pool deduplicates after validating raw count");
  expect_true(parse_peer_stun_servers_request(R"json({"stunServers":["stun:\u005b::1\u005d:3478"],"nested":{"stunServers":["turn:ignored.example"]}})json", &servers) &&
    servers == std::vector<std::string>({"stun:[::1]:3478"}), "JSON escaped IPv6 brackets are decoded correctly");
  expect_true(parse_peer_stun_servers_request(R"json({"nested":{"stunServers":["turn:ignored.example"]}})json", &servers) && servers.empty(),
    "nested STUN pools cannot configure the transport");
  for (const std::string& request : {
      R"json({"stunServers":null})json", R"json({"stunServers":"stun:one.example"})json",
      R"json({"stunServers":[1]})json", R"json({"stunServers":[false]})json", R"json({"stunServers":[null]})json",
      R"json({"stunServers":[{}]})json", R"json({"stunServers":[[]]})json", R"json({"stunServers":[""]})json",
      R"json({"stunServers":["turn:relay.example:3478"]})json", R"json({"stunServers":["turns:relay.example:5349"]})json",
      R"json({"stunServers":["stun:example:65536"]})json", R"json({"stunServers":["stun:example:0"]})json",
      R"json({"stunServers":["stun:[:::]:3478"]})json", R"json({"stunServers":["stun:one.example",]})json",
      R"json({"stunServers":["stun:one.example"] garbage})json", R"json({"stunServers":["stun:one.example"})json",
      R"json({"stunServers":["stun:one.example" "stun:two.example"]})json",
      R"json({"stunServers":["stun:one.example"],"stunServers":[]})json",
      R"json({"stunServers":["stun:one.example","stun:one.example","stun:one.example","stun:one.example","stun:one.example"]})json",
      R"json({"stunServers":["stun:one.example"]} trailing)json",
      R"json([{"stunServers":["stun:one.example"]}])json"}) {
    servers = {"stun:unchanged.example"};
    expect_true(!parse_peer_stun_servers_request(request, &servers) && servers.empty(), "invalid STUN pool is rejected without partial output: " + request);
    const std::string rpc = "{\"id\":1,\"method\":\"createPeer\",\"params\":" + request + "}";
    servers = {"stun:unchanged.example"};
    expect_true(!parse_peer_stun_servers_request(rpc, &servers) && servers.empty(), "invalid STUN pool in JSON-RPC params is rejected without partial output: " + request);
  }
  expect_true(!parse_peer_stun_servers_request("{\"stunServers\":[\"stun:" + std::string(252, 'a') + "\"]}", &servers),
    "oversized STUN pool entry is rejected");
}

void test_session_owner_activation() {
  using namespace vds::media_agent;
  AgentRuntimeState state;
  const std::string owner_a = R"json({"mediaSessionId":"owner-a"})json";
  const std::string owner_b = R"json({"sessionId":"owner-b"})json";
  expect_true(activate_media_owner_sessions_from_request(state, owner_a), "inactive owners can select a session");
  expect_true(activate_media_owner_sessions_from_request(state, "{}"), "legacy requests retain the active owner");

  auto expect_owner_a_unchanged = [&state]() {
    expect_eq(active_host_session_id(state), "owner-a", "rejected switch preserves host owner");
    expect_eq(active_audio_session_id(state), "owner-a", "rejected switch preserves audio owner");
    expect_eq(active_obs_ingest_session_id(state), "owner-a", "rejected switch preserves OBS owner");
    expect_eq_int(static_cast<int>(host_session_count(state)), 2, "rejected switch creates no host registry entry");
    expect_eq_int(static_cast<int>(audio_session_count(state)), 2, "rejected switch creates no audio registry entry");
    expect_eq_int(static_cast<int>(obs_ingest_session_count(state)), 2, "rejected switch creates no OBS registry entry");
  };

  active_host_session(state).running = true;
  expect_true(!activate_media_owner_sessions_from_request(state, owner_b), "running host prevents media owner switch");
  expect_true(!activate_audio_owner_session_from_request(state, owner_b), "running host prevents audio owner switch");
  expect_true(activate_media_owner_sessions_from_request(state, owner_a), "same host owner remains selectable for stop and restart");
  expect_true(active_host_session(state).running, "rejected switch does not stop the active host");
  expect_owner_a_unchanged();
  active_host_session(state).running = false;

  active_audio_session(state).capture_active = true;
  expect_true(!activate_media_owner_sessions_from_request(state, owner_b), "capturing audio prevents media owner switch");
  expect_true(!activate_audio_owner_session_from_request(state, owner_b), "capturing audio prevents audio owner switch");
  expect_true(activate_audio_owner_session_from_request(state, owner_a), "same audio owner remains selectable for stop");
  expect_owner_a_unchanged();
  active_audio_session(state).capture_active = false;

  // A finished but unjoined worker must also keep its owner selected until stop.
  active_obs_ingest_session(state).worker = std::thread([]() {});
  expect_true(!activate_media_owner_sessions_from_request(state, owner_b), "joinable OBS worker prevents media owner switch");
  expect_true(!activate_audio_owner_session_from_request(state, owner_b), "joinable OBS worker prevents audio owner switch");
  expect_true(activate_media_owner_sessions_from_request(state, owner_a), "same OBS owner remains selectable for stop");
  expect_owner_a_unchanged();
  active_obs_ingest_session(state).worker.join();

  expect_true(activate_media_owner_sessions_from_request(state, owner_b), "stopped owners can switch to the next session");
  expect_eq(active_host_session_id(state), "owner-b", "successful switch updates host owner");
  expect_eq(active_audio_session_id(state), "owner-b", "successful switch updates audio owner");
  expect_eq(active_obs_ingest_session_id(state), "owner-b", "successful switch updates OBS owner");
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
  test_session_registries();
  test_session_owner_activation();
  test_peer_stun_config();
  test_video_access_unit();

  if (g_failed_assertions != 0) {
    std::cerr << g_failed_assertions << " unit test assertion(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "media-agent unit tests passed\n";
  return EXIT_SUCCESS;
}
