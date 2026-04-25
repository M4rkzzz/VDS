#include "host_pipeline.h"

#include <algorithm>
#include <sstream>
#include <vector>

#include "ffmpeg_probe.h"
#include "json_protocol.h"
#include "platform_utils.h"
#include "string_utils.h"
#include "video_access_unit.h"

namespace {

void append_video_encoder_runtime_flags(std::ostringstream& command, const HostPipelineState& pipeline);

std::vector<std::string> build_preferred_video_encoder_list(const std::string& requested_codec, bool prefer_hardware) {
  const bool wants_hevc = requested_codec == "h265" || requested_codec == "hevc";
  if (wants_hevc) {
    if (prefer_hardware) {
      return {
        "hevc_nvenc",
        "hevc_amf",
        "hevc_qsv",
        "hevc_d3d12va",
        "hevc_mf",
        "libx265"
      };
    }

    return {
      "libx265"
    };
  }

  if (prefer_hardware) {
    return {
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_d3d12va",
      "h264_mf",
      "libx264",
      "libopenh264"
    };
  }

  return {
    "libx264",
    "libopenh264"
  };
}

std::vector<std::string> build_candidate_video_encoder_list(
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder) {
  const std::string manual_encoder = vds::media_agent::normalize_video_encoder_preference(requested_video_encoder);
  if (prefer_hardware && !manual_encoder.empty() && vds::media_agent::video_encoder_matches_codec(manual_encoder, requested_codec)) {
    return { manual_encoder };
  }

  return build_preferred_video_encoder_list(requested_codec, prefer_hardware);
}

void append_video_encoder_runtime_flags(std::ostringstream& command, const HostPipelineState& pipeline) {
  const std::string preset = normalize_host_encoder_preset(pipeline.requested_preset);
  const std::string tune = normalize_host_encoder_tune(pipeline.requested_tune);
  const std::string encoder = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(pipeline.selected_video_encoder));

  if (encoder == "h264_amf" || encoder == "hevc_amf") {
    const std::string amf_quality =
      preset == "quality" ? "quality" : (preset == "speed" ? "speed" : "balanced");
    command
      << " -usage " << (tune == "zerolatency" ? "ultralowlatency" : "lowlatency")
      << " -quality " << amf_quality
      << " -rc cbr -bf 0";
    return;
  }

  if (encoder == "h264_nvenc" || encoder == "hevc_nvenc") {
    const std::string nvenc_preset =
      preset == "quality" ? "p7" : (preset == "speed" ? "p1" : "p4");
    command << " -preset " << nvenc_preset;
    if (tune == "zerolatency") {
      command << " -tune ull";
    }
    command << " -rc cbr -bf 0";
    return;
  }

  if (encoder == "libx264" || encoder == "libx265") {
    const std::string software_preset =
      preset == "quality" ? "slow" : (preset == "speed" ? "ultrafast" : "medium");
    command << " -preset " << software_preset;
    if (!tune.empty()) {
      command << " -tune " << tune;
    }
    if (encoder == "libx264") {
      command << " -bf 0";
    } else {
      command << " -x265-params bframes=0:rc-lookahead=0";
    }
    return;
  }

  if (encoder == "libopenh264") {
    command << " -rc_mode bitrate -bf 0";
  }
}

}  // namespace

