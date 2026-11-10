# OpenBone for Java, libGDX and Android

A native Java port of the TypeScript runtime (`packages/runtime`), a libGDX renderer and a Kotlin Android view. It
loads `.obone` and `.obonb` files and implements everything in [docs/runtime-spec.md](../../docs/runtime-spec.md):
skeletons, skins and skin bones, every attachment type, animation mixing, IK / transform / path / physics constraints
in custom order, sliders, sprite sequences, particles (same RNG), text templates, the draw list, state machines with
listeners and input bindings, events, audio commands (played by the libGDX and Android modules) and scripts.

It passes the whole conformance suite: all 92 cases of the 21 files in [`conformance/expected`](../../conformance/expected),
on the JVM and on an Android emulator.

| Module | Language | What it is |
|---|---|---|
| `openbone-runtime` | Java 11, no dependencies | The runtime: `DocumentLoader`, `OpenBoneInstance`, `Skeleton`, `AnimationState`, `StateMachineInstance`, `DrawItem`s |
| `openbone-scripting` | Kotlin (JVM, Android) | `QuickJsScriptHost`: state machine scripts in QuickJS |
| `openbone-gdx` | Java 11 | `OpenBoneRenderer` for libGDX: two-colour tint shader, blend modes, stencil clipping, particles, text |
| `openbone-gdx-sample` | Java 11 | LWJGL3 desktop sample (mouse → listeners, sound, events and audio commands in the log) |
| `openbone-android` | Kotlin, Android library | `OpenBoneView`: a `View` with a Kotlin API (inputs, triggers, events as lambdas, touch → pointer listeners) |
| `openbone-conformance` | Java tests | JUnit runner for `conformance/expected/*.json`, plus unit tests for the porting traps |

## Install

The libraries are on Maven Central under the `io.openbone` group (the Java/Kotlin packages are `com.openbone.*`):

```kotlin
// build.gradle.kts
repositories { mavenCentral() }

dependencies {
  implementation("io.openbone:openbone-runtime:0.2.1")   // the runtime, no dependencies
  implementation("io.openbone:openbone-scripting:0.2.1") // state machine scripts (QuickJS)
  implementation("io.openbone:openbone-gdx:0.2.1")       // libGDX renderer (brings openbone-runtime)
  implementation("io.openbone:openbone-android:0.2.1")   // Android OpenBoneView AAR (brings runtime + scripting)
}
```

Use Gradle (or a Maven build that reads Gradle module metadata) for Android: `openbone-scripting` depends on
`io.github.dokar3:quickjs-kt`, and Gradle picks its Android variant (`quickjs-kt-android`) automatically; the plain POM
names the JVM one.

## Build and test

Java 17+ to run Gradle (the libraries target Java 11). The Gradle wrapper fetches Gradle and the Kotlin plugin.

```bash
cd runtimes/java
./gradlew test
```

`test` runs the conformance suite (`openbone-conformance`) and the unit tests (porting traps, `AudioMixerTest`).
Run one file with
`./gradlew :openbone-conformance:test -Dopenbone.only=example-knight`.

The Android library is built when an Android SDK is found (`local.properties` `sdk.dir`, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, or the default `~/Android/Sdk`; it then writes `local.properties` for the Android plugin). Without
an SDK the build skips `:openbone-android` and says so. It needs SDK platform 36:

```bash
./gradlew :openbone-android:assembleRelease
./gradlew :openbone-android:connectedDebugAndroidTest   # all conformance cases + the view, on a device or emulator
```

