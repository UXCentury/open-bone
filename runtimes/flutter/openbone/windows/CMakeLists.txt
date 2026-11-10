# Windows desktop: build openbone.dll from runtimes/cpp and bundle it next to the app.
# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.18)
set(PROJECT_NAME "openbone")
project(${PROJECT_NAME} LANGUAGES C CXX)

add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../src" "${CMAKE_CURRENT_BINARY_DIR}/shared")

set(openbone_bundled_libraries
  $<TARGET_FILE:openbone_shared>
  PARENT_SCOPE
)
