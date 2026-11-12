// Document-embedded fonts for the Flutter renderer: each font file of a document is registered with the engine
// (FontLoader) under its own family name, and text font lists are mapped onto those names.
// SPDX-License-Identifier: MIT
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../document.dart';
import '../types.dart';
import 'textures.dart';

/// The fonts a document ships, loaded for drawing. [families] turns a text's font list into the `fontFamily` +
/// `fontFamilyFallback` names to draw it with.
///
/// Flutter can't unregister fonts, so each file is registered once per process under a name derived from its bytes
/// (`openbone-font-<hash>`): documents never see each other's fonts, even with the same family names, and loading
/// the same document again reuses the registration.
class OpenBoneFonts {
  OpenBoneFonts._(this.document, this._names);

  /// No document fonts: [families] returns the font list as it is.
  OpenBoneFonts.none() : document = null, _names = const {};

  final OpenBoneDocument? document;
  final Map<String, String> _names; // font asset id → registered family

  static final Map<int, Future<String?>> _registered = {};

  /// Loads every font of [doc] (sources resolve like images: data: URLs, or paths relative to [source]). Fonts that
  /// can't be read are skipped (text then falls back to installed fonts).
  static Future<OpenBoneFonts> load(OpenBoneDocument doc, {OpenBoneSource? source}) async {
    if (doc.fonts.isEmpty) return OpenBoneFonts.none();
    final names = <String, String>{};
    await Future.wait([
      for (final f in doc.fonts)
        _register(f, doc, source).then((name) {
          if (name != null) names[f.id] = name;
        }),
    ]);
    return OpenBoneFonts._(doc, names);
  }

  static Future<String?> _register(OpenBoneFontAsset f, OpenBoneDocument doc, OpenBoneSource? source) async {
    Uint8List? bytes;
    try {
      bytes = await openBoneSourceBytes(f.src, doc, source);
    } catch (e) {
      debugPrint('openbone: cannot read font ${f.family} (${f.name}): $e');
    }
    if (bytes == null || bytes.isEmpty) return null;
    final hash = _fnv1a(bytes);
    return _registered.putIfAbsent(hash, () async {
      final name = 'openbone-font-${hash.toRadixString(16)}';
      try {
        await (FontLoader(name)..addFont(Future.value(ByteData.sublistView(bytes!)))).load();
        return name;
      } catch (e) {
        debugPrint('openbone: cannot load font ${f.family} (${f.name}): $e');
        return null;
      }
    });
  }

  static int _fnv1a(Uint8List bytes) {
    var h = 0x811c9dc5;
    for (final b in bytes) {
      h = ((h ^ b) * 0x01000193) & 0xffffffff;
    }
    return (h << 20) ^ bytes.length; // length too, so equal 32-bit hashes of different sizes still differ
  }

  /// The families to draw a text with: its font list in order, each family the document ships replaced by the
  /// registered name of its font closest to [weight]; the first is `fontFamily`, the rest `fontFamilyFallback`.
  List<String> families(String fontList, double weight) => [
    for (final family in OpenBoneDocument.fontFamilies(fontList))
      _names[document?.font(family, weight: weight)?.id] ?? family,
  ];
}
