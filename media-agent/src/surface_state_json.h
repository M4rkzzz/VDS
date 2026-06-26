#pragma once

#include <string>

struct SurfaceAttachmentState;

std::string surface_attachment_json(const SurfaceAttachmentState& state);
std::string surface_attachment_json(SurfaceAttachmentState& state);
std::string build_surface_result_json(SurfaceAttachmentState& state);
std::string build_surface_detached_result_json();
