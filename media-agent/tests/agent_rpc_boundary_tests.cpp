// Exercise the real entry point with replaceable runtime boundaries: no capture,
// transport, or desktop is started by these exception and shutdown regressions.
#define main media_agent_entry_for_test
#include "../src/main.cpp"
#undef main

#include <new>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "agent_rpc_boundary.h"

namespace {
int checks = 0;
int failures = 0;
int init_failure = 0;
int rpc_failure = 0;
bool shutdown_failure = false;
bool diagnostic_failure = false;
int initialized = 0;
int rpc_calls = 0;
int shutdown_calls = 0;
int encoder_probe_calls = 0;
int wgc_probe_calls = 0;
std::string last_probe_encoder;

void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

void throw_failure(int kind) {
  if (kind == 1) throw std::runtime_error("injected runtime failure");
  if (kind == 2) throw 7;
}
}  // namespace

void initialize_agent_runtime(AgentRuntimeState&, const std::string&) {
  ++initialized;
  throw_failure(init_failure);
}

void run_agent_rpc_loop(AgentRuntimeState&) {
  ++rpc_calls;
  throw_failure(rpc_failure);
}

void shutdown_agent_runtime(AgentRuntimeState&) {
  ++shutdown_calls;
  if (shutdown_failure) throw std::runtime_error("injected shutdown failure");
}

void emit_event(const std::string&, const std::string&) {}
void emit_agent_breadcrumb(const std::string&) {
  if (diagnostic_failure) throw std::runtime_error("injected diagnostic failure");
}
std::string build_agent_ready_json(const AgentRuntimeState&) { return "{}"; }

int vds::media_agent::run_ffmpeg_encoder_probe_child(const std::string& encoder) {
  ++encoder_probe_calls;
  last_probe_encoder = encoder;
  return 71;
}
int run_wgc_capture_probe_child() {
  ++wgc_probe_calls;
  return 72;
}

