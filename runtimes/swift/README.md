# OpenBone for Swift

A Swift package for iOS and macOS that plays OpenBone documents (`.obone` / `.obonb`): skeletal animation, skins,
state machines with inputs, triggers and pointer listeners, events, sound (AVFoundation) and scripts. It is a thin layer
over the [C++ runtime](../cpp) — SwiftPM compiles the C++ sources directly and the Swift API wraps its stable C API
(`openbone.h`) — so it poses, draws and reacts exactly like the other runtimes. It passes the whole
[conformance suite](../../conformance) (20 reference files, 88 cases).

| | |
| --- | --- |
| Platforms | iOS 15+, macOS 12+ (tvOS 15+ for the runtime and views; untested); the runtime part also builds on Linux |
| Swift | 5.9+ (swift-tools-version 5.9; checked with Swift 6.0.3) |
| Products | `OpenBone` (one library: runtime API + Metal views + SwiftUI wrapper) |
| Targets | `COpenBone` (C++17 runtime, C API), `CQuickJS` (quickjs-ng 0.10.1), `OpenBone` (Swift), `OpenBoneTests` |
| Dependencies | none at build time beyond the C++ runtime's own: nlohmann/json (MIT, vendored in `runtimes/cpp`), [QuickJS-ng](https://github.com/quickjs-ng/quickjs) (MIT, vendored in `runtimes/cpp/third_party/quickjs`) |
| Licence | MIT |

## Install

The package manifest is at the **repository root** (`Package.swift`), so add the repository URL and a release version:

- Xcode: *File → Add Package Dependencies…*, enter `https://github.com/UXCentury/open-bone`, pick *Up to Next Major
  Version* from `0.2.0`, and add the `OpenBone` library to your target.
- `Package.swift`:

  ```swift
  dependencies: [.package(url: "https://github.com/UXCentury/open-bone", from: "0.2.0")],
  targets: [.target(name: "MyApp", dependencies: [.product(name: "OpenBone", package: "open-bone")])]
  ```

Releases are the repository's `v0.2.0`-style tags (SwiftPM reads a leading `v` as part of the tag, not the version).
SwiftPM clones the whole repository, but builds only the Swift package's targets.

