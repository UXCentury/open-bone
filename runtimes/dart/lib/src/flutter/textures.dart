// Texture loading for the Flutter renderer: data: URLs, files, the asset bundle, premultiplied atlas pages and the
// built-in particle dot.
// SPDX-License-Identifier: MIT
import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import '../document.dart';
import '../native.dart';
import '../types.dart';

/// Loads the encoded image bytes for a texture `src`, or returns null when it cannot.
typedef OpenBoneImageBytesLoader = Future<Uint8List?> Function(OpenBoneTexture texture, OpenBoneDocument document);

/// Where a document came from, so relative texture paths can be resolved the same way.
sealed class OpenBoneSource {
  const OpenBoneSource();
}

/// A document in the app's asset bundle; textures are loaded from the same bundle, relative to its folder.
class OpenBoneAssetSource extends OpenBoneSource {
  const OpenBoneAssetSource(this.key, {this.bundle});
  final String key;
  final AssetBundle? bundle;
}

/// A document on disk; textures are loaded relative to its directory.
class OpenBoneFileSource extends OpenBoneSource {
  const OpenBoneFileSource(this.path);
  final String path;
}

/// Document bytes; relative textures resolve against [basePath] (a directory) when given.
class OpenBoneBytesSource extends OpenBoneSource {
  const OpenBoneBytesSource(this.bytes, {this.basePath});
  final Uint8List bytes;
  final String? basePath;
}

/// Decoded textures by id, ready for drawing.
class OpenBoneTextures {
  OpenBoneTextures(this.images);
  final Map<String, ui.Image> images;

  ui.Image? operator [](String id) => images[id];

  void dispose() {
    for (final i in images.values) {
      i.dispose();
    }
    images.clear();
  }

  /// Loads every texture of [document] plus the particle dot. Missing textures are skipped (their items are not
  /// drawn); [onError] hears about them.
  static Future<OpenBoneTextures> load(
    OpenBoneDocument document, {
    OpenBoneSource? source,
    OpenBoneImageBytesLoader? loader,
    void Function(OpenBoneTexture texture, Object error)? onError,
  }) async {
    final out = <String, ui.Image>{};
    await Future.wait(document.textures.map((t) async {
      try {
        final bytes = await (loader ?? (t, d) => _defaultBytes(t, d, source))(t, document);
        if (bytes == null || bytes.isEmpty) return;
        var image = await _decode(bytes);
        if (t.premultipliedAlpha) image = await _unpremultiply(image);
        out[t.id] = image;
      } catch (e) {
        onError?.call(t, e);
      }
    }));
    out[openBoneParticleDotTexture] = await particleDot();
    return OpenBoneTextures(out);
  }

  static Future<Uint8List?> _defaultBytes(OpenBoneTexture t, OpenBoneDocument doc, OpenBoneSource? source) async {
    final src = t.src;
    if (src.isEmpty) return null;
    if (src.startsWith('data:')) {
      final data = UriData.parse(src);
      final bytes = data.contentAsBytes();
      return bytes.isEmpty ? null : bytes;
    }
    switch (source) {
      case OpenBoneAssetSource(:final key, :final bundle):
        final dir = key.contains('/') ? key.substring(0, key.lastIndexOf('/') + 1) : '';
        final data = await (bundle ?? rootBundle).load(_normalize('$dir$src'));
        return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      case OpenBoneFileSource(:final path):
        return File('${File(path).parent.path}/$src').readAsBytes();
      case OpenBoneBytesSource(:final basePath):
        if (basePath == null) return null;
        return File('$basePath/$src').readAsBytes();
      case null:
        final base = doc.basePath;
        if (base == null) return null;
        return File('$base/$src').readAsBytes();
    }
  }

  static String _normalize(String path) {
    final parts = <String>[];
    for (final p in path.split('/')) {
      if (p == '..' && parts.isNotEmpty && parts.last != '..') {
        parts.removeLast();
      } else if (p != '.' && p.isNotEmpty) {
        parts.add(p);
      }
    }
    return parts.join('/');
  }

  static Future<ui.Image> _decode(Uint8List bytes) async {
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    codec.dispose();
    return frame.image;
  }

  static Future<ui.Image> _fromRgba(Uint8List straightRgba, int width, int height) {
    final c = Completer<ui.Image>();
    ui.decodeImageFromPixels(straightRgba, width, height, ui.PixelFormat.rgba8888, c.complete);
    return c.future;
  }

  /// Atlas pages saved with premultiplied alpha: the decoder would premultiply again, so divide alpha out once.
  static Future<ui.Image> _unpremultiply(ui.Image image) async {
    final data = await image.toByteData(format: ui.ImageByteFormat.rawStraightRgba);
    if (data == null) return image;
    final px = data.buffer.asUint8List();
    for (var i = 0; i < px.length; i += 4) {
      final a = px[i + 3];
      if (a == 0 || a == 255) continue;
      px[i] = math.min(255, (px[i] * 255 / a).round());
      px[i + 1] = math.min(255, (px[i + 1] * 255 / a).round());
      px[i + 2] = math.min(255, (px[i + 2] * 255 / a).round());
    }
    final out = await _fromRgba(px, image.width, image.height);
    image.dispose();
    return out;
  }

  static const int _dotSize = 64;

  /// The runtime's soft round particle sprite (white, alpha from `ob_particle_dot_alpha`).
  static Future<ui.Image> particleDot() {
    final px = Uint8List(_dotSize * _dotSize * 4);
    const half = _dotSize / 2;
    for (var y = 0; y < _dotSize; y++) {
      for (var x = 0; x < _dotSize; x++) {
        final dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
        final r = math.sqrt(dx * dx + dy * dy);
        final a = OpenBoneNative.bindings.ob_particle_dot_alpha(r);
        final i = (y * _dotSize + x) * 4;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = (a.clamp(0.0, 1.0) * 255).round();
      }
    }
    return _fromRgba(px, _dotSize, _dotSize);
  }
}
