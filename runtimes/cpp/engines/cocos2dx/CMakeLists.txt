# Add OpenBone to a Cocos2d-x 4.0 project (CMake). In your game's CMakeLists.txt, after the cocos2d target exists:
#
#   set(OPENBONE_DIR <path>/runtimes/cpp)
#   include(${OPENBONE_DIR}/engines/cocos2dx/CMakeLists.txt)
#   target_link_libraries(${APP_NAME} openbone_cocos2dx)
#
# SPDX-License-Identifier: MIT
set(OPENBONE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(OPENBONE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${OPENBONE_DIR} ${CMAKE_BINARY_DIR}/openbone EXCLUDE_FROM_ALL)
add_library(openbone_cocos2dx STATIC ${OPENBONE_DIR}/engines/cocos2dx/OpenBoneNode.cpp)
target_include_directories(openbone_cocos2dx PUBLIC ${OPENBONE_DIR}/engines/cocos2dx PRIVATE ${OPENBONE_DIR}/engines/common)
target_link_libraries(openbone_cocos2dx PUBLIC cocos2d openbone::openbone)
target_compile_features(openbone_cocos2dx PUBLIC cxx_std_17)
# Text: installed fonts are found with fontconfig on Linux (Cocos2d-x itself already depends on it there).
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID)
  find_package(PkgConfig QUIET)
  if(PkgConfig_FOUND)
    pkg_check_modules(OB_FONTCONFIG QUIET fontconfig)
  endif()
  if(OB_FONTCONFIG_FOUND)
    target_include_directories(openbone_cocos2dx PRIVATE ${OB_FONTCONFIG_INCLUDE_DIRS})
    target_link_libraries(openbone_cocos2dx PRIVATE ${OB_FONTCONFIG_LIBRARIES})
  endif()
endif()
