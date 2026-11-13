cmake_minimum_required(VERSION 3.18)
project(openbone_runtime VERSION 0.4.3 LANGUAGES C CXX)

# OpenBone C++ runtime: C++17, no engine dependencies. nlohmann/json and QuickJS (quickjs-ng v0.10.1, MIT) are
# vendored in third_party/; OPENBONE_QUICKJS_DIR can point at another quickjs-ng source tree.

option(OPENBONE_WITH_SCRIPTS "Run document scripts in embedded QuickJS" ON)
option(OPENBONE_BUILD_SHARED "Build libopenbone (shared, C API) for FFI" ON)
option(OPENBONE_BUILD_STATIC "Build the static library (needed by the tests)" ON)
option(OPENBONE_INSTALL "Generate install rules (off when embedded, e.g. by the Flutter plugin)" ON)
option(OPENBONE_BUILD_TESTS "Build the conformance runner (CTest)" ${PROJECT_IS_TOP_LEVEL})
option(OPENBONE_BUILD_EXAMPLES "Build the C example" ${PROJECT_IS_TOP_LEVEL})
set(OPENBONE_QUICKJS_DIR "" CACHE PATH "quickjs-ng source tree (empty = the vendored third_party/quickjs, or download v0.10.1)")

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
include(GNUInstallDirs)

