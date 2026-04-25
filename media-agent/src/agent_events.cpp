#include "agent_events.h"

#include <iostream>
#include <mutex>

#include "json_protocol.h"

namespace {

std::mutex g_output_mutex;

} // namespace

void emit_event(const std::string& event_name, const std::string& params_json) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"" << vds::media_agent::json_escape(event_name) << "\",\"params\":" << params_json << "}" << std::endl;
}

void write_json_line(const std::string& payload) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << payload << std::endl;
}