std::string build_ffmpeg_host_capture_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan,
  const HostCaptureProcessState& process_state) {
  if (!ffmpeg.available || ffmpeg.path.empty() || pipeline.selected_video_encoder.empty()) {
    return {};
  }

  std::ostringstream command;
  command << vds::media_agent::quote_command_path(ffmpeg.path) << " -hide_banner -loglevel error -nostats -nostdin";

  if (plan.capture_backend == "wgc") {
    if (plan.input_width <= 0 || plan.input_height <= 0) {
      return {};
    }
    command
      << " -f rawvideo -pix_fmt bgra"
      << " -video_size " << plan.input_width << "x" << plan.input_height
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i pipe:0";
  } else {
    if (plan.input_format.empty() || plan.input_target.empty()) {
      return {};
    }
    command
      << " -f " << plan.input_format
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i " << vds::media_agent::quote_command_path(plan.input_target);
  }

  command << " -c:v " << pipeline.selected_video_encoder;

  if (plan.width > 0 && plan.height > 0) {
    command
      << " -vf scale=" << plan.width << ":" << plan.height
      << ":force_original_aspect_ratio=decrease"
      << ",pad=" << plan.width << ":" << plan.height << ":(ow-iw)/2:(oh-ih)/2:color=black"
      << ",setsar=1";
  }

  if (plan.bitrate_kbps > 0) {
    command << " -b:v " << plan.bitrate_kbps << "k";
  }

  const int normalized_frame_rate = plan.frame_rate > 0 ? plan.frame_rate : 60;
  const int gop_size = std::max(1, normalized_frame_rate * 2);
  command << " -g " << gop_size;

  append_video_encoder_runtime_flags(command, pipeline);

  if (process_state.enabled && process_state.container == "mpegts" && !process_state.output_path.empty()) {
    command << " -an -flush_packets 1 -muxdelay 0 -muxpreload 0 -mpegts_flags +resend_headers -f mpegts " << vds::media_agent::quote_command_path(process_state.output_path);
  } else {
    command << " -an -f null -";
  }
  return command.str();
}

bool is_h264_video_encoder(const std::string& encoder) {
  const std::string lowered = vds::media_agent::to_lower_copy(encoder);
  return lowered.find("264") != std::string::npos;
}

bool is_h265_video_encoder(const std::string& encoder) {
  const std::string lowered = vds::media_agent::to_lower_copy(encoder);
  return lowered.find("265") != std::string::npos || lowered.find("hevc") != std::string::npos;
}

int normalize_host_output_dimension(int value, int fallback) {
  return value > 0 ? value : fallback;
}

std::string infer_video_encoder_backend(const std::string& encoder) {
  const std::string lowered = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(encoder));
  if (lowered.empty()) {
    return "none";
  }
  if (lowered.find("_amf") != std::string::npos) {
    return "amf";
  }
  if (lowered.find("_nvenc") != std::string::npos) {
    return "nvenc";
  }
  if (lowered.find("_qsv") != std::string::npos) {
    return "qsv";
  }
  if (lowered.find("_mf") != std::string::npos) {
    return "mf";
  }
  if (lowered.find("_vaapi") != std::string::npos) {
    return "vaapi";
  }
  if (lowered.find("_vulkan") != std::string::npos) {
    return "vulkan";
  }
  if (lowered.find("_d3d12va") != std::string::npos) {
    return "d3d12va";
  }
  if (lowered.rfind("libx264", 0) == 0 || lowered.rfind("libx265", 0) == 0 || lowered.rfind("libopenh264", 0) == 0) {
    return "software";
  }
  return "unknown";
}

std::string normalize_host_encoder_preset(const std::string& preset) {
  const std::string lowered = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(preset));
  if (lowered == "quality" || lowered == "speed") {
    return lowered;
  }
  return "balanced";
}

std::string normalize_host_encoder_tune(const std::string& tune) {
  const std::string lowered = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(tune));
  if (lowered == "fastdecode" || lowered == "zerolatency") {
    return lowered;
  }
  return {};
}

std::string normalize_host_keyframe_policy(const std::string& policy) {
  const std::string lowered = vds::media_agent::to_lower_copy(vds::media_agent::trim_copy(policy));
  if (lowered == "0.5s" || lowered == "500ms" || lowered == "half-second") {
    return "0.5s";
  }
  if (lowered == "all-intra" || lowered == "intra" || lowered == "allintra") {
    return "all-intra";
  }
  return "1s";
}

