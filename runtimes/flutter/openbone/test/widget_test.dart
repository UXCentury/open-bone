// OpenBoneWidget rendering on the host (flutter_tester): loads examples/knight.obone with its PNGs, draws a frame and
// checks pixels; compares to a golden on Linux (`flutter test --update-goldens` regenerates it).
// SPDX-License-Identifier: MIT
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbone/openbone.dart';

import 'conformance_test.dart' show repoRoot;

Future<ui.Image> _capture(WidgetTester tester, GlobalKey key) async {
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  return (await tester.runAsync(() => boundary.toImage()))!;
}

Future<int> _opaquePixels(WidgetTester tester, ui.Image image) async {
  final data = (await tester.runAsync(() => image.toByteData(format: ui.ImageByteFormat.rawStraightRgba)))!;
  final px = data.buffer.asUint8List();
  var n = 0;
  for (var i = 3; i < px.length; i += 4) {
    if (px[i] > 200) n++;
  }
  return n;
}

Future<void> _pumpUntilLoaded(WidgetTester tester, OpenBoneController c) async {
  for (var i = 0; i < 100 && !c.isLoaded; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
  }
  expect(c.isLoaded, isTrue, reason: 'document did not load');
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('particle dot is white with straight alpha', (tester) async {
    final dot = (await tester.runAsync(OpenBoneTextures.particleDot))!;
    final data = (await tester.runAsync(() => dot.toByteData(format: ui.ImageByteFormat.rawStraightRgba)))!;
    final px = data.buffer.asUint8List();
    final centre = (32 * 64 + 32) * 4;
    expect(px.sublist(centre, centre + 4), [255, 255, 255, greaterThan(200)]);
    final mid = (32 * 64 + 50) * 4; // partly transparent, still white
    expect(px[mid + 3], inExclusiveRange(0, 255));
    expect(px[mid], greaterThan(250));
  });

  testWidgets('draws the knight and reacts to the controller', (tester) async {
    final controller = OpenBoneController();
    final key = GlobalKey();
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: RepaintBoundary(
          key: key,
          child: SizedBox(
            width: 320,
            height: 320,
            child: OpenBoneWidget.file('$repoRoot/examples/knight.obone', controller: controller, animation: 'idle'),
          ),
        ),
      ),
    ));
    await _pumpUntilLoaded(tester, controller);
    controller.pause(); // deterministic frame
    controller.play('idle');
    await tester.pump();
    final image = await _capture(tester, key);
    expect(image.width, 320);
    final opaque = await _opaquePixels(tester, image);
    expect(opaque, greaterThan(320 * 320 ~/ 20), reason: 'knight should cover a good part of the view');
    if (Platform.isLinux) {
      await expectLater(find.byKey(key), matchesGoldenFile('goldens/knight_idle.png'));
    }
    expect(controller.instance!.document.animations.map((a) => a.name), contains('walk'));
    await tester.pumpWidget(const SizedBox());
    expect(controller.isLoaded, isFalse);
    controller.dispose();
  });

  testWidgets('pointer input reaches the state machine', (tester) async {
    final controller = OpenBoneController();
    final states = <OpenBoneStateChange>[];
    controller.stateChanges.listen(states.add);
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: SizedBox(
          width: 400,
          height: 400,
          child: OpenBoneWidget.file('$repoRoot/examples/button.obone', controller: controller),
        ),
      ),
    ));
    await _pumpUntilLoaded(tester, controller);
    final inst = controller.instance!;
    expect(inst.stateMachine, isNotNull);
    // Press the button's centre: find it from the draw list bounds.
    final (minX, minY, maxX, maxY) = inst.bounds;
    final view = OpenBoneViewTransform(inst.document, const Size(400, 400));
    final centre = view.toLocal((minX + maxX) / 2, (minY + maxY) / 2);
    final gesture = await tester.startGesture(tester.getTopLeft(find.byType(OpenBoneWidget)) + centre);
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(states, isNotEmpty, reason: 'pressing the button should change state');
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  testWidgets('text draws with the document\'s embedded font', (tester) async {
    // Any TrueType file will do: it is registered under a family nothing has installed.
    final ttf = File('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    if (!ttf.existsSync()) {
      markTestSkipped('no DejaVuSans.ttf on this machine');
      return;
    }
    final src = 'data:font/ttf;base64,${base64Encode(ttf.readAsBytesSync())}';
    final json = '{"format":"openbone","version":1,"name":"fonts","width":10,"height":10,'
        '"fonts":[{"id":"f","name":"Check","family":"OpenBone Embedded Check","src":"$src"}],'
        '"skeleton":{"bones":[{"id":"b","name":"root","parent":null}],"slots":[],"skins":[]}}';
    final doc = OpenBoneDocument.bytes(Uint8List.fromList(utf8.encode(json)));
    expect(doc.fonts.single.family, 'OpenBone Embedded Check');
    final fonts = (await tester.runAsync(() => OpenBoneFonts.load(doc)))!;
    final families = fonts.families('Not Installed, openbone embedded check, sans-serif', 400);
    expect(families, hasLength(3));
    expect(families[0], 'Not Installed');
    expect(families[1], startsWith('openbone-font-'));
    expect(families[2], 'sans-serif');
    expect(fonts.families('Georgia, serif', 400), ['Georgia', 'serif']);
    // The test font draws every glyph as a size × size square; DejaVu Sans's "il" is far narrower.
    double width(List<String> list) {
      final p = TextPainter(
        text: TextSpan(
          text: 'il',
          style: TextStyle(fontFamily: list.first, fontFamilyFallback: list.sublist(1), fontSize: 20),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      final w = p.width;
      p.dispose();
      return w;
    }

    expect(width(['OpenBone Embedded Check']), 40);
    // The registered name draws with the embedded file. (flutter_tester resolves every unknown family to its test
    // font, so the engine skipping an uninstalled first family, as on devices, can't be shown here.)
    expect(width(fonts.families('openbone embedded check, sans-serif', 400)), lessThan(20));
    doc.dispose();
  });
}
