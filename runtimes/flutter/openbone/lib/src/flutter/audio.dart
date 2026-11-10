// Sound playback for OpenBone documents: plays the runtime's audio commands (play, stop, fade) with flutter_soloud.
// SPDX-License-Identifier: MIT
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_soloud/flutter_soloud.dart';

import '../document.dart';
import '../types.dart';
import 'textures.dart';

/// Plays a document's audio commands: each sound file is loaded once (from where the document came from, like its
/// images), and voices follow the command's volume × bus × master, rate, looping, fade-in, stop fades and fades.
///
/// [OpenBoneWidget] creates one when `audio` is true; use it directly with an [OpenBoneInstance] of your own:
/// `instance.audioCommands.listen(audio.handle)`.
class OpenBoneAudio {
  OpenBoneAudio(this.document, {this.source, this.volume = 1});

  final OpenBoneDocument document;
  final OpenBoneSource? source;

  /// Extra gain on everything this player plays.
  double volume;

  final Map<String, Future<AudioSource?>> _sources = {};
  final Map<String, SoundHandle> _voices = {};
  final Map<String, String?> _voiceBus = {};
  final Set<String> _loading = {}, _cancelled = {};
  bool _disposed = false;

  static Future<void>? _init;

  /// Starts the audio engine once per app (also done on the first command).
  static Future<void> ensureInitialized() {
    final s = SoLoud.instance;
    if (s.isInitialized) return Future.value();
    return _init ??= s.init().catchError((Object e) {
      _init = null;
      debugPrint('OpenBone: audio unavailable ($e)');
    });
  }

  double _busGain(String? busId) {
    var gain = document.audioMaster * volume;
    if (busId != null) {
      for (final b in document.audioBuses) {
        if (b.id == busId) gain *= b.muted ? 0 : b.volume;
      }
    }
    return gain;
  }

  Future<AudioSource?> _sourceFor(String assetId) => _sources[assetId] ??= () async {
        OpenBoneAudioAsset? asset;
        for (final a in document.audioAssets) {
          if (a.id == assetId) asset = a;
        }
        if (asset == null) return null;
        try {
          final bytes = await openBoneSourceBytes(asset.src, document, source);
          if (bytes == null || _disposed) return null;
          await ensureInitialized();
          if (!SoLoud.instance.isInitialized) return null;
          return await SoLoud.instance.loadMem('openbone/${document.hashCode}/${asset.id}', bytes);
        } catch (e) {
          debugPrint('OpenBone: cannot load sound "${asset.name}" (${asset.src}): $e');
          return null;
        }
      }();

  /// Handles one audio command (subscribe this to `instance.audioCommands`).
  Future<void> handle(OpenBoneAudioCommand c) async {
    if (_disposed) return;
    switch (c.type) {
      case OpenBoneAudioType.play:
        _loading.add(c.id);
        final src = await _sourceFor(c.asset);
        _loading.remove(c.id);
        // Stopped while its sound was still loading: don't start it late.
        if (_cancelled.remove(c.id) || src == null || _disposed) return;
        final s = SoLoud.instance;
        final target = c.volume * _busGain(c.bus);
        final h = s.play(src, volume: c.fadeIn > 0 ? 0 : target, looping: c.loop);
        if (c.rate != 1) s.setRelativePlaySpeed(h, c.rate <= 0 ? 0.01 : c.rate);
        if (c.fadeIn > 0) s.fadeVolume(h, target, _seconds(c.fadeIn));
        _voices[c.id] = h;
        _voiceBus[c.id] = c.bus;
      case OpenBoneAudioType.stop:
        if (_loading.contains(c.id)) _cancelled.add(c.id);
        final h = _voices.remove(c.id);
        _voiceBus.remove(c.id);
        if (h == null || !SoLoud.instance.isInitialized) return;
        if (c.fade > 0) {
          SoLoud.instance.fadeVolume(h, 0, _seconds(c.fade));
          SoLoud.instance.scheduleStop(h, _seconds(c.fade));
        } else {
          await SoLoud.instance.stop(h);
        }
      case OpenBoneAudioType.fade:
        final h = _voices[c.id];
        if (h == null || !SoLoud.instance.isInitialized) return;
        SoLoud.instance.fadeVolume(h, c.volume * _busGain(_voiceBus[c.id]), _seconds(c.duration));
    }
  }

  /// Stops every voice this player started.
  Future<void> stopAll() async {
    final handles = _voices.values.toList();
    _voices.clear();
    _voiceBus.clear();
    if (!SoLoud.instance.isInitialized) return;
    for (final h in handles) {
      await SoLoud.instance.stop(h);
    }
  }

  /// Stops all voices and frees the loaded sounds.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await stopAll();
    final sources = _sources.values.toList();
    _sources.clear();
    for (final f in sources) {
      final s = await f;
      if (s != null && SoLoud.instance.isInitialized) await SoLoud.instance.disposeSource(s);
    }
  }

  static Duration _seconds(double s) => Duration(microseconds: (s * 1e6).round());
}
