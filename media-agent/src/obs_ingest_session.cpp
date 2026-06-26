#include "obs_ingest_session.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>


extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
}

#include "agent_events.h"
#include "host_session_state.h"
#include "host_session_runtime.h"
#include "json_protocol.h"
#include "obs_ingest_constants.h"
#include "obs_ingest_media.h"
#include "obs_ingest_state.h"
#include "obs_ingest_session_state.h"
#include "relay_hub.h"
#include "runtime_registry.h"
#include "string_utils.h"
#include "time_utils.h"
#include "video_access_unit.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

constexpr std::uint64_t kVideoRtpClockRate = 90000;

#ifdef _WIN32
bool ensure_winsock_started(std::string* error) {
  static std::once_flag winsock_once;
  static bool winsock_ready = false;
  static int winsock_error = 0;
  std::call_once(winsock_once, []() {
    WSADATA wsa_data;
    winsock_error = WSAStartup(MAKEWORD(2, 2), &wsa_data);
    winsock_ready = winsock_error == 0;
  });
  if (!winsock_ready && error) {
    *error = "winsock-startup-failed:" + std::to_string(winsock_error);
  }
  return winsock_ready;
}

bool is_loopback_udp_port_available(int port, std::string* error) {
  if (!ensure_winsock_started(error)) {
    return false;
  }

  if (!is_valid_obs_ingest_port(port)) {
    if (error) {
      *error = "obs-ingest-port-out-of-range:" + std::to_string(port);
    }
    return false;
  }

  SOCKET sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock == INVALID_SOCKET) {
    if (error) {
      *error = "obs-ingest-port-socket-create-failed";
    }
    return false;
  }

  sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<u_short>(port));

  if (bind(sock, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
    closesocket(sock);
    if (error) {
      *error = "obs-ingest-port-unavailable:" + std::to_string(port);
    }
    return false;
  }

  closesocket(sock);
  if (error) {
    error->clear();
  }
  return true;
}
#else
bool is_loopback_udp_port_available(int port, std::string* error) {
  if (!is_valid_obs_ingest_port(port)) {
    if (error) {
      *error = "obs-ingest-port-out-of-range:" + std::to_string(port);
    }
    return false;
  }
  if (error) {
    *error = "obs-ingest-port-validation-unsupported";
  }
  return false;
}
#endif

std::string obs_ingest_media_state_payload(
  const std::string& state_name,
  const HostSessionState& host_session,
  bool transport_ready,
  ObsIngestState& session) {
  std::ostringstream payload;
  payload
    << "{\"state\":\"" << vds::media_agent::json_escape(state_name) << "\""
    << ",\"backend\":\"" << vds::media_agent::json_escape(host_session.backend) << "\""
    << ",\"captureTargetId\":\"" << vds::media_agent::json_escape(host_session.capture_target_id) << "\""
    << ",\"transportReady\":" << (transport_ready ? "true" : "false")
    << ",\"obsIngest\":" << obs_ingest_json(session)
    << "}";
  return payload.str();
}

}  // namespace

ObsIngestSession::ObsIngestSession(ObsIngestState& session, ObsIngestSessionRuntimeAccess access)
    : access_(std::move(access)), session_(session) {}

ObsIngestSessionRuntimeAccess make_obs_ingest_runtime_access(
  AgentRuntimeState& state,
  HostSessionState& host_session) {
  return {
    [&host_session]() -> const HostSessionState& {
      return host_session;
    },
    [&state]() {
      return vds::media_agent::peer_transport_ready(state);
    },
    [&host_session](const std::string& codec) {
      vds::media_agent::set_host_video_codec(host_session, codec);
    }
  };
}

