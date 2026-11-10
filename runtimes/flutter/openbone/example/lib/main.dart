// OpenBone Flutter example: pick a document, play its animations or drive its state machine (inputs, triggers,
// pointer), and watch events and audio commands. Assets are copies of examples/knight.obone and examples/button.obone.
//
//   flutter run -d linux        (or macos / windows / an Android or iOS device)
// SPDX-License-Identifier: MIT
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:openbone/openbone.dart';

/// `--dart-define=OPENBONE_SMOKE=true`: run headlessly for a few seconds, print a status line and exit
/// (used to check the desktop build under xvfb).
const bool smoke = bool.fromEnvironment('OPENBONE_SMOKE');

void main() => runApp(const OpenBoneExampleApp());

class OpenBoneExampleApp extends StatelessWidget {
  const OpenBoneExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'OpenBone',
        theme: ThemeData(colorSchemeSeed: const Color(0xFF6C5CE7), useMaterial3: true),
        home: const ExamplePage(),
      );
}

class ExamplePage extends StatefulWidget {
  const ExamplePage({super.key});

  @override
  State<ExamplePage> createState() => _ExamplePageState();
}

class _ExamplePageState extends State<ExamplePage> {
  static const documents = {
    'Knight (animations)': 'assets/openbone/knight.obone',
    'Button (state machine)': 'assets/openbone/button.obone',
  };

  String _document = documents.values.last;
  OpenBoneController _controller = OpenBoneController();
  final List<String> _log = [];
  final List<StreamSubscription<Object?>> _subs = [];
  OpenBoneInstance? _instance;

  @override
  void initState() {
    super.initState();
    _listen();
    if (smoke) _runSmoke();
  }

  void _listen() {
    for (final s in _subs) {
      s.cancel();
    }
    _subs
      ..clear()
      ..add(_controller.events.listen((e) => _add('event ${e.name}${e.stringValue.isEmpty ? '' : ' "${e.stringValue}"'}')))
      ..add(_controller.audioCommands.listen((c) => _add('audio ${c.type.name} ${c.sound.isEmpty ? c.id : c.sound}')))
      ..add(_controller.stateChanges.listen((s) => _add('state ${s.layer}: ${s.from} → ${s.to}')))
      ..add(_controller.logs.listen((l) => _add('${l.isError ? 'script error' : 'script'}: ${l.message}')));
  }

  void _add(String line) {
    if (!mounted) return;
    setState(() {
      _log.insert(0, line);
      if (_log.length > 60) _log.removeLast();
    });
  }

  void _select(String doc) {
    if (doc == _document) return;
    setState(() {
      _document = doc;
      _instance = null;
      _controller.dispose();
      _controller = OpenBoneController();
      _log.clear();
      _listen();
    });
  }

  Future<void> _runSmoke() async {
    final inst = await _controller.ready.timeout(const Duration(seconds: 20));
    await Future<void>.delayed(const Duration(seconds: 2));
    // Press the button through the state machine API and let it react.
    final sm = inst.document.stateMachines.first;
    if (sm.inputs.any((i) => i.name == 'press')) _controller.fire('press');
    await Future<void>.delayed(const Duration(seconds: 1));
    final items = inst.drawList().items.length;
    final line = 'OPENBONE_SMOKE ok library=${OpenBoneNative.version} scripts=${OpenBoneNative.hasScripts} '
        'items=$items states=${inst.activeStates} log=${_log.length}';
    stdout.writeln(line); // desktop terminals
    debugPrint(line); // Android logcat / iOS console
    await Future<void>.delayed(const Duration(milliseconds: 500));
    exit(items > 0 ? 0 : 1);
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final inst = _instance;
    return Scaffold(
      appBar: AppBar(
        title: const Text('OpenBone'),
        actions: [
          DropdownButton<String>(
            value: _document,
            underline: const SizedBox(),
            items: [for (final e in documents.entries) DropdownMenuItem(value: e.value, child: Text(e.key))],
            onChanged: (v) => _select(v!),
          ),
          IconButton(
            tooltip: _controller.isPlaying ? 'Pause' : 'Play',
            icon: Icon(_controller.isPlaying ? Icons.pause : Icons.play_arrow),
            onPressed: () => setState(() => _controller.isPlaying ? _controller.pause() : _controller.resume()),
          ),
        ],
      ),
      body: LayoutBuilder(builder: (context, box) {
        final wide = box.maxWidth > 760;
        final view = OpenBoneWidget.asset(
          _document,
          key: ValueKey(_document),
          controller: _controller,
          placeholder: const Center(child: CircularProgressIndicator()),
          onLoaded: (i) => setState(() => _instance = i),
          onError: (e) => _add('load error: $e'),
        );
        final side = inst == null ? const SizedBox() : _Controls(instance: inst, controller: _controller, log: _log);
        return wide
            ? Row(children: [Expanded(child: view), SizedBox(width: 320, child: side)])
            : Column(children: [Expanded(child: view), SizedBox(height: 300, child: side)]);
      }),
    );
  }
}

