#include "ffmpeg_probe.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <regex>
#include <set>
#include <sstream>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/mem.h>
}

#include "json_protocol.h"
#include "platform_utils.h"
#include "process_runner.h"
#include "string_utils.h"

namespace fs = std::filesystem;

namespace vds::media_agent {
namespace {

std::string ffmpeg_error_string(int error_code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(error_code, buffer, sizeof(buffer));
  return std::string(buffer);
}

std::string json_object_from_video_encoder_probe(const VideoEncoderProbeResult& probe) {
  std::ostringstream payload;
  payload
    << "{\"name\":\"" << json_escape(probe.name) << "\""
    << ",\"exists\":" << (probe.exists ? "true" : "false")
    << ",\"hardware\":" << (probe.hardware ? "true" : "false")
    << ",\"supportsLowLatency\":" << (probe.supports_low_latency ? "true" : "false")
    << ",\"requiresHwDevice\":" << (probe.requires_hw_device ? "true" : "false")
    << ",\"hwDeviceType\":\"" << json_escape(probe.hw_device_type) << "\""
    << ",\"hwDeviceReady\":" << (probe.hw_device_ready ? "true" : "false")
    << ",\"openSucceeded\":" << (probe.open_succeeded ? "true" : "false")
    << ",\"outputSucceeded\":" << (probe.output_succeeded ? "true" : "false")
    << ",\"validated\":" << (probe.validated ? "true" : "false")
    << ",\"priority\":" << probe.priority
    << ",\"reason\":\"" << json_escape(probe.reason) << "\""
    << ",\"error\":\"" << json_escape(probe.error) << "\""
    << "}";
  return payload.str();
}

std::string json_array_from_video_encoder_probes(const std::vector<VideoEncoderProbeResult>& probes) {
  std::ostringstream payload;
  payload << "[";
  for (std::size_t index = 0; index < probes.size(); ++index) {
    if (index > 0) {
      payload << ",";
    }
    payload << json_object_from_video_encoder_probe(probes[index]);
  }
  payload << "]";
  return payload.str();
}

std::vector<std::string> collect_flag_list(const std::string& output) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  for (const std::string& raw_line : split_lines(output)) {
    const std::string line = trim_copy(raw_line);
    if (line.empty()) {
      continue;
    }

    const std::string lowered = to_lower_copy(line);
    if (lowered == "hardware acceleration methods:" || lowered.rfind("ffmpeg version", 0) == 0) {
      continue;
    }

    if (line.find(' ') != std::string::npos || line.find('\t') != std::string::npos) {
      continue;
    }

    if (seen.insert(line).second) {
      values.push_back(line);
    }
  }
  return values;
}

std::vector<std::string> collect_codec_names(
  const std::string& output,
  const std::vector<std::string>& keywords) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  const std::regex codec_pattern("^\\s*[A-Z\\.]{6}\\s+([^\\s]+)");

  for (const std::string& raw_line : split_lines(output)) {
    std::smatch match;
    if (!std::regex_search(raw_line, match, codec_pattern)) {
      continue;
    }

    const std::string name = match[1].str();
    const std::string lowered = to_lower_copy(name);
    const bool matches = std::any_of(keywords.begin(), keywords.end(), [&](const std::string& keyword) {
      return lowered.find(keyword) != std::string::npos;
    });

    if (matches && seen.insert(name).second) {
      values.push_back(name);
    }
  }

  return values;
}

int video_encoder_probe_priority(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.find("_nvenc") != std::string::npos) {
    return 10;
  }
  if (normalized.find("_amf") != std::string::npos) {
    return 20;
  }
  if (normalized.find("_qsv") != std::string::npos) {
    return 30;
  }
  if (normalized.find("_d3d12va") != std::string::npos) {
    return 40;
  }
  if (normalized.find("_mf") != std::string::npos) {
    return 50;
  }
  if (normalized == "libx264" || normalized == "libx265") {
    return 90;
  }
  if (normalized == "libopenh264") {
    return 95;
  }
  return 100;
}

bool encoder_supports_low_latency(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  return is_hardware_video_encoder(normalized) ||
    normalized == "libx264" ||
    normalized == "libx265" ||
    normalized == "libopenh264";
}