ObsIngestCommandResult ObsIngestSession::prepare_from_request(const std::string& request_json) {
  const HostSessionState& host_session = access_.host_session_snapshot();
  const bool refresh = vds::media_agent::extract_bool_value(request_json, "refresh", true);
  const int requested_port = vds::media_agent::extract_int_value(request_json, "port", 0);
  if (host_session.running && vds::media_agent::to_lower_copy(host_session.backend) != "obs-ingest") {
    return {false, {}, "HOST_SESSION_ACTIVE", "Native host session is already running"};
  }

  std::string prepare_error;
  if (!prepare(refresh, requested_port, &prepare_error)) {
    return {false, {}, "OBS_INGEST_PREPARE_FAILED", prepare_error};
  }

  return {
    true,
    std::string("{\"backend\":\"obs-ingest\",\"transportReady\":") +
      std::string(access_.peer_transport_ready() ? "true" : "false") +
      ",\"obsIngest\":" + session_json() + "}",
    {},
    {}
  };
}

std::string ObsIngestSession::session_json() const {
  return obs_ingest_json(session_);
}

ObsIngestSessionSnapshot make_obs_ingest_session_snapshot(const ObsIngestState& session) {
  ObsIngestSessionSnapshot snapshot;
  std::lock_guard<std::mutex> lock(session.mutex);
  snapshot.prepared = session.prepared;
  snapshot.stream_running = session.stream_running;
  snapshot.width = session.width;
  snapshot.height = session.height;
  snapshot.frame_rate = session.frame_rate;
  snapshot.audio_sample_rate = session.audio_sample_rate;
  snapshot.video_codec = session.video_codec;
  snapshot.audio_codec = session.audio_codec;
  return snapshot;
}

ObsIngestSessionSnapshot ObsIngestSession::snapshot() const {
  return make_obs_ingest_session_snapshot(session_);
}

bool ObsIngestSession::prepare(bool force_refresh, int requested_port, std::string* error) {
  const int port = resolve_requested_obs_ingest_port(requested_port);
  std::string publish_url;
  std::string listen_url;

  if (!is_valid_obs_ingest_port(port)) {
    if (error) {
      *error = "obs-ingest-port-out-of-range:" + std::to_string(port);
    }
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(session_.mutex);
    if (!force_refresh && session_.prepared && session_.port == port &&
        !session_.url.empty() && !session_.listen_url.empty()) {
      if (error) {
        error->clear();
      }
      return true;
    }
  }

  if (!is_loopback_udp_port_available(port, error)) {
    return false;
  }

  publish_url = build_obs_ingest_publish_url(port);
  listen_url = build_obs_ingest_listen_url(port);

  {
    std::lock_guard<std::mutex> lock(session_.mutex);
    session_.prepared = true;
    session_.port = port;
    session_.url = publish_url;
    session_.listen_url = listen_url;
  }

  if (error) {
    error->clear();
  }
  return true;
}

void ObsIngestSession::clear_prepared() {
  std::lock_guard<std::mutex> lock(session_.mutex);
  session_.prepared = false;
  session_.port = 0;
  session_.url.clear();
  session_.listen_url.clear();
  session_.width = 0;
  session_.height = 0;
  session_.frame_rate = 0;
  session_.audio_sample_rate = 48000;
  session_.audio_channel_count = 2;
  session_.video_packets_received = 0;
  session_.video_codec = "h264";
  session_.audio_codec = "aac";
  session_.pending_video_annexb_bytes.clear();
}

void ObsIngestSession::start_worker() {
  session_.stop_requested.store(false);
  session_.worker = std::thread(&ObsIngestSession::run_worker, &session_, access_);
}

void ObsIngestSession::stop() {
  session_.stop_requested.store(true);
  if (session_.worker.joinable()) {
    session_.worker.join();
  }
  {
    std::lock_guard<std::mutex> lock(session_.mutex);
    session_.waiting = false;
    session_.ingest_connected = false;
    session_.stream_running = false;
    session_.pending_video_annexb_bytes.clear();
  }
  relay_hub().clear_upstream_bootstrap_state(kObsIngestVirtualUpstreamPeerId);
}

