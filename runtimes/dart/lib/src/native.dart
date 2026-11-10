// Loading libopenbone and the shared ffigen bindings.
// SPDX-License-Identifier: MIT
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

import 'bindings.g.dart';

/// Thrown when the native runtime reports a failure (the message is `ob_last_error()`).
class OpenBoneException implements Exception {
  OpenBoneException(this.message);
  final String message;
  @override
  String toString() => 'OpenBoneException: $message';
}

/// Access to the native library. [OpenBoneNative.libraryPath] may be set before first use to load a specific build;
/// otherwise `OPENBONE_LIBRARY` (environment) is tried, then the platform's bundled plugin library, then a host build
/// made by `tool/build_native.sh` (`.dart_tool/openbone_native/`).
abstract final class OpenBoneNative {
  static String? libraryPath;

  static DynamicLibrary? _library;
  static OpenBoneBindings? _bindings;

  static DynamicLibrary get library => _library ??= _open();
  static OpenBoneBindings get bindings => _bindings ??= OpenBoneBindings(library);

  /// `ob_version()`, e.g. "0.1.0".
  static String get version => bindings.ob_version().cast<Utf8>().toDartString();

  /// `OB_API_VERSION` of the loaded library.
  static int get apiVersion => bindings.ob_api_version();

  /// Whether the library embeds QuickJS (document scripts run).
  static bool get hasScripts => bindings.ob_has_scripts() != 0;

  static DynamicLibrary _open() {
    final candidates = <String>[
      if (libraryPath != null) libraryPath!,
      if ((Platform.environment['OPENBONE_LIBRARY'] ?? '').isNotEmpty) Platform.environment['OPENBONE_LIBRARY']!,
    ];
    if (Platform.isMacOS || Platform.isIOS) {
      candidates.add('openbone.framework/openbone');
    } else if (Platform.isWindows) {
      candidates.add('openbone.dll');
    } else {
      candidates.add('libopenbone.so');
    }
    final host = Platform.isWindows
        ? 'openbone.dll'
        : Platform.isMacOS
            ? 'libopenbone.dylib'
            : 'libopenbone.so';
    candidates.add('${Directory.current.path}/.dart_tool/openbone_native/$host');
    final errors = <String>[];
    for (final c in candidates) {
      try {
        return DynamicLibrary.open(c);
      } on ArgumentError catch (e) {
        errors.add('$c: ${e.message}');
      }
    }
    if (Platform.isIOS || Platform.isMacOS) {
      // Statically linked pods (no use_frameworks!): the symbols are in the app binary.
      final process = DynamicLibrary.process();
      if (process.providesSymbol('ob_api_version')) return process;
    }
    throw OpenBoneException('libopenbone not found. Tried:\n  ${errors.join('\n  ')}\n'
        'Build it with tool/build_native.sh or set OPENBONE_LIBRARY.');
  }

  /// `ob_last_error()` as an exception.
  static OpenBoneException lastError([String fallback = 'failed']) {
    final msg = bindings.ob_last_error().cast<Utf8>().toDartString();
    return OpenBoneException(msg.isEmpty ? fallback : msg);
  }
}

extension OpenBoneCString on Pointer<Char> {
  /// UTF-8 C string to Dart; NULL → null.
  String? get dartOrNull => this == nullptr ? null : cast<Utf8>().toDartString();
  String get dart => this == nullptr ? '' : cast<Utf8>().toDartString();
}
