import { safeName } from "./engines.ts";
import { createZip } from "./zip.ts";

/**
 * Interactive WebView packages: the self-contained player bundle + an HTML page with the document embedded,
 * wrapped in small native templates (Flutter webview_flutter, Android WebView, iOS WKWebView) that talk to the
 * page through the OpenBone JS bridge (`OpenBone.receive(command)` in, JSON messages out).
 */

export type WebViewPlatform = "flutter" | "android" | "ios";

export interface WebViewPage {
  title: string;
  /** The exported .obone (JSON) or .obonb (binary) bytes, images embedded. */
  doc: Uint8Array;
  stateMachine?: string;
  animation?: string;
  /** CSS colour, or null for transparent (the default, so native backgrounds show through). */
  background?: string | null;
  fit?: "contain" | "cover" | "none";
  /** Script file name next to the page. Default `openbone-player.js`. */
  bundleFile?: string;
}

export const BUNDLE_FILE = "openbone-player.js";

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The page the WebView loads: full-window canvas, document embedded as base64, bundle loaded as a classic script. */
export function webViewHtml(p: WebViewPage): string {
  const data: string[] = [];
  if (p.stateMachine) data.push(`data-state-machine="${escAttr(p.stateMachine)}"`);
  if (p.animation) data.push(`data-animation="${escAttr(p.animation)}"`);
  data.push(`data-background="${escAttr(p.background ?? "none")}"`);
  if (p.fit) data.push(`data-fit="${p.fit}"`);
  const b64 = toBase64(p.doc).replace(/.{1,120}/g, "$&\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${escText(p.title)}</title>
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
canvas#openbone { display: block; width: 100vw; height: 100vh; touch-action: none; }
</style>
</head>
<body ${data.join(" ")}>
<canvas id="openbone"></canvas>
<!-- The animation (.obone/.obonb bytes, base64). Replace it to swap the animation without rebuilding the app. -->
<script type="application/octet-stream" id="openbone-data">
${b64}</script>
<!-- Player + bridge. Host API: OpenBone.receive({type:"setInput"|"fire"|"play"|"pause"|"setSkin", ...}). -->
<script src="${escAttr(p.bundleFile ?? BUNDLE_FILE)}"></script>
</body>
</html>
`;
}

/** A browser page that embeds index.html in an iframe and builds controls for its inputs, using the bridge. */
export function previewHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escText(title)}: bridge preview</title>
<style>
:root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
body { margin: 0; padding: 16px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); max-width: 900px; }
iframe { width: 100%; height: 60vh; border: 1px solid #8884; border-radius: 8px; background: #8881; }
#controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
#log { font: 12px ui-monospace, monospace; max-height: 30vh; overflow: auto; margin: 0; padding: 8px; background: #8882; border-radius: 6px; }
</style>
</head>
<body>
<h1>${escText(title)}</h1>
<p>This page drives <code>index.html</code> through the same JS bridge the native apps use (here via <code>postMessage</code>).</p>
<iframe id="view" src="index.html" title="${escAttr(title)}"></iframe>
<div id="controls"></div>
<pre id="log"></pre>
<script>
const view = document.getElementById("view");
const controls = document.getElementById("controls");
const log = (s) => { const el = document.getElementById("log"); el.textContent = s + "\\n" + el.textContent.slice(0, 4000); };
const send = (cmd) => { view.contentWindow.postMessage({ openbone: cmd }, "*"); log("→ " + JSON.stringify(cmd)); };
const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.source !== "openbone") return;
  log("← " + JSON.stringify(m));
  if (m.type !== "ready") return;
  controls.replaceChildren();
  for (const i of m.inputs) {
    if (i.type === "trigger") controls.append(el("button", { textContent: i.name, onclick: () => send({ type: "fire", name: i.name }) }));
    else if (i.type === "bool") {
      const box = el("input", { type: "checkbox", checked: !!i.value, onchange: () => send({ type: "setInput", name: i.name, value: box.checked }) });
      controls.append(el("label", {}, box, " " + i.name));
    } else if (i.type === "string") {
      const text = el("input", { type: "text", value: i.value ?? "", oninput: () => send({ type: "setInput", name: i.name, value: text.value }) });
      controls.append(el("label", {}, i.name + " ", text));
    } else {
      const range = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: i.value ?? 0, oninput: () => send({ type: "setInput", name: i.name, value: Number(range.value) }) });
      controls.append(el("label", {}, i.name + " ", range));
    }
  }
  if (m.animations.length) {
    const sel = el("select", { onchange: () => send(sel.value ? { type: "play", animation: sel.value } : { type: "useStateMachine" }) });
    if (m.stateMachines.length) sel.append(new Option("State machine", ""));
    for (const a of m.animations) sel.append(new Option("Play " + a, a));
    controls.append(sel);
  }
});
</script>
</body>
</html>
`;
}

export interface WebViewPackOptions extends WebViewPage {
  /** Base name of the files (sanitised). */
  name: string;
  /** File extension of `doc`: "obone" or "obonb". */
  docExt: "obone" | "obonb";
  /** The player bundle source (see `pnpm build:player-bundle`). */
  bundle: string;
  /** Inputs of the chosen state machine, used for the README and examples. */
  inputs?: { name: string; type: "bool" | "number" | "trigger" | "string" }[];
  /** Android package for the Kotlin class. Default `com.openbone`. */
  androidPackage?: string;
}

const enc = (s: string) => new TextEncoder().encode(s);

/** The files of one WebView package (paths relative to the package folder). */
export function webViewPackFiles(platform: WebViewPlatform, o: WebViewPackOptions): { name: string; data: Uint8Array }[] {
  const base = safeName(o.name);
  const web = (dir: string) => [
    { name: `${dir}/index.html`, data: enc(webViewHtml(o)) },
    { name: `${dir}/${o.bundleFile ?? BUNDLE_FILE}`, data: enc(o.bundle) },
    { name: `${dir}/${base}.${o.docExt}`, data: o.doc },
    { name: `${dir}/preview.html`, data: enc(previewHtml(o.title)) },
  ];
  const ctx: TemplateContext = { base, title: o.title, inputs: o.inputs ?? [], stateMachine: o.stateMachine, pkg: o.androidPackage ?? "com.openbone" };
  switch (platform) {
    case "flutter":
      return [
        ...web(`assets/openbone/${base}`),
        { name: "lib/openbone_view.dart", data: enc(FLUTTER_VIEW_DART) },
        { name: "example/main.dart", data: enc(flutterExample(ctx)) },
        { name: "README.md", data: enc(flutterWebReadme(ctx)) },
      ];
    case "android": {
      const pkgPath = ctx.pkg.replace(/\./g, "/");
      return [
        ...web(`app/src/main/assets/openbone/${base}`),
        { name: `app/src/main/java/${pkgPath}/OpenBoneView.kt`, data: enc(androidView(ctx.pkg)) },
        { name: `app/src/main/java/${pkgPath}/example/OpenBoneExampleActivity.kt`, data: enc(androidExample(ctx)) },
        { name: "README.md", data: enc(androidReadme(ctx)) },
      ];
    }
    case "ios":
      return [
        ...web(`OpenBone/${base}`),
        { name: "Sources/OpenBoneView.swift", data: enc(IOS_VIEW_SWIFT) },
        { name: "Sources/OpenBoneExample.swift", data: enc(iosExample(ctx)) },
        { name: "README.md", data: enc(iosReadme(ctx)) },
      ];
  }
}

/** A WebView package as a ZIP with everything inside a `<name>/` folder. */
export function webViewPackZip(platform: WebViewPlatform, o: WebViewPackOptions): Uint8Array {
  const root = safeName(o.name);
  return createZip(webViewPackFiles(platform, o).map((f) => ({ name: `${root}/${f.name}`, data: f.data })));
}

// ---------------------------------------------------------------------------------------------------------------
// Templates

interface TemplateContext {
  base: string;
  title: string;
  inputs: { name: string; type: "bool" | "number" | "trigger" | "string" }[];
  stateMachine?: string;
  pkg: string;
}

const BRIDGE_DOC = `## The bridge

The page exposes \`window.OpenBone\`. The native classes call \`OpenBone.receive(command)\` with one of:

| Command | Fields |
| --- | --- |
| \`setInput\` | \`name\`, \`value\` (bool, number or string) |
| \`fire\` | \`name\` (trigger input) |
| \`play\` | \`animation\` (optional; switches from the state machine to that animation), \`loop\` |
| \`pause\` | |
| \`setSkin\` | \`name\` (or null for the default skin) |
| \`useStateMachine\` | \`name\` (optional; back to a state machine after \`play\`) |
| \`getInputs\` | replies with an \`inputs\` message |

The page posts JSON strings back (\`{"source":"openbone","v":1,"type":...}\`):

| Message | Fields |
| --- | --- |
| \`ready\` | \`animations\`, \`stateMachines\`, \`inputs\` (\`name\`, \`type\`, \`value\`), \`skins\`, \`width\`, \`height\` |
| \`event\` | \`name\`, \`int\`, \`float\`, \`string\`, \`time\` (events keyed in animations, listeners or scripts) |
| \`stateChange\` | \`layer\`, \`from\`, \`to\` |
| \`inputs\` | current input values (sent when an input changes, e.g. from a pointer listener or script) |
| \`error\` | \`message\` |

Commands sent before \`ready\` are queued by the native classes. Pointer and touch input on the view go straight to
the state machine's listeners, and scripts run in the bundled QuickJS sandbox.

## Files in \`openbone/\`

- \`index.html\`: the page (the animation is embedded in it as base64; to swap animations, re-export or replace that block).
- \`openbone-player.js\`: the OpenBone player, renderers, runtime and QuickJS (WASM inlined). Works offline, no network.
- the \`.obone\`/\`.obonb\` file: the same animation as a separate file, for reference or for loading with \`?src=\`.
- \`preview.html\`: open in a desktop browser to try the inputs through the bridge (served over http, e.g.
  \`npx serve\` in that folder; some browsers block iframes on file://).
`;

const inputLines = (c: TemplateContext, fmt: (i: TemplateContext["inputs"][number]) => string) =>
  c.inputs.length ? c.inputs.map(fmt).join("\n") : "";

const inputsTable = (c: TemplateContext) =>
  c.inputs.length
    ? `Inputs of ${c.stateMachine ? `the "${c.stateMachine}"` : "the default"} state machine:\n\n| Input | Type |\n| --- | --- |\n${c.inputs.map((i) => `| ${i.name} | ${i.type} |`).join("\n")}\n`
    : "This export has no state machine inputs; you can still play animations and receive events.\n";

const NOT_COMPILED = (tool: string) =>
  `> Not compiled here: this package was generated without a ${tool} toolchain. The code is small and written against the
> current public APIs, but please treat it as a starting point and report anything that does not build.`;

// ---- Flutter ----

const FLUTTER_VIEW_DART = `// OpenBone WebView widget for Flutter. MIT licensed, generated by OpenBone.
// Needs webview_flutter: ^4.4.0 in pubspec.yaml.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// A message from the animation: type is ready, event, stateChange, inputs or error.
class OpenBoneMessage {
  OpenBoneMessage(this.type, this.data);
  final String type;
  final Map<String, dynamic> data;

  @override
  String toString() => 'OpenBoneMessage(\$type, \$data)';
}

/// Loads an exported OpenBone WebView asset folder and sends commands to it.
class OpenBoneController {
  OpenBoneController({required String asset, Color background = const Color(0x00000000)}) {
    webView = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(background)
      ..addJavaScriptChannel('OpenBoneHost', onMessageReceived: (m) => _onMessage(m.message))
      ..loadFlutterAsset(asset);
  }

  late final WebViewController webView;
  final _messages = StreamController<OpenBoneMessage>.broadcast();
  final _pending = <Map<String, Object?>>[];
  bool _ready = false;
  Map<String, dynamic>? _info;

  /// Every message from the page.
  Stream<OpenBoneMessage> get messages => _messages.stream;

  /// Only animation events (keyed events, listener and script events).
  Stream<OpenBoneMessage> get events => messages.where((m) => m.type == 'event');

  /// The ready message (animations, stateMachines, inputs, skins), once loaded.
  Map<String, dynamic>? get info => _info;
  bool get isReady => _ready;

  Future<void> setBool(String name, bool value) => send({'type': 'setInput', 'name': name, 'value': value});
  Future<void> setNumber(String name, num value) => send({'type': 'setInput', 'name': name, 'value': value});
  Future<void> setString(String name, String value) => send({'type': 'setInput', 'name': name, 'value': value});
  Future<void> fire(String name) => send({'type': 'fire', 'name': name});
  Future<void> play({String? animation, bool loop = true}) =>
      send({'type': 'play', if (animation != null) 'animation': animation, 'loop': loop});
  Future<void> pause() => send({'type': 'pause'});
  Future<void> setSkin(String? name) => send({'type': 'setSkin', 'name': name});
  Future<void> useStateMachine([String? name]) => send({'type': 'useStateMachine', if (name != null) 'name': name});

  /// Send any bridge command; queued until the page is ready.
  Future<void> send(Map<String, Object?> command) async {
    if (!_ready) {
      _pending.add(command);
      return;
    }
    await webView.runJavaScript('OpenBone.receive(\${jsonEncode(command)})');
  }

  void _onMessage(String json) {
    final Object? decoded;
    try {
      decoded = jsonDecode(json);
    } on FormatException {
      return;
    }
    if (decoded is! Map<String, dynamic> || decoded['source'] != 'openbone') return;
    final type = decoded['type'] as String;
    if (type == 'ready') {
      _ready = true;
      _info = decoded;
      final queued = List.of(_pending);
      _pending.clear();
      for (final c in queued) {
        send(c);
      }
    }
    _messages.add(OpenBoneMessage(type, decoded));
  }

  void dispose() => _messages.close();
}

/// Shows an OpenBone animation. Pointer/touch input goes to its state machine.
class OpenBoneView extends StatelessWidget {
  const OpenBoneView({super.key, required this.controller});
  final OpenBoneController controller;

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: controller.webView);
}
`;

function flutterExample(c: TemplateContext) {
  const controls = inputLines(c, (i) =>
    i.type === "trigger"
      ? `            ElevatedButton(onPressed: () => controller.fire('${i.name}'), child: const Text('${i.name}')),`
      : i.type === "bool"
        ? `            ElevatedButton(onPressed: () => controller.setBool('${i.name}', true), child: const Text('${i.name} on')),`
        : i.type === "string"
          ? `            ElevatedButton(onPressed: () => controller.setString('${i.name}', 'Hello'), child: const Text('${i.name} = Hello')),`
          : `            ElevatedButton(onPressed: () => controller.setNumber('${i.name}', 1), child: const Text('${i.name} = 1')),`,
  );
  return `// Example: show the "${c.title}" animation with buttons for its inputs.
import 'package:flutter/material.dart';

import '../lib/openbone_view.dart'; // in your app: import 'openbone_view.dart';

void main() => runApp(const MaterialApp(home: OpenBoneExample()));

class OpenBoneExample extends StatefulWidget {
  const OpenBoneExample({super.key});

  @override
  State<OpenBoneExample> createState() => _OpenBoneExampleState();
}

class _OpenBoneExampleState extends State<OpenBoneExample> {
  final controller = OpenBoneController(asset: 'assets/openbone/${c.base}/index.html');
  String last = '';

  @override
  void initState() {
    super.initState();
    controller.messages.listen((m) => setState(() => last = '\${m.type} \${m.data['name'] ?? m.data['to'] ?? ''}'));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${c.title.replace(/'/g, "\\'")}')),
      body: Column(
        children: [
          Expanded(child: OpenBoneView(controller: controller)),
          Wrap(
            spacing: 8,
            children: [
${controls}
            ],
          ),
          Padding(padding: const EdgeInsets.all(8), child: Text(last)),
        ],
      ),
    );
  }
}
`;
}

function flutterWebReadme(c: TemplateContext) {
  return `# ${c.title}: Flutter (interactive WebView)

Plays the OpenBone animation with its state machine, inputs, scripts and touch interaction, by embedding the
OpenBone web player in [webview_flutter](https://pub.dev/packages/webview_flutter) (Android and iOS).

${inputsTable(c)}
## Install

1. Add the dependency and the asset folder to \`pubspec.yaml\`:

\`\`\`yaml
dependencies:
  webview_flutter: ^4.4.0

flutter:
  assets:
    - assets/openbone/${c.base}/
\`\`\`

2. Copy \`assets/openbone/${c.base}/\` into your app's \`assets/\` and \`lib/openbone_view.dart\` into \`lib/\`.
3. Use it:

\`\`\`dart
final controller = OpenBoneController(asset: 'assets/openbone/${c.base}/index.html');

OpenBoneView(controller: controller);           // in build()
${c.inputs.find((i) => i.type === "trigger") ? `controller.fire('${c.inputs.find((i) => i.type === "trigger")!.name}');` : "controller.play(animation: 'idle');"}
controller.events.listen((e) => print(e.data['name']));
\`\`\`

\`example/main.dart\` is a complete screen with a button per input.

Android needs \`minSdkVersion 19\` or newer (webview_flutter's minimum may be higher); no internet permission is needed.

${BRIDGE_DOC}
${NOT_COMPILED("Flutter")}
`;
}

// ---- Android ----

function androidView(pkg: string) {
  return `// OpenBone WebView for Android. MIT licensed, generated by OpenBone.
package ${pkg}

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * Shows an exported OpenBone animation from app/src/main/assets/<folder>/index.html.
 * Touch input goes to the state machine; use setInput/fire/play to drive it and [listener] for its messages.
 */
@SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
class OpenBoneView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {

    /** Receives every message from the animation (type: ready, event, stateChange, inputs, error). */
    fun interface Listener {
        fun onMessage(message: JSONObject)
    }

    val webView: WebView = WebView(context)
    var listener: Listener? = null
    var isReady = false
        private set
    private val pending = mutableListOf<JSONObject>()
    private val main = Handler(Looper.getMainLooper())

    init {
        webView.settings.javaScriptEnabled = true
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(HostBridge(), "OpenBoneHost")
        addView(webView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    /** Load assets/<assetFolder>/index.html, e.g. load("openbone/hero"). */
    fun load(assetFolder: String) {
        isReady = false
        webView.loadUrl("file:///android_asset/$assetFolder/index.html")
    }

    fun setInput(name: String, value: Boolean) = send(JSONObject().put("type", "setInput").put("name", name).put("value", value))
    fun setInput(name: String, value: Double) = send(JSONObject().put("type", "setInput").put("name", name).put("value", value))
    fun setInput(name: String, value: String) = send(JSONObject().put("type", "setInput").put("name", name).put("value", value))
    fun fire(name: String) = send(JSONObject().put("type", "fire").put("name", name))
    fun play(animation: String? = null, loop: Boolean = true) =
        send(JSONObject().put("type", "play").put("loop", loop).apply { if (animation != null) put("animation", animation) })
    fun pause() = send(JSONObject().put("type", "pause"))
    fun setSkin(name: String?) = send(JSONObject().put("type", "setSkin").put("name", name ?: JSONObject.NULL))
    fun useStateMachine(name: String? = null) =
        send(JSONObject().put("type", "useStateMachine").apply { if (name != null) put("name", name) })

    /** Send any bridge command; queued until the page reports ready. */
    fun send(command: JSONObject) {
        if (!isReady) {
            pending.add(command)
            return
        }
        webView.evaluateJavascript("OpenBone.receive(" + JSONObject.quote(command.toString()) + ")", null)
    }

    /** Call from onDestroy of the hosting Activity/Fragment. */
    fun destroy() {
        listener = null
        webView.removeJavascriptInterface("OpenBoneHost")
        webView.destroy()
    }

    private fun handle(json: String) {
        val message = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }
        if (message.optString("source") != "openbone") return
        if (message.optString("type") == "ready") {
            isReady = true
            val queued = pending.toList()
            pending.clear()
            queued.forEach { send(it) }
        }
        listener?.onMessage(message)
    }

    private inner class HostBridge {
        // Called on a WebView background thread.
        @JavascriptInterface
        fun postMessage(json: String) {
            main.post { handle(json) }
        }
    }
}
`;
}

function androidExample(c: TemplateContext) {
  const t = c.inputs.find((i) => i.type === "trigger");
  const b = c.inputs.find((i) => i.type === "bool");
  const n = c.inputs.find((i) => i.type === "number");
  return `// Example Activity showing "${c.title}". Register it in AndroidManifest.xml to try it.
package ${c.pkg}.example

import android.app.Activity
import android.os.Bundle
import android.util.Log
import ${c.pkg}.OpenBoneView

class OpenBoneExampleActivity : Activity() {
    private lateinit var view: OpenBoneView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        view = OpenBoneView(this)
        setContentView(view)
        view.listener = OpenBoneView.Listener { m ->
            when (m.optString("type")) {
                "event" -> Log.d("OpenBone", "event " + m.optString("name"))
                "stateChange" -> Log.d("OpenBone", m.optString("from") + " -> " + m.optString("to"))
                "error" -> Log.e("OpenBone", m.optString("message"))
            }
        }
        view.load("openbone/${c.base}")
${t ? `        view.setOnLongClickListener { view.fire("${t.name}"); true }\n` : ""}${b ? `        view.setInput("${b.name}", true)\n` : ""}${n ? `        view.setInput("${n.name}", 0.5)\n` : ""}    }

    override fun onDestroy() {
        view.destroy()
        super.onDestroy()
    }
}
`;
}

function androidReadme(c: TemplateContext) {
  return `# ${c.title}: Android (interactive WebView)

Plays the OpenBone animation with its state machine, inputs, scripts and touch interaction, by embedding the
OpenBone web player in a \`WebView\`. Kotlin, no extra dependencies (only the platform WebView), API 21+.

${inputsTable(c)}
## Install

1. Copy \`app/src/main/assets/openbone/${c.base}/\` into your module's \`src/main/assets/\`.
2. Copy \`app/src/main/java/${c.pkg.replace(/\./g, "/")}/OpenBoneView.kt\` into your sources (change the \`package\` line if you like).
3. Use it from code:

\`\`\`kotlin
val view = OpenBoneView(context)
view.load("openbone/${c.base}")
view.listener = OpenBoneView.Listener { m -> Log.d("OpenBone", m.toString()) }
${c.inputs.length ? c.inputs.map((i) => (i.type === "trigger" ? `view.fire("${i.name}")` : i.type === "bool" ? `view.setInput("${i.name}", true)` : i.type === "string" ? `view.setInput("${i.name}", "Hello")` : `view.setInput("${i.name}", 1.0)`)).join("\n") : 'view.play("idle")'}
\`\`\`

or from XML: \`<${c.pkg}.OpenBoneView android:id="@+id/openbone" android:layout_width="match_parent" android:layout_height="300dp" />\`
and call \`load(...)\` in \`onCreate\`. Call \`destroy()\` in \`onDestroy\`.

\`example/OpenBoneExampleActivity.kt\` is a complete Activity. No \`INTERNET\` permission is needed: everything loads from
\`file:///android_asset\`.

${BRIDGE_DOC}
${NOT_COMPILED("Android/Gradle")}
`;
}

// ---- iOS ----

const IOS_VIEW_SWIFT = `// OpenBone WebView for iOS (UIKit + SwiftUI). MIT licensed, generated by OpenBone.
import SwiftUI
import UIKit
import WebKit

/// Shows an exported OpenBone animation from a folder in the app bundle. Touch input goes to the state machine.
public final class OpenBoneView: UIView {
    public private(set) var webView: WKWebView!
    /// Every message from the animation (type: ready, event, stateChange, inputs, error).
    public var onMessage: (([String: Any]) -> Void)?
    public private(set) var isReady = false
    private var pending: [[String: Any]] = []

    public override init(frame: CGRect) {
        super.init(frame: frame)
        setUp()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUp()
    }

    private func setUp() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakMessageHandler(self), name: "openbone")
        webView = WKWebView(frame: bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        addSubview(webView)
    }

    /// Load <folder>/index.html from the bundle. Add the folder to the app target as a folder reference (blue folder).
    public func load(folder: String, bundle: Bundle = .main) {
        guard let dir = bundle.url(forResource: folder, withExtension: nil) else {
            assertionFailure("OpenBone: folder \\(folder) is not in the app bundle")
            return
        }
        isReady = false
        webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
    }

    public func setInput(_ name: String, _ value: Bool) { send(["type": "setInput", "name": name, "value": value]) }
    public func setInput(_ name: String, _ value: Double) { send(["type": "setInput", "name": name, "value": value]) }
    public func setInput(_ name: String, _ value: String) { send(["type": "setInput", "name": name, "value": value]) }
    public func fire(_ name: String) { send(["type": "fire", "name": name]) }
    public func play(_ animation: String? = nil, loop: Bool = true) {
        var command: [String: Any] = ["type": "play", "loop": loop]
        if let animation { command["animation"] = animation }
        send(command)
    }
    public func pause() { send(["type": "pause"]) }
    public func setSkin(_ name: String?) { send(["type": "setSkin", "name": name ?? NSNull()]) }
    public func useStateMachine(_ name: String? = nil) {
        var command: [String: Any] = ["type": "useStateMachine"]
        if let name { command["name"] = name }
        send(command)
    }

    /// Send any bridge command; queued until the page reports ready.
    public func send(_ command: [String: Any]) {
        guard isReady else {
            pending.append(command)
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: command),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("OpenBone.receive(\\(json))", completionHandler: nil)
    }

    fileprivate func handle(_ body: Any) {
        guard let text = body as? String,
              let data = text.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              message["source"] as? String == "openbone" else { return }
        if message["type"] as? String == "ready" {
            isReady = true
            let queued = pending
            pending = []
            queued.forEach { send($0) }
        }
        onMessage?(message)
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "openbone")
    }
}

/// Avoids the retain cycle WKUserContentController -> handler -> view.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var view: OpenBoneView?
    init(_ view: OpenBoneView) { self.view = view }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        view?.handle(message.body)
    }
}

/// Handle for driving an OpenBone view from SwiftUI.
public final class OpenBoneController: ObservableObject {
    fileprivate weak var view: OpenBoneView?
    @Published public private(set) var lastMessage: [String: Any] = [:]
    public init() {}

    public func setInput(_ name: String, _ value: Bool) { view?.setInput(name, value) }
    public func setInput(_ name: String, _ value: Double) { view?.setInput(name, value) }
    public func setInput(_ name: String, _ value: String) { view?.setInput(name, value) }
    public func fire(_ name: String) { view?.fire(name) }
    public func play(_ animation: String? = nil, loop: Bool = true) { view?.play(animation, loop: loop) }
    public func pause() { view?.pause() }
    public func setSkin(_ name: String?) { view?.setSkin(name) }
}

/// SwiftUI wrapper: OpenBoneAnimation(folder: "openbone/hero", controller: controller).
public struct OpenBoneAnimation: UIViewRepresentable {
    public let folder: String
    @ObservedObject public var controller: OpenBoneController
    public var onMessage: (([String: Any]) -> Void)?

    public init(folder: String, controller: OpenBoneController, onMessage: (([String: Any]) -> Void)? = nil) {
        self.folder = folder
        self.controller = controller
        self.onMessage = onMessage
    }

    public func makeUIView(context: Context) -> OpenBoneView {
        let view = OpenBoneView(frame: .zero)
        let controller = self.controller
        let onMessage = self.onMessage
        view.onMessage = { message in
            controller.lastMessage = message
            onMessage?(message)
        }
        controller.view = view
        view.load(folder: folder)
        return view
    }

    public func updateUIView(_ view: OpenBoneView, context: Context) {
        controller.view = view
    }
}
`;

function iosExample(c: TemplateContext) {
  const buttons = c.inputs
    .map((i) =>
      i.type === "trigger"
        ? `                Button("${i.name}") { controller.fire("${i.name}") }`
        : i.type === "bool"
          ? `                Button("${i.name} on") { controller.setInput("${i.name}", true) }`
          : i.type === "string"
            ? `                Button("${i.name} = Hello") { controller.setInput("${i.name}", "Hello") }`
            : `                Button("${i.name} = 1") { controller.setInput("${i.name}", 1.0) }`,
    )
    .join("\n");
  return `// Examples showing "${c.title}" in SwiftUI and UIKit.
import SwiftUI
import UIKit

struct OpenBoneExampleView: View {
    @StateObject private var controller = OpenBoneController()

    var body: some View {
        VStack {
            OpenBoneAnimation(folder: "OpenBone/${c.base}", controller: controller) { message in
                print("OpenBone:", message)
            }
            HStack {
${buttons || '                Button("Pause") { controller.pause() }'}
            }
            .padding()
        }
    }
}

final class OpenBoneExampleViewController: UIViewController {
    private let animationView = OpenBoneView()

    override func viewDidLoad() {
        super.viewDidLoad()
        animationView.frame = view.bounds
        animationView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(animationView)
        animationView.onMessage = { message in print("OpenBone:", message) }
        animationView.load(folder: "OpenBone/${c.base}")
    }
}
`;
}

function iosReadme(c: TemplateContext) {
  return `# ${c.title}: iOS (interactive WebView)

Plays the OpenBone animation with its state machine, inputs, scripts and touch interaction, by embedding the
OpenBone web player in a \`WKWebView\`. Swift 5.7+, iOS 13+, UIKit and SwiftUI. No dependencies.

${inputsTable(c)}
## Install

1. Drag the \`OpenBone\` folder into Xcode and choose **Create folder references** (a blue folder), with your app target
   ticked. The files must keep their folder layout: \`OpenBone/${c.base}/index.html\` next to \`openbone-player.js\`.
2. Add \`Sources/OpenBoneView.swift\` to your target.
3. SwiftUI:

\`\`\`swift
@StateObject var controller = OpenBoneController()

OpenBoneAnimation(folder: "OpenBone/${c.base}", controller: controller) { message in
    print(message["type"] ?? "")
}
${c.inputs.length ? c.inputs.map((i) => (i.type === "trigger" ? `controller.fire("${i.name}")` : i.type === "bool" ? `controller.setInput("${i.name}", true)` : i.type === "string" ? `controller.setInput("${i.name}", "Hello")` : `controller.setInput("${i.name}", 1.0)`)).join("\n") : 'controller.play("idle")'}
\`\`\`

   UIKit:

\`\`\`swift
let view = OpenBoneView(frame: bounds)
view.load(folder: "OpenBone/${c.base}")
view.onMessage = { message in print(message) }
\`\`\`

\`Sources/OpenBoneExample.swift\` has both. Nothing is loaded from the network, so no App Transport Security changes are needed.

${BRIDGE_DOC}
${NOT_COMPILED("Xcode/Swift")}
`;
}
