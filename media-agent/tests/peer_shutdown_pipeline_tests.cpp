#include "agent_runtime.h"
#include "peer_lifecycle_pipeline.h"
#include "peer_media_detach_binding.h"
#include "runtime_registry.h"

#include <iostream>
#include <stdexcept>
#include <vector>

class PeerTransportSession {
 public:
  std::string peer_id;
};

namespace {
std::vector<std::string> calls;
std::string failing_peer;
int failure_kind = 0;
int checks = 0;
int failures = 0;
void expect(bool condition, const char* message) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}
}

bool prepare_peer_media_binding_for_transport_close(PeerState& peer, std::string* error) {
  calls.push_back("stop:" + peer.peer_id);
  if (peer.peer_id == failing_peer) {
    if (failure_kind == 1) throw std::runtime_error("injected sender stop failure");
    if (failure_kind == 2) throw 7;
    if (error) *error = "injected sender stop rejection";
    return false;
  }
  peer.media_binding.active = false;
  return true;
}

void close_peer_video_receiver_handles(PeerVideoReceiverRuntime& receiver) {
  calls.push_back("receiver:" + receiver.peer_id);
  receiver.closing = true;
}

void close_peer_transport_session(const std::shared_ptr<PeerTransportSession>& transport) {
  calls.push_back("transport:" + transport->peer_id);
}

int main() {
  AgentRuntimeState runtime;
  for (const char* peer_id : {"host-viewer", "relay-viewer", "upstream"}) {
    auto& peer = vds::media_agent::ensure_peer(runtime, peer_id);
    peer.media_binding.active = true;
    peer.receiver_runtime = std::make_shared<PeerVideoReceiverRuntime>();
    peer.receiver_runtime->peer_id = peer_id;
    peer.transport_session = std::make_shared<PeerTransportSession>();
    peer.transport_session->peer_id = peer_id;
  }
  vds::media_agent::stop_all_peer_media_bindings(runtime);
  vds::media_agent::close_all_peer_receiver_handles(runtime);
  vds::media_agent::close_all_peer_transport_sessions(runtime);
  expect(calls == std::vector<std::string>({"stop:host-viewer", "stop:relay-viewer", "stop:upstream",
      "receiver:host-viewer", "receiver:relay-viewer", "receiver:upstream",
      "transport:host-viewer", "transport:relay-viewer", "transport:upstream"}),
    "agent shutdown prepares every normal peer media binding before closing receivers/transports");
  for (int kind = 0; kind < 3; ++kind) {
    calls.clear();
    failing_peer = "host-viewer";
    failure_kind = kind;
    bool reported = false;
    try {
      vds::media_agent::stop_all_peer_media_bindings(runtime);
    } catch (...) {
      reported = true;
    }
    expect(reported, "sender cleanup failures must be reported to final runtime cleanup");
    expect(calls == std::vector<std::string>({"stop:host-viewer", "stop:relay-viewer", "stop:upstream"}),
      "one failed sender cannot skip cleanup of other peer producers");
  }
  std::cout << "Peer shutdown pipeline: " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