std::string build_ffmpeg_peer_video_sender_command(
  const FfmpegProbeResult& ffmpeg,
  const HostPipelineState& pipeline,
  const HostCapturePlan& plan) {
  if (!ffmpeg.available || ffmpeg.path.empty() || !plan.ready || !plan.validated) {
    return {};
  }

  const std::string codec = vds::media_agent::normalize_video_codec(plan.codec_path, vds::media_agent::normalize_video_codec(pipeline.requested_video_codec));
  if ((codec == "h265" && !is_h265_video_encoder(pipeline.selected_video_encoder)) ||
      (codec != "h265" && !is_h264_video_encoder(pipeline.selected_video_encoder))) {
    return {};
  }

  std::ostringstream command;
  command << vds::media_agent::quote_command_path(ffmpeg.path) << " -hide_banner -loglevel error -nostats -nostdin";

  if (plan.capture_backend == "wgc") {
    if (plan.input_width <= 0 || plan.input_height <= 0) {
      return {};
    }
    command
      << " -f rawvideo -pix_fmt bgra"
      << " -video_size " << plan.input_width << "x" << plan.input_height
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i pipe:0";
  } else {
    command
      << " -f " << plan.input_format
      << " -framerate " << (plan.frame_rate > 0 ? plan.frame_rate : 60)
      << " -i " << vds::media_agent::quote_command_path(plan.input_target);
  }

  command << " -an -c:v " << pipeline.selected_video_encoder;

  if (plan.width > 0 && plan.height > 0) {
    command
      << " -vf scale=" << plan.width << ":" << plan.height
      << ":force_original_aspect_ratio=decrease"
      << ",pad=" << plan.width << ":" << plan.height << ":(ow-iw)/2:(oh-ih)/2:color=black"
      << ",setsar=1";
  }

  if (plan.bitrate_kbps > 0) {
    command << " -b:v " << plan.bitrate_kbps << "k";
  }

  const int normalized_frame_rate = plan.frame_rate > 0 ? plan.frame_rate : 60;
  const std::string keyframe_policy = normalize_host_keyframe_policy(pipeline.requested_keyframe_policy);
  if (keyframe_policy == "all-intra") {
    command << " -g 1 -force_key_frames " << vds::media_agent::quote_command_path("expr:gte(t,n_forced*0)");
  } else if (keyframe_policy == "0.5s") {
    command << " -g " << std::max(1, normalized_frame_rate / 2);
    command << " -force_key_frames " << vds::media_agent::quote_command_path("expr:gte(t,n_forced*0.5)");
  } else {
    command << " -g " << std::max(1, normalized_frame_rate);
    command << " -force_key_frames " << vds::media_agent::quote_command_path("expr:gte(t,n_forced*1)");
  }

  append_video_encoder_runtime_flags(command, pipeline);

  if (codec == "h265") {
    command << " -f hevc pipe:1";
  } else {
    command << " -bsf:v h264_metadata=aud=insert -f h264 pipe:1";
  }
  return command.str();
}

HostPipelineState select_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune) {
  HostPipelineState pipeline;
  pipeline.prefer_hardware = prefer_hardware;
  pipeline.requested_video_codec = requested_codec.empty() ? "h264" : vds::media_agent::to_lower_copy(requested_codec);
  pipeline.requested_video_encoder = vds::media_agent::normalize_video_encoder_preference(requested_video_encoder);
  pipeline.requested_preset = normalize_host_encoder_preset(requested_preset);
  pipeline.requested_tune = normalize_host_encoder_tune(requested_tune);
  pipeline.selected_audio_encoder = vds::media_agent::select_preferred_audio_encoder(ffmpeg.audio_encoders);

  if (!ffmpeg.available) {
    pipeline.reason = "ffmpeg-unavailable";
    pipeline.video_encoder_backend = "none";
    return pipeline;
  }

  if (pipeline.requested_video_codec == "h265" || pipeline.requested_video_codec == "hevc") {
    pipeline.requested_video_codec = "h265";
  } else {
    pipeline.requested_video_codec = "h264";
  }

  const std::vector<std::string> preferred_video_encoders = build_candidate_video_encoder_list(
    pipeline.requested_video_codec,
    pipeline.prefer_hardware,
    pipeline.requested_video_encoder
  );

  for (const std::string& encoder : preferred_video_encoders) {
    if (vds::media_agent::encoder_exists_for_runtime(ffmpeg, encoder)) {
      pipeline.selected_video_encoder = encoder;
      pipeline.video_encoder_backend = infer_video_encoder_backend(encoder);
      break;
    }
  }

  if (pipeline.selected_video_encoder.empty()) {
    pipeline.reason = "video-encoder-unavailable";
    pipeline.video_encoder_backend = "none";
    pipeline.validation_reason = "video-encoder-unavailable";
    return pipeline;
  }

  if (pipeline.selected_audio_encoder.empty()) {
    pipeline.reason = "audio-encoder-unavailable";
    pipeline.validation_reason = "audio-encoder-unavailable";
    return pipeline;
  }

  pipeline.hardware = vds::media_agent::is_hardware_video_encoder(pipeline.selected_video_encoder);
  pipeline.reason = pipeline.requested_video_encoder.empty()
    ? (pipeline.hardware ? "hardware-pipeline-selected" : "software-pipeline-selected")
    : (pipeline.hardware ? "manual-hardware-pipeline-selected" : "manual-software-pipeline-selected");
  pipeline.validation_reason = "pipeline-selection-only";
  return pipeline;
}

