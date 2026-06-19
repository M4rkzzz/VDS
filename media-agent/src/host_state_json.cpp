#include "host_state_json.h"

#include <sstream>

#include "agent_runtime.h"
#include "json_protocol.h"

std::string host_pipeline_json(const HostPipelineState& pipeline) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (pipeline.ready ? "true" : "false")
    << ",\"hardware\":" << (pipeline.hardware ? "true" : "false")
    << ",\"validated\":" << (pipeline.validated ? "true" : "false")
    << ",\"selectedVideoEncoder\":\"" << vds::media_agent::json_escape(pipeline.selected_video_encoder) << "\""
    << ",\"videoEncoderBackend\":\"" << vds::media_agent::json_escape(pipeline.video_encoder_backend) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(pipeline.reason) << "\""
    << ",\"validationReason\":\"" << vds::media_agent::json_escape(pipeline.validation_reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(pipeline.last_error) << "\""
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
    << ",\"captureBackend\":\"" << vds::media_agent::json_escape(plan.capture_backend) << "\""
    << ",\"width\":" << plan.width
    << ",\"height\":" << plan.height
    << ",\"frameRate\":" << plan.frame_rate
    << ",\"bitrateKbps\":" << plan.bitrate_kbps
    << ",\"reason\":\"" << vds::media_agent::json_escape(plan.reason) << "\""
    << ",\"validationReason\":\"" << vds::media_agent::json_escape(plan.validation_reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(plan.last_error) << "\""
    << "}";
  return payload.str();
}

std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe) {
  std::ostringstream payload;
  payload
    << "{\"ready\":" << (probe.ready ? "true" : "false")
    << ",\"fileSizeBytes\":" << probe.file_size_bytes
    << ",\"width\":" << probe.width
    << ",\"height\":" << probe.height
    << ",\"videoCodec\":\"" << vds::media_agent::json_escape(probe.video_codec) << "\""
    << ",\"reason\":\"" << vds::media_agent::json_escape(probe.reason) << "\""
    << ",\"lastError\":\"" << vds::media_agent::json_escape(probe.last_error) << "\""
    << "}";
  return payload.str();
}
