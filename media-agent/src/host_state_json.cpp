#include "host_state_json.h"

#include <iomanip>
#include <sstream>

#include "json_protocol.h"

std::string host_pipeline_json(const HostPipelineState& pipeline) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (pipeline.ready ? "true" : "false")
    << ",\"hardware\":" << (pipeline.hardware ? "true" : "false")
    << ",\"validated\":" << (pipeline.validated ? "true" : "false")
    << ",\"preferHardware\":" << (pipeline.prefer_hardware ? "true" : "false")
    << ",\"requestedVideoCodec\":\"" << vds::media_agent::json_escape(pipeline.requested_video_codec) << "\""
    << ",\"requestedVideoEncoder\":\"" << vds::media_agent::json_escape(pipeline.requested_video_encoder) << "\""
    << ",\"requestedPreset\":\"" << vds::media_agent::json_escape(pipeline.requested_preset) << "\""
    << ",\"requestedTune\":\"" << vds::media_agent::json_escape(pipeline.requested_tune) << "\""
    << ",\"selectedVideoEncoder\":\"" << vds::media_agent::json_escape(pipeline.selected_video_encoder) << "\""
    << ",\"videoEncoderBackend\":\"" << vds::media_agent::json_escape(pipeline.video_encoder_backend) << "\""
    << ",\"selectedAudioEncoder\":\"" << vds::media_agent::json_escape(pipeline.selected_audio_encoder) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(pipeline.implementation) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(pipeline.reason) << "\""
    << ",\"validationReason\":\"" << vds::media_agent::json_escape(pipeline.validation_reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(pipeline.last_error) << "\""
    << "}";
  return payload.str();
}

std::string wgc_capture_probe_json(const WgcCaptureProbe& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"implemented\":" << (probe.implemented ? "true" : "false")
    << ",\"platformSupported\":" << (probe.platform_supported ? "true" : "false")
    << ",\"implementation\":\"" << vds::media_agent::json_escape(probe.implementation) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(probe.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(probe.last_error) << "\""
    << "}";
  return payload.str();
}

std::string host_capture_plan_json(const HostCapturePlan& plan) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (plan.ready ? "true" : "false")
    << ",\"validated\":" << (plan.validated ? "true" : "false")
    << ",\"captureKind\":\"" << vds::media_agent::json_escape(plan.capture_kind) << "\""
    << ",\"captureState\":\"" << vds::media_agent::json_escape(plan.capture_state) << "\""
    << ",\"preferredCaptureBackend\":\"" << vds::media_agent::json_escape(plan.preferred_capture_backend) << "\""
    << ",\"captureBackend\":\"" << vds::media_agent::json_escape(plan.capture_backend) << "\""
    << ",\"captureFallbackReason\":\"" << vds::media_agent::json_escape(plan.capture_fallback_reason) << "\""
    << ",\"captureHandle\":\"" << vds::media_agent::json_escape(plan.capture_handle) << "\""
    << ",\"captureDisplayId\":\"" << vds::media_agent::json_escape(plan.capture_display_id) << "\""
    << ",\"width\":" << plan.width
    << ",\"height\":" << plan.height
    << ",\"frameRate\":" << plan.frame_rate
    << ",\"bitrateKbps\":" << plan.bitrate_kbps
    << ",\"inputWidth\":" << plan.input_width
    << ",\"inputHeight\":" << plan.input_height
    << ",\"inputFormat\":\"" << vds::media_agent::json_escape(plan.input_format) << "\""
    << ",\"inputTarget\":\"" << vds::media_agent::json_escape(plan.input_target) << "\""
    << ",\"codecPath\":\"" << vds::media_agent::json_escape(plan.codec_path) << "\""
    << ",\"implementation\":\"" << vds::media_agent::json_escape(plan.implementation) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(plan.reason) << "\""
    << ",\"validationReason\":\"" << vds::media_agent::json_escape(plan.validation_reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(plan.last_error) << "\""
    << ",\"commandPreview\":\"" << vds::media_agent::json_escape(plan.command_preview) << "\""
    << "}";
  return payload.str();
}

std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe) {
  std::ostringstream payload;
  payload
    << "{\"available\":" << (probe.available ? "true" : "false")
    << ",\"ready\":" << (probe.ready ? "true" : "false")
    << ",\"fileSizeBytes\":" << probe.file_size_bytes
    << ",\"width\":" << probe.width
    << ",\"height\":" << probe.height
    << ",\"frameRate\":" << std::fixed << std::setprecision(3) << probe.frame_rate
    << ",\"lastProbeAtMs\":";
  vds::media_agent::append_nullable_int64(payload, probe.last_probe_at_unix_ms);
  payload
    << ",\"mediaPath\":\"" << vds::media_agent::json_escape(probe.media_path) << "\""
    << ",\"formatName\":\"" << vds::media_agent::json_escape(probe.format_name) << "\""
    << ",\"videoCodec\":\"" << vds::media_agent::json_escape(probe.video_codec) << "\""
    << ",\"pixelFormat\":\"" << vds::media_agent::json_escape(probe.pixel_format) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(probe.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(probe.last_error) << "\""
    << "}";
  return payload.str();
}
