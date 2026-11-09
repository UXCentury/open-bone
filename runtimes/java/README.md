# OpenBone for Java, libGDX and Android

A native Java port of the TypeScript runtime (`packages/runtime`), a libGDX renderer and a Kotlin Android view. It
loads `.obone` and `.obonb` files and implements everything in [docs/runtime-spec.md](../../docs/runtime-spec.md):
skeletons, skins and skin bones, every attachment type, animation mixing, IK / transform / path / physics constraints
in custom order, sliders, sprite sequences, particles (same RNG), text templates, the draw list, state machines with
listeners and input bindings, events, audio commands and scripts.

It passes the whole conformance suite: all 82 cases of the 18 files in [`conformance/expected`](../../conformance/expected),
on the JVM and on an Android emulator.

| Module | Language | What it is |
|---|---|---|
| `openbone-runtime` | Java 11, no dependencies | The runtime: `DocumentLoader`, `OpenBoneInstance`, `Skeleton`, `AnimationState`, `StateMachineInstance`, `DrawItem`s |
| `openbone-scripting` | Kotlin (JVM, Android) | `QuickJsScriptHost`: state machine scripts in QuickJS |
| `openbone-gdx` | Java 11 | `OpenBoneRenderer` for libGDX: two-colour tint shader, blend modes, stencil clipping, particles, text |
| `openbone-gdx-sample` | Java 11 | LWJGL3 desktop sample (mouse → listeners, events and audio commands in the log) |
| `openbone-android` | Kotlin, Android library | `OpenBoneView`: a `View` with a Kotlin API (inputs, triggers, events as lambdas, touch → pointer listeners) |
| `openbone-conformance` | Java tests | JUnit runner for `conformance/expected/*.json`, plus unit tests for the porting traps |

## Build and test

Java 17+ to run Gradle (the libraries target Java 11). The Gradle wrapper fetches Gradle and the Kotlin plugin.

```bash
cd runtimes/java
./gradlew test
```

`test` runs the conformance suite (`openbone-conformance`) and the unit tests. Run one file with
`./gradlew :openbone-conformance:test -Dopenbone.only=example-knight`.

The Android library is built when an Android SDK is found (`local.properties` `sdk.dir`, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, or the default `~/Android/Sdk`; it then writes `local.properties` for the Android plugin). Without
an SDK the build skips `:openbone-android` and says so. It needs SDK platform 36:

```bash
./gradlew :openbone-android:assembleRelease
./gradlew :openbone-android:connectedDebugAndroidTest   # all conformance cases + the view, on a device or emulator
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
  @Override public void audio(AudioCommand c) { audioBackend.handle(c); } // play / stop / fade
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

Audio: the runtime never plays sound. It emits `AudioCommand`s (`play` with sound, asset, bus, volume, rate, loop,
fade-in; `stop` with a fade; `fade`); feed them to your audio API and apply `doc.audio` bus and master volumes.

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

## Android (Kotlin)

```kotlin
val view = OpenBoneView(context)
view.load(assets.open("knight/knight.obone").readBytes(), ImageSource.assets(assets, "knight"))
view.useStateMachine("knight")                 // or view.play("walk")
view.onEvent { e -> if (e.name == "footstep") playStep() }
view.onStateChange { layer, from, to -> Log.d("anim", "$layer: $from → $to") }
view.onAudio { cmd -> soundBackend.handle(cmd) }
view["walk"] = true                            // inputs: Boolean, Number or String
view.fire("attack")
view.setText("score", "{points:#,##0}")
view.fit = OpenBoneView.Fit.CONTAIN            // CONTAIN, COVER, FILL, NONE
```

Touch (`down`, `move`, `up`) and mouse/stylus hover reach the state machine's pointer listeners in skeleton space
(`viewToSkeleton` / `skeletonToView` convert). The view advances on the display's frame clock while attached and
`isPlaying`; `advance(seconds)` steps it by hand. `release()` stops sounds and scripts and frees bitmaps.

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

`openbone-runtime` itself has no dependencies.
