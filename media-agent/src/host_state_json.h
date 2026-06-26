#pragma once

#include <iosfwd>
#include <string>

struct HostCaptureArtifactProbe;
struct HostCapturePlan;
struct HostPipelineState;
struct HostSessionState;
struct ObsIngestState;

std::string host_pipeline_json(const HostPipelineState& pipeline);
std::string host_capture_plan_json(const HostCapturePlan& plan);
std::string host_capture_artifact_json(const HostCaptureArtifactProbe& probe);
std::string host_session_json(const HostSessionState& session, const ObsIngestState& obs_ingest);
void append_host_session_status_json_fields(std::ostream& payload, const HostSessionState& session);
void append_host_session_stats_json_fields(std::ostream& payload, const HostSessionState& session);
