cmake_minimum_required(VERSION 3.18)
project(openbone_godot LANGUAGES C CXX)

# OpenBone GDExtension for Godot 4.4+. Builds bin/libopenbone_godot.<so|dll|dylib> into demo/bin (or OPENBONE_GODOT_OUT).
#   cmake -S runtimes/cpp/engines/godot -B build-godot -DGODOT_CPP_DIR=/path/to/godot-cpp   (or let it download 4.4)
#   cmake --build build-godot -j

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

add_library(openbone_godot SHARED src/register_types.cpp src/openbone_node.cpp)
target_link_libraries(openbone_godot PRIVATE godot-cpp.template_debug openbone::openbone)
target_compile_features(openbone_godot PRIVATE cxx_std_17)
set_target_properties(openbone_godot PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${OPENBONE_GODOT_OUT}
  RUNTIME_OUTPUT_DIRECTORY ${OPENBONE_GODOT_OUT}
  CXX_VISIBILITY_PRESET hidden)
if(MSVC)
  target_compile_options(openbone_godot PRIVATE /EHsc)
endif()

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
