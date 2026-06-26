#pragma once

#include <string>
#include <vector>

struct PeerTransportBackendInfo {
  bool available = false;
  bool transport_ready = false;
  std::string backend = "stub";
  std::string implementation = "stub";
  std::string mode = "disabled";
  std::string reason = "libdatachannel-not-compiled";
  std::string last_error;
  std::vector<std::string> ice_servers;
};
