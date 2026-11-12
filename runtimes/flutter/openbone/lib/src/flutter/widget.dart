// OpenBoneWidget: loads a document, advances it with a Ticker, paints the draw list and forwards pointers.
// SPDX-License-Identifier: MIT
import 'dart:async';
import 'dart:io';

import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../document.dart';
import '../instance.dart';
import '../types.dart';
import 'audio.dart';
import 'controller.dart';
import 'fonts.dart';
import 'renderer.dart';
import 'textures.dart';

/// Plays an OpenBone document (.obone / .obonb).
///
/// Starts [stateMachine] if given, else plays [animation] (looping); with neither it starts the document's first
/// state machine, or else its first animation. Pointer input (down / move / up / hover) is sent to the state machine
/// when [interactive]. Use an [OpenBoneController] for inputs, triggers, animations, events and audio commands.
class OpenBoneWidget extends StatefulWidget {
  const OpenBoneWidget({
    super.key,
    required this.source,
    this.controller,
    this.animation,
    this.stateMachine,
    this.skin,
    this.fit = BoxFit.contain,
    this.alignment = Alignment.center,
    this.interactive = true,
    this.scripts = true,
    this.audio = true,
    this.imageLoader,
    this.placeholder,
    this.onLoaded,
    this.onError,
  }) : document = null;

  /// A document from the asset bundle (textures load from the same folder).
  OpenBoneWidget.asset(
    String asset, {
    Key? key,
    AssetBundle? bundle,
    OpenBoneController? controller,
    String? animation,
    String? stateMachine,
    String? skin,
    BoxFit fit = BoxFit.contain,
    Alignment alignment = Alignment.center,
    bool interactive = true,
    bool scripts = true,
    Widget? placeholder,
    void Function(OpenBoneInstance)? onLoaded,
    void Function(Object error)? onError,
  }) : this(
          key: key,
          source: OpenBoneAssetSource(asset, bundle: bundle),
          controller: controller,
          animation: animation,
          stateMachine: stateMachine,
          skin: skin,
          fit: fit,
          alignment: alignment,
          interactive: interactive,
          scripts: scripts,
          placeholder: placeholder,
          onLoaded: onLoaded,
          onError: onError,
        );

  /// A document file on disk (textures load relative to it).
  OpenBoneWidget.file(
    String path, {
    Key? key,
    OpenBoneController? controller,
    String? animation,
    String? stateMachine,
    String? skin,
    BoxFit fit = BoxFit.contain,
    Alignment alignment = Alignment.center,
    bool interactive = true,
    bool scripts = true,
    Widget? placeholder,
    void Function(OpenBoneInstance)? onLoaded,
    void Function(Object error)? onError,
  }) : this(
          key: key,
          source: OpenBoneFileSource(path),
          controller: controller,
          animation: animation,
          stateMachine: stateMachine,
          skin: skin,
          fit: fit,
          alignment: alignment,
          interactive: interactive,
          scripts: scripts,
          placeholder: placeholder,
          onLoaded: onLoaded,
          onError: onError,
        );

  /// An already loaded document (the caller keeps ownership and disposes it).
  const OpenBoneWidget.document(
    OpenBoneDocument this.document, {
    super.key,
    this.controller,
    this.animation,
    this.stateMachine,
    this.skin,
    this.fit = BoxFit.contain,
    this.alignment = Alignment.center,
    this.interactive = true,
    this.scripts = true,
    this.audio = true,
    this.imageLoader,
    this.placeholder,
    this.onLoaded,
    this.onError,
  }) : source = null;

  final OpenBoneSource? source;
  final OpenBoneDocument? document;
  final OpenBoneController? controller;
  final String? animation, stateMachine, skin;
  final BoxFit fit;
  final Alignment alignment;
  final bool interactive;
  final bool scripts;