SwiftPM compiles `runtimes/cpp` from source through the symlinks in `Sources/COpenBone` (`src`, `cpp-include`,
`third_party`, `include/openbone.h`) and QuickJS ([quickjs-ng](https://github.com/quickjs-ng/quickjs) 0.10.1, MIT,
vendored in `runtimes/cpp/third_party/quickjs`) through `Sources/CQuickJS/vendor`, so document scripts are always on.
The manifest uses no *unsafe flags* (which SwiftPM refuses in packages used by version): bit-exact results without
fused multiply-add come from `#pragma STDC FP_CONTRACT OFF` in `runtimes/cpp/src/exact_math.h` (included first by every
runtime source) and in the `Sources/CQuickJS/*.c` wrappers, rather than `-ffp-contract=off`.

To work on a local checkout instead, use a path dependency on the repository root:
`.package(name: "OpenBone", path: "../open-bone")`, or *Add Local…* in Xcode.

## Build and test

From the repository root (SwiftPM also finds the root manifest from `runtimes/swift`):

```bash
swift build
```

```bash
swift test
```

`swift test` runs every case of `conformance/expected/*.json` through the Swift API (`ConformanceTests`, one test
per reference file, with the suite's tolerances and the C++ runner's comparison rules), API tests (loading and errors,
`.obonb` = `.obone`, inputs and triggers, pointer → listener events, skins, queueing, clips, text, lifetimes) and
tests of the platform-neutral renderer geometry (framing, mesh building and batching) and sound logic (`AudioTests`:
the document's audio listings, `OpenBoneAudioMixer` gain, fades and voices with a recording output).

## Usage

```swift
import OpenBone

let doc = try OpenBoneDocument(contentsOf: Bundle.main.url(forResource: "button", withExtension: "obone")!)
let inst = try OpenBoneInstance(document: doc)          // scripts: true by default

inst.onEvent = { e in print("event", e.name, e.stringValue) }
inst.onAudio = { cmd in print(cmd) }                    // .play / .stop / .fade (OpenBoneView plays them)
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

### Sound

`OpenBoneView` (and so `OpenBonePlayer`) plays the document's sounds by default through an `OpenBoneAudio`
(AVFoundation, one `AVAudioPlayer` per voice). Each file is read once, from a `data:` URL or a path relative to the
document; a voice's gain is `command volume × bus volume (0 if muted) × master (0 if the document is muted)`, with
the command's rate (AVAudioPlayer's 0.5…2 range), looping and fade-in, stop fades and `fade` commands (the sound's
new volume, keeping the voice's bus and master gain). Voices stop when the instance is replaced or the view leaves
its window.

```swift
view.isAudioEnabled = false                     // opt out; inst.onAudio still gets every command
OpenBonePlayer(instance: inst, isAudioEnabled: false)
view.audio?.volume = 0.5                        // extra gain on everything the view plays

let audio = OpenBoneAudio(document: doc)        // without a view
inst.onAudio = { audio.handle($0) }
```

`onAudio` is independent of the view's player: setting it does not turn the view's sound off. `OpenBoneAudio` leaves
`AVAudioSession` alone, so set the category your app needs on iOS. The platform-neutral part — gain, voice
bookkeeping, fades — is `OpenBoneAudioMixer`, which drives any `OpenBoneAudioOutput` (use it to plug in another
engine); it is unit-tested on Linux.

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

That runs it on macOS. For iOS, create an iOS App target in Xcode, add the repository root as a local package and the
two files in `Sources/OpenBoneSample` to the target (bundle the documents and their `assets/` folder, or use *Open…*).

## API

| Type | What it is |
| --- | --- |
| `OpenBoneDocument` | Loaded, immutable document (`init(contentsOf:)`, `init(data:baseURL:)`); `artboard`, `animations` (name, duration), `skins`, `stateMachines` (inputs with type and default), `textures` (atlas pages, images, premultiplied flag), `textureData(for:)`, `audioAssets`, `audioBuses`, `audioMaster`, `audioData(for:)`, `artboardToSkeleton` |
| `OpenBoneInstance` | A skeleton of a document: `setSkin`, `setTransform`, `play` / `queue` / `clearTracks`, `useStateMachine`, `setInput`, `fire`, `input(_:)`, `pointer`, `activeStates`, `setText(slot:_:)`, `advance`, `bones` / `bone(named:)`, `slots` / `slot(named:)`, `bounds`, `withDrawList`, `drawList()`; callbacks `onEvent`, `onAudio`, `onStateChange`, `onLog` |
| `OpenBoneSkeletonBounds`, `OpenBoneBoundingBox` | Bounding-box queries: `instance.boundingBoxes()` (see below) |
| `OpenBoneDrawItemView` / `OpenBoneDrawItem` | Draw item (zero-copy view or copy): slot, attachment, kind, blend, texture, vertices, uvs, indices, colour, dark, per-vertex colours, clip, text, stroke |
| `OpenBoneEvent`, `OpenBoneAudioCommand`, `OpenBoneValue`, `OpenBoneBone`, `OpenBoneSlot` | Value types |
| `OpenBoneViewport`, `OpenBoneRenderMesh` | Framing (skeleton ↔ view, NDC) and the batched GPU-ready mesh |
| `OpenBoneMetalRenderer`, `OpenBoneView`, `OpenBonePlayer` | Metal renderer, UIKit / AppKit view, SwiftUI view (Apple platforms) |
| `OpenBoneAudio` | Plays audio commands with AVFoundation (Apple platforms); `handle(_:)`, `stopAll(fade:)`, `volume` |
| `OpenBoneAudioMixer`, `OpenBoneAudioOutput` | Platform-neutral gain, voice and fade logic, and the protocol of what plays the voices |
| `OpenBoneRuntime` | `apiVersion`, `version`, `hasScripts` |
| `OpenBoneError` | Thrown with the runtime's message (`ob_last_error()`) |

### Bounding boxes

`instance.boundingBoxes()` returns an `OpenBoneSkeletonBounds` snapshot of the current pose (like Spine's
SkeletonBounds; docs/runtime-spec.md §8.10): `boxes` (`OpenBoneBoundingBox`: `index`, `slot`, `attachment`, world
`vertices` as `[Float]`, own `bounds`) for every slot in draw order whose bone is active and whose current attachment is
a bounding box, and `aabb` (nil with no box). Queries in skeleton space: `aabbContainsPoint(x:y:)`, `aabbIntersects(_:)`,
`containsPoint(x:y:)` / `containsPointAll(x:y:)`, `intersectsSegment(x1:y1:x2:y2:)` / `intersectsSegmentAll`, and
`intersectsBounds(_:)` → `(mine, theirs)?` between two snapshots (for example two characters). Call `update(_:)` or take
a new snapshot after the pose changes.

```swift
inst.advance(dt)
if let hit = inst.boundingBoxes().containsPoint(x: p.x, y: p.y) { print("hit \(hit.attachment)") }
```

Path constraints with `constantSpeed: false` in the document place bones at the raw bezier parameter inside each
segment instead of by arc length (Spine's "constant speed" off); unset or true keeps arc-length placement.

Memory: documents and instances own their C handles and free them in `deinit`. An instance keeps its document alive,
so a document is always freed after its instances. Callbacks are closures stored on the instance (beware of
capturing the instance strongly in its own callbacks — use `[weak inst]`). An instance is not thread-safe; different
instances may be used from different threads.

## What was and wasn't tested

Tested here (Linux x86_64, Swift 6.0.3, Ubuntu 22.04):

- `swift build` and `swift test`: all 88 conformance cases pass (including the bounding-box queries of `bounds.json`),
  plus the API, render-geometry and audio tests (43 tests);
- the conformance comparison was mutation-checked (perturbed vertices and states make every case fail);
- `swift test --sanitize=address`: no errors; LeakSanitizer reports only allocations made inside the Swift runtime /
  XCTest themselves (none from the C / C++ runtime or this package's objects); `testLifetimes` checks documents and
  instances are released;
- use as a versioned dependency: a consumer package depending on a tagged clone by URL resolves `v0.2.0` and builds
  with no unsafe-flags error (CI repeats this on Linux), and that the sample package resolves and compiles (on Linux
  it compiles to a stub, as SwiftUI is missing).

**Not tested: everything that needs Apple frameworks.** `MetalRenderer.swift`, `OpenBoneView.swift`,
`OpenBonePlayer.swift`, `Audio/OpenBoneAudio.swift` (AVFoundation) and the sample's UI are behind
`#if canImport(Metal/MetalKit/SwiftUI/AVFoundation/…)` and were neither compiled nor run — there was no Apple hardware
or SDK. Expect small compile fixes on first build in Xcode, check rendering by eye (blend modes, clipping, two-colour
tint, premultiplied pages, text placement, touch mapping) against the editor, and listen to the sounds (the button
and campfire examples). The ARM64 path (Apple Silicon, iOS devices) is likewise untested here, although the C++
runtime is compiled without FMA contraction for it.