AVHWDeviceType required_hw_device_type_for_encoder(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.find("_d3d12va") != std::string::npos) {
    return AV_HWDEVICE_TYPE_D3D12VA;
  }
  return AV_HWDEVICE_TYPE_NONE;
}

bool codec_supports_hw_device(const AVCodec* codec, AVHWDeviceType device_type) {
  if (!codec || device_type == AV_HWDEVICE_TYPE_NONE) {
    return false;
  }

  for (int index = 0;; ++index) {
    const AVCodecHWConfig* config = avcodec_get_hw_config(codec, index);
    if (!config) {
      return false;
    }
    if ((config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) == 0) {
      continue;
    }
    if (config->device_type == device_type) {
      return true;
    }
  }
}

AVPixelFormat select_probe_pixel_format(const AVCodec* codec) {
  if (!codec) {
    return AV_PIX_FMT_NONE;
  }

  const void* supported_configs = nullptr;
  int supported_config_count = 0;
  if (avcodec_get_supported_config(
    nullptr,
    codec,
    AV_CODEC_CONFIG_PIX_FORMAT,
    0,
    &supported_configs,
    &supported_config_count
  ) < 0 || !supported_configs || supported_config_count <= 0) {
    return AV_PIX_FMT_NONE;
  }

  const auto* pixel_formats = static_cast<const AVPixelFormat*>(supported_configs);
  AVPixelFormat first_supported = AV_PIX_FMT_NONE;
  for (int index = 0; index < supported_config_count; ++index) {
    const AVPixelFormat format = pixel_formats[index];
    if (first_supported == AV_PIX_FMT_NONE) {
      first_supported = format;
    }
    if (format == AV_PIX_FMT_NV12) {
      return format;
    }
  }

  for (int index = 0; index < supported_config_count; ++index) {
    const AVPixelFormat format = pixel_formats[index];
    if (format == AV_PIX_FMT_YUV420P || format == AV_PIX_FMT_YUVJ420P) {
      return format;
    }
  }

  return first_supported;
}

bool fill_probe_test_frame(AVFrame* frame, std::string* error) {
  if (!frame) {
    if (error) {
      *error = "encoder-frame-missing";
    }
    return false;
  }

  if (frame->format == AV_PIX_FMT_NV12) {
    for (int y = 0; y < frame->height; ++y) {
      std::memset(frame->data[0] + (y * frame->linesize[0]), 0x10, static_cast<std::size_t>(frame->width));
    }
    for (int y = 0; y < frame->height / 2; ++y) {
      std::memset(frame->data[1] + (y * frame->linesize[1]), 0x80, static_cast<std::size_t>(frame->width));
    }
    return true;
  }

  if (frame->format == AV_PIX_FMT_YUV420P || frame->format == AV_PIX_FMT_YUVJ420P) {
    for (int y = 0; y < frame->height; ++y) {
      std::memset(frame->data[0] + (y * frame->linesize[0]), 0x10, static_cast<std::size_t>(frame->width));
    }
    for (int y = 0; y < frame->height / 2; ++y) {
      std::memset(frame->data[1] + (y * frame->linesize[1]), 0x80, static_cast<std::size_t>(frame->width / 2));
      std::memset(frame->data[2] + (y * frame->linesize[2]), 0x80, static_cast<std::size_t>(frame->width / 2));
    }
    return true;
  }

  if (error) {
    *error = "unsupported-probe-pixel-format";
  }
  return false;
}

VideoEncoderProbeResult run_video_encoder_probe(const std::string& video_encoder);

std::vector<std::string> collect_ffmpeg_devices(const std::string& output, bool demuxing_supported) {
  std::vector<std::string> values;
  std::set<std::string> seen;
  bool in_device_table = false;

  for (const std::string& raw_line : split_lines(output)) {
    const std::string trimmed = trim_copy(raw_line);
    if (trimmed == "---") {
      in_device_table = true;
      continue;
    }

    if (!in_device_table) {
      continue;
    }

    std::stringstream line_stream(trimmed);
    std::string flags;
    std::string name;
    line_stream >> flags >> name;
    if (flags.empty() || name.empty()) {
      continue;
    }

    const bool supports_demuxing = flags.find('D') != std::string::npos;
    const bool supports_muxing = flags.find('E') != std::string::npos;
    if ((demuxing_supported && !supports_demuxing) || (!demuxing_supported && !supports_muxing)) {
      continue;
    }

    if (name == "=") {
      continue;
    }

    if (seen.insert(name).second) {
      values.push_back(name);
    }
  }

  return values;
}

