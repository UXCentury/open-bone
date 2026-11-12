// Draws an OpenBone draw list on a Flutter Canvas with Canvas.drawVertices.
// SPDX-License-Identifier: MIT
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';

import '../document.dart';
import '../types.dart';
import 'fonts.dart';
import 'textures.dart';

/// Maps the document's artboard into a widget box ([fit] + [alignment]) and skeleton space (y up) into the artboard.
class OpenBoneViewTransform {
  OpenBoneViewTransform(OpenBoneDocument document, Size size, {BoxFit fit = BoxFit.contain, Alignment alignment = Alignment.center})
      : originX = document.originX,
        originY = document.originY {
    final art = Size(document.width > 0 ? document.width : size.width, document.height > 0 ? document.height : size.height);
    final fitted = applyBoxFit(fit, art, size);
    final src = alignment.inscribe(fitted.source, Offset.zero & art);
    final dst = alignment.inscribe(fitted.destination, Offset.zero & size);
    scaleX = fitted.source.width == 0 ? 1 : dst.width / fitted.source.width;
    scaleY = fitted.source.height == 0 ? 1 : dst.height / fitted.source.height;
    offset = Offset(dst.left - src.left * scaleX, dst.top - src.top * scaleY);
  }

  final double originX, originY;
  late final double scaleX, scaleY;
  late final Offset offset;

  /// Applies widget → skeleton space to [canvas] (y flipped).
  void apply(Canvas canvas) {
    canvas.translate(offset.dx, offset.dy);
    canvas.scale(scaleX, scaleY);
    canvas.translate(originX, originY);
    canvas.scale(1, -1);
  }

  /// A widget-local position in skeleton space.
  (double, double) toSkeleton(Offset local) {
    final ax = (local.dx - offset.dx) / scaleX, ay = (local.dy - offset.dy) / scaleY;
    return (ax - originX, originY - ay);
  }

  /// A skeleton-space point in widget-local coordinates.
  Offset toLocal(double x, double y) => Offset((x + originX) * scaleX + offset.dx, (originY - y) * scaleY + offset.dy);
}

/// Stateless drawing of draw lists. Reuses scratch buffers between frames.
class OpenBoneRenderer {
  OpenBoneRenderer({this.filterQuality = FilterQuality.medium});

  final FilterQuality filterQuality;
  final Map<ui.Image, ui.ImageShader> _shaders = {};

  static BlendMode blendMode(OpenBoneBlend b) => switch (b) {
        OpenBoneBlend.normal => BlendMode.srcOver,
        OpenBoneBlend.additive => BlendMode.plus,
        OpenBoneBlend.multiply => BlendMode.multiply,
        OpenBoneBlend.screen => BlendMode.screen,
      };

  static int _argb(double r, double g, double b, double a) {
    int c(double v) => (v.clamp(0.0, 1.0) * 255).round();
    return (c(a) << 24) | (c(r) << 16) | (c(g) << 8) | c(b);
  }

  /// Draws [list] in skeleton space: call after [OpenBoneViewTransform.apply] (or any y-up transform). Text uses the
  /// document's own [fonts] when given (see [OpenBoneFonts.load]), else its font list as installed families.
  void draw(Canvas canvas, OpenBoneDrawList list, OpenBoneTextures textures, {OpenBoneFonts? fonts}) {
    var clip = -1;
    for (final item in list.items) {
      if (item.clip != clip) {
        if (clip >= 0) canvas.restore();
        clip = item.clip;
        if (clip >= 0 && clip < list.clips.length) {
          canvas.save();
          canvas.clipPath(Path()..addPolygon(_points(list.clips[clip].polygon), true));
        } else {
          clip = -1;
        }
      }
      switch (item.kind) {
        case OpenBoneItemKind.text:
          _text(canvas, item, fonts);
        case OpenBoneItemKind.shape:
          _shape(canvas, item);
        default:
          _textured(canvas, item, textures);
      }
    }
    if (clip >= 0) canvas.restore();
  }

  void dispose() {
    for (final s in _shaders.values) {
      s.dispose();
    }
    _shaders.clear();
  }

  static List<Offset> _points(Float32List xy) => [for (var i = 0; i + 1 < xy.length; i += 2) Offset(xy[i], xy[i + 1])];