namespace {
void test_control_character_serialization() {
  using vds::media_agent::json_escape;
  static constexpr char hex[] = "0123456789abcdef";
  for (unsigned code = 0; code < 32; ++code) {
    std::string expected;
    switch (code) {
      case '\b': expected = "\\b"; break;
      case '\f': expected = "\\f"; break;
      case '\n': expected = "\\n"; break;
      case '\r': expected = "\\r"; break;
      case '\t': expected = "\\t"; break;
      default: expected = std::string("\\u00") + hex[code >> 4] + hex[code & 15];
    }
    expect(json_escape(std::string(1, static_cast<char>(code))) == expected,
      "every JSON control character must have a legal escape");
  }
  const std::string utf8 = "\xe8\xa7\x82\xe7\x9c\x8b\xe8\x80\x85";
  expect(json_escape(utf8) == utf8, "UTF-8 names remain unchanged");
  expect(json_escape("\"\\") == "\\\"\\\\", "quote and backslash remain escaped");
  const auto error = vds::media_agent::build_error_payload(9, "INTERNAL_ERROR", std::string("peer\x01", 5));
  expect(error.find('\x01') == std::string::npos && error.find("\\u0001") != std::string::npos,
    "remote diagnostic controls cannot break an RPC response");
}

void test_request_isolation() {
  std::vector<std::string> errors;
  std::vector<int> accepted;
  const auto write_error = [&](int id, const std::string& code, const std::string& message) {
    errors.push_back(vds::media_agent::build_error_payload(id, code, message));
  };
  const auto handler = [&](int id, const std::string& method) {
    if (method == "throw") throw std::runtime_error(std::string("peer\x01", 5));
    if (method == "unknown-throw") throw 42;
    if (method == "allocation-throw") throw std::bad_alloc();
    accepted.push_back(id);
  };
  for (const auto* request : {
      "{\"id\":41,\"method\":\"throw\"}",
      "{\"id\":42,\"method\":\"ping\"}",
      "{\"id\":43,\"method\":\"unknown-throw\"}",
      "{\"id\":44,\"method\":\"allocation-throw\"}",
      "{\"id\":45,\"method\":\"ping\"}",
      "{\"id\":99999999999999999999,\"method\":\"ping\"}",
      "{\"id\":46}"}) {
    vds::media_agent::dispatch_agent_rpc_request(request, handler, write_error);
  }
  expect(accepted == std::vector<int>({42, 45}), "a failed RPC cannot prevent later requests from running");
  expect(errors.size() == 5, "each failed RPC receives one error response");
  expect(errors[0].find("\"id\":41") != std::string::npos &&
      errors[0].find("INTERNAL_ERROR") != std::string::npos &&
      errors[0].find("\\u0001") != std::string::npos,
    "RPC exceptions retain their request ID and safely escape diagnostics");
  expect(errors[1].find("\"id\":43") != std::string::npos, "non-standard exceptions retain the request ID");
  expect(errors[3].find("\"id\":0") != std::string::npos &&
      errors[3].find("BAD_REQUEST") != std::string::npos,
    "invalid numeric IDs cannot escape the request boundary");
  bool output_failure_escaped = false;
  try {
    vds::media_agent::dispatch_agent_rpc_request("{\"id\":47,\"method\":\"throw\"}", handler,
      [](int, const std::string&, const std::string&) { throw std::runtime_error("stdout-failed"); });
  } catch (const std::runtime_error&) {
    output_failure_escaped = true;
  }
  expect(output_failure_escaped, "broken RPC output reaches the entry point cleanup boundary");
}

void test_entry_point_cleanup() {
  std::ostringstream expected_diagnostics;
  auto* previous = std::cerr.rdbuf(expected_diagnostics.rdbuf());
  for (int phase = 0; phase < 8; ++phase) {
    initialized = rpc_calls = shutdown_calls = 0;
    init_failure = phase == 1 ? 1 : phase == 2 ? 2 : 0;
    rpc_failure = phase == 3 || phase == 6 ? 1 : phase == 4 ? 2 : 0;
    shutdown_failure = phase == 5 || phase == 7;
    diagnostic_failure = phase >= 6;
    const auto result = media_agent_entry_for_test(0, nullptr);
    expect(result == (phase == 0 ? 0 : 1), "entry point reports startup/RPC/shutdown failures");
    expect(initialized == 1 && shutdown_calls == 1, "runtime cleanup always runs exactly once");
    expect(rpc_calls == (init_failure ? 0 : 1), "failed initialization cannot enter the RPC loop");
  }
  std::cerr.rdbuf(previous);
}

void test_isolated_probe_entry_points() {
  initialized = rpc_calls = shutdown_calls = 0;
  encoder_probe_calls = wgc_probe_calls = 0;
  char executable[] = "agent";
  char encoder_mode[] = "--probe-video-encoder";
  char encoder[] = "libx264";
  char wgc_mode[] = "--probe-wgc-capability";
  char* encoder_arguments[] {executable, encoder_mode, encoder};
  expect(media_agent_entry_for_test(3, encoder_arguments) == 71 &&
      encoder_probe_calls == 1 && last_probe_encoder == "libx264",
      "isolated encoder mode forwards one requested codec and returns the child result");
  expect(media_agent_entry_for_test(2, encoder_arguments) == 1 && encoder_probe_calls == 1,
      "missing encoder argument cannot start the RPC runtime");
  char* wgc_arguments[] {executable, wgc_mode, encoder};
  expect(media_agent_entry_for_test(2, wgc_arguments) == 72 && wgc_probe_calls == 1,
      "isolated WGC mode returns only its capability result");
  expect(media_agent_entry_for_test(3, wgc_arguments) == 1 && wgc_probe_calls == 1,
      "unexpected WGC arguments cannot start the RPC runtime");
  expect(initialized == 0 && rpc_calls == 0 && shutdown_calls == 0,
      "all child diagnostic entry points bypass ordinary initialization, RPC, and shutdown");
}
}  // namespace

int main() {
  test_control_character_serialization();
  test_request_isolation();
  test_entry_point_cleanup();
  test_isolated_probe_entry_points();
  std::cout << "Agent RPC boundary: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
