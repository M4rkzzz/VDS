#pragma once

#include <string>
#include "wgc_capture_state.h"

WgcCaptureProbe probe_wgc_capture_backend_isolated(const std::string& agent_binary_path);
int run_wgc_capture_probe_child();