HostPipelineState select_and_validate_host_pipeline(
  const FfmpegProbeResult& ffmpeg,
  const std::string& requested_codec,
  bool prefer_hardware,
  const std::string& requested_video_encoder,
  const std::string& requested_preset,
  const std::string& requested_tune) {
  HostPipelineState base_pipeline = select_host_pipeline(
    ffmpeg,
    requested_codec,
    prefer_hardware,
    requested_video_encoder,
    requested_preset,
    requested_tune
  );
  if (!ffmpeg.available || base_pipeline.selected_audio_encoder.empty()) {
    return base_pipeline;
  }

  const std::string normalized_codec = base_pipeline.requested_video_codec.empty()
    ? "h264"
    : base_pipeline.requested_video_codec;

  const std::vector<std::string> preferred_video_encoders = build_candidate_video_encoder_list(
    normalized_codec,
    base_pipeline.prefer_hardware,
    base_pipeline.requested_video_encoder
  );

  std::string last_validation_error;
  for (const std::string& encoder : preferred_video_encoders) {
    if (!vds::media_agent::encoder_exists_for_runtime(ffmpeg, encoder)) {
      continue;
    }

    CommandResult validation = vds::media_agent::run_ffmpeg_encoder_self_test(ffmpeg, encoder, base_pipeline.selected_audio_encoder);
    if (validation.launched && validation.exit_code == 0) {
      base_pipeline.selected_video_encoder = encoder;
      base_pipeline.video_encoder_backend = infer_video_encoder_backend(encoder);
      base_pipeline.hardware = vds::media_agent::is_hardware_video_encoder(encoder);
      base_pipeline.ready = true;
      base_pipeline.validated = true;
      base_pipeline.reason = base_pipeline.requested_video_encoder.empty()
        ? (base_pipeline.hardware ? "hardware-pipeline-validated" : "software-pipeline-validated")
        : (base_pipeline.hardware ? "manual-hardware-pipeline-validated" : "manual-software-pipeline-validated");
      base_pipeline.validation_reason = "encoder-self-test-passed";
      base_pipeline.last_error.clear();
      return base_pipeline;
    }

    last_validation_error = vds::media_agent::trim_copy(validation.output);
    if (last_validation_error.empty()) {
      last_validation_error = "encoder-self-test-failed";
    }
  }

  base_pipeline.ready = false;
  base_pipeline.validated = false;
  base_pipeline.validation_reason = "encoder-self-test-failed";
  base_pipeline.last_error = last_validation_error;
  if (
    base_pipeline.reason == "hardware-pipeline-selected" ||
    base_pipeline.reason == "software-pipeline-selected" ||
    base_pipeline.reason == "manual-hardware-pipeline-selected" ||
    base_pipeline.reason == "manual-software-pipeline-selected"
  ) {
    base_pipeline.reason = "pipeline-selected-but-not-validated";
  }
  return base_pipeline;
}