Publishing (see [docs/releasing.md](../../docs/releasing.md) and `.github/workflows/publish-maven.yml`) uses
[gradle-maven-publish-plugin](https://github.com/vanniktech/gradle-maven-publish-plugin). Try it locally, unsigned:

```bash
./gradlew publishToMavenLocal   # ~/.m2/repository/io/openbone/openbone-*/<version>/
```

The libGDX sample:

```bash
./gradlew :openbone-gdx-sample:run --args="../../examples/knight.obone"
./gradlew :openbone-gdx-sample:installDist
xvfb-run -a openbone-gdx-sample/build/install/openbone-gdx-sample/bin/openbone-gdx-sample ../../examples/campfire.obone --frames 120 --screenshot shot.png
```

Arguments: a document path, `--state-machine <name>`, `--animation <name>`, `--size 960x720`, and for headless runs
`--frames <n>` (fixed 1/60 s steps, then exit) and `--screenshot <png>`.

## Java

```java
OpenBoneDocument doc = DocumentLoader.load(Files.readAllBytes(Path.of("knight.obone"))); // .obone or .obonb
OpenBoneInstance inst = new OpenBoneInstance(doc, new QuickJsScriptHost()); // null host = no scripts

inst.addListener(new OpenBoneInstance.Listener() {
  @Override public void event(FiredEvent e) { System.out.println(e.name); }
  @Override public void stateChange(String layer, String from, String to) { }
  @Override public void audio(AudioCommand c) { mixer.handle(c); } // play / stop / fade (see AudioMixer)
});

StateMachineInstance sm = inst.useStateMachine("knight"); // or inst.play("walk", true)
sm.setInput("walk", true);
sm.fire("attack");
inst.pointer("down", x, y); // skeleton space, y up; inst.artboardToSkeleton(px, py) converts artboard pixels

inst.advance(1 / 60.0);
for (DrawItem it : inst.drawList()) { /* vertices, uvs, indices, color, dark, blend, texture, clip, text… */ }
```

`inst.skeleton` gives bones (`world` matrices), slots, `setSkin`, `findBone`, `hitTest`, particle controls and
`setText`. `inst.animationState` queues and mixes animations on tracks (`setAnimation`, `addAnimation`).
Draw item vertices are skeleton space (y up); uvs are in the item's texture (an image, or an atlas page when packed).

### Bounding-box queries

`skeleton.boundingBoxes()` returns a `SkeletonBounds` (like Spine's): a snapshot of the active bounding boxes, in draw
order, for the current pose (spec §8.10). Each `SkeletonBounds.Box` has its `slot`, `attachment` name, world
`vertices` (skeleton space, y up, float32 values) and its own `minX`…`maxY`; the bounds have the overall
`minX`, `minY`, `maxX`, `maxY` (all 0 with no box). Call `update(skeleton)` on it after the pose changes.

```java
SkeletonBounds b = inst.skeleton.boundingBoxes();          // after inst.advance(dt)
if (b.aabbContainsPoint(x, y)) {
  SkeletonBounds.Box hit = b.containsPoint(x, y);           // first box in draw order, or null
  List<SkeletonBounds.Box> all = b.containsPointAll(x, y);  // every box containing the point
}
b.intersectsSegment(x1, y1, x2, y2);    // first box the segment crosses or starts in (…All for every one)
b.aabbIntersects(minX, minY, maxX, maxY);
SkeletonBounds.Pair p = b.intersectsBounds(enemy.skeleton.boundingBoxes()); // p.mine / p.theirs, or null
```

Bounding boxes may be weighted to several bones and deformed, posed exactly like meshes and paths. In libGDX,
`OpenBoneRenderer.screenToSkeleton(camera, screenX, screenY, out)` turns input coordinates into skeleton space.

Path constraints read `constantSpeed` (default true: points are placed by arc length, evenly spaced). With
`constantSpeed: false` the segment is still found by arc length but the point inside it is at the raw bezier
parameter, so bones bunch up where the handles are short (Spine's "constant speed" off).

Audio: the runtime itself never plays sound. It emits `AudioCommand`s (`play` with sound, asset, bus, volume, rate,
loop, fade-in; `stop` with a fade; `fade`). `AudioMixer` (in `openbone-runtime`, no dependencies) turns them into calls
on an `AudioMixer.Output` that makes the noise: gain `command volume × bus volume (0 if muted) × master (0 if the
document is muted)`, voice bookkeeping, fade-in, stop fades and `fade` commands (the sound's new volume, keeping the
voice's bus and master gain) stepped in `update(seconds)`, and one-shots released after their asset's duration. The
libGDX and Android players below are built on it; implement `Output` for any other engine.

## libGDX

```java
OpenBoneDocument doc = DocumentLoader.load(Gdx.files.internal("knight/knight.obone").readBytes());
OpenBoneInstance inst = new OpenBoneInstance(doc, new QuickJsScriptHost());
inst.useStateMachine(null);
DocumentTextures textures = new DocumentTextures(doc, Gdx.files.internal("knight")); // data: URLs or relative paths
OpenBoneRenderer renderer = new OpenBoneRenderer(); // or new OpenBoneRenderer(myBitmapFont)

// render():
inst.advance(Gdx.graphics.getDeltaTime());
renderer.draw(inst, textures, camera.combined); // camera in skeleton space (y up)
```

- Two-colour tint, normal / additive / multiply / screen blending; straight and premultiplied-alpha atlas pages
  (`atlas.premultipliedAlpha`) both draw right, since the shader works in premultiplied output.
- Clipping masks use the stencil buffer: request one (LWJGL3 `config.setBackBufferConfig(8, 8, 8, 8, 16, 8, 0)`).
- Particles draw with per-vertex colours and the built-in soft dot texture; shapes use the atlas white block or a
  generated white texture; strokes are drawn as quads.
- Text uses a `BitmapFont` (libGDX's default font unless you pass one) scaled to each text's size.

Sound: `OpenBoneAudio` plays a document's sounds with `Gdx.audio` `Sound`s (files loaded once from `data:` URLs or
paths relative to the folder you give; rate as pitch in libGDX's 0.5…2 range; looping; fades stepped per frame). It is
an `OpenBoneInstance.Listener`, so playing is opt-in per instance and your own listeners keep every command:

```java
OpenBoneAudio audio = new OpenBoneAudio(doc, Gdx.files.internal("knight"));
inst.addListener(audio);                    // leave this out to stay silent
// render():  inst.advance(dt); audio.update(Gdx.graphics.getDeltaTime());
// dispose(): audio.dispose();
```

The sample plays sounds by default; `--mute` turns them off.

## Android (Kotlin)

```kotlin
val view = OpenBoneView(context)
view.load(assets.open("knight/knight.obone").readBytes(), ImageSource.assets(assets, "knight"),
  SoundSource.assets(assets, "knight"))        // sounds next to the document (default: embedded data: URLs only)
view.useStateMachine("knight")                 // or view.play("walk")
view.onEvent { e -> if (e.name == "footstep") playStep() }
view.onStateChange { layer, from, to -> Log.d("anim", "$layer: $from → $to") }
view.onAudio { cmd -> Log.d("audio", "$cmd") } // every command, whether or not the view plays it
view.isAudioEnabled = false                    // opt out of playback (on by default)
view["walk"] = true                            // inputs: Boolean, Number or String
view.fire("attack")
view.setText("score", "{points:#,##0}")
view.fit = OpenBoneView.Fit.CONTAIN            // CONTAIN, COVER, FILL, NONE
```

Touch (`down`, `move`, `up`) and mouse/stylus hover reach the state machine's pointer listeners in skeleton space
(`viewToSkeleton` / `skeletonToView` convert). The view advances on the display's frame clock while attached and
`isPlaying`; `advance(seconds)` steps it by hand. `release()` stops sounds and scripts and frees bitmaps.

The view plays the document's sounds with `OpenBoneAudio` (usable on its own with any instance): short sounds through
a `SoundPool`, sounds longer than 5 s through a `MediaPlayer` each, with rate (0.5…2), looping, volume and fades
stepped on the frame clock. Files are read once through the `SoundSource` and cached in the app's cache folder; a play
that arrives while its sound is still loading starts when it is ready unless a stop came first. Sounds stop when the
view leaves its window or loads another document; `audio?.volume` scales everything it plays.

`CanvasRenderer` (usable on any `Canvas`) draws triangles with `drawVertices`; the two-colour tint is a colour matrix
per item (`dark + (light − dark) × texture`, exact for uniformly tinted items, which is every image), blend modes map
to `PorterDuff` modes, clipping masks to `clipPath`, particles use per-vertex colours, text uses the platform
typeface named by the attachment's font (bold from weight 600).

## Scripts: why QuickJS

State machine scripts need a JavaScript engine that runs on desktop JVMs **and** Android under a permissive licence:

- **QuickJS** (MIT), used through [quickjs-kt](https://github.com/dokar3/quickjs-kt) (Apache-2.0), which ships JNI
  builds for Linux, macOS and Windows (x64/arm64) and Android. It is the same engine the TypeScript reference runs
  scripts in (`@openbone/scripting`, quickjs-emscripten), so scripts behave identically, down to number formatting.
- GraalJS (UPL) is permissive but does not run on Android (Truffle needs HotSpot/GraalVM, not ART).
- Rhino is MPL-2.0 (excluded); Nashorn is GPL with Classpath Exception and gone from current JDKs.

`QuickJsScriptHost` mirrors `@openbone/scripting`: one runtime per script with an 8 MB heap and 512 KB stack, the
`ob` API and `console.log` defined by the same prelude, arguments and results crossing as JSON, a 16 ms deadline per
call (50 ms to load), and errors reported through the state machine's `error` listener and swallowed. Any other engine
can implement `ScriptHost` (the core has no engine dependency).

## Porting notes

The port follows the spec's §12 traps: times are summed exactly as the reference does, `%` is `fmod`, world vertices,
uvs and particle buffers are rounded to float32 (held in doubles), the curve solver is the 24-step bisection, sorts are
stable, earcut is a line-for-line port of earcut 3.2.4 (indices match), the mulberry32 RNG and FNV-1a hash wrap at 32
bits, and `JsNum` reproduces JavaScript's `String(n)`, `toFixed` (ties away from zero) and `Number(s)` for text
templates and `.obonb` float decoding (`Number(f32.toPrecision(7))`). Hit tests use JavaScript object key order to
find a slot's first bounding box.

## Dependencies and licences

| Dependency | Licence | Used by |
|---|---|---|
| QuickJS | MIT | scripting |
| quickjs-kt, kotlinx-coroutines, Kotlin stdlib | Apache-2.0 | scripting, Android |
| libGDX | Apache-2.0 | gdx, sample |
| LWJGL 3 | BSD-3-Clause | sample |
| earcut 3.2.4 (ported) | ISC | runtime (`Earcut.java`) |
| JUnit, androidx.test | EPL-2.0 / EPL-1.0, Apache-2.0 | tests only, not shipped |
| gradle-maven-publish-plugin | Apache-2.0 | build only (Maven Central publishing), not shipped |

`openbone-runtime` itself has no dependencies.
