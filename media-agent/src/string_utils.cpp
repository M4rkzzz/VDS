#include "string_utils.h"

#include <algorithm>
#include <cctype>
#include <sstream>

namespace vds::media_agent {

std::string to_lower_copy(const std::string& value) {
  std::string lowered = value;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return lowered;
}

std::vector<std::string> split_lines(const std::string& value) {
  std::vector<std::string> lines;
  std::stringstream stream(value);
  std::string line;
  while (std::getline(stream, line)) {
    lines.push_back(line);
  }
  return lines;
}

} // namespace vds::media_agent
