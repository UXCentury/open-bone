cmake_minimum_required(VERSION 3.18)
project(openbone_sdl2 LANGUAGES C CXX)

# SDL2 sample renderer. Uses an installed SDL2 (find_package) or builds SDL 2.30 from source
# (-DOPENBONE_FETCH_SDL2=ON, the default when none is found). stb_image decodes PNG/JPEG textures.

option(OPENBONE_FETCH_SDL2 "Download and build SDL2 when it is not installed" ON)
include(FetchContent)

find_package(SDL2 CONFIG QUIET)
if(NOT SDL2_FOUND AND OPENBONE_FETCH_SDL2)
  set(SDL_SHARED OFF CACHE BOOL "" FORCE)
  set(SDL_STATIC ON CACHE BOOL "" FORCE)
  set(SDL_TEST OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(sdl2 URL https://github.com/libsdl-org/SDL/releases/download/release-2.30.9/SDL2-2.30.9.tar.gz DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(sdl2)
endif()

FetchContent_Declare(stb URL https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_image.h DOWNLOAD_NO_EXTRACT TRUE)
FetchContent_MakeAvailable(stb)

set(OPENBONE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. openbone EXCLUDE_FROM_ALL)

add_executable(openbone_sdl2 main.cpp)
target_include_directories(openbone_sdl2 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../common ${stb_SOURCE_DIR})
if(TARGET SDL2::SDL2-static)
  target_link_libraries(openbone_sdl2 PRIVATE SDL2::SDL2main SDL2::SDL2-static)
else()
  target_link_libraries(openbone_sdl2 PRIVATE SDL2::SDL2main SDL2::SDL2)
endif()
target_link_libraries(openbone_sdl2 PRIVATE openbone::openbone)
target_compile_features(openbone_sdl2 PRIVATE cxx_std_17)
