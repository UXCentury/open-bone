cmake_minimum_required(VERSION 3.18)
project(openbone_godot LANGUAGES C CXX)

# OpenBone GDExtension for Godot 4.4+. Builds bin/libopenbone_godot.<so|dll|dylib> into demo/bin (or OPENBONE_GODOT_OUT).
#   cmake -S runtimes/cpp/engines/godot -B build-godot -DGODOT_CPP_DIR=/path/to/godot-cpp   (or let it download 4.4)
#   cmake --build build-godot -j
# Addon (prebuilt, for the Asset Library): add -DOPENBONE_GODOT_ADDON=ON -DOPENBONE_GODOT_OUT=<dir>, then
#   ./package.sh <out> <dir>...   (see README.md and .github/workflows/publish-godot.yml)

set(GODOT_CPP_DIR "" CACHE PATH "godot-cpp source tree (empty = download the godot-4.4-stable tag)")
set(OPENBONE_GODOT_OUT "${CMAKE_CURRENT_SOURCE_DIR}/demo/bin" CACHE PATH "Where the extension library is written")

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
# The runtime reports errors with exceptions; keep them on in godot-cpp too.
set(GODOTCPP_DISABLE_EXCEPTIONS OFF CACHE BOOL "" FORCE)

if(GODOT_CPP_DIR STREQUAL "")
  include(FetchContent)
  FetchContent_Declare(godot_cpp
    URL https://github.com/godotengine/godot-cpp/archive/refs/tags/godot-4.4-stable.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(godot_cpp)
else()
  add_subdirectory(${GODOT_CPP_DIR} godot-cpp EXCLUDE_FROM_ALL)
endif()

set(OPENBONE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. openbone EXCLUDE_FROM_ALL)

# The library the demo (and CTest) loads: template_debug, named libopenbone_godot.<ext>.
add_library(openbone_godot SHARED src/register_types.cpp src/openbone_node.cpp)
target_link_libraries(openbone_godot PRIVATE godot-cpp.template_debug openbone::openbone)

# Addon build (-DOPENBONE_GODOT_ADDON=ON): also a template_release library, and both named the way the addon's
# openbone.gdextension expects (libopenbone.<platform>.<target>.<arch>.<ext>, godot-cpp's suffix). package.sh copies
# them into addons/openbone/bin/.
option(OPENBONE_GODOT_ADDON "Build template_debug + template_release libraries named for addons/openbone/bin" OFF)
set(_ob_godot_targets openbone_godot)
if(OPENBONE_GODOT_ADDON)
  add_library(openbone_godot_release SHARED src/register_types.cpp src/openbone_node.cpp)
  target_link_libraries(openbone_godot_release PRIVATE godot-cpp.template_release openbone::openbone)
  list(APPEND _ob_godot_targets openbone_godot_release)
  get_target_property(_ob_sfx_debug godot-cpp.template_debug GODOTCPP_SUFFIX)
  get_target_property(_ob_sfx_release godot-cpp.template_release GODOTCPP_SUFFIX)
  if(ANDROID)  # godot-cpp names Android .android.<abi>.<target>.<arch>; the arch is enough.
    string(REPLACE "android.${ANDROID_ABI}" "android" _ob_sfx_debug "${_ob_sfx_debug}")
    string(REPLACE "android.${ANDROID_ABI}" "android" _ob_sfx_release "${_ob_sfx_release}")
  endif()
  set_target_properties(openbone_godot PROPERTIES OUTPUT_NAME "openbone${_ob_sfx_debug}")
  set_target_properties(openbone_godot_release PROPERTIES OUTPUT_NAME "openbone${_ob_sfx_release}")
endif()

foreach(t ${_ob_godot_targets})
  target_compile_features(${t} PRIVATE cxx_std_17)
  set_target_properties(${t} PROPERTIES
    # $<1:…> stops multi-config generators (Visual Studio, Xcode) from adding a Release/ subfolder.
    LIBRARY_OUTPUT_DIRECTORY "$<1:${OPENBONE_GODOT_OUT}>"
    RUNTIME_OUTPUT_DIRECTORY "$<1:${OPENBONE_GODOT_OUT}>"
    CXX_VISIBILITY_PRESET hidden)
  if(MSVC)
    target_compile_options(${t} PRIVATE /EHsc)
  elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND OPENBONE_GODOT_ADDON)
    # Self-contained .so for the addon: no dependency on the user's libstdc++ version, only openbone_library_init
    # exported (not QuickJS's or libstdc++'s symbols), no symbol tables.
    target_link_options(${t} PRIVATE -static-libstdc++ -static-libgcc -Wl,--exclude-libs,ALL $<$<CONFIG:Release,MinSizeRel>:-s>)
  elseif(ANDROID AND OPENBONE_GODOT_ADDON)
    target_link_options(${t} PRIVATE -Wl,--exclude-libs,ALL $<$<CONFIG:Release,MinSizeRel>:-s>)
  endif()
endforeach()

# Headless check: -DGODOT_EXECUTABLE=/path/to/godot, then `ctest` (needs the library built first).
set(GODOT_EXECUTABLE "" CACHE FILEPATH "Godot 4.4+ editor binary for the headless test")
if(GODOT_EXECUTABLE)
  enable_testing()
  get_filename_component(OB_REPO ${CMAKE_CURRENT_SOURCE_DIR}/../../../.. ABSOLUTE)
  foreach(f conformance/fixtures/interactive.obone conformance/fixtures/dynamics.obone examples/knight.obone examples/rocket.obone)
    get_filename_component(n ${f} NAME_WE)
    add_test(NAME godot.${n} COMMAND ${GODOT_EXECUTABLE} --headless --path ${CMAKE_CURRENT_SOURCE_DIR}/demo -s test_headless.gd -- ${OB_REPO}/${f})
  endforeach()
endif()
