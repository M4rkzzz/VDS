#include "peer_media_manifest.h"

#include <algorithm>
#include <cctype>
#include <mutex>
#include <utility>

#include "json_protocol.h"
#include "peer_session_state.h"
#include "peer_transport.h"

namespace vds::media_agent {
namespace {

std::string to_lower_ascii_copy(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string normalize_manifest_codec_impl(std::string value) {
  value = to_lower_ascii_copy(trim_copy(value));
  value.erase(std::remove(value.begin(), value.end(), '.'), value.end());
  if (value == "hevc") {
    return "h265";
  }
  return value;
}

std::string extract_object_slice(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t key_pos = json.find(needle);
  if (key_pos == std::string::npos) {
    return {};
  }
  const std::size_t object_start = json.find('{', key_pos + needle.size());
  if (object_start == std::string::npos) {
    return {};
  }
  int depth = 0;
  bool in_string = false;
  bool escaping = false;
  for (std::size_t i = object_start; i < json.size(); ++i) {
    const char ch = json[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch == '\\' && in_string) {
      escaping = true;
      continue;
    }
    if (ch == '"') {
      in_string = !in_string;
      continue;
    }
    if (in_string) {
      continue;
    }
    if (ch == '{') {
      depth += 1;
    } else if (ch == '}') {
      depth -= 1;
      if (depth == 0) {
        return json.substr(object_start, i - object_start + 1);
      }
    }
  }
  return {};
}

}  // namespace

std::string normalize_manifest_codec(std::string value) {
  return normalize_manifest_codec_impl(std::move(value));
}

void apply_media_manifest_to_peer(PeerState& peer, const std::string& request_json) {
  const std::string manifest_json = extract_object_slice(request_json, "mediaManifest");
  if (manifest_json.empty()) {
    return;
  }
  peer.media_session_id = extract_string_value(manifest_json, "mediaSessionId");
  peer.media_manifest_version = extract_int_value(manifest_json, "manifestVersion", 0);
  const std::string video_json = extract_object_slice(manifest_json, "video");
  const std::string audio_json = extract_object_slice(manifest_json, "audio");
  peer.expected_video_codec = normalize_manifest_codec_impl(extract_string_value(video_json, "codec"));
  peer.expected_audio_codec = normalize_manifest_codec_impl(extract_string_value(audio_json, "codec"));
  if (peer.receiver_runtime && !peer.expected_video_codec.empty()) {
    std::lock_guard<std::mutex> lock(peer.receiver_runtime->mutex);
    peer.receiver_runtime->codec_path = peer.expected_video_codec;
    peer.receiver_runtime->reason = "media-manifest-applied";
  }
  if (!peer.expected_video_codec.empty()) {
    peer.transport.codec_path = peer.expected_video_codec;
    peer.transport.video_codec = peer.expected_video_codec;
  }
  if (!peer.expected_audio_codec.empty()) {
    peer.transport.audio_codec = peer.expected_audio_codec;
  }
  if (peer.transport_session) {
    set_peer_transport_media_manifest(
      peer.transport_session,
      peer.media_session_id,
      peer.media_manifest_version
    );
    peer.transport = get_peer_transport_snapshot(peer.transport_session);
  }
}

}  // namespace vds::media_agent
