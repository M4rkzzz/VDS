#pragma once

#include <memory>
#include <string>
#ifdef VDS_NATIVE_SURFACE_TESTING
#include <functional>
#endif

struct AVFrame;

// Window-thread owned. The input AVFrame keeps the decoder texture alive until
// the GPU blit is submitted; no staging texture or CPU pixel conversion here.
class NativeD3D11Presenter {
 public:
  enum class Result { Presented, Skipped, Failed };
  NativeD3D11Presenter();
  ~NativeD3D11Presenter();
  static bool supports(const AVFrame* frame);
  Result present(void* parent, AVFrame* frame, int width, int height,
    int left, int top, int right, int bottom, int rate_num, int rate_den, std::string& error);
  void reset();
#ifdef VDS_NATIVE_SURFACE_TESTING
  std::function<void(void*, void*)> inspect_output;
#endif
 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};
