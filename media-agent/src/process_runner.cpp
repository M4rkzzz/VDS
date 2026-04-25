#include "process_runner.h"

#include <cstdio>

#include "string_utils.h"

namespace vds::media_agent {

CommandResult run_command_capture(const std::string& command) {
  CommandResult result;

#ifdef _WIN32
  FILE* pipe = _popen(command.c_str(), "r");
#else
  FILE* pipe = popen(command.c_str(), "r");
#endif

  if (!pipe) {
    return result;
  }

  result.launched = true;
  char buffer[4096];
  while (std::fgets(buffer, static_cast<int>(sizeof(buffer)), pipe) != nullptr) {
    result.output += buffer;
  }

#ifdef _WIN32
  result.exit_code = _pclose(pipe);
#else
  result.exit_code = pclose(pipe);
#endif

  return result;
}

bool command_failed_to_resolve(const CommandResult& result) {
  if (!result.launched) {
    return true;
  }

  const std::string output = to_lower_copy(result.output);
  return output.find("is not recognized") != std::string::npos ||
    output.find("not found") != std::string::npos ||
    output.find("no such file") != std::string::npos;
}

}  // namespace vds::media_agent
