#include "agent_diagnostics.h"

#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <unordered_map>

#include "time_utils.h"

namespace {

bool verbose_breadcrumbs_enabled() {
#ifdef _MSC_VER
  char* verbose = nullptr;
  std::size_t length = 0;
  if (_dupenv_s(&verbose, &length, "VDS_VERBOSE_MEDIA_LOGS") != 0 || !verbose) {
    return false;
  }
  const bool enabled = std::string(verbose) == "1";
  std::free(verbose);
  return enabled;
#else
  const char* verbose = std::getenv("VDS_VERBOSE_MEDIA_LOGS");
  return verbose && std::string(verbose) == "1";
#endif
}

}  // namespace

void emit_agent_breadcrumb(const std::string& step) {
  static std::mutex mutex;
  static std::unordered_map<std::string, std::int64_t> last_emit_at_by_step;
  static std::unordered_map<std::string, unsigned long long> suppressed_by_step;

  constexpr std::int64_t kBreadcrumbIntervalMs = 1000;
  const std::int64_t now = vds::media_agent::current_time_millis();
  unsigned long long suppressed = 0;

  {
    std::lock_guard<std::mutex> lock(mutex);
    if (!verbose_breadcrumbs_enabled()) {
      const auto last_it = last_emit_at_by_step.find(step);
      if (last_it != last_emit_at_by_step.end() && now - last_it->second < kBreadcrumbIntervalMs) {
        suppressed_by_step[step] += 1;
        return;
      }
    }
    suppressed = suppressed_by_step[step];
    suppressed_by_step[step] = 0;
    last_emit_at_by_step[step] = now;
  }

  std::cerr << "[media-agent breadcrumb] t=" << now << " step=" << step;
  if (suppressed > 0) {
    std::cerr << " suppressed=" << suppressed;
  }
  std::cerr << std::endl;
}
