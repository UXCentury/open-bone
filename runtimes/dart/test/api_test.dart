// Dart API checks beyond the conformance suite: metadata, inputs, events, binary documents, disposal.
// SPDX-License-Identifier: MIT
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbone/openbone_core.dart';

import 'conformance_test.dart' show repoRoot;

void main() {
  late OpenBoneDocument doc;
  setUp(() => doc = OpenBoneDocument.file('$repoRoot/conformance/fixtures/interactive.obone'));
  tearDown(() => doc.dispose());

  test('document metadata', () {
    expect(OpenBoneNative.version, isNotEmpty);
    expect(doc.width, greaterThan(0));
    expect(doc.stateMachines, isNotEmpty);
    expect(doc.stateMachines.first.inputs.map((i) => i.type), contains(OpenBoneInputType.trigger));
    expect(doc.artboardToSkeleton(doc.originX, doc.originY), (0.0, 0.0));
  });

  test('inputs, state changes and draw list', () {
    final inst = doc.createInstance();
    final changes = <OpenBoneStateChange>[];
    inst.stateChanges.listen(changes.add);
    inst.useStateMachine();
    final number = doc.stateMachines.first.inputs.firstWhere((i) => i.type == OpenBoneInputType.number);
    inst.setNumber(number.name, 0.5);
    expect(inst.getInput(number.name), 0.5);
    inst.advance(0);
    for (var i = 0; i < 30; i++) {
      inst.advance(1 / 60);
    }
    expect(changes, isNotEmpty);
    expect(inst.activeStates, isNotEmpty);
    final list = inst.drawList();
    expect(list.items, isNotEmpty);
    expect(list.items.first.vertices.length, list.items.first.uvs.length);
    expect(inst.slots.length, greaterThan(0));
    expect(inst.findSlot(inst.slots.last.name), inst.slots.length - 1);
    expect(inst.findSlot('no such slot'), -1);
    expect(() => inst.setNumber('no such input', 1), throwsA(isA<OpenBoneException>()));
    inst.dispose();
    expect(inst.isDisposed, isTrue);
    expect(() => inst.advance(0), throwsStateError);
    inst.dispose(); // idempotent
  });

  test('animation events', () {
    final t = OpenBoneDocument.file('$repoRoot/conformance/fixtures/transforms.obone');
    final inst = t.createInstance();
    final events = <OpenBoneEvent>[];
    inst.events.listen(events.add);
    inst.play(t.animations.first.name);
    inst.advance(0);
    for (var i = 0; i < 120; i++) {
      inst.advance(1 / 60);
    }
    expect(events, isNotEmpty);
    inst.dispose();
    t.dispose();
  });

  test('binary .obonb loads from bytes', () {
    final bytes = File('$repoRoot/runtimes/cpp/tests/data/interactive.obonb').readAsBytesSync();
    final b = OpenBoneDocument.bytes(bytes);
    expect(b.stateMachines.length, doc.stateMachines.length);
    final inst = b.createInstance()..useStateMachine()..advance(0);
    expect(inst.bones.length, greaterThan(0));
    // Instances keep the native document alive: disposing the document first is safe.
    b.dispose();
    inst.advance(1 / 60);
    expect(inst.drawList().items, isNotEmpty);
    inst.dispose();
  });

  test('bad input reports the native error', () {
    expect(() => OpenBoneDocument.bytes(Uint8List.fromList([1, 2, 3])), throwsA(isA<OpenBoneException>()));
    expect(() => doc.createInstance().setSkin('nope'), throwsA(isA<OpenBoneException>()));
  });
}