  /// Play the document's sounds (flutter_soloud). The audio commands also reach [OpenBoneController.audioCommands]
  /// either way; set false to play them yourself.
  final bool audio;

  /// Custom loading of texture bytes (default: data: URLs, then the asset bundle / file system next to the document).
  final OpenBoneImageBytesLoader? imageLoader;

  /// Shown while loading.
  final Widget? placeholder;
  final void Function(OpenBoneInstance instance)? onLoaded;
  final void Function(Object error)? onError;

  @override
  State<OpenBoneWidget> createState() => _OpenBoneWidgetState();
}

class _OpenBoneWidgetState extends State<OpenBoneWidget> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final _repaint = ValueNotifier<int>(0);
  final _renderer = OpenBoneRenderer();
  OpenBoneController? _ownController;
  OpenBoneDocument? _ownDocument;
  OpenBoneInstance? _instance;
  OpenBoneTextures? _textures;
  OpenBoneFonts? _fonts;
  OpenBoneAudio? _audio;
  StreamSubscription<OpenBoneAudioCommand>? _audioSub;
  OpenBoneDrawList? _drawList;
  Duration _last = Duration.zero;
  int _generation = 0;

  OpenBoneController get _controller => widget.controller ?? (_ownController ??= OpenBoneController());

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onController);
    _load();
  }

  @override
  void didUpdateWidget(OpenBoneWidget old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      (old.controller ?? _ownController)?.removeListener(_onController);
      _controller.addListener(_onController);
      (old.controller ?? _ownController)?.attach(null);
      _controller.attach(_instance);
    }
    final sourceChanged = old.document != widget.document || !_sameSource(old.source, widget.source);
    if (sourceChanged || old.scripts != widget.scripts) {
      _load();
    } else if (_instance != null &&
        (old.animation != widget.animation || old.stateMachine != widget.stateMachine || old.skin != widget.skin)) {
      _start(_instance!);
    }
  }

  static bool _sameSource(OpenBoneSource? a, OpenBoneSource? b) => switch ((a, b)) {
        (OpenBoneAssetSource x, OpenBoneAssetSource y) => x.key == y.key && x.bundle == y.bundle,
        (OpenBoneFileSource x, OpenBoneFileSource y) => x.path == y.path,
        _ => identical(a, b),
      };

  void _onController() {
    final playing = _controller.isPlaying && _instance != null;
    if (playing && !_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    } else if (!playing && _ticker.isActive) {
      _ticker.stop();
    }
    // State changed outside a tick (input set, animation started while paused): show the new pose.
    if (!_ticker.isActive) _refresh(0);
  }

  Future<void> _load() async {
    final gen = ++_generation;
    _release();
    try {
      final OpenBoneDocument doc;
      OpenBoneDocument? own;
      if (widget.document != null) {
        doc = widget.document!;
      } else {
        switch (widget.source!) {
          case OpenBoneAssetSource(:final key, :final bundle):
            final data = await (bundle ?? rootBundle).load(key);
            doc = own = OpenBoneDocument.bytes(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
          case OpenBoneFileSource(:final path):
            doc = own = OpenBoneDocument.bytes(await File(path).readAsBytes(), basePath: File(path).parent.path);
          case OpenBoneBytesSource(:final bytes, :final basePath):
            doc = own = OpenBoneDocument.bytes(bytes, basePath: basePath);
        }
      }
      final pendingFonts = OpenBoneFonts.load(doc, source: widget.source); // never throws: unreadable fonts are skipped
      final textures = await OpenBoneTextures.load(doc, source: widget.source, loader: widget.imageLoader);
      final fonts = await pendingFonts;
      if (!mounted || gen != _generation) {
        textures.dispose();
        own?.dispose();
        return;
      }
      final inst = doc.createInstance(scripts: widget.scripts);
      _ownDocument = own;
      _textures = textures;
      _fonts = fonts;
      _instance = inst;
      if (widget.audio) {
        // Subscribe before the first frame so sounds of the entry state aren't missed.
        final audio = _audio = OpenBoneAudio(doc, source: widget.source);
        _audioSub = inst.audioCommands.listen(audio.handle);
      }
      _start(inst);
      _controller.attach(inst);
      widget.onLoaded?.call(inst);
      _onController();
      setState(() {});
    } catch (e, st) {
      if (!mounted || gen != _generation) return;
      widget.onError?.call(e);
      if (widget.onError == null) {
        FlutterError.reportError(FlutterErrorDetails(exception: e, stack: st, library: 'openbone'));
      }
    }
  }

  void _start(OpenBoneInstance inst) {
    final doc = inst.document;
    if (widget.skin != null) inst.setSkin(widget.skin);
    if (widget.stateMachine != null) {
      inst.useStateMachine(widget.stateMachine);
    } else if (widget.animation != null) {
      inst.play(widget.animation!);
    } else if (doc.stateMachines.isNotEmpty) {
      inst.useStateMachine();
    } else if (doc.animations.isNotEmpty) {
      inst.play(doc.animations.first.name);
    }
    _refresh(0);
  }

  void _tick(Duration elapsed) {
    final dt = _last == Duration.zero ? 0.0 : (elapsed - _last).inMicroseconds / 1e6;
    _last = elapsed;
    // Clamp long frames (debugger, backgrounding) so physics does not explode.
    _refresh((dt * _controller.speed).clamp(0.0, 0.1));
  }

  void _refresh(double dt) {
    final inst = _instance;
    if (inst == null || inst.isDisposed) return;
    inst.advance(dt);
    _drawList = inst.drawList();
    _repaint.value++;
  }

  void _pointer(OpenBonePointerType type, Offset local) {
    final inst = _instance;
    final size = context.size;
    if (!widget.interactive || inst == null || inst.stateMachine == null || size == null) return;
    final (x, y) = OpenBoneViewTransform(inst.document, size, fit: widget.fit, alignment: widget.alignment).toSkeleton(local);
    inst.pointer(type, x, y);
  }

  void _release() {
    _ticker.stop();
    _controller.attach(null);
    _audioSub?.cancel();
    _audioSub = null;
    _audio?.dispose();
    _audio = null;
    _instance?.dispose();
    _instance = null;
    _textures?.dispose();
    _textures = null;
    _fonts = null;
    _ownDocument?.dispose();
    _ownDocument = null;
    _drawList = null;
  }

  @override
  void dispose() {
    _generation++;
    _controller.removeListener(_onController);
    _release();
    _ticker.dispose();
    _renderer.dispose();
    _repaint.dispose();
    _ownController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final inst = _instance;
    if (inst == null) return widget.placeholder ?? const SizedBox.expand();
    final paint = CustomPaint(
      size: Size.infinite,
      painter: _OpenBonePainter(this),
    );
    if (!widget.interactive) return paint;
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: (e) => _pointer(OpenBonePointerType.down, e.localPosition),
      onPointerMove: (e) => _pointer(OpenBonePointerType.move, e.localPosition),
      onPointerHover: (e) => _pointer(OpenBonePointerType.move, e.localPosition),
      onPointerUp: (e) => _pointer(OpenBonePointerType.up, e.localPosition),
      child: paint,
    );
  }
}

class _OpenBonePainter extends CustomPainter {
  _OpenBonePainter(this.state) : super(repaint: state._repaint);
  final _OpenBoneWidgetState state;

  @override
  void paint(Canvas canvas, Size size) {
    final inst = state._instance, list = state._drawList, textures = state._textures;
    if (inst == null || list == null || textures == null) return;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    OpenBoneViewTransform(inst.document, size, fit: state.widget.fit, alignment: state.widget.alignment).apply(canvas);
    state._renderer.draw(canvas, list, textures, fonts: state._fonts);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_OpenBonePainter old) => old.state != state;
}
