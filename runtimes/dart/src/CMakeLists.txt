# libopenbone for the Flutter plugin (Android, Linux, Windows). Builds the C++ runtime in runtimes/cpp as a shared
# library exposing the C API (openbone.h); the Dart side binds it with dart:ffi (lib/src/bindings.g.dart).
#
#   OPENBONE_CPP_DIR       the C++ runtime sources (default: ../../cpp, i.e. this repository's runtimes/cpp)
#   OPENBONE_WITH_SCRIPTS  embed QuickJS for document scripts (default ON). QuickJS comes from ../third_party/quickjs
#                          when present (tool/fetch_quickjs.sh), otherwise it is downloaded at configure time.
# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.18)
project(openbone_flutter LANGUAGES C CXX)

# Flutter reaches this file through a symlink (.plugin_symlinks/openbone): resolve it before going up to runtimes/cpp.
get_filename_component(OPENBONE_PLUGIN_SRC "${CMAKE_CURRENT_SOURCE_DIR}" REALPATH)
set(OPENBONE_CPP_DIR "${OPENBONE_PLUGIN_SRC}/../../cpp" CACHE PATH "OpenBone C++ runtime sources")
if(NOT EXISTS "${OPENBONE_CPP_DIR}/include/openbone.h")
  message(FATAL_ERROR "OpenBone C++ runtime not found at ${OPENBONE_CPP_DIR} (set OPENBONE_CPP_DIR)")
endif()
if(EXISTS "${OPENBONE_PLUGIN_SRC}/../third_party/quickjs/quickjs.c" AND NOT OPENBONE_QUICKJS_DIR)
  set(OPENBONE_QUICKJS_DIR "${OPENBONE_PLUGIN_SRC}/../third_party/quickjs" CACHE PATH "" FORCE)
endif()

set(OPENBONE_BUILD_SHARED ON CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_STATIC OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(OPENBONE_INSTALL OFF CACHE BOOL "" FORCE)  # the Flutter tool bundles libopenbone itself
add_subdirectory("${OPENBONE_CPP_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/openbone_cpp")

# Plain libopenbone.so / openbone.dll: dart:ffi opens it by that name, Android packages only unversioned names.
set_property(TARGET openbone_shared PROPERTY VERSION)
set_property(TARGET openbone_shared PROPERTY SOVERSION)
set_target_properties(openbone_shared PROPERTIES NO_SONAME ON)

if(ANDROID)
  # Android 15+ devices with 16 KB pages.
  target_link_options(openbone_shared PRIVATE "-Wl,-z,max-page-size=16384")
endif()
