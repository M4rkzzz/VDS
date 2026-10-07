set(VDS_MEDIA_AGENT_ICE_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/build/vds-ice/installed"
  CACHE PATH "Pinned VDS enhanced ICE dependency installation")
set(_vds_ice_marker "${VDS_MEDIA_AGENT_ICE_PREFIX}/vds-enhanced-ice.txt")
if(NOT EXISTS "${_vds_ice_marker}" OR
   NOT EXISTS "${VDS_MEDIA_AGENT_ICE_PREFIX}/include/rtc/configuration.hpp")
  message(FATAL_ERROR "Enhanced ICE is required. Run scripts/build-vds-ice.ps1 before configuring media-agent.")
endif()
file(READ "${VDS_MEDIA_AGENT_ICE_PREFIX}/include/rtc/configuration.hpp" _vds_rtc_configuration)
if(NOT _vds_rtc_configuration MATCHES "RTC_VDS_ENHANCED_ICE 1")
  message(FATAL_ERROR "The selected libdatachannel installation lacks the VDS enhanced ICE patch")
endif()
file(READ "${_vds_ice_marker}" _vds_ice_stamp)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/src/nat_port_prediction.h" _vds_algorithm_hash)
string(SUBSTRING "${_vds_algorithm_hash}" 0 12 _vds_algorithm_hash)
string(TOUPPER "${_vds_algorithm_hash}" _vds_algorithm_hash)
foreach(_vds_dependency "libjuice-1.7.0" "libdatachannel-0.24.1")
  file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ice-patches/${_vds_dependency}-vds.patch" _vds_patch_hash)
  string(SUBSTRING "${_vds_patch_hash}" 0 12 _vds_patch_hash)
  string(TOUPPER "${_vds_patch_hash}" _vds_patch_hash)
  if(NOT _vds_ice_stamp MATCHES "${_vds_patch_hash}-${_vds_algorithm_hash}")
    message(FATAL_ERROR "Enhanced ICE sources changed. Re-run scripts/build-vds-ice.ps1.")
  endif()
endforeach()
set(LibDataChannel_DIR "${VDS_MEDIA_AGENT_ICE_PREFIX}/lib/cmake/LibDataChannel" CACHE PATH "" FORCE)
list(PREPEND CMAKE_PREFIX_PATH "${VDS_MEDIA_AGENT_ICE_PREFIX}")
function(vds_copy_enhanced_ice_runtime target_name)
  add_custom_command(TARGET ${target_name} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${VDS_MEDIA_AGENT_ICE_PREFIX}/bin/datachannel.dll"
      "${VDS_MEDIA_AGENT_ICE_PREFIX}/bin/juice.dll"
      "$<TARGET_FILE_DIR:${target_name}>"
    VERBATIM)
endfunction()
