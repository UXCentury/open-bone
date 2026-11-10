// OpenBoneInstance: a playing skeleton (ob_instance).
// SPDX-License-Identifier: MIT
import 'dart:async';
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'bindings.g.dart';
import 'document.dart';
import 'native.dart';
import 'types.dart';

/// Event sinks shared with the native callbacks. Kept apart from [OpenBoneInstance] so the callbacks do not keep the
/// instance reachable (otherwise its finalizer could never run).
class _Channels {
  final events = StreamController<OpenBoneEvent>.broadcast(sync: true);
  final audio = StreamController<OpenBoneAudioCommand>.broadcast(sync: true);
  final states = StreamController<OpenBoneStateChange>.broadcast(sync: true);
  final logs = StreamController<OpenBoneLog>.broadcast(sync: true);

  void close() {
    events.close();
    audio.close();
    states.close();
    logs.close();
  }
}

/// Everything the finalizer must release when an undisposed instance is collected.
class _Native {
  _Native(this.ptr, this.callables, this.channels);
  final Pointer<ob_instance> ptr;
  final List<NativeCallable<Function>> callables;
  final _Channels channels;

  void release() {
    final b = OpenBoneNative.bindings;
    // Unhook the callbacks before freeing so nothing calls into closed trampolines.
    b.ob_instance_set_event_callback(ptr, nullptr, nullptr);
    b.ob_instance_set_audio_callback(ptr, nullptr, nullptr);
    b.ob_instance_set_state_callback(ptr, nullptr, nullptr);
    b.ob_instance_set_log_callback(ptr, nullptr, nullptr);
    b.ob_instance_free(ptr);
    for (final c in callables) {
      c.close();
    }
    channels.close();
  }
}

/// A playing skeleton: animation tracks or a state machine, inputs, pointer events, pose and draw list.
///
/// Callbacks (events, audio commands, state changes, logs) are delivered synchronously from inside [advance] (and
/// [pointer]-driven listeners during the next [advance]) on the calling isolate, through broadcast streams.
///
/// Call [dispose] when done; an instance that is garbage collected without it is released by a finalizer.
class OpenBoneInstance {
  OpenBoneInstance(this.document, {bool scripts = true}) {
    final b = OpenBoneNative.bindings;
    final ptr = b.ob_instance_create(document.handle, scripts ? OB_INSTANCE_SCRIPTS : 0);
    if (ptr == nullptr) throw OpenBoneNative.lastError('cannot create instance');
    final ch = _Channels();
    final onEvent = NativeCallable<ob_event_fnFunction>.isolateLocal((Pointer<Void> _, Pointer<ob_event> e) {
      if (!ch.events.hasListener) return;
      final r = e.ref;
      ch.events.add(OpenBoneEvent(
        name: r.name.dart,
        id: r.id.dart,
        time: r.time,
        intValue: r.int_value,
        floatValue: r.float_value,
        stringValue: r.string_value.dart,
        animation: r.animation.dart,
        audio: r.audio.dartOrNull,
      ));
    })
      ..keepIsolateAlive = false;
    final onAudio = NativeCallable<ob_audio_fnFunction>.isolateLocal((Pointer<Void> _, Pointer<ob_audio_command> c) {
      if (!ch.audio.hasListener) return;
      final r = c.ref;
      ch.audio.add(OpenBoneAudioCommand(
        type: OpenBoneAudioType.values[r.type.value],
        id: r.id.dart,
        sound: r.sound.dart,
        asset: r.asset.dart,
        bus: r.bus.dartOrNull,
        volume: r.volume,
        rate: r.rate,
        fadeIn: r.fade_in,
        loop: r.loop != 0,
        source: r.source.dart,
        fade: r.fade,
        duration: r.duration,
      ));
    })
      ..keepIsolateAlive = false;
    final onState = NativeCallable<ob_state_fnFunction>.isolateLocal(
        (Pointer<Void> _, Pointer<Char> layer, Pointer<Char> from, Pointer<Char> to) {
      if (ch.states.hasListener) ch.states.add(OpenBoneStateChange(layer.dart, from.dartOrNull, to.dart));
    })
      ..keepIsolateAlive = false;
    final onLog = NativeCallable<ob_log_fnFunction>.isolateLocal((Pointer<Void> _, Pointer<Char> msg, int isError) {
      if (ch.logs.hasListener) ch.logs.add(OpenBoneLog(msg.dart, isError != 0));
    })
      ..keepIsolateAlive = false;
    b.ob_instance_set_event_callback(ptr, onEvent.nativeFunction, nullptr);
    b.ob_instance_set_audio_callback(ptr, onAudio.nativeFunction, nullptr);
    b.ob_instance_set_state_callback(ptr, onState.nativeFunction, nullptr);
    b.ob_instance_set_log_callback(ptr, onLog.nativeFunction, nullptr);
    _native = _Native(ptr, [onEvent, onAudio, onState, onLog], ch);
    _finalizer.attach(this, _native!, detach: this);
  }

