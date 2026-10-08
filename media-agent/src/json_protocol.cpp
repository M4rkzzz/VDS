#include "json_protocol.h"

#include <algorithm>
#include <cctype>
#include <limits>
#include <regex>
#include <sstream>

namespace vds::media_agent {

std::string json_escape(const std::string& value) {
  std::ostringstream escaped;
  static constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        escaped << "\\\\";
        break;
      case '"':
        escaped << "\\\"";
        break;
      case '\n':
        escaped << "\\n";
        break;
      case '\r':
        escaped << "\\r";
        break;
      case '\t':
        escaped << "\\t";
        break;
      case '\b':
        escaped << "\\b";
        break;
      case '\f':
        escaped << "\\f";
        break;
      default:
        if (ch < 0x20) {
          escaped << "\\u00" << hex[ch >> 4] << hex[ch & 0x0f];
        } else {
          escaped << static_cast<char>(ch);
        }
        break;
    }
  }
  return escaped.str();
}

std::string trim_copy(const std::string& value) {
  const auto begin = std::find_if_not(value.begin(), value.end(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  });
  const auto end = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  }).base();

  if (begin >= end) {
    return {};
  }

  return std::string(begin, end);
}

std::string json_unescape(const std::string& value) {
  std::string unescaped;
  unescaped.reserve(value.size());

  for (size_t index = 0; index < value.size(); ++index) {
    const char ch = value[index];
    if (ch != '\\' || index + 1 >= value.size()) {
      unescaped.push_back(ch);
      continue;
    }

    const char escaped = value[++index];
    switch (escaped) {
      case '\\':
        unescaped.push_back('\\');
        break;
      case '"':
        unescaped.push_back('"');
        break;
      case 'n':
        unescaped.push_back('\n');
        break;
      case 'r':
        unescaped.push_back('\r');
        break;
      case 't':
        unescaped.push_back('\t');
        break;
      case 'b':
        unescaped.push_back('\b');
        break;
      case 'f':
        unescaped.push_back('\f');
        break;
      default:
        unescaped.push_back(escaped);
        break;
    }
  }

  return unescaped;
}

std::string build_error_payload(int id, const std::string& code, const std::string& message) {
  std::ostringstream payload;
  payload
    << "{\"id\":" << id
    << ",\"error\":{\"code\":\"" << json_escape(code)
    << "\",\"message\":\"" << json_escape(message) << "\"}}";
  return payload.str();
}

std::string build_result_payload(int id, const std::string& result_json) {
  std::ostringstream payload;
  payload << "{\"id\":" << id << ",\"result\":" << result_json << "}";
  return payload.str();
}

int extract_id(const std::string& line) {
  const std::regex id_pattern("\"id\"\\s*:\\s*(\\d+)");
  std::smatch match;
  if (std::regex_search(line, match, id_pattern)) {
    try {
      const long long parsed = std::stoll(match[1].str());
      if (parsed < 0 || parsed > std::numeric_limits<int>::max()) {
        return -1;
      }
      return static_cast<int>(parsed);
    } catch (...) {
      return -1;
    }
  }

  return -1;
}

std::string extract_method(const std::string& line) {
  const std::regex method_pattern("\"method\"\\s*:\\s*\"([^\"]+)\"");
  std::smatch match;
  if (std::regex_search(line, match, method_pattern)) {
    return match[1].str();
  }

  return {};
}

std::string extract_string_value(const std::string& json, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    return json_unescape(match[1].str());
  }

  return {};
}

int extract_int_value(const std::string& json, const std::string& key, int default_value) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?\\d+)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    try {
      return std::stoi(match[1].str());
    } catch (...) {
      return default_value;
    }
  }

  return default_value;
}

double extract_double_value(const std::string& json, const std::string& key, double default_value) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    try {
      return std::stod(match[1].str());
    } catch (...) {
      return default_value;
    }
  }

  return default_value;
}

bool extract_bool_value(const std::string& json, const std::string& key, bool default_value) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
  std::smatch match;
  if (std::regex_search(json, match, pattern)) {
    return match[1].str() == "true";
  }

  return default_value;
}

std::string json_array_from_strings(const std::vector<std::string>& values) {
  std::ostringstream payload;
  payload << "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) {
      payload << ",";
    }
    payload << "\"" << json_escape(values[index]) << "\"";
  }
  payload << "]";
  return payload.str();
}

void append_nullable_int64(std::ostringstream& payload, long long value) {
  if (value > 0) {
    payload << value;
  } else {
    payload << "null";
  }
}

} // namespace vds::media_agent
