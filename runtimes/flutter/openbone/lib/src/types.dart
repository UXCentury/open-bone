// Plain Dart value types copied out of the native runtime (no native memory is retained).
// SPDX-License-Identifier: MIT
import 'dart:typed_data';

enum OpenBoneBlend { normal, additive, multiply, screen }

enum OpenBoneItemKind { region, mesh, sequence, shape, text, particles }

enum OpenBonePointerType { down, up, move }

enum OpenBoneInputType { boolean, number, string, trigger }

/// play / stop / fade a sound; mix: a mute button muted or unmuted a bus (`bus` null = everything, see `muted`).
enum OpenBoneAudioType { play, stop, fade, mix }

/// The texture id of the runtime's built-in soft particle sprite (no image file; see `ob_particle_dot_alpha`).
const String openBoneParticleDotTexture = '@openbone/particle-dot';

class OpenBoneAnimationInfo {
  const OpenBoneAnimationInfo(this.name, this.duration);
  final String name;

  /// Seconds.
  final double duration;
  @override
  String toString() => 'OpenBoneAnimationInfo($name, ${duration}s)';
}

class OpenBoneInputInfo {
  const OpenBoneInputInfo(this.name, this.type, this.defaultValue);
  final String name;
  final OpenBoneInputType type;

  /// bool, double or String (false for triggers).
  final Object? defaultValue;
  @override
  String toString() => 'OpenBoneInputInfo($name, ${type.name}, $defaultValue)';
}

class OpenBoneStateMachineInfo {
  const OpenBoneStateMachineInfo(this.name, this.inputs);
  final String name;
  final List<OpenBoneInputInfo> inputs;
}

/// An image asset or atlas page a renderer has to provide. [src] is a data: URL or a path relative to the document.
/// A sound file of the document: [src] is a data: URL or a path relative to the document.
class OpenBoneAudioAsset {
  const OpenBoneAudioAsset({required this.id, required this.name, required this.src, required this.duration});
  final String id, name, src;
  final double duration;
}

/// A mixer bus of the document.
class OpenBoneAudioBus {
  const OpenBoneAudioBus({required this.id, required this.name, required this.volume, required this.muted});
  final String id, name;
  final double volume;
  final bool muted;
}

class OpenBoneTexture {
  const OpenBoneTexture({
    required this.id,
    required this.name,
    required this.src,
    required this.width,
    required this.height,
    required this.isAtlasPage,
    required this.premultipliedAlpha,
  });
  final String id, name, src;
  final double width, height;
  final bool isAtlasPage;

  /// Atlas pages packed with premultiplied alpha.
  final bool premultipliedAlpha;
}

class OpenBoneEvent {
  const OpenBoneEvent({
    required this.name,
    required this.id,
    required this.time,
    required this.intValue,
    required this.floatValue,
    required this.stringValue,
    required this.animation,
    this.audio,
  });
  final String name, id;
  final double time;
  final double intValue;
  final double floatValue;
  final String stringValue;

  /// Animation that keyed the event ("" for listener and script events).
  final String animation;

  /// Sound the event plays, if any.
  final String? audio;
  @override
  String toString() => 'OpenBoneEvent($name t=$time int=$intValue float=$floatValue "$stringValue")';
}

/// A command for the host's audio engine (the runtime does not play sound itself).
class OpenBoneAudioCommand {
  const OpenBoneAudioCommand({
    required this.type,
    required this.id,
    this.sound = '',
    this.asset = '',
    this.bus,
    this.volume = 1,
    this.rate = 1,
    this.fadeIn = 0,
    this.loop = false,
    this.source = '',
    this.fade = 0,
    this.duration = 0,
    this.muted = false,
  });
  final OpenBoneAudioType type;

  /// Playing-instance id; stop and fade commands refer to the id of an earlier play.
  final String id;
  final String sound, asset;

  /// Bus id, null = master.
  final String? bus;

  /// play: volume; fade: target volume.
  final double volume;
  final double rate, fadeIn;
  final bool loop;
  final String source;

  /// stop: fade-out seconds.
  final double fade;

  /// fade: seconds.
  final double duration;

  /// mix: whether `bus` (null = everything) is now muted.
  final bool muted;
  @override
  String toString() => 'OpenBoneAudioCommand(${type.name} $id $sound)';
}

