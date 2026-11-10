// Conformance: replays every case of conformance/expected/*.json (see conformance/README.md) through the Dart API
// (OpenBoneDocument / OpenBoneInstance over libopenbone) and compares each sample within the suite's tolerances.
//
//   tool/build_native.sh && flutter test test/conformance_test.dart
// SPDX-License-Identifier: MIT
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:openbone/openbone_core.dart';

const double dt = 1 / 60;
const int sampleEvery = 10;
const double slack = 5e-5 + 1e-9; // reference values are rounded to 4 decimals

final String repoRoot = _findRepoRoot();

String _findRepoRoot() {
  var dir = Directory.current.absolute;
  while (true) {
    if (Directory('${dir.path}/conformance/expected').existsSync()) return dir.path;
    final parent = dir.parent;
    if (parent.path == dir.path) throw StateError('conformance/expected not found above ${Directory.current.path}');
    dir = parent;
  }
}

double r4(num n) {
  final v = (n * 1e4 + 0.5).floorToDouble() / 1e4;
  return v == 0 ? 0 : v;
}

/// Records callbacks between samples, like the reference recorder.
/// Bounding-box queries of a file (conformance/README.md "Bounding-box queries"): the queries, and the other
/// skeleton per `queries.others` placement.
class BoundsProbe {
  BoundsProbe(OpenBoneDocument doc, this.q) {
    for (final xy in (q['others'] as List).cast<List>()) {
      // The same document in a second instance at the placement: setup pose, default skin.
      final o = doc.createInstance(scripts: true);
      o.setTransform(x: (xy[0] as num).toDouble(), y: (xy[1] as num).toDouble());
      o.advance(0);
      others.add(o.boundingBoxes());
      o.dispose(); // the snapshot outlives its instance
    }
  }

  final Map<String, dynamic> q;
  final List<OpenBoneSkeletonBounds> others = [];
  final List<String> errors = [];

  void dispose() {
    for (final o in others) {
      o.dispose();
    }
  }

  static List<double> _d(Object? list) => [for (final v in list as List) (v as num).toDouble()];

  Map<String, Object?> record(OpenBoneInstance inst) {
    final b = inst.boundingBoxes();
    try {
      List<int> idx(List<OpenBoneBoundingBox> l) => [for (final x in l) x.index];
      final aabb = b.aabb;
      return {
        'boxes': [
          for (final x in b.boxes) {'slot': x.slot, 'attachment': x.attachment, 'vertices': x.vertices},
        ],
        'aabb': aabb == null ? null : [aabb.$1, aabb.$2, aabb.$3, aabb.$4],
        'points': [
          for (final p in (q['points'] as List).map(_d))
            () {
              final all = b.containsPointAll(p[0], p[1]);
              if (b.containsPoint(p[0], p[1])?.index != (all.isEmpty ? null : all.first.index)) {
                errors.add('containsPoint disagrees with containsPointAll');
              }
              return idx(all);
            }(),
        ],
        'segments': [
          for (final s in (q['segments'] as List).map(_d))
            () {
              final all = b.intersectsSegmentAll(s[0], s[1], s[2], s[3]);
              if (b.intersectsSegment(s[0], s[1], s[2], s[3])?.index != (all.isEmpty ? null : all.first.index)) {
                errors.add('intersectsSegment disagrees with intersectsSegmentAll');
              }
              return idx(all);
            }(),
        ],
        'aabbs': [
          for (final a in (q['aabbs'] as List).map(_d)) b.aabbIntersects(a[0], a[1], a[2], a[3]),
        ],
        'others': [
          for (final o in others)
            () {
              final pair = b.intersectsBounds(o);
              return pair == null ? null : [pair.$1.index, pair.$2.index];
            }(),
        ],
      };
    } finally {
      b.dispose();
    }
  }
}

class Recorder {
  Recorder(OpenBoneInstance inst, [this.bounds]) {
    inst.events.listen((e) => events.add({
          'name': e.name,
          'time': r4(e.time),
          'int': e.intValue,
          'float': r4(e.floatValue),
          'string': e.stringValue,
        }));
    inst.audioCommands.listen((c) {
      if (c.type == OpenBoneAudioType.mix) {
        audio.add({'type': 'mix', 'bus': c.bus, 'muted': c.muted});
        return;
      }
      final id = ids.putIfAbsent(c.id, () => 'p${ids.length + 1}');
      audio.add(switch (c.type) {
        OpenBoneAudioType.play => {
            'type': 'play',
            'id': id,
            'sound': c.sound,
            'asset': c.asset,
            'bus': c.bus,
            'volume': r4(c.volume),
            'rate': r4(c.rate),
            'loop': c.loop,
            'fadeIn': r4(c.fadeIn),
            'source': c.source,
          },
        OpenBoneAudioType.stop => {'type': 'stop', 'id': id, 'fade': r4(c.fade)},
        OpenBoneAudioType.fade => {'type': 'fade', 'id': id, 'volume': r4(c.volume), 'duration': r4(c.duration)},
        OpenBoneAudioType.mix => const <String, Object?>{},
      });
    });
  }

