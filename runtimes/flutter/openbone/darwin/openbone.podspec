#
# OpenBone Flutter plugin (iOS and macOS, shared darwin sources): compiles the C++ runtime (runtimes/cpp) into the pod through the forwarders in
# Classes/runtime. Document scripts need QuickJS: run tool/fetch_quickjs.sh once (it fills ../third_party/quickjs);
# without it the library builds with scripts disabled (ob_has_scripts() == 0).
# SPDX-License-Identifier: MIT
#
# Flutter links the plugin through a symlink (.symlinks/plugins/openbone): resolve it to find runtimes/cpp.
plugin = File.realpath(File.join(__dir__, '..'))
runtimes = File.expand_path('../..', plugin)  # runtimes/: the plugin is runtimes/flutter/openbone
quickjs = File.exist?(File.join(plugin, 'third_party', 'quickjs', 'quickjs.c'))

Pod::Spec.new do |s|
  s.name             = 'openbone'
  s.version          = '0.1.0'
  s.summary          = 'OpenBone runtime: skeletal animation and state machines (libopenbone over dart:ffi).'
  s.description      = 'Builds libopenbone, the C API of the OpenBone C++ runtime, for the openbone Flutter plugin.'
  s.homepage         = 'https://github.com/UXCentury/open-bone'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'OpenBone contributors' => 'https://github.com/UXCentury/open-bone' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.ios.dependency 'Flutter'
  s.osx.dependency 'FlutterMacOS'
  s.ios.deployment_target = '13.0'
  s.osx.deployment_target = '10.15'
  s.library = 'c++'

  # Flutter.framework does not contain an i386 slice.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => "\"#{runtimes}\" \"#{runtimes}/cpp/include\" \"#{runtimes}/cpp/third_party\" \"#{runtimes}/cpp/src\" \"#{plugin}/third_party\" \"#{plugin}/third_party/quickjs\"",
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) OPENBONE_WITH_SCRIPTS=#{quickjs ? 1 : 0} _GNU_SOURCE=1",
    # Bit-for-bit parity with the reference runtime: no fused multiply-add contraction. QuickJS wants unsigned char.
    'OTHER_CFLAGS' => '$(inherited) -funsigned-char -ffp-contract=off -w',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -ffp-contract=off -fno-fast-math',
  }
  s.swift_version = '5.0'
end
