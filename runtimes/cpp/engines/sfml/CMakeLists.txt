cmake_minimum_required(VERSION 3.18)
project(openbone_sfml LANGUAGES C CXX)

# SFML 2.6 sample renderer. Needs SFML 2.6 installed (find_package) or -DOPENBONE_FETCH_SFML=ON to build it from
# source (on Linux that needs the X11, Xrandr, Xcursor, udev, OpenGL and FreeType development packages).

option(OPENBONE_FETCH_SFML "Download and build SFML 2.6 when it is not installed" OFF)
find_package(SFML 2.6 COMPONENTS graphics window system QUIET)
if(NOT SFML_FOUND)
  if(NOT OPENBONE_FETCH_SFML)
    message(FATAL_ERROR "SFML 2.6 not found: install it (e.g. libsfml-dev) or configure with -DOPENBONE_FETCH_SFML=ON")
  endif()
  include(FetchContent)
  set(BUILD_SHARED_LIBS OFF)
  set(SFML_BUILD_AUDIO OFF CACHE BOOL "" FORCE)
  set(SFML_BUILD_NETWORK OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(sfml URL https://github.com/SFML/SFML/archive/refs/tags/2.6.2.tar.gz DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(sfml)
endif()

set(OPENBONE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. openbone EXCLUDE_FROM_ALL)

add_executable(openbone_sfml main.cpp)
target_include_directories(openbone_sfml PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../common)
target_link_libraries(openbone_sfml PRIVATE sfml-graphics sfml-window sfml-system openbone::openbone)
target_compile_features(openbone_sfml PRIVATE cxx_std_17)