  final BoundsProbe? bounds;
  List<Map<String, Object?>> events = [];
  List<Map<String, Object?>> audio = [];
  final Map<String, String> ids = {};

  Map<String, Object?> sample(OpenBoneInstance inst, double t, bool machine) {
    final drawList = inst.drawList();
    final clipsUsed = <int>[];
    final s = <String, Object?>{
      't': r4(t),
      'bones': [
        for (final b in inst.bones) [b.a, b.b, b.c, b.d, b.x, b.y],
      ],
      'slots': [
        for (final sl in inst.slots) [sl.attachment, sl.color, sl.dark],
      ],
      'draw': [
        for (final it in drawList.items)
          {
            'slot': it.slot,
            'attachment': it.attachment,
            'type': it.kind.name,
            'blend': it.blend.name,
            'texture': it.textureId,
            'vertices': it.vertices,
            'uvs': it.uvs,
            'indices': it.indices,
            'color': it.color,
            if (it.dark != null) 'dark': it.dark,
            if (it.colors != null) 'colors': it.colors,
            if (it.clip >= 0)
              'clip': () {
                var idx = clipsUsed.indexOf(it.clip);
                if (idx < 0) {
                  clipsUsed.add(it.clip);
                  idx = clipsUsed.length - 1;
                }
                return idx;
              }(),
            if (it.text != null) 'text': it.text!.content,
          },
      ],
      'events': events,
      'audio': audio,
      if (machine) 'states': inst.activeStates,
      if (bounds != null) 'bounds': bounds!.record(inst),
    };
    events = [];
    audio = [];
    return s;
  }
}

class Compare {
  final List<String> errors = [];
  static const int max = 12;

  void fail(String path, String what) {
    if (errors.length < max) {
      errors.add('$path: $what');
    } else if (errors.length == max) {
      errors.add('…');
    }
  }

  static String show(Object? o) {
    final s = jsonEncode(o, toEncodable: (x) => x is List ? x.toList() : x.toString());
    return s.length > 200 ? '${s.substring(0, 200)}…' : s;
  }

  void number(String path, Object? mine, Object? ref, double tol) {
    final mineNull = mine == null || (mine is num && mine.isNaN);
    if (ref == null) {
      if (!mineNull) fail(path, 'expected null/NaN, got ${show(mine)}');
      return;
    }
    if (mine is! num) return fail(path, 'expected ${show(ref)}, got ${show(mine)}');
    final a = mine.toDouble(), b = (ref as num).toDouble();
    if (!((a - b).abs() <= tol + slack)) {
      fail(path, '${a.toStringAsFixed(6)} vs reference ${b.toStringAsFixed(6)} (diff ${(a - b).abs().toStringAsExponential(2)})');
    }
  }

  void numbers(String path, Object? mine, Object? ref, double tol) {
    if (ref is! List || mine is! List || mine.length != ref.length) {
      return fail(path, 'length ${mine is List ? mine.length : show(mine)} vs reference ${ref is List ? ref.length : show(ref)}');
    }
    for (var i = 0; i < ref.length; i++) {
      number('$path[$i]', mine[i], ref[i], tol);
    }
  }

  void exact(String path, Object? mine, Object? ref) {
    if (!_deepEquals(mine, ref)) fail(path, '${show(mine)} vs reference ${show(ref)}');
  }

