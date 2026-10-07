cmake_minimum_required(VERSION 3.20)

project(vds-media-agent VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL "Enable libdatachannel peer transport backend" OFF)
option(VDS_MEDIA_AGENT_ENHANCED_ICE "Use pinned VDS pure-P2P ICE extensions" ON)
option(VDS_MEDIA_AGENT_BUILD_TESTS "Build media-agent unit tests" ON)

add_executable(vds-media-agent
  src/agent_events.cpp
  src/agent_diagnostics.cpp
  src/agent_lifecycle.cpp
  src/agent_rpc_router.cpp
  src/agent_rpc_session_bindings.cpp
  src/agent_status_json.cpp
  src/audio_state_json.cpp
  src/encoded_frame_bus.cpp
  src/ffmpeg_probe.cpp
  src/host_audio_dispatch_session.cpp
  src/host_capture_plan.cpp
  src/host_capture_process.cpp
    src/host_session_controller.cpp
    src/host_session_runtime.cpp
    src/host_session_start_pipeline.cpp
    src/host_session_stop_pipeline.cpp
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
  src/obs_ingest_session.cpp
  src/obs_ingest_state.cpp
  src/peer_create_pipeline.cpp
  src/peer_create_request_config.cpp
  src/peer_host_binding_pipeline.cpp
  src/peer_host_source_binding.cpp
  src/peer_lifecycle_pipeline.cpp
  src/peer_media_detach_binding.cpp
  src/peer_media_manifest.cpp
  src/peer_media_source_pipeline.cpp
  src/peer_transport.cpp
  src/peer_transport_state_json.cpp
  src/peer_transport_callback_factory.cpp
  src/peer_transport_session_factory.cpp
  src/peer_receiver_runtime.cpp
  src/peer_refresh_pipeline.cpp
  src/peer_relay_source_binding.cpp
  src/peer_session_controller.cpp
  src/peer_stun_config.cpp
  src/peer_snapshot_aggregator.cpp
  src/peer_state_json.cpp
  src/peer_video_sender.cpp
  src/platform_utils.cpp
  src/process_runner.cpp
  src/relay_backend_runtime.cpp
  src/relay_hub.cpp
  src/runtime_registry.cpp
  src/session_owner_activation.cpp
  src/string_utils.cpp
    src/surface_attachment_runtime.cpp
    src/surface_session_controller.cpp
    src/surface_snapshot_aggregator.cpp
    src/surface_state_json.cpp
  src/surface_target.cpp
  src/time_utils.cpp
  src/viewer_audio_playback.cpp
  src/viewer_audio_session.cpp
  src/viewer_video_pipeline.cpp
  src/video_access_unit.cpp
  src/wasapi_backend.cpp
  src/wgc_capture.cpp
)

set(VDS_MEDIA_AGENT_FFMPEG_ROOT "" CACHE PATH "FFmpeg SDK root that contains include/ and lib/")
if(NOT VDS_MEDIA_AGENT_FFMPEG_ROOT)
  if(DEFINED ENV{VDS_FFMPEG_SOURCE} AND EXISTS "$ENV{VDS_FFMPEG_SOURCE}/include/libavcodec/avcodec.h")
    set(VDS_MEDIA_AGENT_FFMPEG_ROOT "$ENV{VDS_FFMPEG_SOURCE}")
  endif()
endif()