  static final Finalizer<_Native> _finalizer = Finalizer((n) => n.release());

  final OpenBoneDocument document;
  _Native? _native;
  String? _stateMachine;

  bool get isDisposed => _native == null;

  /// The native handle (valid until [dispose]).
  Pointer<ob_instance> get handle {
    final n = _native;
    if (n == null) throw StateError('OpenBoneInstance was disposed');
    return n.ptr;
  }

  static OpenBoneBindings get _b => OpenBoneNative.bindings;

  /// Events fired by animations, listeners and scripts.
  Stream<OpenBoneEvent> get events => _channels.events.stream;

  /// Audio commands for the host's audio engine.
  Stream<OpenBoneAudioCommand> get audioCommands => _channels.audio.stream;

  /// State-machine state changes.
  Stream<OpenBoneStateChange> get stateChanges => _channels.states.stream;

  /// Script logs and errors.
  Stream<OpenBoneLog> get logs => _channels.logs.stream;

  _Channels get _channels {
    final n = _native;
    if (n == null) throw StateError('OpenBoneInstance was disposed');
    return n.channels;
  }

  /// Releases the native instance and closes the streams.
  void dispose() {
    final n = _native;
    if (n == null) return;
    _finalizer.detach(this);
    _native = null;
    n.release();
  }

  // ---------- Setup ----------

  /// Sets the skin by name or id; null or "" = none (default skin only).
  void setSkin(String? skin) => _withString(skin, (p) => _check(_b.ob_instance_set_skin(handle, p)));

  /// Skeleton placement applied to root bones.
  void setTransform({double x = 0, double y = 0, double scaleX = 1, double scaleY = 1}) =>
      _b.ob_instance_set_transform(handle, x, y, scaleX, scaleY);

  // ---------- Animations ----------

  /// Plays an animation on a track (stops a running state machine). Cross-fades from what was playing.
  void play(String animation, {bool loop = true, int track = 0}) {
    _stateMachine = null;
    _withString(animation, (p) => _check(_b.ob_instance_play(handle, p, loop ? 1 : 0, track)));
  }

  /// Queues an animation after the current one on [track] completes (or after [delay] seconds when > 0).
  void queue(String animation, {bool loop = false, int track = 0, double delay = 0}) {
    _stateMachine = null;
    _withString(animation, (p) => _check(_b.ob_instance_queue(handle, p, loop ? 1 : 0, track, delay)));
  }

  void clearTracks() => _b.ob_instance_clear_tracks(handle);

  // ---------- State machines ----------

  /// Starts a state machine by name or id (null = the first).
  void useStateMachine([String? name]) {
    _withString(name, (p) => _check(_b.ob_instance_use_state_machine(handle, p)));
    _stateMachine = name ?? (document.stateMachines.isNotEmpty ? document.stateMachines.first.name : null);
  }

  /// Name of the state machine started with [useStateMachine] (null when playing animations).
  String? get stateMachine => _stateMachine;

  void setBool(String input, bool value) =>
      _withString(input, (p) => _check(_b.ob_instance_set_bool(handle, p, value ? 1 : 0)));
  void setNumber(String input, double value) =>
      _withString(input, (p) => _check(_b.ob_instance_set_number(handle, p, value)));
  void setString(String input, String value) => _withString(
      input, (p) => _withString(value, (v) => _check(_b.ob_instance_set_string(handle, p, v))));

