#include "peer_stun_config.h"

#include <algorithm>
#include <utility>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#endif

namespace vds::media_agent {
namespace {

// Read complete JSON values so an IPv6 ']' inside a string cannot terminate a
// pool early. Request scope is either the JSON-RPC params object or legacy root.
class StunRequestJson {
 public:
  explicit StunRequestJson(const std::string& json) : json_(json) {}

  bool field(const std::string& key, std::string* value, bool* present) {
    *present = false;
    if (!take('{')) { return false; }
    if (!take('}')) {
      do {
        std::string current;
        if (!string(&current) || !take(':')) { return false; }
        space();
        const std::size_t begin = cursor_;
        if (!skip_value(0)) { return false; }
        if (current == key) {
          if (*present) { return false; }
          *present = true;
          *value = json_.substr(begin, cursor_ - begin);
        }
        if (take('}')) { return done(); }
      } while (take(','));
      return false;
    }
    return done();
  }

  bool string(std::string* value) {
    if (!take('"')) { return false; }
    value->clear();
    while (cursor_ < json_.size()) {
      const unsigned char current = static_cast<unsigned char>(json_[cursor_++]);
      if (current == '"') { return true; }
      if (current < 0x20) { return false; }
      if (current != '\\') { value->push_back(static_cast<char>(current)); continue; }
      if (cursor_ == json_.size()) { return false; }
      switch (json_[cursor_++]) {
        case '"': value->push_back('"'); break;
        case '\\': value->push_back('\\'); break;
        case '/': value->push_back('/'); break;
        case 'b': value->push_back('\b'); break;
        case 'f': value->push_back('\f'); break;
        case 'n': value->push_back('\n'); break;
        case 'r': value->push_back('\r'); break;
        case 't': value->push_back('\t'); break;
        case 'u': {
          unsigned int point = 0;
          if (!hex4(&point)) { return false; }
          if (point >= 0xd800 && point <= 0xdbff) {
            if (json_.substr(cursor_, 2) != "\\u") { return false; }
            cursor_ += 2;
            unsigned int low = 0;
            if (!hex4(&low) || low < 0xdc00 || low > 0xdfff) { return false; }
            point = 0x10000 + (point - 0xd800) * 0x400 + low - 0xdc00;
          } else if (point >= 0xdc00 && point <= 0xdfff) { return false; }
          if (point < 0x80) { value->push_back(static_cast<char>(point)); }
          else if (point < 0x800) {
            value->push_back(static_cast<char>(0xc0 | (point >> 6)));
            value->push_back(static_cast<char>(0x80 | (point & 0x3f)));
          } else if (point < 0x10000) {
            value->push_back(static_cast<char>(0xe0 | (point >> 12)));
            value->push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3f)));
            value->push_back(static_cast<char>(0x80 | (point & 0x3f)));
          } else {
            value->push_back(static_cast<char>(0xf0 | (point >> 18)));
            value->push_back(static_cast<char>(0x80 | ((point >> 12) & 0x3f)));
            value->push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3f)));
            value->push_back(static_cast<char>(0x80 | (point & 0x3f)));
          }
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool strings(std::vector<std::string>* values) {
    if (!take('[')) { return false; }
    if (take(']')) { return done(); }
    std::size_t count = 0;
    do {
      std::string value;
      if (++count > 4 || !string(&value) || !is_valid_peer_stun_server(value)) { return false; }
      if (std::find(values->begin(), values->end(), value) == values->end()) { values->push_back(value); }
      if (take(']')) { return done(); }
    } while (take(','));
    return false;
  }

  bool done() { space(); return cursor_ == json_.size(); }

 private:
  void space() {
    while (cursor_ < json_.size() && (json_[cursor_] == ' ' || json_[cursor_] == '\t' ||
        json_[cursor_] == '\n' || json_[cursor_] == '\r')) { ++cursor_; }
  }

  bool take(char value) {
    space();
    if (cursor_ == json_.size() || json_[cursor_] != value) { return false; }
    ++cursor_;
    return true;
  }

  bool hex4(unsigned int* value) {
    *value = 0;
    for (int index = 0; index < 4; ++index) {
      if (cursor_ == json_.size()) { return false; }
      const char digit = json_[cursor_++];
      const unsigned int number = digit >= '0' && digit <= '9' ? digit - '0' :
        digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 :
        digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : 16;
      if (number == 16) { return false; }
      *value = *value * 16 + number;
    }
    return true;
  }

  bool digits() {
    const std::size_t begin = cursor_;
    while (cursor_ < json_.size() && json_[cursor_] >= '0' && json_[cursor_] <= '9') { ++cursor_; }
    return cursor_ > begin;
  }