void ObsIngestSession::run_worker(ObsIngestState* session_ptr, ObsIngestSessionRuntimeAccess access) {
  if (!session_ptr) {
    return;
  }

  ObsIngestState& session = *session_ptr;
  while (!session.stop_requested.load()) {
    {
      std::lock_guard<std::mutex> lock(session.mutex);
      session.waiting = true;
      session.ingest_connected = false;
      session.stream_running = false;
      session.pending_video_annexb_bytes.clear();
    }
    emit_event("media-state", obs_ingest_media_state_payload(
      "obs-ingest-waiting",
      access.host_session_snapshot(),
      access.peer_transport_ready(),
      session));

    AVFormatContext* format_context = avformat_alloc_context();
    if (!format_context) {
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest format context allocation failed.\"}");
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    format_context->interrupt_callback.callback = [](void* opaque) -> int {
      const auto* stop_flag = static_cast<std::atomic<bool>*>(opaque);
      return stop_flag && stop_flag->load() ? 1 : 0;
    };
    format_context->interrupt_callback.opaque = &session.stop_requested;

    AVDictionary* options = nullptr;
    av_dict_set(&options, "listen_timeout", "2000", 0);
    av_dict_set(&options, "timeout", "2000000", 0);

    std::string listen_url;
    {
      std::lock_guard<std::mutex> lock(session.mutex);
      listen_url = session.listen_url.empty() ? session.url : session.listen_url;
    }

    const int open_result = avformat_open_input(&format_context, listen_url.c_str(), nullptr, &options);
    av_dict_free(&options);
    if (open_result < 0) {
      avformat_free_context(format_context);
      if (session.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    if (avformat_find_stream_info(format_context, nullptr) < 0) {
      avformat_close_input(&format_context);
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest stream info probe failed.\"}");
      if (session.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    int video_stream_index = -1;
    int audio_stream_index = -1;
    std::string video_codec = "h264";
    ParsedAacConfig aac_config;
    for (unsigned int index = 0; index < format_context->nb_streams; ++index) {
      AVStream* stream = format_context->streams[index];
      if (!stream || !stream->codecpar) {
        continue;
      }
      if (video_stream_index < 0 && stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        if (stream->codecpar->codec_id == AV_CODEC_ID_H264) {
          video_stream_index = static_cast<int>(index);
          video_codec = "h264";
        } else if (stream->codecpar->codec_id == AV_CODEC_ID_HEVC) {
          video_stream_index = static_cast<int>(index);
          video_codec = "h265";
        }
      }
      if (audio_stream_index < 0 && stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && stream->codecpar->codec_id == AV_CODEC_ID_AAC) {
        audio_stream_index = static_cast<int>(index);
        aac_config = parse_aac_config(stream->codecpar);
      }
    }

    if (video_stream_index < 0) {
      avformat_close_input(&format_context);
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest did not expose a supported H.264/H.265 video stream.\"}");
      if (session.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    if (audio_stream_index >= 0 && aac_config.sample_rate != 48000) {
      avformat_close_input(&format_context);
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest AAC sample rate must be 48 kHz.\"}");
      if (session.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    AVBSFContext* video_bsf = nullptr;
    const char* bsf_name = vds::media_agent::normalize_video_codec(video_codec) == "h265" ? "hevc_mp4toannexb" : "h264_mp4toannexb";
    const AVBitStreamFilter* bsf = av_bsf_get_by_name(bsf_name);
    if (bsf) {
      if (av_bsf_alloc(bsf, &video_bsf) == 0 && video_bsf) {
        avcodec_parameters_copy(video_bsf->par_in, format_context->streams[video_stream_index]->codecpar);
        video_bsf->time_base_in = format_context->streams[video_stream_index]->time_base;
        if (av_bsf_init(video_bsf) < 0) {
          av_bsf_free(&video_bsf);
        }
      }
    }

    {
      std::lock_guard<std::mutex> lock(session.mutex);
      session.waiting = false;
      session.ingest_connected = true;
      session.video_codec = video_codec;
      session.audio_codec = audio_stream_index >= 0 ? "aac" : "";
      session.audio_sample_rate = aac_config.sample_rate;
      session.audio_channel_count = aac_config.channel_count;
      AVStream* video_stream = format_context->streams[video_stream_index];
      session.width = video_stream && video_stream->codecpar ? video_stream->codecpar->width : 0;
      session.height = video_stream && video_stream->codecpar ? video_stream->codecpar->height : 0;
      AVRational fps = video_stream && video_stream->avg_frame_rate.num > 0
        ? video_stream->avg_frame_rate
        : (video_stream ? video_stream->r_frame_rate : AVRational{0, 1});
      session.frame_rate = fps.num > 0 && fps.den > 0
        ? static_cast<int>(av_q2d(fps) + 0.5)
        : 60;
    }
    emit_event("media-state", obs_ingest_media_state_payload(
      "obs-ingest-connected",
      access.host_session_snapshot(),
      access.peer_transport_ready(),
      session));

    AVPacket packet;
    av_init_packet(&packet);
    bool stream_running_emitted = false;
    while (!session.stop_requested.load()) {
      const int read_result = av_read_frame(format_context, &packet);
      if (read_result < 0) {
        break;
      }

      if (packet.stream_index == video_stream_index) {
        auto handle_video_packet = [&](const AVPacket& ready_packet) {
          std::vector<std::uint8_t> bytes(
            ready_packet.data,
            ready_packet.data + ready_packet.size
          );
          auto units = vds::media_agent::extract_annexb_video_access_units(
            video_codec,
            bytes,
            true
          );
          if (units.empty()) {
            std::lock_guard<std::mutex> lock(session.mutex);
            session.pending_video_annexb_bytes.insert(
              session.pending_video_annexb_bytes.end(),
              bytes.begin(),
              bytes.end()
            );
            units = vds::media_agent::extract_annexb_video_access_units(
              video_codec,
              session.pending_video_annexb_bytes,
              false
            );
          }
          if (units.empty()) {
            return;
          }
          const std::uint32_t rtp_timestamp = packet_timestamp_at_clock_rate(
            format_context->streams[video_stream_index],
            &ready_packet,
            static_cast<int>(kVideoRtpClockRate)
          );
          relay_hub().publish_video_units(kObsIngestVirtualUpstreamPeerId, video_codec, units, rtp_timestamp);
          {
            std::lock_guard<std::mutex> lock(session.mutex);
            session.stream_running = true;
            session.video_packets_received += 1;
            access.set_host_video_codec(video_codec);
          }
          if (!stream_running_emitted) {
            stream_running_emitted = true;
            emit_event("media-state", obs_ingest_media_state_payload(
              "obs-stream-running",
              access.host_session_snapshot(),
              access.peer_transport_ready(),
              session));
          }
        };

        if (video_bsf) {
          av_bsf_send_packet(video_bsf, &packet);
          while (true) {
            AVPacket filtered_packet;
            av_init_packet(&filtered_packet);
            const int receive_result = av_bsf_receive_packet(video_bsf, &filtered_packet);
            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
              av_packet_unref(&filtered_packet);
              break;
            }
            if (receive_result < 0) {
              av_packet_unref(&filtered_packet);
              break;
            }
            handle_video_packet(filtered_packet);
            av_packet_unref(&filtered_packet);
          }
        } else {
          handle_video_packet(packet);
        }
      } else if (audio_stream_index >= 0 && packet.stream_index == audio_stream_index) {
        auto framed = build_adts_framed_aac(packet.data, static_cast<std::size_t>(packet.size), aac_config);
        if (!framed.empty()) {
          const std::uint32_t rtp_timestamp = packet_timestamp_at_clock_rate(
            format_context->streams[audio_stream_index],
            &packet,
            48000
          );
          relay_hub().publish_audio_frame(kObsIngestVirtualUpstreamPeerId, framed, "aac", rtp_timestamp);
        }
      }

      av_packet_unref(&packet);
    }

    av_packet_unref(&packet);
    if (video_bsf) {
      av_bsf_free(&video_bsf);
    }
    avformat_close_input(&format_context);
    relay_hub().clear_upstream_bootstrap_state(kObsIngestVirtualUpstreamPeerId);

    if (session.stop_requested.load()) {
      break;
    }

    {
      std::lock_guard<std::mutex> lock(session.mutex);
      session.ingest_connected = false;
      session.stream_running = false;
      session.pending_video_annexb_bytes.clear();
    }
    emit_event("media-state", obs_ingest_media_state_payload(
      "obs-ingest-ended",
      access.host_session_snapshot(),
      access.peer_transport_ready(),
      session));
  }
}
