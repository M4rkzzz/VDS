#pragma once

#include <string>

struct PeerControlCommandResult {
  bool ok = false;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};
