// OpenBoneDocument: an immutable loaded .obone / .obonb (ob_document).
// SPDX-License-Identifier: MIT
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'bindings.g.dart';
import 'instance.dart';
import 'native.dart';
import 'types.dart';

/// A loaded document. Immutable; share it between any number of [OpenBoneInstance]s (each keeps the native
/// document alive on its own, so disposing the document while instances run is safe).
///
/// Native memory is released by [dispose], or by a finalizer when the object is garbage collected.
class OpenBoneDocument implements Finalizable {
  OpenBoneDocument._(this._ptr, {this.basePath}) {
    _finalizer.attach(this, _ptr.cast(), detach: this, externalSize: 64 * 1024);
    _readMetadata();
  }

  static final NativeFinalizer _finalizer =
      NativeFinalizer(OpenBoneNative.library.lookup<NativeFinalizerFunction>('ob_document_free'));

  /// Loads a .obone (JSON) or .obonb (binary) file. Relative texture paths resolve against its directory.
  factory OpenBoneDocument.file(String path) {
    final b = OpenBoneNative.bindings;
    final p = path.toNativeUtf8();
    try {
      final doc = b.ob_document_load_file(p.cast());
      if (doc == nullptr) throw OpenBoneNative.lastError('cannot load $path');
      return OpenBoneDocument._(doc, basePath: File(path).parent.path);
    } finally {
      malloc.free(p);
    }
  }

  /// Loads .obone JSON or .obonb binary bytes (copied). [basePath] is used to resolve relative texture paths.
  factory OpenBoneDocument.bytes(Uint8List bytes, {String? basePath}) {
    final b = OpenBoneNative.bindings;
    final p = malloc<Uint8>(bytes.isEmpty ? 1 : bytes.length);
    try {
      p.asTypedList(bytes.length).setAll(0, bytes);
      final doc = b.ob_document_load_memory(p.cast(), bytes.length);
      if (doc == nullptr) throw OpenBoneNative.lastError('cannot load document');
      return OpenBoneDocument._(doc, basePath: basePath);
    } finally {
      malloc.free(p);
    }
  }

  Pointer<ob_document> _ptr;

  /// Directory (or asset folder) that relative texture `src` values are relative to.
  final String? basePath;

  late final double width, height, originX, originY;
  late final List<OpenBoneAnimationInfo> animations;
  late final List<String> skins;
  late final List<OpenBoneStateMachineInfo> stateMachines;

  /// Atlas pages first, then images.
  late final List<OpenBoneTexture> textures;

  /// Sound files the document's audio commands play (`asset` in a play command is an id here).
  late final List<OpenBoneAudioAsset> audioAssets;

  /// Mixer buses (`bus` in a play command is an id here).
  late final List<OpenBoneAudioBus> audioBuses;

  /// Master volume: 0 when the document's audio is muted.
  late final double audioMaster;

  /// Font files shipped with the document (see [font] for how text picks one).
  late final List<OpenBoneFontAsset> fonts;

  /// The document's font for one family (case-insensitive) whose weight is closest to [weight] (the first wins a
  /// tie), or null. Every runtime picks text fonts this way: for each family of the text's font list in order, the
  /// document's font of that family if it has one, else the installed font of that name.
  OpenBoneFontAsset? font(String family, {double weight = 400}) {
    final f = family.toLowerCase();
    OpenBoneFontAsset? best;
    for (final a in fonts) {
      if (a.family.toLowerCase() == f && (best == null || (a.weight - weight).abs() < (best.weight - weight).abs())) {
        best = a;
      }
    }
    return best;
  }

  /// The families of a CSS-like font list ("Noto Serif JP, 'Open Sans', serif"), trimmed and unquoted, in order.
  static List<String> fontFamilies(String list) => [
        for (final part in list.split(','))
          if (_unquote(part.trim()) case final n when n.isNotEmpty) n,
      ];

  static String _unquote(String s) =>
      s.length >= 2 && (s[0] == '"' || s[0] == "'") && s[s.length - 1] == s[0] ? s.substring(1, s.length - 1) : s;

  bool get isDisposed => _ptr == nullptr;

  /// The native handle (valid until [dispose]).
  Pointer<ob_document> get handle {
    if (_ptr == nullptr) throw StateError('OpenBoneDocument was disposed');
    return _ptr;
  }

  /// Creates a playable instance. With [scripts], document scripts run in the embedded QuickJS sandbox.
  OpenBoneInstance createInstance({bool scripts = true}) => OpenBoneInstance(this, scripts: scripts);