  void _textured(Canvas canvas, OpenBoneDrawItem item, OpenBoneTextures textures) {
    if (item.indices.isEmpty) return;
    final id = item.textureId;
    final image = id == null ? null : textures[id];
    if (id != null && image == null) return; // texture not loaded
    final n = item.vertexCount;
    final colors = Int32List(n);
    final per = item.colors;
    final c = item.color;
    if (per != null) {
      for (var i = 0; i < n; i++) {
        colors[i] = _argb(per[i * 4], per[i * 4 + 1], per[i * 4 + 2], per[i * 4 + 3]);
      }
    } else {
      colors.fillRange(0, n, _argb(c[0], c[1], c[2], c[3]));
    }
    Float32List? uv;
    if (image != null) {
      uv = Float32List(n * 2);
      final w = image.width.toDouble(), h = image.height.toDouble();
      for (var i = 0; i < n; i++) {
        uv[i * 2] = item.uvs[i * 2] * w;
        uv[i * 2 + 1] = item.uvs[i * 2 + 1] * h;
      }
    }
    final vertices = ui.Vertices.raw(VertexMode.triangles, item.vertices,
        textureCoordinates: uv, colors: colors, indices: item.indices);
    final paint = Paint()
      ..blendMode = blendMode(item.blend)
      ..filterQuality = filterQuality
      ..color = const Color(0xFFFFFFFF);
    if (image != null) paint.shader = _shader(image);
    // Tint: vertex colours multiply the texture.
    canvas.drawVertices(vertices, BlendMode.modulate, paint);

    final dark = item.dark;
    if (image != null && dark != null && per == null && (dark[0] > 0 || dark[1] > 0 || dark[2] > 0)) {
      // Two-colour tint: dark + (color - dark) * tex = color * tex + dark * (1 - tex). The first pass drew
      // color * tex; add dark * (1 - tex.rgb), weighted by the item's alpha, on top.
      final alpha = Int32List(n)..fillRange(0, n, _argb(1, 1, 1, c[3]));
      final darkPaint = Paint()
        ..shader = _shader(image)
        ..filterQuality = filterQuality
        ..blendMode = item.blend == OpenBoneBlend.normal ? BlendMode.plus : blendMode(item.blend)
        ..colorFilter = ColorFilter.matrix(<double>[
          -dark[0], 0, 0, 0, dark[0] * 255, //
          0, -dark[1], 0, 0, dark[1] * 255, //
          0, 0, -dark[2], 0, dark[2] * 255, //
          0, 0, 0, 1, 0,
        ]);
      canvas.drawVertices(
          ui.Vertices.raw(VertexMode.triangles, item.vertices, textureCoordinates: uv, colors: alpha, indices: item.indices),
          BlendMode.modulate,
          darkPaint);
    }
  }

  ui.ImageShader _shader(ui.Image image) => _shaders.putIfAbsent(
      image, () => ui.ImageShader(image, TileMode.clamp, TileMode.clamp, Matrix4Identity.storage, filterQuality: filterQuality));

  void _shape(Canvas canvas, OpenBoneDrawItem item) {
    final c = item.color;
    if (item.indices.isNotEmpty && c[3] > 0) {
      final n = item.vertexCount;
      final colors = Int32List(n)..fillRange(0, n, _argb(c[0], c[1], c[2], c[3]));
      canvas.drawVertices(ui.Vertices.raw(VertexMode.triangles, item.vertices, colors: colors, indices: item.indices),
          BlendMode.modulate,
          Paint()
            ..color = const Color(0xFFFFFFFF)
            ..blendMode = blendMode(item.blend));
    }
    final s = item.strokeColor;
    if (s != null && item.strokeWidth > 0 && item.vertexCount > 1) {
      canvas.drawPath(
          Path()..addPolygon(_points(item.vertices), true),
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = item.strokeWidth
            ..strokeJoin = StrokeJoin.round
            ..blendMode = blendMode(item.blend)
            ..color = Color(_argb(s[0], s[1], s[2], s[3])));
    }
  }

  void _text(Canvas canvas, OpenBoneDrawItem item, OpenBoneFonts? fonts) {
    final t = item.text;
    if (t == null || t.content.isEmpty) return;
    final m = t.matrix;
    canvas.save();
    canvas.transform(Float64List.fromList([m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], 0, 1]));
    canvas.scale(1, -1); // text lays out y down
    final align = switch (t.align) { 0 => TextAlign.left, 2 => TextAlign.right, _ => TextAlign.center };
    final weight = FontWeight.values[((t.weight / 100).round() - 1).clamp(0, FontWeight.values.length - 1)];
    final tint = item.color;
    // The whole list: unavailable families are skipped, and later ones fill in characters the first lacks.
    final families = fonts?.families(t.font, t.weight) ?? OpenBoneDocument.fontFamilies(t.font);
    TextPainter painter(Paint? foreground, Color? color) => TextPainter(
          text: TextSpan(
            text: t.content,
            style: TextStyle(
              fontFamily: families.isEmpty ? null : families.first,
              fontFamilyFallback: families.length > 1 ? families.sublist(1) : null,
              fontSize: t.size,
              fontWeight: weight,
              color: color,
              foreground: foreground,
              height: 1.2,
            ),
          ),
          textAlign: align,
          textDirection: TextDirection.ltr,
        )..layout(minWidth: t.width > 0 ? t.width : 0, maxWidth: t.width > 0 ? t.width : double.infinity);
    final fill = Color(_argb(t.fill[0] * tint[0], t.fill[1] * tint[1], t.fill[2] * tint[2], t.fill[3] * tint[3]));
    final main = painter(null, fill);
    final origin = Offset(-main.width / 2, -main.height / 2);
    final o = t.outline;
    if (o != null && t.outlineWidth > 0) {
      final outline = painter(
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = t.outlineWidth * 2
            ..strokeJoin = StrokeJoin.round
            ..color = Color(_argb(o[0], o[1], o[2], o[3] * tint[3])),
          null);
      outline.paint(canvas, origin);
      outline.dispose();
    }
    main.paint(canvas, origin);
    main.dispose();
    canvas.restore();
  }
}

/// Identity 4×4 matrix storage for ImageShader (uv coordinates are already in image pixels).
abstract final class Matrix4Identity {
  static final Float64List storage = Float64List.fromList([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