  /// Sets an input from a bool, num or String.
  void setInput(String input, Object value) {
    switch (value) {
      case bool v:
        setBool(input, v);
      case num v:
        setNumber(input, v.toDouble());
      case String v:
        setString(input, v);
      default:
        throw ArgumentError.value(value, 'value', 'bool, num or String');
    }
  }

  /// Fires a trigger input.
  void fire(String trigger) => _withString(trigger, (p) => _check(_b.ob_instance_fire(handle, p)));

  /// Current value of an input (bool, double or String).
  Object? getInput(String input) => using((arena) {
        final v = arena<ob_value>();
        final p = input.toNativeUtf8(allocator: arena);
        _check(_b.ob_instance_get_input(handle, p.cast(), v));
        return switch (v.ref.type) {
          ob_value_type.OB_VALUE_BOOL => v.ref.b != 0,
          ob_value_type.OB_VALUE_NUMBER => v.ref.n,
          ob_value_type.OB_VALUE_STRING => v.ref.s.dart,
          ob_value_type.OB_VALUE_NONE => null,
        };
      });

  /// A pointer event in skeleton space (y up), processed by the next [advance].
  void pointer(OpenBonePointerType type, double x, double y) {
    final t = switch (type) {
      OpenBonePointerType.down => ob_pointer_type.OB_POINTER_DOWN,
      OpenBonePointerType.up => ob_pointer_type.OB_POINTER_UP,
      OpenBonePointerType.move => ob_pointer_type.OB_POINTER_MOVE,
    };
    _check(_b.ob_instance_pointer(handle, t, x, y));
  }

  /// Active state per state-machine layer (null = none), in layer order.
  Map<String, String?> get activeStates => using((arena) {
        final layer = arena<Pointer<Char>>();
        final state = arena<Pointer<Char>>();
        final out = <String, String?>{};
        final n = _b.ob_instance_layer_count(handle);
        for (var i = 0; i < n; i++) {
          if (_b.ob_instance_active_state(handle, i, layer, state) != 0) out[layer.value.dart] = state.value.dartOrNull;
        }
        return out;
      });

  /// Shows fixed text (or a {template}) in a slot's text attachment; null restores the attachment's own text.
  void setText(String slot, String? text) =>
      _withString(slot, (s) => _withString(text, (t) => _check(_b.ob_instance_set_text(handle, s, t))));

  // ---------- Time ----------

  /// Steps time by [dt] seconds and poses the skeleton; `advance(0)` poses without moving time.
  void advance(double dt) => _b.ob_instance_advance(handle, dt);

  // ---------- Pose ----------

  List<OpenBoneBone> get bones => using((arena) {
        final info = arena<ob_bone_info>();
        final n = _b.ob_instance_bone_count(handle);
        return [
          for (var i = 0; i < n; i++)
            if (_b.ob_instance_bone(handle, i, info) != 0)
              OpenBoneBone(
                name: info.ref.name.dart,
                parent: info.ref.parent.dartOrNull,
                length: info.ref.length,
                a: info.ref.a,
                b: info.ref.b,
                c: info.ref.c,
                d: info.ref.d,
                x: info.ref.x,
                y: info.ref.y,
                active: info.ref.active != 0,
              ),
        ];
      });

  /// Index of a bone by name or id, or -1.
  int findBone(String name) => using((arena) => _b.ob_instance_find_bone(handle, name.toNativeUtf8(allocator: arena).cast()));

  /// Index of a slot by name or id, or -1.
  int findSlot(String name) => using((arena) => _b.ob_instance_find_slot(handle, name.toNativeUtf8(allocator: arena).cast()));

  List<OpenBoneSlot> get slots => using((arena) {
        final info = arena<ob_slot_info>();
        final n = _b.ob_instance_slot_count(handle);
        return [
          for (var i = 0; i < n; i++)
            if (_b.ob_instance_slot(handle, i, info) != 0)
              OpenBoneSlot(
                name: info.ref.name.dart,
                bone: info.ref.bone.dartOrNull,
                attachment: info.ref.attachment.dartOrNull,
                color: [for (var k = 0; k < 4; k++) info.ref.color[k]],
                dark: info.ref.has_dark != 0 ? [for (var k = 0; k < 3; k++) info.ref.dark[k]] : null,
                blend: OpenBoneBlend.values[info.ref.blend.value],
              ),
        ];
      });

