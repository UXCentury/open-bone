cmake_minimum_required(VERSION 3.18)
project(openbone_glfw LANGUAGES C CXX)

# GLFW + OpenGL 3.3 sample renderer. Uses an installed GLFW 3.3+ (find_package) or builds GLFW 3.4 from source
# (-DOPENBONE_FETCH_GLFW=ON, the default when none is found). OpenGL functions are loaded through glfwGetProcAddress,
# so no GL loader library is needed. stb_image decodes PNG/JPEG textures; stb_image_write saves --out screenshots.

option(OPENBONE_FETCH_GLFW "Download and build GLFW when it is not installed" ON)
include(FetchContent)

find_package(glfw3 3.3 CONFIG QUIET)
if(NOT glfw3_FOUND AND OPENBONE_FETCH_GLFW)
  set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
  set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(GLFW_INSTALL OFF CACHE BOOL "" FORCE)
  set(GLFW_BUILD_WAYLAND OFF CACHE BOOL "" FORCE)  # X11 only: fewer system packages needed on Linux
  if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
  endif()
  FetchContent_Declare(glfw URL https://github.com/glfw/glfw/releases/download/3.4/glfw-3.4.zip)
  FetchContent_MakeAvailable(glfw)
endif()

FetchContent_Declare(stb_image URL https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_image.h DOWNLOAD_NO_EXTRACT TRUE)
FetchContent_Declare(stb_image_write URL https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_image_write.h DOWNLOAD_NO_EXTRACT TRUE)
FetchContent_MakeAvailable(stb_image stb_image_write)

set(OPENBONE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. openbone EXCLUDE_FROM_ALL)

add_executable(openbone_glfw main.cpp)
target_include_directories(openbone_glfw PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../common ${stb_image_SOURCE_DIR} ${stb_image_write_SOURCE_DIR})
target_link_libraries(openbone_glfw PRIVATE glfw openbone::openbone)
target_compile_features(openbone_glfw PRIVATE cxx_std_17)