  static bool _deepEquals(Object? a, Object? b) {
    if (a is List && b is List) {
      if (a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!_deepEquals(a[i], b[i])) return false;
      }
      return true;
    }
    if (a is Map && b is Map) {
      if (a.length != b.length) return false;
      for (final k in b.keys) {
        if (!a.containsKey(k) || !_deepEquals(a[k], b[k])) return false;
      }
      return true;
    }
    if (a is num && b is num) return a == b;
    return a == b;
  }

  void sample(String p, Map<String, Object?> m, Map<String, dynamic> r) {
    number('$p.t', m['t'], r['t'], 1e-9);
    final mb = m['bones'] as List, rb = r['bones'] as List;
    if (mb.length != rb.length) {
      fail('$p.bones', 'count ${mb.length} vs ${rb.length}');
    } else {
      for (var i = 0; i < rb.length; i++) {
        for (var k = 0; k < 6; k++) {
          number('$p.bones[$i][$k]', (mb[i] as List)[k], (rb[i] as List)[k], k < 4 ? 1e-4 : 1e-3);
        }
      }
    }
    final ms = m['slots'] as List, rs = r['slots'] as List;
    if (ms.length != rs.length) {
      fail('$p.slots', 'count ${ms.length} vs ${rs.length}');
    } else {
      for (var i = 0; i < rs.length; i++) {
        final q = '$p.slots[$i]';
        final mi = ms[i] as List, ri = rs[i] as List;
        exact('$q.attachment', mi[0], ri[0]);
        numbers('$q.color', mi[1], ri[1], 1 / 255);
        if (ri[2] == null || mi[2] == null) {
          exact('$q.dark', mi[2] == null ? null : 'set', ri[2] == null ? null : 'set');
        } else {
          numbers('$q.dark', mi[2], ri[2], 1 / 255);
        }
      }
    }
    final md = m['draw'] as List, rd = r['draw'] as List;
    if (md.length != rd.length) {
      fail('$p.draw', 'count ${md.length} vs ${rd.length} [${md.map((x) => x['slot']).join(' ')}] vs [${rd.map((x) => x['slot']).join(' ')}]');
    } else {
      for (var i = 0; i < rd.length; i++) {
        final x = md[i] as Map<String, Object?>, y = rd[i] as Map<String, dynamic>;
        final q = '$p.draw[$i](${y['slot']})';
        for (final k in ['slot', 'attachment', 'type', 'blend', 'texture']) {
          exact('$q.$k', x[k], y[k]);
        }
        final particles = y['type'] == 'particles';
        numbers('$q.vertices', x['vertices'], y['vertices'], particles ? 1e-2 : 1e-3);
        numbers('$q.uvs', x['uvs'], y['uvs'], 1e-3);
        exact('$q.indices', x['indices'], y['indices']);
        numbers('$q.color', x['color'], y['color'], 1 / 255);
        for (final k in ['dark', 'colors']) {
          if (y.containsKey(k) != x.containsKey(k)) {
            fail('$q.$k', x.containsKey(k) ? 'unexpected' : 'missing');
          } else if (y.containsKey(k)) {
            numbers('$q.$k', x[k], y[k], 1 / 255);
          }
        }
        exact('$q.clip', x['clip'], y['clip']);
        exact('$q.text', x['text'], y['text']);
      }
    }
    final me = m['events'] as List, re = r['events'] as List;
    if (me.length != re.length) {
      fail('$p.events', '${show(me)} vs reference ${show(re)}');
    } else {
      for (var i = 0; i < re.length; i++) {
        final q = '$p.events[$i]';
        exact('$q.name', me[i]['name'], re[i]['name']);
        exact('$q.string', me[i]['string'], re[i]['string']);
        number('$q.time', me[i]['time'], re[i]['time'], 1e-4);
        number('$q.int', me[i]['int'], re[i]['int'], 1e-9);
        number('$q.float', me[i]['float'], re[i]['float'], 1e-4);
      }
    }
    final ma = m['audio'] as List, ra = r['audio'] as List;
    if (ma.length != ra.length) {
      fail('$p.audio', '${show(ma)} vs reference ${show(ra)}');
    } else {
      for (var i = 0; i < ra.length; i++) {
        final q = '$p.audio[$i]';
        final mi = ma[i] as Map, ri = ra[i] as Map;
        for (final e in ri.entries) {
          if (e.value is num) {
            number('$q.${e.key}', mi[e.key], e.value, 1e-4);
          } else {
            exact('$q.${e.key}', mi[e.key], e.value);
          }
        }
        if (mi.length != ri.length) fail(q, '${show(mi)} vs reference ${show(ri)}');
      }
    }
    if (r.containsKey('bounds') != m.containsKey('bounds')) {
      fail('$p.bounds', m.containsKey('bounds') ? 'unexpected' : 'missing');
    } else if (r.containsKey('bounds')) {
      final mb = m['bounds'] as Map<String, Object?>, rb = r['bounds'] as Map<String, dynamic>;
      final mx = mb['boxes'] as List, rx = rb['boxes'] as List;
      if (mx.length != rx.length) {
        fail('$p.bounds.boxes', '${show(mx)} vs reference ${show(rx)}');
      } else {
        for (var i = 0; i < rx.length; i++) {
          final q = '$p.bounds.boxes[$i]';
          exact('$q.slot', mx[i]['slot'], rx[i]['slot']);
          exact('$q.attachment', mx[i]['attachment'], rx[i]['attachment']);
          numbers('$q.vertices', mx[i]['vertices'], rx[i]['vertices'], 1e-3);
        }
      }
      if (rb['aabb'] == null || mb['aabb'] == null) {
        exact('$p.bounds.aabb', mb['aabb'], rb['aabb']);
      } else {
        numbers('$p.bounds.aabb', mb['aabb'], rb['aabb'], 1e-3);
      }
      for (final k in ['points', 'segments', 'aabbs', 'others']) {
        exact('$p.bounds.$k', mb[k], rb[k]);
      }
    }
    if (r.containsKey('states') || m.containsKey('states')) exact('$p.states', m['states'], r['states']);
  }
}

