#include <rtc/utils.hpp>
#include "earlydtlscallback.hpp"
#include <atomic>
#include <iostream>
#include <stdexcept>
#include <thread>

using rtc::impl::EarlyDtlsCallback;
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
rtc::message_ptr hello(unsigned id = 0, size_t size = 25) {
  auto packet = std::make_shared<rtc::Message>(size);
  auto* data = reinterpret_cast<unsigned char*>(packet->data());
  data[0] = 22; data[1] = 0xfe; data[2] = 0xfd;
  data[10] = static_cast<unsigned char>(id);
  data[11] = static_cast<unsigned char>((size - 13) >> 8);
  data[12] = static_cast<unsigned char>(size - 13); data[13] = 1;
  return packet;
}
int main() {
  try {
    EarlyDtlsCallback callback(true);
    auto first = hello();
    require(callback(first) && callback(hello()), "initial flight accepted and duplicate coalesced");
    unsigned count = 0;
    callback = [&](rtc::message_ptr message) { require(message == first, "replay must reuse the packet"); ++count; };
    require(count == 1, "replay exactly once");
    callback = nullptr;
    require(!callback(first), "stop must not retain new packets");
    callback = [&](rtc::message_ptr) { ++count; };
    require(count == 1, "registration after stop cannot resurrect a stale flight");

    EarlyDtlsCallback bounded(true);
    require(!bounded(nullptr), "null is not a handshake");
    auto invalid = hello(); (*invalid)[0] = std::byte{23};
    require(!bounded(invalid), "do not cache application data");
    invalid = hello(); (*invalid)[4] = std::byte{1};
    require(!bounded(invalid), "do not cache encrypted records");
    invalid = hello(); (*invalid)[12] = std::byte{255};
    require(!bounded(invalid), "do not cache truncated records");
    for (unsigned i = 0; i < 16; ++i) require(bounded(hello(i)), "bounded startup flight");
    require(!bounded(hello(16)), "packet-count bound");
    count = 0;
    bounded = [&](rtc::message_ptr message) {
      require(std::to_integer<unsigned>((*message)[10]) == count++, "replay preserves arrival order");
    };
    require(count == 16, "all retained fragments replayed");
    require(bounded(hello(16, 64000)) && count == 17, "startup bounds must not constrain live traffic");

    EarlyDtlsCallback bytes(true);
    require(bytes(hello(0, 64000)) && !bytes(hello(1, 2048)), "startup byte bound");
    EarlyDtlsCallback ordinary;
    require(!ordinary(hello()), "non-ICE transports keep their existing behavior");

    for (unsigned run = 0; run < 200; ++run) {
      EarlyDtlsCallback racing(true);
      std::atomic<unsigned> delivered{0};
      std::atomic<bool> ready{false};
      std::thread producer([&] { while (!ready.load()) std::this_thread::yield(); racing(hello()); });
      ready = true;
      racing = [&](rtc::message_ptr) { ++delivered; };
      producer.join();
      require(delivered == 1, "registration/arrival race cannot lose or duplicate the flight");
    }
    std::cout << "PASS early DTLS handoff: replay, bounds, stop, live traffic and 200 registration races\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