  /// Artboard coordinates (y down, origin top-left) to skeleton space (y up).
  (double, double) artboardToSkeleton(double x, double y) => (x - originX, originY - y);

  /// Skeleton space to artboard coordinates.
  (double, double) skeletonToArtboard(double x, double y) => (x + originX, originY - y);

  /// Releases the native document now. Instances created from it keep working.
  void dispose() {
    if (_ptr == nullptr) return;
    _finalizer.detach(this);
    OpenBoneNative.bindings.ob_document_free(_ptr);
    _ptr = nullptr;
  }

  void _readMetadata() {
    final b = OpenBoneNative.bindings;
    using((arena) {
      final d = arena<Double>(4);
      b.ob_document_size(_ptr, d, d + 1, d + 2, d + 3);
      width = d[0];
      height = d[1];
      originX = d[2];
      originY = d[3];

      animations = [
        for (var i = 0; i < b.ob_document_animation_count(_ptr); i++)
          OpenBoneAnimationInfo(b.ob_document_animation_name(_ptr, i).dart, b.ob_document_animation_duration(_ptr, i)),
      ];
      skins = [for (var i = 0; i < b.ob_document_skin_count(_ptr); i++) b.ob_document_skin_name(_ptr, i).dart];

      final name = arena<Pointer<Char>>();
      final value = arena<ob_value>();
      final trigger = arena<Int>();
      stateMachines = [
        for (var m = 0; m < b.ob_document_state_machine_count(_ptr); m++)
          OpenBoneStateMachineInfo(b.ob_document_state_machine_name(_ptr, m).dart, [
            for (var i = 0; i < b.ob_document_input_count(_ptr, m); i++)
              if (b.ob_document_input(_ptr, m, i, name, value, trigger) != 0)
                _input(name.value.dart, value.ref, trigger.value != 0),
          ]),
      ];

      final tex = arena<ob_texture_info>();
      textures = [
        for (var i = 0; i < b.ob_document_texture_count(_ptr); i++)
          if (b.ob_document_texture(_ptr, i, tex) != 0)
            OpenBoneTexture(
              id: tex.ref.id.dart,
              name: tex.ref.name.dart,
              src: tex.ref.src.dart,
              width: tex.ref.width,
              height: tex.ref.height,
              isAtlasPage: tex.ref.is_atlas_page != 0,
              premultipliedAlpha: tex.ref.premultiplied_alpha != 0,
            ),
      ];

      final asset = arena<ob_audio_asset>();
      audioAssets = [
        for (var i = 0; i < b.ob_document_audio_asset_count(_ptr); i++)
          if (b.ob_document_audio_asset(_ptr, i, asset) != 0)
            OpenBoneAudioAsset(id: asset.ref.id.dart, name: asset.ref.name.dart, src: asset.ref.src.dart, duration: asset.ref.duration),
      ];
      final bus = arena<ob_audio_bus>();
      audioBuses = [
        for (var i = 0; i < b.ob_document_audio_bus_count(_ptr); i++)
          if (b.ob_document_audio_bus(_ptr, i, bus) != 0)
            OpenBoneAudioBus(id: bus.ref.id.dart, name: bus.ref.name.dart, volume: bus.ref.volume, muted: bus.ref.muted != 0),
      ];
      audioMaster = b.ob_document_audio_master(_ptr);
      final font = arena<ob_font_asset>();
      fonts = [
        for (var i = 0; i < b.ob_document_font_count(_ptr); i++)
          if (b.ob_document_font(_ptr, i, font) != 0)
            OpenBoneFontAsset(
              id: font.ref.id.dart,
              name: font.ref.name.dart,
              family: font.ref.family.dart,
              src: font.ref.src.dart,
              weight: font.ref.weight,
              style: font.ref.style.dart,
            ),
      ];
    });
  }

  static OpenBoneInputInfo _input(String name, ob_value v, bool trigger) {
    if (trigger) return OpenBoneInputInfo(name, OpenBoneInputType.trigger, false);
    return switch (v.type) {
      ob_value_type.OB_VALUE_BOOL => OpenBoneInputInfo(name, OpenBoneInputType.boolean, v.b != 0),
      ob_value_type.OB_VALUE_NUMBER => OpenBoneInputInfo(name, OpenBoneInputType.number, v.n),
      ob_value_type.OB_VALUE_STRING => OpenBoneInputInfo(name, OpenBoneInputType.string, v.s.dart),
      _ => OpenBoneInputInfo(name, OpenBoneInputType.number, 0.0),
    };
  }
}
