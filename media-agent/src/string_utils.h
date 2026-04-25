#pragma once

#include <string>
#include <vector>

namespace vds::media_agent {

std::string to_lower_copy(const std::string& value);
std::vector<std::string> split_lines(const std::string& value);

} // namespace vds::media_agent
