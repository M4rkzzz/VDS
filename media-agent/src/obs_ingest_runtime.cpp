#include "obs_ingest_runtime.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
}

#include "agent_events.h"
#include "json_protocol.h"
#include "obs_ingest_media.h"
#include "obs_ingest_state.h"
#include "relay_dispatch.h"
#include "string_utils.h"
#include "time_utils.h"
#include "video_access_unit.h"

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
  AgentRuntimeState& state) {
  std::ostringstream payload;
  payload
    << "{\"state\":\"" << vds::media_agent::json_escape(state_name) << "\""
    << ",\"backend\":\"" << vds::media_agent::json_escape(state.host_backend) << "\""
    << ",\"captureTargetId\":\"" << vds::media_agent::json_escape(state.host_capture_target_id) << "\""
    << ",\"transportReady\":" << (state.peer_transport_backend.transport_ready ? "true" : "false")
    << ",\"obsIngest\":" << obs_ingest_json(state.obs_ingest)
    << "}";
  return payload.str();
}

}  // namespace

ObsIngestCommandResult prepare_obs_ingest_from_request(
  AgentRuntimeState& state,
  const std::string& request_json) {
  const bool refresh = vds::media_agent::extract_bool_value(request_json, "refresh", true);
  const int requested_port = vds::media_agent::extract_int_value(request_json, "port", 0);
  if (state.host_session_running && !is_obs_ingest_backend(state)) {
    return {false, {}, "HOST_SESSION_ACTIVE", "Native host session is already running"};
  }

  std::string prepare_error;
  if (!prepare_obs_ingest_session(state, refresh, requested_port, &prepare_error)) {
    return {false, {}, "OBS_INGEST_PREPARE_FAILED", prepare_error};
  }

  return {
    true,
    std::string("{\"backend\":\"obs-ingest\",\"transportReady\":") +
      std::string(state.peer_transport_backend.transport_ready ? "true" : "false") +
      ",\"obsIngest\":" + obs_ingest_json(state.obs_ingest) + "}",
    {},
    {}
  };
}

void clear_obs_ingest_prepared_session(AgentRuntimeState& state) {
  std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
  state.obs_ingest.prepared = false;
  state.obs_ingest.port = 0;
  state.obs_ingest.url.clear();
  state.obs_ingest.listen_url.clear();
  state.obs_ingest.width = 0;
  state.obs_ingest.height = 0;
  state.obs_ingest.frame_rate = 0;
  state.obs_ingest.audio_sample_rate = 48000;
  state.obs_ingest.audio_channel_count = 2;
  state.obs_ingest.video_packets_received = 0;
  state.obs_ingest.audio_packets_received = 0;
  state.obs_ingest.video_access_units_emitted = 0;
  state.obs_ingest.audio_frames_forwarded = 0;
  state.obs_ingest.video_codec = "h264";
  state.obs_ingest.audio_codec = "aac";
  state.obs_ingest.reason = "obs-ingest-idle";
  state.obs_ingest.last_error.clear();
  state.obs_ingest.pending_video_annexb_bytes.clear();
  state.obs_ingest.started_at_unix_ms = 0;
  state.obs_ingest.connected_at_unix_ms = 0;
  state.obs_ingest.last_packet_at_unix_ms = 0;
  state.obs_ingest.ended_at_unix_ms = 0;
}

bool prepare_obs_ingest_session(AgentRuntimeState& state, bool force_refresh, int requested_port, std::string* error) {
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
    std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
    if (!force_refresh && state.obs_ingest.prepared && state.obs_ingest.port == port &&
        !state.obs_ingest.url.empty() && !state.obs_ingest.listen_url.empty()) {
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
    std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
    state.obs_ingest.prepared = true;
    state.obs_ingest.local_only = true;
    state.obs_ingest.port = port;
    state.obs_ingest.url = publish_url;
    state.obs_ingest.listen_url = listen_url;
    state.obs_ingest.reason = "obs-ingest-prepared";
    state.obs_ingest.last_error.clear();
  }

  if (error) {
    error->clear();
  }
  return true;
}

bool is_obs_ingest_backend(const AgentRuntimeState& state) {
  return vds::media_agent::to_lower_copy(state.host_backend) == "obs-ingest";
}

