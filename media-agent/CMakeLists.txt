cmake_minimum_required(VERSION 3.20)

project(vds-media-agent VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL "Enable libdatachannel peer transport backend" OFF)
option(VDS_MEDIA_AGENT_BUILD_TESTS "Build media-agent unit tests" ON)

add_executable(vds-media-agent
  src/agent_events.cpp
  src/agent_diagnostics.cpp
  src/agent_lifecycle.cpp
  src/agent_rpc_router.cpp
  src/agent_status_json.cpp
  src/ffmpeg_probe.cpp
  src/host_capture_plan.cpp
  src/host_capture_process.cpp
  src/host_session_controller.cpp
  src/host_state_json.cpp
  src/host_pipeline.cpp
  src/json_protocol.cpp
  src/main.cpp
  src/media_audio.cpp
  src/native_artifact_preview.cpp
  src/native_live_preview.cpp
  src/native_surface_layout.cpp
  src/native_video_surface.cpp
  src/obs_ingest_media.cpp
  src/obs_ingest_runtime.cpp
  src/obs_ingest_state.cpp
  src/peer_control_runtime.cpp
  src/peer_media_binding_runtime.cpp
  src/peer_transport.cpp
  src/peer_receiver_runtime.cpp
  src/peer_state_json.cpp
  src/peer_video_sender.cpp
  src/platform_utils.cpp
  src/process_runner.cpp
  src/relay_dispatch.cpp
  src/string_utils.cpp
  src/surface_attachment_runtime.cpp
  src/surface_control_runtime.cpp
  src/surface_target.cpp
  src/time_utils.cpp
  src/viewer_audio_playback.cpp
  src/viewer_video_pipeline.cpp
  src/video_access_unit.cpp
  src/wasapi_backend.cpp
  src/wgc_capture.cpp
)

set(VDS_MEDIA_AGENT_FFMPEG_ROOT "" CACHE PATH "FFmpeg SDK root that contains include/ and lib/")
if(NOT VDS_MEDIA_AGENT_FFMPEG_ROOT)
  if(DEFINED ENV{VDS_FFMPEG_SOURCE} AND EXISTS "$ENV{VDS_FFMPEG_SOURCE}/include/libavcodec/avcodec.h")
    set(VDS_MEDIA_AGENT_FFMPEG_ROOT "$ENV{VDS_FFMPEG_SOURCE}")
  elseif(EXISTS "D:/project/publicresource/ffmpeg-master-latest-win64-gpl-shared/include/libavcodec/avcodec.h")
    set(VDS_MEDIA_AGENT_FFMPEG_ROOT "D:/project/publicresource/ffmpeg-master-latest-win64-gpl-shared")
  endif()
endif()

if(NOT VDS_MEDIA_AGENT_FFMPEG_ROOT OR NOT EXISTS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include/libavcodec/avcodec.h")
  message(FATAL_ERROR "FFmpeg SDK root not found. Set VDS_MEDIA_AGENT_FFMPEG_ROOT or VDS_FFMPEG_SOURCE to a shared FFmpeg build that contains include/ and lib/.")
endif()

find_library(VDS_MEDIA_AGENT_AVCODEC_LIBRARY NAMES avcodec PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_AVFORMAT_LIBRARY NAMES avformat PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_AVUTIL_LIBRARY NAMES avutil PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_SWSCALE_LIBRARY NAMES swscale PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)

target_include_directories(vds-media-agent PRIVATE
  src
  "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include"
)

target_link_libraries(vds-media-agent PRIVATE
  "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}"
  "${VDS_MEDIA_AGENT_AVFORMAT_LIBRARY}"
  "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
  "${VDS_MEDIA_AGENT_SWSCALE_LIBRARY}"
)

if(VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL)
  find_package(LibDataChannel CONFIG REQUIRED)
  target_link_libraries(vds-media-agent PRIVATE LibDataChannel::LibDataChannel)
  target_compile_definitions(vds-media-agent PRIVATE VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL=1)
endif()

if(WIN32)
  target_link_libraries(vds-media-agent PRIVATE
    Gdi32
    Mmdevapi
    Winmm
    Ws2_32
    D3D11
    Dwmapi
    Dxgi
    ole32
    RuntimeObject
    User32
    windowsapp
  )
endif()

target_compile_definitions(vds-media-agent PRIVATE
  VDS_MEDIA_AGENT_NAME="vds-media-agent"
  VDS_MEDIA_AGENT_VERSION="${PROJECT_VERSION}"
)

if(MSVC)
  target_compile_options(vds-media-agent PRIVATE /W4 /permissive-)
else()
  target_compile_options(vds-media-agent PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(VDS_MEDIA_AGENT_BUILD_TESTS)
  enable_testing()
  add_executable(vds-media-agent-tests
    tests/media_agent_unit_tests.cpp
    src/ffmpeg_probe.cpp
    src/host_pipeline.cpp
    src/json_protocol.cpp
    src/obs_ingest_state.cpp
    src/platform_utils.cpp
    src/process_runner.cpp
    src/string_utils.cpp
    src/surface_target.cpp
    src/video_access_unit.cpp
  )
  target_include_directories(vds-media-agent-tests PRIVATE
    src
    "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include"
  )
  if(MSVC)
    target_compile_options(vds-media-agent-tests PRIVATE /W4 /permissive-)
  else()
    target_compile_options(vds-media-agent-tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  target_link_libraries(vds-media-agent-tests PRIVATE
    "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}"
    "${VDS_MEDIA_AGENT_AVFORMAT_LIBRARY}"
    "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
    "${VDS_MEDIA_AGENT_SWSCALE_LIBRARY}"
  )
  add_test(NAME vds-media-agent-unit-tests COMMAND vds-media-agent-tests)
  set_tests_properties(vds-media-agent-unit-tests PROPERTIES
    ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
  )
endif()
