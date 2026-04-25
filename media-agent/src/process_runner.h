#pragma once

#include "agent_runtime.h"

namespace vds::media_agent {

CommandResult run_command_capture(const std::string& command);
bool command_failed_to_resolve(const CommandResult& result);

}  // namespace vds::media_agent
