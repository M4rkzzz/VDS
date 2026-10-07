#pragma once

#include <cstddef>
#include <set>
#include <string>

namespace vds::media_agent {

inline bool media_source_epoch_is_valid(const std::string& epoch) {
  if (epoch.size() > 128) return false;
  for (const unsigned char character : epoch) {
    if (character < 0x20 || character == 0x7f) return false;
  }
  return true;
}

// Audio and video share one gate. Retired origins are never evicted: accepting
// one again could put an old IDR/PCM packet back on the active source clock.
class MediaSourceEpochGate {
 public:
  enum class Result { accepted, retired, invalid };

  Result accept(const std::string& epoch) {
    if (!media_source_epoch_is_valid(epoch)) return Result::invalid;
    // Older v1 peers omit this optional field; preserve their existing clock.
    if (epoch.empty()) return current_.empty() ? Result::accepted : Result::retired;
    if (epoch == current_) return Result::accepted;
    if (retired_.count(epoch) != 0) return Result::retired;
    if (!current_.empty()) {
      retired_.insert(current_);
    }
    current_ = epoch;
    return Result::accepted;
  }

  const std::string& current() const { return current_; }
  std::size_t retired_count() const { return retired_.size(); }

 private:
  std::string current_;
  std::set<std::string> retired_;
};

} // namespace vds::media_agent
