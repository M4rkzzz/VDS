#pragma once

#include <string>

struct AudioSessionCommandResult {
  bool ok = true;
  std::string result_json;
  std::string error_code;
  std::string error_message;
};
