#pragma once

#include <string>
#include <sstream>
#include <vector>

namespace vds::media_agent {

std::string json_escape(const std::string& value);
std::string json_unescape(const std::string& value);
std::string trim_copy(const std::string& value);

std::string build_error_payload(int id, const std::string& code, const std::string& message);
std::string build_result_payload(int id, const std::string& result_json);

int extract_id(const std::string& line);
std::string extract_method(const std::string& line);
std::string extract_string_value(const std::string& json, const std::string& key);
int extract_int_value(const std::string& json, const std::string& key, int default_value = 0);
double extract_double_value(const std::string& json, const std::string& key, double default_value = 0.0);
bool extract_bool_value(const std::string& json, const std::string& key, bool default_value = false);

std::string json_array_from_strings(const std::vector<std::string>& values);
void append_nullable_int64(std::ostringstream& payload, long long value);

} // namespace vds::media_agent
