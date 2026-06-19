#pragma once

#include <string>

struct CommandResult {
  bool launched = false;
  int exit_code = -1;
  std::string output;
};

namespace vds::media_agent {

CommandResult run_command_capture(const std::string& command);
bool command_failed_to_resolve(const CommandResult& result);

}  // namespace vds::media_agent
