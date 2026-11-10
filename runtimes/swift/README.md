# OpenBone for Swift

A Swift package for iOS and macOS that plays OpenBone documents (`.obone` / `.obonb`): skeletal animation, skins,
state machines with inputs, triggers and pointer listeners, events, audio commands and scripts. It is a thin layer
over the [C++ runtime](../cpp) — SwiftPM compiles the C++ sources directly and the Swift API wraps its stable C API
(`openbone.h`) — so it poses, draws and reacts exactly like the other runtimes. It passes the whole
[conformance suite](../../conformance) (18 reference files, 82 cases).

| | |
| --- | --- |
| Platforms | iOS 15+, macOS 12+ (tvOS 15+ for the runtime and views; untested); the runtime part also builds on Linux |
| Swift | 5.9+ (swift-tools-version 5.9; checked with Swift 6.0.3) |
| Products | `OpenBone` (one library: runtime API + Metal views + SwiftUI wrapper) |
| Targets | `COpenBone` (C++17 runtime, C API), `CQuickJS` (quickjs-ng 0.10.1, only when fetched), `OpenBone` (Swift), `OpenBoneTests` |
| Dependencies | none at build time beyond the C++ runtime's own: nlohmann/json (MIT, vendored in `runtimes/cpp`), [QuickJS-ng](https://github.com/quickjs-ng/quickjs) (MIT, downloaded by a script) |
| Licence | MIT |

## Install

The package lives inside this repository and compiles `runtimes/cpp` through the symlinks in
`Sources/COpenBone` (`src`, `cpp-include`, `third_party`, `include/openbone.h`), so use it from a checkout:

1. Fetch QuickJS (document scripts; same release and SHA-256 as the C++ CMake build). Without it the package still
   builds, with scripts disabled (`OpenBoneRuntime.hasScripts == false`):

   ```bash
   runtimes/swift/scripts/fetch-quickjs.sh
   ```

2. Add the package as a **local** dependency — in Xcode *File → Add Package Dependencies… → Add Local…* and pick
   `runtimes/swift`, or in a `Package.swift`:

   ```swift
   dependencies: [.package(name: "OpenBone", path: "../open-bone/runtimes/swift")],
   targets: [.target(name: "MyApp", dependencies: [.product(name: "OpenBone", package: "OpenBone")])]
   ```

The C++ code is compiled with `-ffp-contract=off` (no fused multiply-add, so results match the reference on ARM64);
SwiftPM calls that an *unsafe flag*, which it accepts for root and local packages but not for packages pulled by
version from a URL. Distributing it as a remote package would need a `Package.swift` at the repository root or a
prebuilt `libopenbone` XCFramework (`binaryTarget`) — not done yet.

## Build and test

```bash
cd runtimes/swift && swift build
```

```bash
cd runtimes/swift && swift test
```

`swift test` runs every case of `conformance/expected/*.json` through the Swift API (`ConformanceTests`, one test
per reference file, with the suite's tolerances and the C++ runner's comparison rules), API tests (loading and errors,
`.obonb` = `.obone`, inputs and triggers, pointer → listener events, skins, queueing, clips, text, lifetimes) and
tests of the platform-neutral renderer geometry (framing, mesh building and batching). Set `OPENBONE_NO_SCRIPTS=1`
to build without QuickJS even when it is fetched.

## Usage

```swift
import OpenBone

let doc = try OpenBoneDocument(contentsOf: Bundle.main.url(forResource: "button", withExtension: "obone")!)
let inst = try OpenBoneInstance(document: doc)          // scripts: true by default

inst.onEvent = { e in print("event", e.name, e.stringValue) }
inst.onAudio = { cmd in audio.handle(cmd) }             // .play / .stop / .fade → your AVAudioEngine
inst.onStateChange = { layer, from, to in print(layer, "→", to) }

try inst.useStateMachine()                              // or: try inst.play("walk", loop: true)
try inst.setInput("speed", 0.5)                         // Bool, Double, String or OpenBoneValue
try inst.fire("attack")
try inst.pointer(.down, x: 10, y: 20)                   // skeleton space (y up); or artboardX:artboardY:

inst.advance(1.0 / 60)
inst.withDrawList { list in                             // zero copy; views valid inside the closure
    for item in list.items {
        // item.vertices / uvs / indices (UnsafeBufferPointer), item.color, item.dark, item.colors (particles),
        // item.textureID, item.blend, item.clip (→ list.clip(i)), item.text, item.stroke
    }
}
let copy = inst.drawList()                              // or a copied OpenBoneDrawList
```

### SwiftUI, UIKit, AppKit

```swift
struct Stage: View {
    let instance: OpenBoneInstance
    var body: some View { OpenBonePlayer(instance: instance, fit: .contain).frame(height: 320) }
}

let view = try OpenBoneView(document: doc, stateMachine: "button")   // UIView / NSView (MTKView)
view.fit = .contain          // .cover, .fill, .scale(2)
view.framing = .artboard     // .bounds, .rect(…)
view.speed = 1
```