std::vector<std::string> build_ffmpeg_candidates(const std::string& agent_binary_path) {
  std::vector<std::string> candidates;
  std::set<std::string> seen;

  const auto append_candidate = [&](const std::string& candidate) {
    if (!candidate.empty() && seen.insert(candidate).second) {
      candidates.push_back(candidate);
    }
  };

#ifdef _WIN32
  char* env_path = nullptr;
  std::size_t env_length = 0;
  if (_dupenv_s(&env_path, &env_length, "VDS_FFMPEG_PATH") == 0 && env_path) {
    append_candidate(env_path);
    std::free(env_path);
  }
#else
  if (const char* env_path = std::getenv("VDS_FFMPEG_PATH")) {
    append_candidate(env_path);
  }
#endif

  if (!agent_binary_path.empty()) {
    const fs::path agent_path(agent_binary_path);
    const fs::path agent_dir = agent_path.parent_path();
    append_candidate((agent_dir / "ffmpeg.exe").string());
    append_candidate((agent_dir / "ffmpeg" / "ffmpeg.exe").string());
    append_candidate((agent_dir / "ffmpeg" / "bin" / "ffmpeg.exe").string());
    append_candidate((agent_dir.parent_path() / "ffmpeg.exe").string());
    append_candidate((agent_dir.parent_path() / "ffmpeg" / "bin" / "ffmpeg.exe").string());
  }

  append_candidate("ffmpeg");
  return candidates;
}

std::string parse_ffmpeg_version(const std::string& output) {
  const std::regex version_pattern("ffmpeg version\\s+([^\\s]+)");
  std::smatch match;
  if (std::regex_search(output, match, version_pattern)) {
    return match[1].str();
  }
  return {};
}

bool contains_value(const std::vector<std::string>& values, const std::string& target) {
  return std::find(values.begin(), values.end(), target) != values.end();
}

const VideoEncoderProbeResult* find_video_encoder_probe(
  const FfmpegProbeResult& ffmpeg,
  const std::string& target) {
  const std::string normalized = to_lower_copy(trim_copy(target));
  for (const VideoEncoderProbeResult& probe : ffmpeg.video_encoder_probes) {
    if (to_lower_copy(trim_copy(probe.name)) == normalized) {
      return &probe;
    }
  }
  return nullptr;
}

}  // namespace

bool is_hardware_video_encoder(const std::string& encoder) {
  return encoder.find("_amf") != std::string::npos ||
    encoder.find("_mf") != std::string::npos ||
    encoder.find("_qsv") != std::string::npos ||
    encoder.find("_nvenc") != std::string::npos ||
    encoder.find("_d3d12va") != std::string::npos;
}