class _Controls extends StatefulWidget {
  const _Controls({required this.instance, required this.controller, required this.log});
  final OpenBoneInstance instance;
  final OpenBoneController controller;
  final List<String> log;

  @override
  State<_Controls> createState() => _ControlsState();
}

class _ControlsState extends State<_Controls> {
  @override
  Widget build(BuildContext context) {
    final doc = widget.instance.document;
    final c = widget.controller;
    final machine = widget.instance.stateMachine;
    final sm = doc.stateMachines.where((m) => m.name == machine).firstOrNull;
    final theme = Theme.of(context);
    return ListView(padding: const EdgeInsets.all(12), children: [
      Text('Animations', style: theme.textTheme.titleSmall),
      Wrap(spacing: 6, children: [
        for (final a in doc.animations)
          ActionChip(label: Text(a.name), onPressed: () => setState(() => c.play(a.name))),
      ]),
      if (doc.stateMachines.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('State machines', style: theme.textTheme.titleSmall),
        Wrap(spacing: 6, children: [
          for (final m in doc.stateMachines)
            ChoiceChip(
              label: Text(m.name),
              selected: m.name == machine,
              onSelected: (_) => setState(() => c.useStateMachine(m.name)),
            ),
        ]),
      ],
      if (sm != null) ...[
        const SizedBox(height: 8),
        Text('Inputs (or click / hover the artwork)', style: theme.textTheme.titleSmall),
        for (final input in sm.inputs) _input(input),
      ],
      if (doc.skins.length > 1) ...[
        const SizedBox(height: 8),
        Text('Skins', style: theme.textTheme.titleSmall),
        Wrap(spacing: 6, children: [
          for (final s in doc.skins) ActionChip(label: Text(s), onPressed: () => c.setSkin(s)),
        ]),
      ],
      const Divider(),
      Text('Events, audio commands, states', style: theme.textTheme.titleSmall),
      for (final l in widget.log) Text(l, style: theme.textTheme.bodySmall),
    ]);
  }

  Widget _input(OpenBoneInputInfo input) {
    final c = widget.controller;
    final value = c.getInput(input.name);
    return switch (input.type) {
      OpenBoneInputType.trigger =>
        Align(alignment: Alignment.centerLeft, child: FilledButton(onPressed: () => c.fire(input.name), child: Text(input.name))),
      OpenBoneInputType.boolean => SwitchListTile(
          dense: true,
          title: Text(input.name),
          value: value == true,
          onChanged: (v) => setState(() => c.setBool(input.name, v)),
        ),
      OpenBoneInputType.number => ListTile(
          dense: true,
          title: Text('${input.name}: ${(value is double ? value : 0.0).toStringAsFixed(2)}'),
          subtitle: Slider(
            value: (value is double ? value : 0.0).clamp(0, 1),
            onChanged: (v) => setState(() => c.setNumber(input.name, v)),
          ),
        ),
      OpenBoneInputType.string => TextField(
          decoration: InputDecoration(labelText: input.name),
          controller: TextEditingController(text: value as String? ?? ''),
          onSubmitted: (v) => setState(() => c.setString(input.name, v)),
        ),
    };
  }
}