`OpenBoneView` advances its instance every frame (MTKView's display loop, `isPaused` stops it), draws with
`OpenBoneMetalRenderer` and turns touches (UIKit) or mouse down / drag / up / move (AppKit) into pointer events for
the running state machine's listeners, using the inverse of the view's framing. The renderer:

- one premultiplied-alpha pipeline per blend mode (normal, additive, multiply, screen);
- two-colour tint in the fragment shader: `rgb = (dark·a + (light − dark)·tex.rgb)·light.a` (dark = 0 is a plain multiply);
- clipping masks in the stencil buffer (a fresh stencil value per mask);
- textures decoded with ImageIO from `data:` URLs or paths relative to the document (`OpenBoneDocument.baseURL`);
  straight-alpha images are premultiplied on upload, premultiplied atlas pages are kept as they are;
  `setTexture(_:forID:)` lets you supply your own;
- particles with the built-in soft dot sprite and per-vertex colours; shapes untextured, with their stroke;
- text rasterised with CoreText (font family, weight, size, alignment, fill, outline) into cached textures, drawn on
  the text box's quad;
- batching: consecutive items with the same texture, blend and clip become one draw call
  (`OpenBoneRenderMesh` — platform-neutral, unit-tested).

`OpenBoneView` waits for each frame's command buffer before the next (one shared vertex buffer); fine for a few
skeletons, a ring of buffers would be the next step for many.

### Sample

[`Examples/OpenBoneSample`](Examples/OpenBoneSample) is a SwiftUI app: pick one of the repository's `examples/`
(or open any `.obone` / `.obonb`), switch between its state machine and animations, set skins and speed, drive every
input (toggles, sliders, text fields, trigger buttons), click / tap the stage, and watch events, audio commands,
state changes and script logs.

```bash
cd runtimes/swift/Examples/OpenBoneSample && swift run
```

That runs it on macOS. For iOS, create an iOS App target in Xcode, add `runtimes/swift` as a local package and the
two files in `Sources/OpenBoneSample` to the target (bundle the documents and their `assets/` folder, or use *Open…*).

## API

| Type | What it is |
| --- | --- |
| `OpenBoneDocument` | Loaded, immutable document (`init(contentsOf:)`, `init(data:baseURL:)`); `artboard`, `animations` (name, duration), `skins`, `stateMachines` (inputs with type and default), `textures` (atlas pages, images, premultiplied flag), `textureData(for:)`, `artboardToSkeleton` |
| `OpenBoneInstance` | A skeleton of a document: `setSkin`, `setTransform`, `play` / `queue` / `clearTracks`, `useStateMachine`, `setInput`, `fire`, `input(_:)`, `pointer`, `activeStates`, `setText(slot:_:)`, `advance`, `bones` / `bone(named:)`, `slots` / `slot(named:)`, `bounds`, `withDrawList`, `drawList()`; callbacks `onEvent`, `onAudio`, `onStateChange`, `onLog` |
| `OpenBoneDrawItemView` / `OpenBoneDrawItem` | Draw item (zero-copy view or copy): slot, attachment, kind, blend, texture, vertices, uvs, indices, colour, dark, per-vertex colours, clip, text, stroke |
| `OpenBoneEvent`, `OpenBoneAudioCommand`, `OpenBoneValue`, `OpenBoneBone`, `OpenBoneSlot` | Value types |
| `OpenBoneViewport`, `OpenBoneRenderMesh` | Framing (skeleton ↔ view, NDC) and the batched GPU-ready mesh |
| `OpenBoneMetalRenderer`, `OpenBoneView`, `OpenBonePlayer` | Metal renderer, UIKit / AppKit view, SwiftUI view (Apple platforms) |
| `OpenBoneRuntime` | `apiVersion`, `version`, `hasScripts` |
| `OpenBoneError` | Thrown with the runtime's message (`ob_last_error()`) |

Memory: documents and instances own their C handles and free them in `deinit`. An instance keeps its document alive,
so a document is always freed after its instances. Callbacks are closures stored on the instance (beware of
capturing the instance strongly in its own callbacks — use `[weak inst]`). An instance is not thread-safe; different
instances may be used from different threads.

## What was and wasn't tested

Tested here (Linux x86_64, Swift 6.0.3, Ubuntu 22.04):

- `swift build` and `swift test`: all 82 conformance cases pass, plus the API and render-geometry tests (35 tests);
- the conformance comparison was mutation-checked (perturbed vertices and states make every case fail);
- `swift test --sanitize=address`: no errors; LeakSanitizer reports only allocations made inside the Swift runtime /
  XCTest themselves (none from the C / C++ runtime or this package's objects); `testLifetimes` checks documents and
  instances are released;
- the build without QuickJS (`OPENBONE_NO_SCRIPTS=1`), and that the sample package resolves and compiles (on Linux
  it compiles to a stub, as SwiftUI is missing).

**Not tested: everything that needs Apple frameworks.** `MetalRenderer.swift`, `OpenBoneView.swift`,
`OpenBonePlayer.swift` and the sample's UI are behind `#if canImport(Metal/MetalKit/SwiftUI/…)` and were neither
compiled nor run — there was no Apple hardware or SDK. Expect small compile fixes on first build in Xcode, and check
rendering by eye (blend modes, clipping, two-colour tint, premultiplied pages, text placement, touch mapping) against
the editor. The ARM64 path (Apple Silicon, iOS devices) is likewise untested here, although the C++ runtime is
compiled without FMA contraction for it.
