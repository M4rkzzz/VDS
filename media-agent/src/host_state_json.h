#pragma once

#include <string>

#include "agent_runtime.h"
#include "wgc_capture.h"

std::string host_pipeline_json(const HostPipelineState& pipeline);
std::string wgc_capture_probe_json(const WgcCaptureProbe& probe);
std::string host_capture_plan_json(const HostCapturePlan& plan);
std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe);