  bool skip_value(unsigned int depth) {
    if (depth > 32) { return false; }
    space();
    if (cursor_ == json_.size()) { return false; }
    if (json_[cursor_] == '"') { std::string ignored; return string(&ignored); }
    if (take('{')) {
      if (take('}')) { return true; }
      do {
        std::string ignored;
        if (!string(&ignored) || !take(':') || !skip_value(depth + 1)) { return false; }
        if (take('}')) { return true; }
      } while (take(','));
      return false;
    }
    if (take('[')) {
      if (take(']')) { return true; }
      do {
        if (!skip_value(depth + 1)) { return false; }
        if (take(']')) { return true; }
      } while (take(','));
      return false;
    }
    for (const char* literal : {"true", "false", "null"}) {
      const std::string text(literal);
      if (json_.compare(cursor_, text.size(), text) == 0) { cursor_ += text.size(); return true; }
    }
    if (json_[cursor_] == '-') { ++cursor_; }
    if (cursor_ == json_.size()) { return false; }
    if (json_[cursor_] == '0') { ++cursor_; }
    else if (json_[cursor_] < '1' || json_[cursor_] > '9' || !digits()) { return false; }
    if (cursor_ < json_.size() && json_[cursor_] == '.') { ++cursor_; if (!digits()) { return false; } }
    if (cursor_ < json_.size() && (json_[cursor_] == 'e' || json_[cursor_] == 'E')) {
      ++cursor_;
      if (cursor_ < json_.size() && (json_[cursor_] == '+' || json_[cursor_] == '-')) { ++cursor_; }
      if (!digits()) { return false; }
    }
    return true;
  }

  const std::string& json_;
  std::size_t cursor_ = 0;
};

bool select_request_scope(const std::string& request_json, std::string* scope) {
  std::string params;
  bool has_params = false;
  if (!StunRequestJson(request_json).field("params", &params, &has_params)) { return false; }
  if (!has_params) { *scope = request_json; return true; }

  // A JSON-RPC envelope cannot also provide legacy root options. Reject even
  // identical values so precedence never depends on which parser is called.
  for (const char* key : {"stunServer", "stunServers"}) {
    std::string ignored;
    bool present = false;
    if (!StunRequestJson(request_json).field(key, &ignored, &present) || present) { return false; }
  }
  std::string ignored;
  bool present = false;
  if (!StunRequestJson(params).field("stunServer", &ignored, &present)) { return false; }
  *scope = std::move(params);
  return true;
}

bool is_ascii_alphanumeric(char value) {
  return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
    (value >= '0' && value <= '9');
}

bool valid_dns_host(std::string host) {
  if (!host.empty() && host.back() == '.') { host.pop_back(); }
  if (host.empty() || host.size() > 253) { return false; }
  std::size_t start = 0;
  while (start < host.size()) {
    const std::size_t end = host.find('.', start);
    const std::size_t length = (end == std::string::npos ? host.size() : end) - start;
    if (length == 0 || length > 63 || !is_ascii_alphanumeric(host[start]) ||
        !is_ascii_alphanumeric(host[start + length - 1])) { return false; }
    for (std::size_t index = start; index < start + length; ++index) {
      if (!is_ascii_alphanumeric(host[index]) && host[index] != '-') { return false; }
    }
    if (end == std::string::npos) { return true; }
    start = end + 1;
  }
  return false;
}

bool valid_port_suffix(const std::string& suffix) {
  if (suffix.empty()) { return true; }
  if (suffix[0] != ':' || suffix.size() < 2 || suffix.size() > 6) { return false; }
  unsigned int port = 0;
  for (std::size_t index = 1; index < suffix.size(); ++index) {
    if (suffix[index] < '0' || suffix[index] > '9') { return false; }
    port = port * 10 + static_cast<unsigned int>(suffix[index] - '0');
  }
  return port > 0 && port <= 65535;
}

} // namespace

bool is_valid_peer_stun_server(const std::string& server) {
  if (server.size() <= 5 || server.size() > 256 || server.rfind("stun:", 0) != 0) {
    return false;
  }
  const std::string authority = server.substr(5);
  if (authority[0] == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string::npos || close <= 1) { return false; }
    const std::string host = authority.substr(1, close - 1);
    in6_addr address{};
#ifdef _WIN32
    const bool valid_ip = InetPtonA(AF_INET6, host.c_str(), &address) == 1;
#else
    const bool valid_ip = inet_pton(AF_INET6, host.c_str(), &address) == 1;
#endif
    return valid_ip && valid_port_suffix(authority.substr(close + 1));
  }
  const std::size_t colon = authority.find(':');
  const std::string host = authority.substr(0, colon);
  return valid_dns_host(host) &&
    (colon == std::string::npos || valid_port_suffix(authority.substr(colon)));
}

bool parse_peer_stun_server_request(const std::string& request_json, std::string* server) {
  if (server) { server->clear(); }
  std::string scope;
  if (!select_request_scope(request_json, &scope)) { return false; }
  std::string value;
  bool present = false;
  if (!StunRequestJson(scope).field("stunServer", &value, &present)) { return false; }
  if (!present) { return true; }
  std::string requested;
  StunRequestJson parser(value);
  if (!parser.string(&requested) || !parser.done() || !is_valid_peer_stun_server(requested)) { return false; }
  if (server) { *server = requested; }
  return true;
}

bool parse_peer_stun_servers_request(const std::string& request_json, std::vector<std::string>* servers) {
  if (servers) { servers->clear(); }
  std::string scope;
  if (!select_request_scope(request_json, &scope)) { return false; }
  std::string value;
  bool present = false;
  if (!StunRequestJson(scope).field("stunServers", &value, &present)) { return false; }
  if (!present) { return true; }
  std::vector<std::string> requested;
  if (!StunRequestJson(value).strings(&requested)) { return false; }
  if (servers) { *servers = std::move(requested); }
  return true;
}

} // namespace vds::media_agent