class OpenBoneStateChange {
  const OpenBoneStateChange(this.layer, this.from, this.to);
  final String layer;
  final String? from;
  final String to;
  @override
  String toString() => 'OpenBoneStateChange($layer: $from -> $to)';
}

class OpenBoneLog {
  const OpenBoneLog(this.message, this.isError);
  final String message;
  final bool isError;
  @override
  String toString() => '${isError ? 'error' : 'log'}: $message';
}

/// A bone's world transform: x' = a*x + b*y + x0, y' = c*x + d*y + y0 (skeleton space, y up).
class OpenBoneBone {
  const OpenBoneBone({
    required this.name,
    required this.parent,
    required this.length,
    required this.a,
    required this.b,
    required this.c,
    required this.d,
    required this.x,
    required this.y,
    required this.active,
  });
  final String name;
  final String? parent;
  final double length, a, b, c, d, x, y;
  final bool active;
}

class OpenBoneSlot {
  const OpenBoneSlot({
    required this.name,
    required this.bone,
    this.attachment,
    required this.color,
    this.dark,
    this.blend = OpenBoneBlend.normal,
  });
  final String name;
  final String? bone;

  /// Current attachment name, null = empty.
  final String? attachment;

  /// Straight RGBA, 0..1.
  final List<double> color;

  /// Dark colour (two-colour tint) RGB, or null.
  final List<double>? dark;

  /// The slot's blend mode.
  final OpenBoneBlend blend;
}

class OpenBoneText {
  const OpenBoneText({
    required this.content,
    required this.font,
    required this.size,
    required this.weight,
    required this.align,
    required this.width,
    required this.height,
    required this.fill,
    this.outline,
    required this.outlineWidth,
    required this.matrix,
  });

  /// Resolved text (templates filled in).
  final String content;
  final String font;
  final double size, weight;

  /// 0 left, 1 centre, 2 right.
  final int align;

  /// The text box, centred on [matrix]'s origin.
  final double width, height;
  final List<double> fill;
  final List<double>? outline;
  final double outlineWidth;

  /// a, b, c, d, x, y: box centre to skeleton space.
  final Float64List matrix;
}

/// One draw call worth of geometry (skeleton space, y up), in draw order.
class OpenBoneDrawItem {
  const OpenBoneDrawItem({
    required this.slot,
    required this.attachment,
    required this.kind,
    required this.blend,
    this.textureId,
    this.textureSrc,
    required this.textureWidth,
    required this.textureHeight,
    required this.vertices,
    required this.uvs,
    required this.indices,
    required this.color,
    this.dark,
    this.colors,
    required this.clip,
    this.text,
    this.strokeColor,
    this.strokeWidth = 0,
  });
  final String slot, attachment;
  final OpenBoneItemKind kind;
  final OpenBoneBlend blend;

  /// Image or atlas page id, [openBoneParticleDotTexture], or null for untextured (solid) geometry.
  final String? textureId;
  final String? textureSrc;
  final double textureWidth, textureHeight;

  /// x,y pairs.
  final Float32List vertices;

  /// u,v pairs in 0..1, v down.
  final Float32List uvs;
  final Uint16List indices;

  /// Tint, straight RGBA (ignored when [colors] is set).
  final Float32List color;

  /// Two-colour tint dark RGB: output = dark + (color - dark) * texture.rgb. Null = plain multiply.
  final Float32List? dark;

  /// Per-vertex straight RGBA (particles).
  final Float32List? colors;

  /// Index into [OpenBoneDrawList.clips], or -1.
  final int clip;
  final OpenBoneText? text;

  /// Shapes: stroke colour (null = no stroke) and width.
  final Float32List? strokeColor;
  final double strokeWidth;
  int get vertexCount => vertices.length ~/ 2;
}

class OpenBoneClip {
  const OpenBoneClip(this.slot, this.polygon, this.indices);
  final String slot;

  /// x,y pairs.
  final Float32List polygon;
  final Uint16List indices;
}

class OpenBoneDrawList {
  const OpenBoneDrawList(this.items, this.clips);
  final List<OpenBoneDrawItem> items;
  final List<OpenBoneClip> clips;
}
