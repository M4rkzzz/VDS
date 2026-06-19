#pragma once

#include <string>

struct HostCaptureArtifactProbe;
struct HostCapturePlan;
struct HostPipelineState;

std::string host_pipeline_json(const HostPipelineState& pipeline);
std::string host_capture_plan_json(const HostCapturePlan& plan);
std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe);
