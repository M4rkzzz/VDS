cmake_minimum_required(VERSION 3.20)

# Single-configuration generators (Ninja/Makefiles) otherwise build without the
# Release optimization flags. Set this before project(): MSVC can initialize an
# unspecified build type to Debug there. Explicit configurations are preserved.
get_property(VDS_MEDIA_AGENT_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(NOT VDS_MEDIA_AGENT_MULTI_CONFIG AND NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build configuration" FORCE)
endif()

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
  src/native_preview_presenter.cpp
  src/native_surface_layout.cpp
  src/native_video_surface.cpp
  src/native_d3d11_presenter.cpp
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
  src/wgc_capability_probe.cpp
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
    D2d1
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
  add_executable(vds-nat-allocation-model-tests tests/nat_allocation_model_tests.cpp)
  target_include_directories(vds-nat-allocation-model-tests PRIVATE src)
  add_test(NAME vds-nat-allocation-model-tests COMMAND vds-nat-allocation-model-tests)
  set_tests_properties(vds-nat-allocation-model-tests PROPERTIES TIMEOUT 30)
  add_executable(vds-encoded-media-transport-limits-tests tests/encoded_media_transport_limits_tests.cpp)
  target_include_directories(vds-encoded-media-transport-limits-tests PRIVATE src)
  add_test(NAME vds-encoded-media-transport-limits-tests COMMAND vds-encoded-media-transport-limits-tests)
  add_executable(vds-video-access-unit-tests tests/video_access_unit_tests.cpp src/video_access_unit.cpp)
  target_include_directories(vds-video-access-unit-tests PRIVATE src)
  add_test(NAME vds-video-access-unit-tests COMMAND vds-video-access-unit-tests)
  add_executable(vds-agent-rpc-boundary-tests tests/agent_rpc_boundary_tests.cpp src/json_protocol.cpp)
  target_include_directories(vds-agent-rpc-boundary-tests PRIVATE src)
  add_test(NAME vds-agent-rpc-boundary-tests COMMAND vds-agent-rpc-boundary-tests)
  add_executable(vds-peer-shutdown-pipeline-tests
    tests/peer_shutdown_pipeline_tests.cpp src/peer_lifecycle_pipeline.cpp src/runtime_registry.cpp)
  target_include_directories(vds-peer-shutdown-pipeline-tests PRIVATE src)
  add_test(NAME vds-peer-shutdown-pipeline-tests COMMAND vds-peer-shutdown-pipeline-tests)
  add_executable(vds-wgc-frame-sampling-tests tests/wgc_frame_sampling_tests.cpp)
  target_include_directories(vds-wgc-frame-sampling-tests PRIVATE src)
  add_test(NAME vds-wgc-frame-sampling-tests COMMAND vds-wgc-frame-sampling-tests)
  if(WIN32)
    add_executable(vds-wgc-apartment-lifecycle-tests
      tests/wgc_apartment_lifecycle_tests.cpp src/wgc_capture.cpp)
    target_include_directories(vds-wgc-apartment-lifecycle-tests PRIVATE src)
    target_link_libraries(vds-wgc-apartment-lifecycle-tests PRIVATE d3d11 dxgi user32 gdi32 ole32 RuntimeObject windowsapp)
    add_test(NAME vds-wgc-apartment-lifecycle-tests COMMAND vds-wgc-apartment-lifecycle-tests)
    set_tests_properties(vds-wgc-apartment-lifecycle-tests PROPERTIES SKIP_RETURN_CODE 77)
    add_executable(vds-wasapi-packet-diagnostics-tests
      tests/wasapi_packet_diagnostics_tests.cpp src/json_protocol.cpp)
    target_include_directories(vds-wasapi-packet-diagnostics-tests PRIVATE src)
    target_link_libraries(vds-wasapi-packet-diagnostics-tests PRIVATE Mmdevapi ole32 RuntimeObject windowsapp)
    add_test(NAME vds-wasapi-packet-diagnostics-tests COMMAND vds-wasapi-packet-diagnostics-tests)
    add_executable(vds-host-audio-dispatch-tests
      tests/host_audio_dispatch_tests.cpp src/json_protocol.cpp src/audio_state_json.cpp)
    target_include_directories(vds-host-audio-dispatch-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_link_libraries(vds-host-audio-dispatch-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}" "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}")
    add_test(NAME vds-host-audio-dispatch-tests COMMAND vds-host-audio-dispatch-tests)
    set_tests_properties(vds-host-audio-dispatch-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}")
    add_executable(vds-win32-owned-process-tests tests/win32_owned_process_tests.cpp)
    target_include_directories(vds-win32-owned-process-tests PRIVATE src)
    add_test(NAME vds-win32-owned-process-tests COMMAND vds-win32-owned-process-tests)
    set_tests_properties(vds-win32-owned-process-tests PROPERTIES TIMEOUT 30)
    add_executable(vds-probe-process-tests
      tests/probe_process_tests.cpp src/process_runner.cpp src/string_utils.cpp src/json_protocol.cpp)
    target_include_directories(vds-probe-process-tests PRIVATE src)
    add_test(NAME vds-probe-process-tests COMMAND vds-probe-process-tests)
    set_tests_properties(vds-probe-process-tests PROPERTIES TIMEOUT 30)
    add_test(NAME vds-media-agent-capability-probe-tests COMMAND vds-probe-process-tests
      --agent-path "$<TARGET_FILE:vds-media-agent>")
    set_tests_properties(vds-media-agent-capability-probe-tests PROPERTIES
      TIMEOUT 40 ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}")
  endif()
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
    add_executable(vds-peer-stun-config-tests tests/peer_stun_rtc_tests.cpp src/peer_stun_config.cpp)
    target_include_directories(vds-peer-stun-config-tests PRIVATE src)
    target_link_libraries(vds-peer-stun-config-tests PRIVATE LibDataChannel::LibDataChannel Ws2_32)
    if(VDS_MEDIA_AGENT_ENHANCED_ICE)
      vds_copy_enhanced_ice_runtime(vds-peer-stun-config-tests)
    endif()
    add_test(NAME vds-peer-stun-config-tests COMMAND vds-peer-stun-config-tests)
    add_executable(vds-peer-keyframe-control-e2e
      tests/peer_keyframe_control_e2e.cpp
      src/peer_transport.cpp src/json_protocol.cpp src/peer_stun_config.cpp src/time_utils.cpp)
    target_include_directories(vds-peer-keyframe-control-e2e PRIVATE src)
    target_compile_definitions(vds-peer-keyframe-control-e2e PRIVATE VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL=1 VDS_TRANSPORT_TESTING=1)
    target_link_libraries(vds-peer-keyframe-control-e2e PRIVATE
      LibDataChannel::LibDataChannel Threads::Threads Ws2_32)
    if(VDS_MEDIA_AGENT_ENHANCED_ICE)
      target_compile_definitions(vds-peer-keyframe-control-e2e PRIVATE VDS_MEDIA_AGENT_ENHANCED_ICE=1)
      vds_copy_enhanced_ice_runtime(vds-peer-keyframe-control-e2e)
    endif()
    add_test(NAME vds-peer-keyframe-control-e2e COMMAND vds-peer-keyframe-control-e2e)
    foreach(network_recovery IN ITEMS control config)
      add_test(NAME vds-peer-congestion-${network_recovery} COMMAND vds-peer-keyframe-control-e2e --congestion-${network_recovery})
      set_tests_properties(vds-peer-congestion-${network_recovery} PROPERTIES TIMEOUT 30
        ENVIRONMENT "PATH=${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent;$ENV{PATH}")
    endforeach()
    set_tests_properties(vds-peer-keyframe-control-e2e PROPERTIES TIMEOUT 30
      ENVIRONMENT "PATH=${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent;$ENV{PATH}")
  endif()
  if(WIN32 AND VDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL AND VDS_MEDIA_AGENT_ENHANCED_ICE)
    find_package(Threads REQUIRED)
    set(LibJuice_DIR "${VDS_MEDIA_AGENT_ICE_PREFIX}/lib/cmake/LibJuice" CACHE PATH "" FORCE)
    find_package(LibJuice 1.7.0 CONFIG REQUIRED)
    # Test the exact STUN address selector from this patch/algorithm revision.
    file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ice-patches/libjuice-1.7.0-vds.patch" _stun_patch_hash)
    file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/src/nat_port_prediction.h" _stun_algorithm_hash)
    string(SUBSTRING "${_stun_patch_hash}" 0 12 _stun_patch_hash)
    string(SUBSTRING "${_stun_algorithm_hash}" 0 12 _stun_algorithm_hash)
    string(TOUPPER "${_stun_patch_hash}-${_stun_algorithm_hash}" _stun_revision)
    set(_stun_source "${VDS_MEDIA_AGENT_ICE_PREFIX}/../sources/libjuice-1.7.0-${_stun_revision}/libjuice-1.7.0")
    # Compile this exact ICE revision with only getaddrinfo substituted in agent.c.
    # This target is isolated from the shipped DLL; DNS delay is test-only.
    enable_language(C)
    # Exercise the actual patched parser/poll code, not a second implementation.
    add_executable(vds-tcp-io-tests tests/juice_tcp_io_tests.c
      "${_stun_source}/src/addr.c" "${_stun_source}/src/udp.c"
      "${_stun_source}/src/log.c" "${_stun_source}/src/timestamp.c" "${_stun_source}/src/random.c")
    add_executable(vds-tcp-ice-e2e tests/tcp_ice_e2e.cpp tests/juice_tcp_invalid.c)
    target_include_directories(vds-tcp-ice-e2e PRIVATE "${_stun_source}/src" "${_stun_source}/include/juice")
    target_link_libraries(vds-tcp-ice-e2e PRIVATE LibDataChannel::LibDataChannel LibJuice::LibJuice Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-tcp-ice-e2e)
    add_test(NAME vds-tcp-ice-e2e COMMAND vds-tcp-ice-e2e)
    add_test(NAME vds-tcp-active-bind-e2e COMMAND vds-tcp-ice-e2e --active-bind)
    set_tests_properties(vds-tcp-active-bind-e2e PROPERTIES TIMEOUT 90)
    add_test(NAME vds-tcp-so-e2e COMMAND vds-tcp-ice-e2e --simultaneous-edge)
    set_tests_properties(vds-tcp-so-e2e PROPERTIES TIMEOUT 90)
    set_tests_properties(vds-tcp-ice-e2e PROPERTIES TIMEOUT 90)
    add_executable(vds-tcp-wire-tests tests/juice_tcp_wire_tests.cpp
      "${_stun_source}/src/tcp.c" "${_stun_source}/src/log.c" "${_stun_source}/src/timestamp.c")
    foreach(_tcp_test IN ITEMS vds-tcp-io-tests vds-tcp-wire-tests)
      target_include_directories(${_tcp_test} PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
      target_compile_definitions(${_tcp_test} PRIVATE JUICE_STATIC USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
      target_link_libraries(${_tcp_test} PRIVATE Ws2_32 bcrypt)
      add_test(NAME ${_tcp_test} COMMAND ${_tcp_test})
      set_tests_properties(${_tcp_test} PROPERTIES TIMEOUT 20)
    endforeach()
    set(_resolver_test_sources)
    foreach(_unit IN ITEMS addr crc32 const_time conn conn_poll conn_thread conn_mux base64 hash hmac ice juice log random server stun timestamp tcp turn udp)
      list(APPEND _resolver_test_sources "${_stun_source}/src/${_unit}.c")
    endforeach()
    add_executable(vds-stun-resolver-progress-tests tests/juice_resolver_progress_tests.cpp tests/juice_resolver_agent.c ${_resolver_test_sources})
    target_include_directories(vds-stun-resolver-progress-tests PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
    target_compile_definitions(vds-stun-resolver-progress-tests PRIVATE JUICE_STATIC USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    set_target_properties(vds-stun-resolver-progress-tests PROPERTIES C_STANDARD 11)
    target_link_libraries(vds-stun-resolver-progress-tests PRIVATE Threads::Threads Ws2_32 bcrypt)
    add_test(NAME vds-stun-resolver-progress-tests COMMAND vds-stun-resolver-progress-tests)
    set_tests_properties(vds-stun-resolver-progress-tests PROPERTIES TIMEOUT 30)
    add_executable(vds-sequential-pacing-tests tests/juice_sequential_pacing_tests.c "${_stun_source}/src/agent.c" ${_resolver_test_sources})
    target_include_directories(vds-sequential-pacing-tests PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
    target_compile_definitions(vds-sequential-pacing-tests PRIVATE JUICE_STATIC USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(vds-sequential-pacing-tests PRIVATE Threads::Threads Ws2_32 bcrypt)
    add_test(NAME vds-sequential-pacing-tests COMMAND vds-sequential-pacing-tests)
    set_tests_properties(vds-sequential-pacing-tests PROPERTIES TIMEOUT 10)
    add_executable(vds-stun-resolver-tests tests/stun_resolver_tests.cpp)
    target_include_directories(vds-stun-resolver-tests PRIVATE "${_stun_source}/src")
    target_link_libraries(vds-stun-resolver-tests PRIVATE Ws2_32)
    add_test(NAME vds-stun-resolver-tests COMMAND vds-stun-resolver-tests)
    set_tests_properties(vds-stun-resolver-tests PROPERTIES TIMEOUT 10)
    add_executable(vds-nat-stun-probe-tests tests/juice_stun_probe_tests.cpp)
    target_link_libraries(vds-nat-stun-probe-tests PRIVATE LibJuice::LibJuice Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-nat-stun-probe-tests)
    add_test(NAME vds-nat-stun-probe-tests COMMAND vds-nat-stun-probe-tests)
    set_tests_properties(vds-nat-stun-probe-tests PROPERTIES TIMEOUT 30)
    add_executable(vds-nat-traversal-e2e tests/nat_traversal_e2e.cpp)
    target_link_libraries(vds-nat-traversal-e2e PRIVATE LibDataChannel::LibDataChannel Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-nat-traversal-e2e)
    # Isolate the UDP seam from every shipped/test production DLL directory.
    set(_egress_sources ${_resolver_test_sources})
    list(REMOVE_ITEM _egress_sources "${_stun_source}/src/udp.c")
    add_library(vds-test-juice-egress SHARED tests/juice_full_egress.c "${_stun_source}/src/agent.c" ${_egress_sources})
    target_include_directories(vds-test-juice-egress PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
    target_compile_definitions(vds-test-juice-egress PRIVATE JUICE_EXPORTS USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(vds-test-juice-egress PRIVATE Threads::Threads Ws2_32 bcrypt)
    set_target_properties(vds-test-juice-egress PROPERTIES OUTPUT_NAME juice
      RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/full-egress/$<CONFIG>"
      ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/full-egress/$<CONFIG>")
    add_executable(vds-nat-full-egress tests/nat_traversal_e2e.cpp)
    target_compile_definitions(vds-nat-full-egress PRIVATE VDS_TEST_FULL_EGRESS=1)
    target_link_libraries(vds-nat-full-egress PRIVATE LibDataChannel::LibDataChannel vds-test-juice-egress Threads::Threads Ws2_32)
    set_target_properties(vds-nat-full-egress PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/full-egress/$<CONFIG>")
    file(GLOB _egress_runtime "${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent/libssl-*.dll"
      "${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent/libcrypto-*.dll"
      "${CMAKE_CURRENT_SOURCE_DIR}/../runtime/media-agent/srtp2.dll")
    # The application runtime is refreshed only after this build finishes.
    # Pair each isolated juice DLL with the datachannel DLL it actually links
    # against, not a previous build's application runtime with a stale C ABI.
    list(PREPEND _egress_runtime "$<TARGET_FILE:LibDataChannel::LibDataChannel>")
    foreach(_dll IN LISTS _egress_runtime)
      add_custom_command(TARGET vds-nat-full-egress POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dll}" "$<TARGET_FILE_DIR:vds-nat-full-egress>" VERBATIM)
    endforeach()
    add_test(NAME vds-nat-full-egress COMMAND vds-nat-full-egress --full-egress)
    set_tests_properties(vds-nat-full-egress PROPERTIES TIMEOUT 90)
      # Repeatable target-plan randomness for comparative NAT experiments.
      # Network scheduling remains real and is not claimed deterministic.
      add_library(vds-test-juice-seeded SHARED tests/juice_full_egress.c tests/juice_seeded_agent.c ${_egress_sources})
      target_include_directories(vds-test-juice-seeded PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
      target_compile_definitions(vds-test-juice-seeded PRIVATE JUICE_EXPORTS USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
      target_link_libraries(vds-test-juice-seeded PRIVATE Threads::Threads Ws2_32 bcrypt)
      set_target_properties(vds-test-juice-seeded PROPERTIES OUTPUT_NAME juice
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/seeded-egress/$<CONFIG>"
        ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/seeded-egress/$<CONFIG>")
      add_executable(vds-nat-seeded-egress tests/nat_traversal_e2e.cpp)
      target_compile_definitions(vds-nat-seeded-egress PRIVATE VDS_TEST_FULL_EGRESS=1 VDS_TEST_SEEDED_PLANNER=1)
      target_link_libraries(vds-nat-seeded-egress PRIVATE LibDataChannel::LibDataChannel vds-test-juice-seeded Threads::Threads Ws2_32)
      set_target_properties(vds-nat-seeded-egress PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/seeded-egress/$<CONFIG>")
      foreach(_dll IN LISTS _egress_runtime)
        add_custom_command(TARGET vds-nat-seeded-egress POST_BUILD
          COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dll}" "$<TARGET_FILE_DIR:vds-nat-seeded-egress>" VERBATIM)
      endforeach()
      add_test(NAME vds-nat-standard-peer COMMAND vds-nat-seeded-egress --standard-peer)
      set_tests_properties(vds-nat-standard-peer PROPERTIES TIMEOUT 60)
      add_test(NAME vds-nat-standard-multiexit COMMAND vds-nat-seeded-egress --standard-peer-multiexit)
      set_tests_properties(vds-nat-standard-multiexit PROPERTIES TIMEOUT 60)
    # Delay only TCP readiness delivery in an isolated DLL; retain the real
    # ICE/DTLS/SCTP implementation and keep test hooks out of shipped runtime.
    set(_tcp_delay_sources ${_resolver_test_sources})
    list(REMOVE_ITEM _tcp_delay_sources "${_stun_source}/src/conn_poll.c")
    add_library(vds-test-juice-tcp-delay SHARED tests/juice_tcp_delayed_poll.c "${_stun_source}/src/agent.c" ${_tcp_delay_sources})
    target_include_directories(vds-test-juice-tcp-delay PRIVATE src "${_stun_source}/src" "${_stun_source}/include" "${_stun_source}/include/juice")
    target_compile_definitions(vds-test-juice-tcp-delay PRIVATE JUICE_EXPORTS USE_NETTLE=0 WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(vds-test-juice-tcp-delay PRIVATE Threads::Threads Ws2_32 bcrypt)
    set_target_properties(vds-test-juice-tcp-delay PROPERTIES OUTPUT_NAME juice
      RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/tcp-delay/$<CONFIG>"
      ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/tcp-delay/$<CONFIG>")
    add_executable(vds-tcp-delay-e2e tests/tcp_ice_e2e.cpp tests/juice_tcp_invalid.c)
    target_include_directories(vds-tcp-delay-e2e PRIVATE "${_stun_source}/src" "${_stun_source}/include/juice")
    target_compile_definitions(vds-tcp-delay-e2e PRIVATE VDS_TEST_TCP_DELAY=1)
    target_link_libraries(vds-tcp-delay-e2e PRIVATE LibDataChannel::LibDataChannel vds-test-juice-tcp-delay Threads::Threads Ws2_32)
    set_target_properties(vds-tcp-delay-e2e PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/tcp-delay/$<CONFIG>")
    foreach(_dll IN LISTS _egress_runtime)
      add_custom_command(TARGET vds-tcp-delay-e2e POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dll}" "$<TARGET_FILE_DIR:vds-tcp-delay-e2e>" VERBATIM)
    endforeach()
    find_program(VDS_TEST_NODE_EXECUTABLE NAMES node REQUIRED)
    add_test(NAME vds-tcp-delay-e2e COMMAND "${VDS_TEST_NODE_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/test-native-tcp-delay.js" "$<TARGET_FILE:vds-tcp-delay-e2e>")
    set_tests_properties(vds-tcp-delay-e2e PROPERTIES TIMEOUT 45)
    add_executable(vds-dual-stack-ice-e2e tests/dual_stack_ice_e2e.cpp)
    target_link_libraries(vds-dual-stack-ice-e2e PRIVATE LibDataChannel::LibDataChannel Threads::Threads Ws2_32)
    vds_copy_enhanced_ice_runtime(vds-dual-stack-ice-e2e)
    add_test(NAME vds-dual-stack-ice-e2e COMMAND vds-dual-stack-ice-e2e)
    set_tests_properties(vds-dual-stack-ice-e2e PROPERTIES TIMEOUT 45)
    # Compile the exact fingerprinted callback used by the shipped ICE build.
    file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ice-patches/libdatachannel-0.24.1-vds.patch" _dtls_patch_hash)
    file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/src/nat_port_prediction.h" _dtls_algorithm_hash)
    string(SUBSTRING "${_dtls_patch_hash}" 0 12 _dtls_patch_hash)
    string(SUBSTRING "${_dtls_algorithm_hash}" 0 12 _dtls_algorithm_hash)
    string(TOUPPER "${_dtls_patch_hash}-${_dtls_algorithm_hash}" _dtls_revision)
    set(_dtls_source "${VDS_MEDIA_AGENT_ICE_PREFIX}/../sources/libdatachannel-0.24.1-${_dtls_revision}/libdatachannel-0.24.1")
    add_executable(vds-early-dtls-callback-tests tests/early_dtls_callback_tests.cpp)
    target_include_directories(vds-early-dtls-callback-tests PRIVATE "${_dtls_source}/src/impl" "${_dtls_source}/include/rtc")
    target_link_libraries(vds-early-dtls-callback-tests PRIVATE LibDataChannel::LibDataChannel Threads::Threads)
    vds_copy_enhanced_ice_runtime(vds-early-dtls-callback-tests)
    add_test(NAME vds-early-dtls-callback-tests COMMAND vds-early-dtls-callback-tests)
    set_tests_properties(vds-early-dtls-callback-tests PROPERTIES TIMEOUT 20)
    add_test(NAME vds-nat-late-path COMMAND vds-nat-traversal-e2e --late-path)
    set_tests_properties(vds-nat-late-path PROPERTIES TIMEOUT 50)
    add_test(NAME vds-nat-sparse-samples COMMAND vds-nat-traversal-e2e --sparse-samples)
    set_tests_properties(vds-nat-sparse-samples PROPERTIES TIMEOUT 55)
    add_test(NAME vds-nat-late-stun COMMAND vds-nat-traversal-e2e --late-stun)
    set_tests_properties(vds-nat-late-stun PROPERTIES TIMEOUT 30)
    add_test(NAME vds-nat-sdp-candidates COMMAND vds-nat-traversal-e2e --sdp-candidates)
    set_tests_properties(vds-nat-sdp-candidates PROPERTIES TIMEOUT 30)
    add_test(NAME vds-nat-same-address-stun COMMAND vds-nat-traversal-e2e --same-address-stun)
    set_tests_properties(vds-nat-same-address-stun PROPERTIES TIMEOUT 30)
    add_test(NAME vds-nat-delayed-nomination COMMAND vds-nat-traversal-e2e --delayed-nomination)
    set_tests_properties(vds-nat-delayed-nomination PROPERTIES TIMEOUT 30)
    add_test(NAME vds-nat-early-handshake COMMAND vds-nat-traversal-e2e --early-handshake)
    set_tests_properties(vds-nat-early-handshake PROPERTIES TIMEOUT 25)
    add_test(NAME vds-nat-traversal-e2e COMMAND vds-nat-traversal-e2e)
    set_tests_properties(vds-nat-traversal-e2e PROPERTIES TIMEOUT 75)
    add_test(NAME vds-random-nat-invalid-ice COMMAND vds-nat-traversal-e2e --random-invalid)
    set_tests_properties(vds-random-nat-invalid-ice PROPERTIES TIMEOUT 25)
    add_test(NAME vds-nat-primary-exploration COMMAND vds-nat-traversal-e2e --primary-exploration)
    set_tests_properties(vds-nat-primary-exploration PROPERTIES TIMEOUT 25)
    add_test(NAME vds-nat-paced-recovery COMMAND vds-nat-traversal-e2e --paced-recovery)
    set_tests_properties(vds-nat-paced-recovery PROPERTIES TIMEOUT 25)
    add_test(NAME vds-nat-exploration-plans COMMAND vds-nat-traversal-e2e --exploration-plans)
    set_tests_properties(vds-nat-exploration-plans PROPERTIES TIMEOUT 40)
    add_test(NAME vds-nat-sampled-range COMMAND vds-nat-traversal-e2e --sampled-range)
    set_tests_properties(vds-nat-sampled-range PROPERTIES TIMEOUT 25)
  endif()
  add_executable(vds-media-agent-tests
    src/agent_events.cpp
    src/agent_diagnostics.cpp
    src/time_utils.cpp
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
    add_executable(vds-native-preview-presenter-tests
      tests/native_preview_presenter_tests.cpp src/native_preview_presenter.cpp)
    target_include_directories(vds-native-preview-presenter-tests PRIVATE src)
    target_link_libraries(vds-native-preview-presenter-tests PRIVATE D2d1 User32 Gdi32 Dwmapi)
    add_test(NAME vds-native-preview-presenter-tests COMMAND vds-native-preview-presenter-tests)
    set_tests_properties(vds-native-preview-presenter-tests PROPERTIES TIMEOUT 20)
    add_executable(vds-native-d3d11-resource-tests
      tests/native_d3d11_resource_tests.cpp src/native_d3d11_presenter.cpp)
    target_include_directories(vds-native-d3d11-resource-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_compile_definitions(vds-native-d3d11-resource-tests PRIVATE VDS_NATIVE_SURFACE_TESTING)
    target_link_libraries(vds-native-d3d11-resource-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}" User32 D3D11 Dxgi)
    add_test(NAME vds-native-d3d11-resource-tests COMMAND vds-native-d3d11-resource-tests)
    set_tests_properties(vds-native-d3d11-resource-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 40)
    add_executable(vds-native-playback-surface-tests
      tests/native_playback_surface_tests.cpp
      src/native_video_surface.cpp
      src/native_d3d11_presenter.cpp
      src/video_access_unit.cpp
      src/time_utils.cpp
      src/viewer_audio_playback.cpp
      src/media_audio.cpp
      src/string_utils.cpp
    )
    target_include_directories(vds-native-playback-surface-tests PRIVATE src "${VDS_MEDIA_AGENT_FFMPEG_ROOT}/include")
    target_compile_definitions(vds-native-playback-surface-tests PRIVATE VDS_NATIVE_SURFACE_TESTING)
    target_link_libraries(vds-native-playback-surface-tests PRIVATE
      "${VDS_MEDIA_AGENT_AVCODEC_LIBRARY}" "${VDS_MEDIA_AGENT_AVUTIL_LIBRARY}"
      "${VDS_MEDIA_AGENT_SWSCALE_LIBRARY}" "${VDS_MEDIA_AGENT_SWRESAMPLE_LIBRARY}" User32 Gdi32 Winmm D3D11 Dxgi)
    add_test(NAME vds-native-playback-surface-tests COMMAND vds-native-playback-surface-tests)
    add_test(NAME vds-native-playback-clock-handoff-tests COMMAND vds-native-playback-surface-tests --clock-handoff)
    add_test(NAME vds-native-playback-network-gap-tests COMMAND vds-native-playback-surface-tests --network-gap)
    add_test(NAME vds-native-playback-network-decode-tests COMMAND vds-native-playback-surface-tests --network-decode)
    set_tests_properties(vds-native-playback-network-gap-tests vds-native-playback-network-decode-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 60)
    set_tests_properties(vds-native-playback-clock-handoff-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 40)
    set_tests_properties(vds-native-playback-surface-tests PROPERTIES
      ENVIRONMENT "PATH=${VDS_MEDIA_AGENT_FFMPEG_ROOT}/bin;$ENV{PATH}" TIMEOUT 60)
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
      TIMEOUT 120
    )
  endif()
endif()
