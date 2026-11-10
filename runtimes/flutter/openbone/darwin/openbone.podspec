#
# OpenBone Flutter plugin (iOS and macOS, shared darwin sources): compiles the C++ runtime and QuickJS (quickjs-ng, MIT,
# vendored in cpp/third_party/quickjs) into the pod through the forwarders in Classes/.
# SPDX-License-Identifier: MIT
#
# Flutter links the plugin through a symlink (.symlinks/plugins/openbone): resolve it to find the runtime. The published
# package carries it in cpp/ (tool/bundle.sh); in the repository the plugin is runtimes/flutter/openbone, next to
# runtimes/cpp. The forwarders include "cpp/src/....cpp" relative to this root.
plugin = File.realpath(File.join(__dir__, '..'))
root = File.exist?(File.join(plugin, 'cpp', 'include', 'openbone.h')) ? plugin : File.expand_path('../..', plugin)

Pod::Spec.new do |s|
  s.name             = 'openbone'
  s.version          = '0.2.0'
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
    'HEADER_SEARCH_PATHS' => "\"#{root}\" \"#{root}/cpp/include\" \"#{root}/cpp/third_party\" \"#{root}/cpp/third_party/quickjs\" \"#{root}/cpp/src\"",
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) OPENBONE_WITH_SCRIPTS=1 _GNU_SOURCE=1",
    # Bit-for-bit parity with the reference runtime: no fused multiply-add contraction. QuickJS wants unsigned char.
    'OTHER_CFLAGS' => '$(inherited) -funsigned-char -ffp-contract=off -w',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -ffp-contract=off -fno-fast-math',
  }
  s.swift_version = '5.0'
end