void stop_obs_ingest_runtime(AgentRuntimeState& state, const std::string& reason) {
  state.obs_ingest.stop_requested.store(true);
  if (state.obs_ingest.worker.joinable()) {
    state.obs_ingest.worker.join();
  }
  {
    std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
    state.obs_ingest.waiting = false;
    state.obs_ingest.ingest_connected = false;
    state.obs_ingest.stream_running = false;
    state.obs_ingest.video_ready = false;
    state.obs_ingest.audio_ready = false;
    state.obs_ingest.listener_active = false;
    state.obs_ingest.reason = reason;
    state.obs_ingest.pending_video_annexb_bytes.clear();
  }
  clear_relay_upstream_bootstrap_state(kObsIngestVirtualUpstreamPeerId);
}

void obs_ingest_worker(AgentRuntimeState* state_ptr) {
  if (!state_ptr) {
    return;
  }

  AgentRuntimeState& state = *state_ptr;
  while (!state.obs_ingest.stop_requested.load()) {
    {
      std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
      state.obs_ingest.waiting = true;
      state.obs_ingest.ingest_connected = false;
      state.obs_ingest.stream_running = false;
      state.obs_ingest.video_ready = false;
      state.obs_ingest.audio_ready = false;
      state.obs_ingest.listener_active = true;
      state.obs_ingest.reason = "waiting-for-obs-ingest";
      state.obs_ingest.last_error.clear();
      state.obs_ingest.pending_video_annexb_bytes.clear();
      state.obs_ingest.started_at_unix_ms = vds::media_agent::current_time_millis();
      state.obs_ingest.connected_at_unix_ms = 0;
      state.obs_ingest.last_packet_at_unix_ms = 0;
      state.obs_ingest.ended_at_unix_ms = 0;
    }
    emit_event("media-state", obs_ingest_media_state_payload("obs-ingest-waiting", state));

    AVFormatContext* format_context = avformat_alloc_context();
    if (!format_context) {
      {
        std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
        state.obs_ingest.last_error = "obs-ingest-format-context-allocation-failed";
        state.obs_ingest.reason = "obs-ingest-open-failed";
      }
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest format context allocation failed.\"}");
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    format_context->interrupt_callback.callback = [](void* opaque) -> int {
      const auto* stop_flag = static_cast<std::atomic<bool>*>(opaque);
      return stop_flag && stop_flag->load() ? 1 : 0;
    };
    format_context->interrupt_callback.opaque = &state.obs_ingest.stop_requested;

    AVDictionary* options = nullptr;
    av_dict_set(&options, "listen_timeout", "2000", 0);
    av_dict_set(&options, "timeout", "2000000", 0);

    std::string listen_url;
    {
      std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
      listen_url = state.obs_ingest.listen_url.empty() ? state.obs_ingest.url : state.obs_ingest.listen_url;
    }

    const int open_result = avformat_open_input(&format_context, listen_url.c_str(), nullptr, &options);
    av_dict_free(&options);
    if (open_result < 0) {
      avformat_free_context(format_context);
      if (state.obs_ingest.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    if (avformat_find_stream_info(format_context, nullptr) < 0) {
      avformat_close_input(&format_context);
      {
        std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
        state.obs_ingest.reason = "obs-ingest-stream-info-failed";
        state.obs_ingest.last_error = "obs-ingest-stream-info-failed";
      }
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest stream info probe failed.\"}");
      if (state.obs_ingest.stop_requested.load()) {
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
      {
        std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
        state.obs_ingest.reason = "obs-ingest-video-codec-unsupported";
        state.obs_ingest.last_error = "obs-ingest-video-codec-unsupported";
      }
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest did not expose a supported H.264/H.265 video stream.\"}");
      if (state.obs_ingest.stop_requested.load()) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      continue;
    }

    if (audio_stream_index >= 0 && aac_config.sample_rate != 48000) {
      avformat_close_input(&format_context);
      {
        std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
        state.obs_ingest.reason = "obs-ingest-aac-sample-rate-unsupported";
        state.obs_ingest.last_error = "obs-ingest-aac-sample-rate-unsupported";
      }
      emit_event("warning", "{\"scope\":\"obs-ingest\",\"message\":\"OBS ingest AAC sample rate must be 48 kHz.\"}");
      if (state.obs_ingest.stop_requested.load()) {
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
      std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
      state.obs_ingest.waiting = false;
      state.obs_ingest.ingest_connected = true;
      state.obs_ingest.video_ready = false;
      state.obs_ingest.audio_ready = audio_stream_index >= 0;
      state.obs_ingest.connected_at_unix_ms = vds::media_agent::current_time_millis();
      state.obs_ingest.video_codec = video_codec;
      state.obs_ingest.audio_codec = audio_stream_index >= 0 ? "aac" : "";
      state.obs_ingest.audio_sample_rate = aac_config.sample_rate;
      state.obs_ingest.audio_channel_count = aac_config.channel_count;
      AVStream* video_stream = format_context->streams[video_stream_index];
      state.obs_ingest.width = video_stream && video_stream->codecpar ? video_stream->codecpar->width : 0;
      state.obs_ingest.height = video_stream && video_stream->codecpar ? video_stream->codecpar->height : 0;
      AVRational fps = video_stream && video_stream->avg_frame_rate.num > 0
        ? video_stream->avg_frame_rate
        : (video_stream ? video_stream->r_frame_rate : AVRational{0, 1});
      state.obs_ingest.frame_rate = fps.num > 0 && fps.den > 0
        ? static_cast<int>(av_q2d(fps) + 0.5)
        : 60;
      state.obs_ingest.reason = "obs-ingest-connected";
    }
    emit_event("media-state", obs_ingest_media_state_payload("obs-ingest-connected", state));

    AVPacket packet;
    av_init_packet(&packet);
    bool stream_running_emitted = false;
    while (!state.obs_ingest.stop_requested.load()) {
      const int read_result = av_read_frame(format_context, &packet);
      if (read_result < 0) {
        break;
      }

      {
        std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
        state.obs_ingest.last_packet_at_unix_ms = vds::media_agent::current_time_millis();
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
            std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
            state.obs_ingest.pending_video_annexb_bytes.insert(
              state.obs_ingest.pending_video_annexb_bytes.end(),
              bytes.begin(),
              bytes.end()
            );
            units = vds::media_agent::extract_annexb_video_access_units(
              video_codec,
              state.obs_ingest.pending_video_annexb_bytes,
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
          fanout_relay_video_units(kObsIngestVirtualUpstreamPeerId, video_codec, units, rtp_timestamp);
          {
            std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
            state.obs_ingest.video_ready = true;
            state.obs_ingest.stream_running = true;
            state.obs_ingest.video_packets_received += 1;
            state.obs_ingest.video_access_units_emitted += units.size();
            state.host_codec = video_codec;
          }
          if (!stream_running_emitted) {
            stream_running_emitted = true;
            emit_event("media-state", obs_ingest_media_state_payload("obs-stream-running", state));
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
          fanout_relay_audio_frame(kObsIngestVirtualUpstreamPeerId, framed, "aac", rtp_timestamp);
          std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
          state.obs_ingest.audio_packets_received += 1;
          state.obs_ingest.audio_frames_forwarded += 1;
        }
      }

      av_packet_unref(&packet);
    }

    av_packet_unref(&packet);
    if (video_bsf) {
      av_bsf_free(&video_bsf);
    }
    avformat_close_input(&format_context);
    clear_relay_upstream_bootstrap_state(kObsIngestVirtualUpstreamPeerId);

    if (state.obs_ingest.stop_requested.load()) {
      break;
    }

    {
      std::lock_guard<std::mutex> lock(state.obs_ingest.mutex);
      state.obs_ingest.ingest_connected = false;
      state.obs_ingest.stream_running = false;
      state.obs_ingest.video_ready = false;
      state.obs_ingest.audio_ready = false;
      state.obs_ingest.listener_active = false;
      state.obs_ingest.ended_at_unix_ms = vds::media_agent::current_time_millis();
      state.obs_ingest.reason = "obs-ingest-ended";
      state.obs_ingest.pending_video_annexb_bytes.clear();
    }
    emit_event("media-state", obs_ingest_media_state_payload("obs-ingest-ended", state));
  }
}
