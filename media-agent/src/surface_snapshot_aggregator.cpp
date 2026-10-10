#include "surface_snapshot_aggregator.h"

#include <sstream>

#include "runtime_registry.h"
#include "surface_attachment_state.h"
#include "surface_state_json.h"

namespace vds::media_agent {

std::size_t surface_session_count(const AgentRuntimeState& runtime_state) {
  return surface_count(runtime_state);
}

std::string surface_session_stats_json(const AgentRuntimeState& runtime_state) {
  std::ostringstream payload;
  payload << "[";
  bool first = true;
  for_each_surface(runtime_state, [&](const SurfaceAttachmentState& surface) {
    if (!first) {
      payload << ",";
    }
    first = false;
    // Serialize a refreshed snapshot without mutating the registry during a
    // const stats read. Peer surfaces otherwise keep their attachment-time count.
    SurfaceAttachmentState snapshot = surface;
    payload << surface_attachment_json(snapshot);
  });
  payload << "]";
  return payload.str();
}

}  // namespace vds::media_agent
