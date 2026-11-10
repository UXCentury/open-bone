// OpenBoneController: drive an OpenBoneWidget (animations, state machine inputs, pause/speed) and listen to it.
// SPDX-License-Identifier: MIT
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../document.dart';
import '../instance.dart';
import '../types.dart';

/// Controls an [OpenBoneWidget]. Calls made before the document has loaded are queued and applied once it has.
/// Streams are available immediately and survive reloads.
class OpenBoneController extends ChangeNotifier {
  OpenBoneController({double speed = 1, bool playing = true})
      : _speed = speed,
        _playing = playing;

  OpenBoneInstance? _instance;
  final List<void Function(OpenBoneInstance)> _pending = [];
  final List<StreamSubscription<Object?>> _subs = [];
  final _events = StreamController<OpenBoneEvent>.broadcast(sync: true);
  final _audio = StreamController<OpenBoneAudioCommand>.broadcast(sync: true);
  final _states = StreamController<OpenBoneStateChange>.broadcast(sync: true);
  final _logs = StreamController<OpenBoneLog>.broadcast(sync: true);
  Completer<OpenBoneInstance> _ready = Completer();
  double _speed;
  bool _playing;

  /// The running instance, or null until the widget has loaded its document.
  OpenBoneInstance? get instance => _instance;
  OpenBoneDocument? get document => _instance?.document;
  bool get isLoaded => _instance != null;

  /// Completes with the instance once loaded.
  Future<OpenBoneInstance> get ready => _ready.future;

  Stream<OpenBoneEvent> get events => _events.stream;
  Stream<OpenBoneAudioCommand> get audioCommands => _audio.stream;
  Stream<OpenBoneStateChange> get stateChanges => _states.stream;
  Stream<OpenBoneLog> get logs => _logs.stream;

  /// Time scale (1 = real time).
  double get speed => _speed;
  set speed(double v) {
    _speed = v;
    notifyListeners();
  }

  bool get isPlaying => _playing;
  void pause() {
    _playing = false;
    notifyListeners();
  }

  void resume() {
    _playing = true;
    notifyListeners();
  }

  void _run(void Function(OpenBoneInstance i) f) {
    final i = _instance;
    if (i != null) {
      f(i);
      notifyListeners();
    } else {
      _pending.add(f);
    }
  }

  void play(String animation, {bool loop = true, int track = 0}) => _run((i) => i.play(animation, loop: loop, track: track));
  void queue(String animation, {bool loop = false, int track = 0, double delay = 0}) =>
      _run((i) => i.queue(animation, loop: loop, track: track, delay: delay));
  void useStateMachine([String? name]) => _run((i) => i.useStateMachine(name));
  void setInput(String input, Object value) => _run((i) => i.setInput(input, value));
  void setBool(String input, bool value) => _run((i) => i.setBool(input, value));
  void setNumber(String input, double value) => _run((i) => i.setNumber(input, value));
  void setString(String input, String value) => _run((i) => i.setString(input, value));
  void fire(String trigger) => _run((i) => i.fire(trigger));
  void setSkin(String? skin) => _run((i) => i.setSkin(skin));
  void setText(String slot, String? text) => _run((i) => i.setText(slot, text));

  /// Current input value (null before load).
  Object? getInput(String input) => _instance?.getInput(input);

  /// Called by the widget when its instance is ready (or replaced / disposed with null).
  @internal
  void attach(OpenBoneInstance? instance) {
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    _instance = instance;
    if (instance == null) {
      if (_ready.isCompleted) _ready = Completer();
      return;
    }
    _subs
      ..add(instance.events.listen(_events.add))
      ..add(instance.audioCommands.listen(_audio.add))
      ..add(instance.stateChanges.listen(_states.add))
      ..add(instance.logs.listen(_logs.add));
    final pending = List.of(_pending);
    _pending.clear();
    for (final f in pending) {
      f(instance);
    }
    if (!_ready.isCompleted) _ready.complete(instance);
    notifyListeners();
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _events.close();
    _audio.close();
    _states.close();
    _logs.close();
    super.dispose();
  }
}