if(NOT VDS_MEDIA_AGENT_FFMPEG_ROOT OR NOT EXISTS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include/libavcodec/avcodec.h")
  message(FATAL_ERROR "FFmpeg SDK root not found. Set VDS_MEDIA_AGENT_FFMPEG_ROOT or VDS_FFMPEG_SOURCE to a shared FFmpeg build that contains include/ and lib/.")
endif()

find_library(VDS_MEDIA_AGENT_AVCODEC_LIBRARY NAMES avcodec PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_AVFORMAT_LIBRARY NAMES avformat PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_AVUTIL_LIBRARY NAMES avutil PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_SWSCALE_LIBRARY NAMES swscale PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY NAMES swresample PATHS "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH REQUIRED)

target_include_directories(vds-media-agent PRIVATE
  src
  "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include"
)

target_link_libraries(vds-media-agent PRIVATE
  "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}"
  "${VDS_MEDIA_AGENT_AVFORMAT_LIBRARY}"
  "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
  "${VDS_MEDIA_AGENT_SWSCALE_LIBRARY}"
  "${VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY}"
)

if(VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL)
  if(VDS_MEDIA_AGENT_ENHANCED_ICE)
    include(cmake/VdsEnhancedIce.cmake)
  endif()
  find_package(LibDataChannel CONFIG REQUIRED)
  target_link_libraries(vds-media-agent PRIVATE LibDataChannel::LibDataChannel)
  target_compile_definitions(vds-media-agent PRIVATE VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL=1)
  if(VDS_MEDIA_AGENT_ENHANCED_ICE)
    target_compile_definitions(vds-media-agent PRIVATE VDS_MEDIA_AGENT_ENHANCED_ICE=1)
    vds_copy_enhanced_ice_runtime(vds-media-agent)
  endif()
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
  set_source_files_properties(src/wgc_capture.cpp PROPERTIES COMPILE_OPTIONS /EHa)
else()
  target_compile_options(vds-media-agent PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(VDS_MEDIA_AGENT_BUILD_TESTS)
  enable_testing()
  add_executable(vds-nat-port-prediction-tests tests/nat_port_prediction_tests.cpp)
  target_include_directories(vds-nat-port-prediction-tests PRIVATE src)
  add_test(NAME vds-nat-port-prediction-tests COMMAND vds-nat-port-prediction-tests)
  foreach(playback_policy_test IN ITEMS native_playback_scheduler relay_media_timing host_media_clock)
    string(REPLACE "_" "-" playback_policy_target "vds-${playback_policy_test}-tests")
    add_executable(${playback_policy_target} tests/${playback_policy_test}_tests.cpp)
    target_include_directories(${playback_policy_target} PRIVATE src)
    add_test(NAME ${playback_policy_target} COMMAND ${playback_policy_target})
  endforeach()
  add_executable(vds-relay-backend-timing-tests
    tests/relay_backend_timing_tests.cpp src/relay_backend_runtime.cpp
    src/video_access_unit.cpp src/json_protocol.cpp)
  target_include_directories(vds-relay-backend-timing-tests PRIVATE src)
  add_test(NAME vds-relay-backend-timing-tests COMMAND vds-relay-backend-timing-tests)
  add_executable(vds-media-source-timing-tests tests/media_source_timing_tests.cpp src/obs_ingest_media.cpp)
  target_include_directories(vds-media-source-timing-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
  target_link_libraries(vds-media-source-timing-tests PRIVATE "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}")
  add_test(NAME vds-media-source-timing-tests COMMAND vds-media-source-timing-tests)
  set_tests_properties(vds-media-source-timing-tests PROPERTIES
    ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
  )
  add_executable(vds-host-audio-encoder-clock-tests tests/host_audio_encoder_clock_tests.cpp)
  target_include_directories(vds-host-audio-encoder-clock-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
  target_link_libraries(vds-host-audio-encoder-clock-tests PRIVATE
    "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}" "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}")
  add_test(NAME vds-host-audio-encoder-clock-tests COMMAND vds-host-audio-encoder-clock-tests)
  set_tests_properties(vds-host-audio-encoder-clock-tests PROPERTIES
    ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
  )
  if(WIN32 AND VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL)
    find_package(Threads REQUIRED)
    add_executable(vds-peer-keyframe-control-e2e
      tests/peer_keyframe_control_e2e.cpp
      src/peer_transport.cpp src/json_protocol.cpp src/peer_stun_config.cpp src/time_utils.cpp)
    target_include_directories(vds-peer-keyframe-control-e2e PRIVATE src)
    target_compile_definitions(vds-peer-keyframe-control-e2e PRIVATE VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL=1)
    target_link_libraries(vds-peer-keyframe-control-e2e PRIVATE
      LibDataChannel::LibDataChannel Threads::Threads Ws2_32)
    if(VDS_MEDIA_AGENT_ENHANCED_ICE)
      target_compile_definitions(vds-peer-keyframe-control-e2e PRIVATE VDS_MEDIA_AGENT_ENHANCED_ICE=1)
      vds_copy_enhanced_ice_runtime(vds-peer-keyframe-control-e2e)
    endif()
    add_test(NAME vds-peer-keyframe-control-e2e COMMAND vds-peer-keyframe-control-e2e)
    set_tests_properties(vds-peer-keyframe-control-e2e PROPERTIES TIMEOUT 30
      ENVIRONMENT "PATH=${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent;$ENV{PATH}")
  endif()
  if(WIN32 AND VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL AND VDS_MEDIA_AGENT_ENHANCED_ICE)
    find_package(Threads REQUIRED)
    set(LibJuice_DIR "${VDS_MEDIA_AGENT_ICE_PREFIX}/lib/cmake/LibJuice" CACHE PATH "" FORCE)
    find_package(LibJuice 1.7.0 CONFIG REQUIRED)
    add_executable(vds-nat-stun-probe-tests tests/juice_stun_probe_tests.cpp)
    target_link_libraries(vds-nat-stun-probe-tests PRIVATE LibJuice::LibJuice Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-nat-stun-probe-tests)
    add_test(NAME vds-nat-stun-probe-tests COMMAND vds-nat-stun-probe-tests)
    set_tests_properties(vds-nat-stun-probe-tests PROPERTIES TIMEOUT 30)
    add_executable(vds-nat-traversal-e2e tests/nat_traversal_e2e.cpp)
    target_link_libraries(vds-nat-traversal-e2e PRIVATE LibDataChannel::LibDataChannel Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-nat-traversal-e2e)
    add_test(NAME vds-nat-traversal-e2e COMMAND vds-nat-traversal-e2e)
    set_tests_properties(vds-nat-traversal-e2e PROPERTIES TIMEOUT 75)
  endif()
  add_executable(vds-media-agent-tests
    tests/media_agent_unit_tests.cpp
    src/ffmpeg_probe.cpp
    src/host_pipeline.cpp
    src/json_protocol.cpp
    src/obs_ingest_state.cpp
    src/platform_utils.cpp
    src/peer_stun_config.cpp
    src/process_runner.cpp
    src/runtime_registry.cpp
    src/session_owner_activation.cpp
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
  if(WIN32)
    target_link_libraries(vds-media-agent-tests PRIVATE Ws2_32)
  endif()
  add_test(NAME vds-media-agent-unit-tests COMMAND vds-media-agent-tests)
  set_tests_properties(vds-media-agent-unit-tests PROPERTIES
    ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
  )
  if(WIN32)
    add_executable(vds-native-playback-surface-tests
      tests/native_playback_surface_tests.cpp
      src/native_video_surface.cpp
      src/video_access_unit.cpp
      src/time_utils.cpp
      src/viewer_audio_playback.cpp
      src/media_audio.cpp
      src/string_utils.cpp
    )
    target_include_directories(vds-native-playback-surface-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_link_libraries(vds-native-playback-surface-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}" "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
      "${VDS_MEDIA_AGENT_SWSCALE_LIBRARY}" "${VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY}" User32 Gdi32 Winmm)
    add_test(NAME vds-native-playback-surface-tests COMMAND vds-native-playback-surface-tests)
    set_tests_properties(vds-native-playback-surface-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 30)
    add_executable(vds-viewer-audio-clock-tests
      tests/viewer_audio_clock_tests.cpp
      src/media_audio.cpp
      src/obs_ingest_media.cpp
      src/string_utils.cpp
      src/time_utils.cpp
      src/viewer_audio_playback.cpp
    )
    target_include_directories(vds-viewer-audio-clock-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_link_libraries(vds-viewer-audio-clock-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}" "${VDS_MEDIA_AGENT_AVFORMAT_LIBRARY}"
      "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}" "${VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY}" Winmm)
    add_test(NAME vds-viewer-audio-clock-tests COMMAND vds-viewer-audio-clock-tests)
    set_tests_properties(vds-viewer-audio-clock-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 30)
    add_executable(vds-media-agent-audio-tests
      tests/media_agent_audio_tests.cpp
      src/media_audio.cpp
      src/obs_ingest_media.cpp
      src/string_utils.cpp
      src/time_utils.cpp
      src/viewer_audio_playback.cpp
    )
    target_include_directories(vds-media-agent-audio-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_link_libraries(vds-media-agent-audio-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}"
      "${VDS_MEDIA_AGENT_AVFORMAT_LIBRARY}"
      "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
      "${VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY}"
      Winmm
    )
    add_test(NAME vds-media-agent-audio-tests COMMAND vds-media-agent-audio-tests)
    set_tests_properties(vds-media-agent-audio-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
      TIMEOUT 30
    )
    find_program(VDS_MEDIA_AGENT_POWERSHELL NAMES pwsh powershell REQUIRED)
    add_test(NAME vds-media-agent-rpc-lifecycle-tests
      COMMAND "${VDS_MEDIA_AGENT_POWERSHELL}" -NoProfile -ExecutionPolicy Bypass
        -File "${CMAKE_CURRENT_SOURCE_DIR}/tests/media_agent_rpc_lifecycle_tests.ps1"
        -AgentPath $<TARGET_FILE:vds-media-agent>
    )
    set_tests_properties(vds-media-agent-rpc-lifecycle-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}"
      TIMEOUT 45
    )
  endif()
endif()