  /// Rebuilds the draw list from the current pose and copies it out.
  OpenBoneDrawList drawList() => using((arena) {
        final h = handle;
        final n = _b.ob_instance_update_draw_list(h);
        final it = arena<ob_draw_item>();
        final items = <OpenBoneDrawItem>[];
        for (var i = 0; i < n; i++) {
          if (_b.ob_instance_draw_item(h, i, it) == 0) continue;
          final r = it.ref;
          final vc = r.vertex_count;
          OpenBoneText? text;
          if (r.text != nullptr) {
            text = OpenBoneText(
              content: r.text.dart,
              font: r.font.dart,
              size: r.font_size,
              weight: r.font_weight,
              align: r.text_align,
              width: r.text_width,
              height: r.text_height,
              fill: [for (var k = 0; k < 4; k++) r.text_fill[k]],
              outline: r.has_outline != 0 ? [for (var k = 0; k < 4; k++) r.text_outline[k]] : null,
              outlineWidth: r.outline_width,
              matrix: Float64List.fromList([for (var k = 0; k < 6; k++) r.text_matrix[k]]),
            );
          }
          items.add(OpenBoneDrawItem(
            slot: r.slot.dart,
            attachment: r.attachment.dart,
            kind: OpenBoneItemKind.values[r.kind.value],
            blend: OpenBoneBlend.values[r.blend.value],
            textureId: r.texture_id.dartOrNull,
            textureSrc: r.texture_src.dartOrNull,
            textureWidth: r.texture_width,
            textureHeight: r.texture_height,
            vertices: _f32(r.vertices, vc * 2),
            uvs: _f32(r.uvs, vc * 2),
            indices: r.index_count > 0 ? Uint16List.fromList(r.indices.asTypedList(r.index_count)) : Uint16List(0),
            color: Float32List.fromList([for (var k = 0; k < 4; k++) r.color[k]]),
            dark: r.has_dark != 0 ? Float32List.fromList([for (var k = 0; k < 3; k++) r.dark[k]]) : null,
            colors: r.colors != nullptr ? _f32(r.colors, vc * 4) : null,
            clip: r.clip,
            text: text,
            strokeColor: r.has_stroke != 0 ? Float32List.fromList([for (var k = 0; k < 4; k++) r.stroke_color[k]]) : null,
            strokeWidth: r.stroke_width,
          ));
        }
        final clip = arena<ob_clip>();
        final clips = <OpenBoneClip>[
          for (var i = 0; i < _b.ob_instance_clip_count(h); i++)
            if (_b.ob_instance_clip(h, i, clip) != 0)
              OpenBoneClip(
                clip.ref.slot.dart,
                _f32(clip.ref.polygon, clip.ref.vertex_count * 2),
                clip.ref.index_count > 0
                    ? Uint16List.fromList(clip.ref.indices.asTypedList(clip.ref.index_count))
                    : Uint16List(0),
              ),
        ];
        return OpenBoneDrawList(items, clips);
      });

  /// Bounds of the drawn geometry and bones in skeleton space: (minX, minY, maxX, maxY).
  (double, double, double, double) get bounds => using((arena) {
        final out = arena<Double>(4);
        _b.ob_instance_bounds(handle, out);
        return (out[0], out[1], out[2], out[3]);
      });

  // ---------- helpers ----------

  static Float32List _f32(Pointer<Float> p, int n) =>
      n <= 0 || p == nullptr ? Float32List(0) : Float32List.fromList(p.asTypedList(n));

  static void _check(int result) {
    if (result == 0) throw OpenBoneNative.lastError();
  }

  static void _withString(String? s, void Function(Pointer<Char>) f) {
    if (s == null) return f(nullptr);
    final p = s.toNativeUtf8();
    try {
      f(p.cast());
    } finally {
      malloc.free(p);
    }
  }
}