List<Map<String, Object?>> runCase(OpenBoneDocument doc, Map<String, dynamic> c, [BoundsProbe? bounds]) {
  final kind = c['kind'] as String;
  final duration = (c['duration'] as num).toDouble();
  final steps = (duration / dt).round();
  final inst = doc.createInstance(scripts: true);
  try {
    final rec = Recorder(inst, bounds);
    if (kind != 'stateMachine' && c['skin'] is String) inst.setSkin(c['skin'] as String);
    if (kind == 'animation') inst.play(c['animation'] as String, loop: true);
    final machine = kind == 'stateMachine';
    if (machine) inst.useStateMachine(c['stateMachine'] as String);
    final out = <Map<String, Object?>>[];
    inst.advance(0);
    out.add(rec.sample(inst, 0, machine));
    final actions = (c['actions'] as List?) ?? const [];
    for (var i = 1; i <= steps; i++) {
      final t = (i - 1) * dt;
      for (final a in actions.cast<Map<String, dynamic>>()) {
        if (((a['t'] as num) - t).abs() > dt / 2) continue;
        try {
          if (a.containsKey('fire')) {
            inst.fire(a['fire'] as String);
          } else if (a.containsKey('input')) {
            inst.setInput(a['input'] as String, a['value'] as Object);
          } else {
            final type = switch (a['pointer']) {
              'down' => OpenBonePointerType.down,
              'up' => OpenBonePointerType.up,
              _ => OpenBonePointerType.move,
            };
            inst.pointer(type, (a['x'] as num).toDouble(), (a['y'] as num).toDouble());
          }
        } on OpenBoneException catch (e) {
          // The reference runner logs failed actions and carries on.
          stderr.writeln('  action failed: ${e.message}');
        }
      }
      inst.advance(dt);
      if (i % sampleEvery == 0) out.add(rec.sample(inst, i * dt, machine));
    }
    return out;
  } finally {
    inst.dispose();
  }
}

void main() {
  final files = Directory('$repoRoot/conformance/expected')
      .listSync()
      .whereType<File>()
      .where((f) => f.path.endsWith('.json'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  test('library loads', () {
    expect(OpenBoneNative.apiVersion, 1);
    expect(OpenBoneNative.hasScripts, isTrue, reason: 'conformance needs the QuickJS script host');
  });

  var total = 0;
  for (final file in files) {
    final expected = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final fixture = expected['fixture'] as String;
    final cases = (expected['cases'] as List).cast<Map<String, dynamic>>();
    total += cases.length;
    group(fixture, () {
      late OpenBoneDocument doc;
      BoundsProbe? bounds;
      setUpAll(() {
        doc = OpenBoneDocument.file('$repoRoot/${expected['document']}');
        if (expected['queries'] != null) bounds = BoundsProbe(doc, expected['queries'] as Map<String, dynamic>);
      });
      tearDownAll(() {
        bounds?.dispose();
        doc.dispose();
      });
      for (final c in cases) {
        test(c['name'] as String, () {
          bounds?.errors.clear();
          final mine = runCase(doc, c, bounds);
          final ref = (c['samples'] as List).cast<Map<String, dynamic>>();
          final cmp = Compare();
          if (mine.length != ref.length) cmp.fail('samples', 'count ${mine.length} vs ${ref.length}');
          for (final e in bounds?.errors ?? const <String>[]) {
            cmp.fail('bounds', e);
          }
          for (var i = 0; i < math.min(mine.length, ref.length); i++) {
            cmp.sample('t=${(ref[i]['t'] as num).toStringAsFixed(4)}', mine[i], ref[i]);
          }
          if (cmp.errors.isNotEmpty) fail('${cmp.errors.length} mismatches:\n  ${cmp.errors.join('\n  ')}');
        });
      }
    });
  }

  test('suite has 22 files / 100 cases', () {
    expect(files.length, 22);
    expect(total, 100);
  });
}