namespace {

VideoEncoderProbeResult run_video_encoder_probe(const std::string& video_encoder) {
  VideoEncoderProbeResult probe;
  probe.name = trim_copy(video_encoder);
  probe.hardware = is_hardware_video_encoder(probe.name);
  probe.supports_low_latency = encoder_supports_low_latency(probe.name);
  probe.priority = video_encoder_probe_priority(probe.name);

  const AVCodec* codec = avcodec_find_encoder_by_name(probe.name.c_str());
  if (!codec) {
    probe.reason = "encoder-missing";
    probe.error = "avcodec-find-encoder-by-name-failed";
    return probe;
  }

  probe.exists = true;

  AVBufferRef* device_ref = nullptr;
  AVCodecContext* codec_context = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* packet = nullptr;

  const AVHWDeviceType device_type = required_hw_device_type_for_encoder(probe.name);
  if (device_type != AV_HWDEVICE_TYPE_NONE) {
    probe.requires_hw_device = true;
    probe.hw_device_type = av_hwdevice_get_type_name(device_type);

    if (!codec_supports_hw_device(codec, device_type)) {
      probe.reason = "encoder-hw-device-unsupported";
      probe.error = "encoder-does-not-support-hw-device-context";
      return probe;
    }

    const int hw_result = av_hwdevice_ctx_create(&device_ref, device_type, nullptr, nullptr, 0);
    if (hw_result < 0 || !device_ref) {
      probe.reason = "hardware-device-unavailable";
      probe.error = hw_result < 0 ? ffmpeg_error_string(hw_result) : "av-hwdevice-ctx-create-failed";
      if (device_ref) {
        av_buffer_unref(&device_ref);
      }
      return probe;
    }

    probe.hw_device_ready = true;
  }

  codec_context = avcodec_alloc_context3(codec);
  if (!codec_context) {
    probe.reason = "encoder-context-allocation-failed";
    probe.error = "avcodec-alloc-context3-failed";
    av_buffer_unref(&device_ref);
    return probe;
  }

  codec_context->width = 640;
  codec_context->height = 480;
  codec_context->time_base = AVRational { 1, 30 };
  codec_context->framerate = AVRational { 30, 1 };
  codec_context->bit_rate = 1000000;
  codec_context->pix_fmt = select_probe_pixel_format(codec);
  codec_context->gop_size = 30;
  codec_context->max_b_frames = 0;
  codec_context->flags |= AV_CODEC_FLAG_LOW_DELAY;

  if (codec_context->pix_fmt == AV_PIX_FMT_NONE) {
    probe.reason = "encoder-pixel-format-unsupported";
    probe.error = "encoder-has-no-supported-probe-pixel-format";
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  if (device_ref) {
    codec_context->hw_device_ctx = av_buffer_ref(device_ref);
    if (!codec_context->hw_device_ctx) {
      probe.reason = "encoder-hw-device-attach-failed";
      probe.error = "av-buffer-ref-failed";
      avcodec_free_context(&codec_context);
      av_buffer_unref(&device_ref);
      return probe;
    }
  }

  const int open_result = avcodec_open2(codec_context, codec, nullptr);
  if (open_result < 0) {
    probe.reason = "encoder-open-failed";
    probe.error = ffmpeg_error_string(open_result);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  probe.open_succeeded = true;

  frame = av_frame_alloc();
  packet = av_packet_alloc();
  if (!frame || !packet) {
    probe.reason = "encoder-frame-allocation-failed";
    probe.error = "av-frame-or-packet-allocation-failed";
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  frame->format = codec_context->pix_fmt;
  frame->width = codec_context->width;
  frame->height = codec_context->height;

  int buffer_result = av_frame_get_buffer(frame, 32);
  if (buffer_result < 0) {
    probe.reason = "encoder-frame-buffer-failed";
    probe.error = ffmpeg_error_string(buffer_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  buffer_result = av_frame_make_writable(frame);
  if (buffer_result < 0) {
    probe.reason = "encoder-frame-not-writable";
    probe.error = ffmpeg_error_string(buffer_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  std::string fill_error;
  if (!fill_probe_test_frame(frame, &fill_error)) {
    probe.reason = "encoder-test-frame-fill-failed";
    probe.error = fill_error;
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }
  frame->pts = 0;

  int send_result = avcodec_send_frame(codec_context, frame);
  if (send_result < 0) {
    probe.reason = "encoder-send-frame-failed";
    probe.error = ffmpeg_error_string(send_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  const int flush_result = avcodec_send_frame(codec_context, nullptr);
  if (flush_result < 0 && flush_result != AVERROR_EOF) {
    probe.reason = "encoder-flush-failed";
    probe.error = ffmpeg_error_string(flush_result);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec_context);
    av_buffer_unref(&device_ref);
    return probe;
  }

  for (int attempt = 0; attempt < 5; ++attempt) {
    const int receive_result = avcodec_receive_packet(codec_context, packet);
    if (receive_result == 0) {
      if (packet->size > 0) {
        probe.output_succeeded = true;
        probe.validated = true;
        probe.reason = "encoder-self-test-passed";
        probe.error.clear();
        av_packet_unref(packet);
        break;
      }

      av_packet_unref(packet);
      continue;
    }

    if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
      continue;
    }

    probe.reason = "encoder-receive-packet-failed";
    probe.error = ffmpeg_error_string(receive_result);
    break;
  }

  if (!probe.validated && probe.reason.empty()) {
    probe.reason = "encoder-self-test-no-output";
    probe.error = "encoded-packet-not-produced";
  }

  av_frame_free(&frame);
  av_packet_free(&packet);
  avcodec_free_context(&codec_context);
  av_buffer_unref(&device_ref);
  return probe;
}

}  // namespace

std::string select_preferred_audio_encoder(const std::vector<std::string>& audio_encoders) {
  if (std::find(audio_encoders.begin(), audio_encoders.end(), "libopus") != audio_encoders.end()) {
    return "libopus";
  }
  if (std::find(audio_encoders.begin(), audio_encoders.end(), "opus") != audio_encoders.end()) {
    return "opus";
  }
  return {};
}

FfmpegProbeResult probe_ffmpeg(const std::string& agent_binary_path) {
  FfmpegProbeResult probe;
  const std::vector<std::string> candidates = build_ffmpeg_candidates(agent_binary_path);

  for (const std::string& candidate : candidates) {
    const bool requires_existence_check =
      candidate.find('\\') != std::string::npos ||
      candidate.find('/') != std::string::npos ||
      candidate.find(':') != std::string::npos;

    if (requires_existence_check && !fs::exists(candidate)) {
      continue;
    }

    const std::string command_target = requires_existence_check ? quote_command_path(candidate) : candidate;
    const CommandResult version_result = run_command_capture(command_target + " -hide_banner -version 2>&1");
    const std::string parsed_version = parse_ffmpeg_version(version_result.output);

    if (command_failed_to_resolve(version_result)) {
      probe.error = "ffmpeg-binary-not-found";
      continue;
    }

    if (!version_result.launched || (version_result.exit_code != 0 && parsed_version.empty())) {
      if (!requires_existence_check && parsed_version.empty()) {
        probe.error = "ffmpeg-binary-not-found";
      } else {
        probe.error = trim_copy(version_result.output);
      }

      if (probe.error.empty()) {
        probe.error = "ffmpeg-version-probe-failed";
      }
      continue;
    }

    probe.available = true;
    probe.path = candidate;
    probe.version = parsed_version;

    const CommandResult hwaccels_result = run_command_capture(command_target + " -hide_banner -hwaccels 2>&1");
    if (hwaccels_result.launched && hwaccels_result.exit_code == 0) {
      probe.hwaccels = collect_flag_list(hwaccels_result.output);
    }

    const CommandResult bsfs_result = run_command_capture(command_target + " -hide_banner -bsfs 2>&1");
    if (bsfs_result.launched && bsfs_result.exit_code == 0) {
      probe.bitstream_filters = collect_flag_list(bsfs_result.output);
      probe.h264_metadata_bsf_available =
        std::find(probe.bitstream_filters.begin(), probe.bitstream_filters.end(), "h264_metadata") != probe.bitstream_filters.end();
      probe.hevc_metadata_bsf_available =
        std::find(probe.bitstream_filters.begin(), probe.bitstream_filters.end(), "hevc_metadata") != probe.bitstream_filters.end();
    }

    const CommandResult devices_result = run_command_capture(command_target + " -hide_banner -devices 2>&1");
    if (devices_result.launched && !trim_copy(devices_result.output).empty()) {
      probe.input_devices = collect_ffmpeg_devices(devices_result.output, true);
    }

    const std::vector<std::string> capability_probe_encoders = {
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_d3d12va",
      "h264_mf",
      "libx264",
      "libopenh264",
      "hevc_nvenc",
      "hevc_amf",
      "hevc_qsv",
      "hevc_d3d12va",
      "hevc_mf",
      "libx265"
    };

    const CommandResult encoders_result = run_command_capture(command_target + " -hide_banner -encoders 2>&1");
    if (encoders_result.launched && encoders_result.exit_code == 0) {
      probe.video_encoders = collect_codec_names(encoders_result.output, { "264", "265", "hevc" });
      probe.audio_encoders = collect_codec_names(encoders_result.output, { "opus" });
    }

    for (const std::string& encoder : capability_probe_encoders) {
      VideoEncoderProbeResult validation = run_video_encoder_probe(encoder);
      probe.video_encoder_probes.push_back(validation);
      if (validation.validated) {
        probe.validated_video_encoders.push_back(encoder);
      }
    }

    const CommandResult decoders_result = run_command_capture(command_target + " -hide_banner -decoders 2>&1");
    if (decoders_result.launched && decoders_result.exit_code == 0) {
      probe.video_decoders = collect_codec_names(decoders_result.output, { "264", "265", "hevc" });
      probe.audio_decoders = collect_codec_names(decoders_result.output, { "opus" });
    }

    probe.error.clear();
    return probe;
  }

  if (probe.error.empty()) {
    probe.error = "ffmpeg-binary-not-found";
  }

  return probe;
}

std::string ffmpeg_probe_json(const FfmpegProbeResult& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"path\":\"" << json_escape(probe.path) << "\""
    << ",\"version\":\"" << json_escape(probe.version) << "\""
    << ",\"hwaccels\":" << json_array_from_strings(probe.hwaccels)
    << ",\"bitstreamFilters\":" << json_array_from_strings(probe.bitstream_filters)
    << ",\"inputDevices\":" << json_array_from_strings(probe.input_devices)
    << ",\"videoEncoders\":" << json_array_from_strings(probe.video_encoders)
    << ",\"validatedVideoEncoders\":" << json_array_from_strings(probe.validated_video_encoders)
    << ",\"videoEncoderProbes\":" << json_array_from_video_encoder_probes(probe.video_encoder_probes)
    << ",\"videoDecoders\":" << json_array_from_strings(probe.video_decoders)
    << ",\"audioEncoders\":" << json_array_from_strings(probe.audio_encoders)
    << ",\"audioDecoders\":" << json_array_from_strings(probe.audio_decoders)
    << ",\"h264MetadataBsfAvailable\":" << (probe.h264_metadata_bsf_available ? "true" : "false")
    << ",\"hevcMetadataBsfAvailable\":" << (probe.hevc_metadata_bsf_available ? "true" : "false")
    << ",\"error\":\"" << json_escape(probe.error) << "\""
    << "}";
  return payload.str();
}

bool encoder_exists_for_runtime(const FfmpegProbeResult& ffmpeg, const std::string& target) {
  if (contains_value(ffmpeg.video_encoders, target)) {
    return true;
  }
  const VideoEncoderProbeResult* probe = find_video_encoder_probe(ffmpeg, target);
  return probe && probe->exists;
}

std::string normalize_video_encoder_preference(const std::string& encoder) {
  const std::string normalized = to_lower_copy(trim_copy(encoder));
  if (normalized.empty() || normalized == "auto") {
    return {};
  }
  return normalized;
}

bool video_encoder_matches_codec(const std::string& encoder, const std::string& requested_codec) {
  const std::string lowered = to_lower_copy(trim_copy(encoder));
  if (lowered.empty()) {
    return false;
  }

  const bool wants_hevc = requested_codec == "h265" || requested_codec == "hevc";
  if (wants_hevc) {
    return lowered.find("265") != std::string::npos || lowered.find("hevc") != std::string::npos;
  }

  return lowered.find("264") != std::string::npos &&
    lowered.find("265") == std::string::npos &&
    lowered.find("hevc") == std::string::npos;
}

CommandResult run_ffmpeg_encoder_self_test(
  const FfmpegProbeResult& ffmpeg,
  const std::string& video_encoder,
  const std::string& audio_encoder) {
  CommandResult result;
  if (!ffmpeg.available || ffmpeg.path.empty() || video_encoder.empty() || audio_encoder.empty()) {
    return result;
  }

  (void)audio_encoder;
  const VideoEncoderProbeResult* cached_probe = find_video_encoder_probe(ffmpeg, video_encoder);
  const VideoEncoderProbeResult probe = cached_probe
    ? *cached_probe
    : run_video_encoder_probe(video_encoder);
  result.launched = probe.exists;
  result.exit_code = probe.validated ? 0 : 1;
  result.output = probe.error.empty() ? probe.reason : (probe.reason + ": " + probe.error);
  return result;
}

}  // namespace vds::media_agent
