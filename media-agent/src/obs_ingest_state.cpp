#include "obs_ingest_state.h"

#include <algorithm>
#include <mutex>
#include <sstream>

#include "json_protocol.h"
#include "obs_ingest_session_state.h"

std::string obs_ingest_json(const ObsIngestState& state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  std::ostringstream payload;
  payload
    << "{\"prepared\":" << (state.prepared ? "true" : "false")
    << ",\"waiting\":" << (state.waiting ? "true" : "false")
    << ",\"ingestConnected\":" << (state.ingest_connected ? "true" : "false")
    << ",\"streamRunning\":" << (state.stream_running ? "true" : "false")
    << ",\"port\":" << state.port
    << ",\"width\":" << state.width
    << ",\"height\":" << state.height
    << ",\"frameRate\":" << state.frame_rate
    << ",\"audioSampleRate\":" << state.audio_sample_rate
    << ",\"audioChannelCount\":" << state.audio_channel_count
    << ",\"videoPacketsReceived\":" << state.video_packets_received
    << ",\"url\":\"" << vds::media_agent::json_escape(state.url) << "\""
    << ",\"videoCodec\":\"" << vds::media_agent::json_escape(state.video_codec) << "\""
    << ",\"audioCodec\":\"" << vds::media_agent::json_escape(state.audio_codec) << "\""
    << "}";
  return payload.str();
}

bool is_valid_obs_ingest_port(int port) {
  return port >= kMinObsIngestPort && port <= kMaxObsIngestPort;
}

int resolve_requested_obs_ingest_port(int requested_port) {
  return requested_port > 0 ? requested_port : kDefaultObsIngestPort;
}

std::string build_obs_ingest_publish_url(int port) {
  return std::string("srt://127.0.0.1:") + std::to_string(std::max(1, port)) + "?mode=caller&transtype=live";
}

std::string build_obs_ingest_listen_url(int port) {
  return std::string("srt://127.0.0.1:") + std::to_string(std::max(1, port)) +
    "?mode=listener&transtype=live&latency=120&rcvlatency=120&peerlatency=120";
}
