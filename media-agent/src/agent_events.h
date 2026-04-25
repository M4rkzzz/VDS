#pragma once

#include <string>

void emit_event(const std::string& event_name, const std::string& params_json);
void write_json_line(const std::string& payload);
