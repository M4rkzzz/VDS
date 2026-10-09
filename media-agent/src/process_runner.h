#pragma once

#include <string>
#include <vector>

struct CommandResult {
  bool launched = false;
  int exit_code = -1;
  std::string output;
  bool timed_out = false;
};

namespace vds::media_agent {

CommandResult run_command_capture(const std::string& command);
// A bounded, owned child is for short capability probes only. Live media
// processes continue using their own lifetime and have no probe deadline.
CommandResult run_probe_process_capture(
  const std::string& executable,
  const std::vector<std::string>& arguments,
  unsigned long timeout_ms);
bool command_failed_to_resolve(const CommandResult& result);

}  // namespace vds::media_agent
