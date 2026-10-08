#pragma once

#include <exception>
#include <string>

#include "json_protocol.h"

namespace vds::media_agent {

// A failed request must not tear down the RPC owner or strand its media workers.
// Output failures may still escape to main, which performs final runtime cleanup.
template <typename Handler, typename ErrorWriter>
void dispatch_agent_rpc_request(const std::string& request, Handler&& handler, ErrorWriter&& write_error) {
  int id = 0;
  try {
    const int parsed_id = extract_id(request);
    if (parsed_id >= 0) id = parsed_id;
    const std::string method = extract_method(request);
    if (parsed_id < 0 || method.empty()) {
      write_error(id, "BAD_REQUEST", "Invalid JSON-RPC payload");
      return;
    }
    handler(id, method);
  } catch (const std::exception& error) {
    write_error(id, "INTERNAL_ERROR", error.what());
  } catch (...) {
    write_error(id, "INTERNAL_ERROR", "Unexpected native request failure");
  }
}

}  // namespace vds::media_agent
