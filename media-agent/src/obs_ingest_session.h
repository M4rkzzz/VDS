#pragma once

#include <functional>
#include <string>

struct AgentRuntimeState;
struct ObsIngestState;
struct HostSessionState;

struct ObsIngestCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};

struct ObsIngestSessionSnapshot {
  bool prepared = false;
  bool stream_running = false;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
  int audio_sample_rate = 48000;
  std::string video_codec = "h264";
  std::string audio_codec = "aac";
};

ObsIngestSessionSnapshot make_obs_ingest_session_snapshot(const ObsIngestState& session);

struct ObsIngestSessionRuntimeAccess {
  std::function<const HostSessionState&()> host_session_snapshot;
  std::function<bool()> peer_transport_ready;
  std::function<void(const std::string& codec)> set_host_video_codec;
};

ObsIngestSessionRuntimeAccess make_obs_ingest_runtime_access(
  AgentRuntimeState& state,
  HostSessionState& host_session);

class ObsIngestSession {
 public:
  ObsIngestSession(ObsIngestState& session, ObsIngestSessionRuntimeAccess access);

  ObsIngestCommandResult prepare_from_request(const std::string& request_json);

  std::string session_json() const;
  ObsIngestSessionSnapshot snapshot() const;
  bool prepare(bool force_refresh, int requested_port, std::string* error);
  void clear_prepared();
  void start_worker();
  void stop();

 private:
  static void run_worker(ObsIngestState* session, ObsIngestSessionRuntimeAccess access);
  ObsIngestSessionRuntimeAccess access_;
  ObsIngestState& session_;
};