if(OPENBONE_WITH_SCRIPTS)
  if(OPENBONE_QUICKJS_DIR STREQUAL "" AND EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/third_party/quickjs/quickjs.c)
    set(OPENBONE_QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/quickjs)
  endif()
  if(OPENBONE_QUICKJS_DIR STREQUAL "")
    include(FetchContent)
    # Extracted files get the extraction time (CMake 3.24+ policy); spelled as a policy, not the
    # DOWNLOAD_EXTRACT_TIMESTAMP option, so the Android SDK's CMake 3.22 accepts it too.
    if(POLICY CMP0135)
      cmake_policy(SET CMP0135 NEW)
    endif()
    FetchContent_Declare(quickjs_ng
      URL https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.10.1.tar.gz
      URL_HASH SHA256=4e917eea3bb6051a0551fdd3aac45199ff705fa08920c15b824a08c5fbb032e4
      SOURCE_SUBDIR do-not-add)  # only download: the sources are compiled below with this project's flags
    FetchContent_MakeAvailable(quickjs_ng)
    set(OPENBONE_QUICKJS_DIR ${quickjs_ng_SOURCE_DIR})
  endif()
  add_library(openbone_quickjs STATIC
    ${OPENBONE_QUICKJS_DIR}/cutils.c
    ${OPENBONE_QUICKJS_DIR}/libregexp.c
    ${OPENBONE_QUICKJS_DIR}/libunicode.c
    ${OPENBONE_QUICKJS_DIR}/quickjs.c
    ${OPENBONE_QUICKJS_DIR}/xsum.c)
  # SYSTEM: warnings inside quickjs.h are QuickJS's, not ours (GCC/Clang -isystem, MSVC /external:I).
  target_include_directories(openbone_quickjs SYSTEM PUBLIC ${OPENBONE_QUICKJS_DIR})
  target_compile_definitions(openbone_quickjs PRIVATE _GNU_SOURCE)
  if(WIN32)
    target_compile_definitions(openbone_quickjs PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
  endif()
  if(MSVC)
    # quickjs-ng uses C11 atomics, which MSVC only enables with these switches (as quickjs-ng's own build does).
    target_compile_options(openbone_quickjs PRIVATE /J /w /std:c11 /experimental:c11atomics)
  else()
    target_compile_options(openbone_quickjs PRIVATE -funsigned-char -w)
    find_package(Threads)
    target_link_libraries(openbone_quickjs PUBLIC ${CMAKE_THREAD_LIBS_INIT} ${CMAKE_DL_LIBS})
    find_library(M_LIBRARY m)
    if(M_LIBRARY)
      target_link_libraries(openbone_quickjs PUBLIC ${M_LIBRARY})
    endif()
  endif()
endif()

set(OPENBONE_SOURCES
  src/animation.cpp
  src/c_api.cpp
  src/document.cpp
  src/geometry.cpp
  src/jsnum.cpp
  src/math.cpp
  src/particles.cpp
  src/scripting_quickjs.cpp
  src/skeleton.cpp
  src/state_machine.cpp)

function(openbone_configure target)
  target_compile_features(${target} PUBLIC cxx_std_17)
  target_include_directories(${target} PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
  target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party ${CMAKE_CURRENT_SOURCE_DIR}/src)
  # Bit-for-bit parity with the reference needs plain IEEE double arithmetic: no fused multiply-add contraction.
  if(MSVC)
    target_compile_options(${target} PRIVATE /fp:precise /bigobj)
  else()
    target_compile_options(${target} PRIVATE -ffp-contract=off -fno-fast-math)
  endif()
  if(OPENBONE_WITH_SCRIPTS)
    target_compile_definitions(${target} PRIVATE OPENBONE_WITH_SCRIPTS=1)
    target_link_libraries(${target} PRIVATE openbone_quickjs)
  else()
    target_compile_definitions(${target} PRIVATE OPENBONE_WITH_SCRIPTS=0)
  endif()
endfunction()

if(OPENBONE_BUILD_STATIC OR OPENBONE_BUILD_TESTS)
  add_library(openbone STATIC ${OPENBONE_SOURCES})
  openbone_configure(openbone)
  target_compile_definitions(openbone PUBLIC OPENBONE_STATIC)
  if(MSVC)
    # MSVC names both the static library and the DLL's import library openbone.lib; keep them apart.
    set_target_properties(openbone PROPERTIES OUTPUT_NAME openbone_static)
  endif()
  add_library(openbone::openbone ALIAS openbone)
  if(OPENBONE_INSTALL)
    install(TARGETS openbone EXPORT openboneTargets ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
  endif()
endif()

if(OPENBONE_BUILD_SHARED)
  add_library(openbone_shared SHARED ${OPENBONE_SOURCES})
  openbone_configure(openbone_shared)
  target_compile_definitions(openbone_shared PRIVATE OPENBONE_BUILDING_DLL)
  set_target_properties(openbone_shared PROPERTIES OUTPUT_NAME openbone CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON
    VERSION ${PROJECT_VERSION} SOVERSION 0)
  add_library(openbone::shared ALIAS openbone_shared)
endif()

if(OPENBONE_BUILD_TESTS)
  enable_testing()
  add_executable(openbone_conformance tests/conformance.cpp)
  target_link_libraries(openbone_conformance PRIVATE openbone)
  target_include_directories(openbone_conformance PRIVATE third_party)
  target_compile_options(openbone_conformance PRIVATE $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-ffp-contract=off>)
  get_filename_component(OPENBONE_REPO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../.. ABSOLUTE)
  file(GLOB OPENBONE_EXPECTED ${OPENBONE_REPO_ROOT}/conformance/expected/*.json)
  foreach(f ${OPENBONE_EXPECTED})
    get_filename_component(n ${f} NAME_WE)
    add_test(NAME conformance.${n} COMMAND openbone_conformance --root ${OPENBONE_REPO_ROOT} ${f})
  endforeach()
  add_executable(openbone_unit tests/unit.cpp)
  target_link_libraries(openbone_unit PRIVATE openbone)
  target_include_directories(openbone_unit PRIVATE src)
  add_test(NAME unit COMMAND openbone_unit)
  # Document-embedded fonts: .obone/.obonb parsing, family/weight matching and the C API.
  add_executable(openbone_fonts tests/fonts.cpp)
  target_link_libraries(openbone_fonts PRIVATE openbone)
  add_test(NAME fonts COMMAND openbone_fonts)
  # The engine samples' shared sound mixer (header-only, engines/common/openbone_audio.hpp).
  add_executable(openbone_engine_audio tests/engine_audio.cpp)
  target_link_libraries(openbone_engine_audio PRIVATE openbone)
  add_test(NAME engine_audio COMMAND openbone_engine_audio ${OPENBONE_REPO_ROOT}/examples/button.obone)
  set(OB_DATA ${CMAKE_CURRENT_SOURCE_DIR}/tests/data)
  add_test(NAME binary COMMAND openbone_unit ${OB_DATA}/interactive.obonb ${OB_DATA}/interactive.decoded.obone
    ${OB_DATA}/dynamics.obonb ${OB_DATA}/dynamics.decoded.obone)
  if(OPENBONE_BUILD_SHARED)
    add_executable(openbone_c_example examples/c/play.c)
    target_link_libraries(openbone_c_example PRIVATE openbone_shared)
    add_test(NAME c_example COMMAND openbone_c_example ${OPENBONE_REPO_ROOT}/conformance/fixtures/interactive.obone)
    # Bounding-box queries through the C API (ob_bounds_*), against the conformance expectations.
    add_executable(openbone_c_bounds tests/c_bounds.cpp)
    target_link_libraries(openbone_c_bounds PRIVATE openbone_shared)
    target_include_directories(openbone_c_bounds PRIVATE third_party)
    add_test(NAME c_bounds COMMAND openbone_c_bounds ${OPENBONE_REPO_ROOT} ${OPENBONE_REPO_ROOT}/conformance/expected/bounds.json)
  endif()
endif()

if(OPENBONE_INSTALL)
  if(OPENBONE_WITH_SCRIPTS)
    install(TARGETS openbone_quickjs ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
  endif()
  if(OPENBONE_BUILD_SHARED)
    install(TARGETS openbone_shared LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR} RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
      ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
  endif()
  install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
endif()
