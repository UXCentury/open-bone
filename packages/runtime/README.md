# @openbone/runtime

The reference OpenBone runtime: poses skeletons, mixes animations and runs state machines. It does not render.

[![npm](https://img.shields.io/npm/v/@openbone/runtime)](https://www.npmjs.com/package/@openbone/runtime)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package takes a document loaded with
[`@openbone/core`](https://www.npmjs.com/package/@openbone/core) and turns it into a pose every frame: bones,
constraints (IK, transform, path, physics), animation tracks with cross-fades, state machines with inputs and pointer
listeners, events, particles, text and audio commands. The result is a renderer-agnostic **draw list**. Draw it with
[`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
[`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas) or an engine package
([PixiJS](https://www.npmjs.com/package/@openbone/pixi), [Phaser](https://www.npmjs.com/package/@openbone/phaser),
[Three.js](https://www.npmjs.com/package/@openbone/three), [CanvasKit](https://www.npmjs.com/package/@openbone/canvaskit)),
or use [`@openbone/player`](https://www.npmjs.com/package/@openbone/player), which does all of it for you.

The runtime has no DOM, audio or Node dependencies. It runs the same in browsers, Node and workers. The native
runtimes (C++, C#, Java, Swift, Flutter, Haxe) are ports of this one and are tested against its output.

## Install

```bash
npm install @openbone/core @openbone/runtime
```

```bash
pnpm add @openbone/core @openbone/runtime
```

```bash
yarn add @openbone/core @openbone/runtime
```

Add [`@openbone/scripting`](https://www.npmjs.com/package/@openbone/scripting) if your documents use scripts.

## Quick start

```ts
import { readFileSync } from "node:fs";
import { parseDocument } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";

const knight = new OpenBoneInstance(parseDocument(readFileSync("knight.obone")));

knight.play("walk"); // loops by default
for (let i = 0; i < 30; i++) knight.advance(1 / 60);

const items = knight.drawList(); // back to front: world vertices, uvs, indices, colour, blend mode
console.log(items.length, items[0].slot.name);

const head = knight.skeleton.findBone("head")!;
console.log(head.worldX, head.worldY, head.worldRotation);
```

In a browser, load the bytes with `fetch` instead: `parseDocument(new Uint8Array(await res.arrayBuffer()))`.

## API

| Export | What it does |
|---|---|
| `OpenBoneInstance` | One skeleton driven by an `AnimationState` or a state machine. The usual entry point |
| `Skeleton` | Bones, slots, skins and constraints; solves world transforms and builds the draw list |
| `AnimationState` / `TrackEntry` | Plays animations on numbered tracks with cross-fades and a queue |
| `StateMachineInstance` | Runs a state machine: inputs, layers, transitions, listeners, scripts |
| `AudioDirector`, `AudioCommand` | Turns sound triggers into `play` / `stop` / `fade` commands for an audio backend |
| `ScriptHost`, `ScriptApi`, `trustedFunctionHost` | The script engine interface, and an unsandboxed host for trusted content |
| `applyAnimation`, `seekAnimation`, `eventsBetween` | Low-level timeline sampling and deterministic posing |
| `animationAudioSchedule` | Every sound an animation plays, with times (for rendering audio offline) |
| `ParticleEmitter`, `PARTICLE_DOT_TEXTURE`, `particleDotAlpha` | Particle simulation and the built-in soft dot sprite renderers draw |
| `drawTextBox`, `cssFont`, `cssColor` | Helpers for renderers that draw text attachments on a 2D canvas |
| `solvePose`, `poseChainFrom` | Drag-to-pose IK used by editor tools |
| Types | `DrawItem`, `FiredEvent`, `TextDraw`, `ClipRegion`, `StateMachineOptions`, ... |

### OpenBoneInstance

```ts
new OpenBoneInstance(doc: OpenBoneDocument, options?: { scriptHost?: ScriptHost | null })
```

| Member | What it does |
|---|---|
| `play(animation, loop = true, track = 0)` | Play an animation by name or id (stops the state machine); returns the `TrackEntry` |
| `useStateMachine(name?)` | Start a state machine by name or id (default: the first one); returns the `StateMachineInstance` |
| `advance(dt)` | Step time by `dt` seconds and pose the skeleton |
| `pointer(type, x, y)` | Forward `"down"`, `"up"` or `"move"` in skeleton space to the state machine |
| `artboardToSkeleton(px, py)` | Convert artboard pixels (y-down, top-left origin) to skeleton space (y-up) |
| `drawList()` | The `DrawItem[]` for the current pose |
| `on(type, fn)` | Subscribe to `"event"`, `"stateChange"` or `"audio"`; returns an unsubscribe function |
| `dispose()` | Stop every sound and release the state machine's scripts |
| `skeleton`, `animationState`, `stateMachine`, `doc` | The parts it drives |

### Time stepping

Call `advance(dt)` once per frame with the elapsed seconds. Each frame the runtime resets to the setup pose, applies
the animation tracks or state-machine layers, then script overrides and input bindings, solves bones and constraints,
and builds the draw list. Physics constraints and particles run at fixed steps inside `advance`, so the same
sequence of `dt` values always gives the same result.

### Animations and mixing

```ts
import { readFileSync } from "node:fs";
import { parseDocument } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";

const inst = new OpenBoneInstance(parseDocument(readFileSync("knight.obone")));
const state = inst.animationState;
state.defaultMix = 0.25; // cross-fade seconds (default 0.2)

state.on("complete", (entry, track) => console.log("done", track, entry.animation.name));
state.setAnimation(0, "idle");
state.addAnimation(0, "attack", false, 1); // after 1 s on track 0
state.addAnimation(0, "idle"); // once attack completes

for (let i = 0; i < 180; i++) inst.advance(1 / 60);
```

- `setAnimation(track, anim, loop = true, mix = defaultMix)` replaces what a track plays, cross-fading over `mix` seconds.
- `addAnimation(track, anim, loop = true, delay = 0, mix = defaultMix)` queues an animation. It starts after `delay`
  seconds, or when the current one completes (or finishes a loop) if `delay` is 0.
- Higher tracks are applied on top of lower ones. `clearTrack(track)` and `clearTracks()` stop them.
- `TrackEntry` has `speed`, `alpha`, `time`, `localTime`, `duration` and `isComplete`.
- `AnimationState` events: `start`, `complete`, `event` and `audio`.

### State machines and inputs

```ts
import { readFileSync } from "node:fs";
import { parseDocument } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";

const walker = new OpenBoneInstance(parseDocument(readFileSync("walker.obone")));
const sm = walker.useStateMachine("character");

sm.on("stateChange", ({ layer, from, to }) => console.log(`[${layer}] ${from} -> ${to}`));
walker.on("event", (e) => console.log("event", e.name, e.time));

sm.setInput("walk", true);
for (let i = 0; i < 60; i++) walker.advance(1 / 60);
sm.fire("jump");
for (let i = 0; i < 90; i++) walker.advance(1 / 60);
console.log(sm.activeStates); // { "Layer 1": "locomotion" }

// A click at artboard pixel (400, 300): listeners hit-test slots in skeleton space.
const [x, y] = walker.artboardToSkeleton(400, 300);
walker.pointer("down", x, y);
walker.pointer("up", x, y);
walker.advance(1 / 60);
```

| `StateMachineInstance` member | What it does |
|---|---|
| `setInput(name, value)`, `setBool`, `setNumber`, `setString` | Set an input by name or id. Values are coerced to the input's type |
| `fire(name)` | Fire a trigger input for the next `advance` |
| `getInput(name)`, `inputs` | Read input values (`inputs` is keyed by input id) |
| `activeStates` | Current state name per layer |
| `pointer(type, x, y)` | Queue a pointer event in skeleton space; handled on the next `advance` |
| `setText(slot, text)` | Show fixed text or a template in a text attachment; `null` restores its own |
| `setEmitter(slot, emitting)` | Switch a particle emitter on or off |
| `clearOverrides()` | Clear bone and slot overrides set by scripts |
| Events | `stateChange`, `inputChange`, `event`, `audio`, `log` and `error` (script output and failures) |

Inputs are `bool`, `number`, `string` or `trigger`. A state's entry can set inputs too, so set an input after the
first `advance` if the entry state also sets it. Throws when the named input does not exist.

Scripts only run when you pass a `scriptHost`. Without one, they are skipped and the runtime prints a warning once per
document; pass `scriptHost: null` to run without scripts on purpose, with no warning. Use
`createQuickJsHost()` from [`@openbone/scripting`](https://www.npmjs.com/package/@openbone/scripting) for any content
you did not write. `trustedFunctionHost` runs scripts with `new Function` in your own realm and is **not** a sandbox.

### Events and audio commands

Events come from animation keys, listeners and scripts as `FiredEvent`: `{ name, id, time, int, float, string,
animation, audio?, volume? }`.

The runtime never plays sound. It emits `AudioCommand`s that an audio backend turns into sound (the
`@openbone/player` package has a Web Audio one):

- `{ type: "play", id, sound, asset, bus, volume, rate, loop, fadeIn, source }`
- `{ type: "stop", id, fade }`
- `{ type: "fade", id, volume, duration }`

`volume` does not include the bus and master gain; the backend applies those from `doc.audio`. Each track entry and
state owns the sounds it starts, and its looping sounds stop when it ends.

```ts
walker.on("audio", (cmd) => {
  if (cmd.type === "play") console.log("play", cmd.sound, "from", cmd.source); // e.g. "key:jump", "event:land"
});
```

### Skins, text, particles and physics

```ts
import { readFileSync } from "node:fs";
import { parseDocument } from "@openbone/core";
import { OpenBoneInstance, Skeleton, seekAnimation } from "@openbone/runtime";

// Text: templates such as "{multiplier:0.00}x" read the running state machine's inputs by name.
const crash = new OpenBoneInstance(parseDocument(readFileSync("crash.obone")));
const game = crash.useStateMachine();
crash.advance(0); // enter the entry state, which sets its own input values
game.setNumber("multiplier", 2.5);
game.setText("button-label", "CASH OUT");
crash.advance(1 / 60);
for (const item of crash.drawList()) if (item.text) console.log(item.slot.name, item.text.content); // "2.50x", ...

// Particles advance in real time with advance(dt); bursts can come from code.
const rocket = new OpenBoneInstance(parseDocument(readFileSync("rocket.obone")));
rocket.play("launch");
rocket.skeleton.emitParticles("sparks", 20);
for (let i = 0; i < 30; i++) rocket.advance(1 / 60);

// Deterministic posing at any time (exports, scrubbing): the same particles for the same time.
const doc = parseDocument(readFileSync("rocket.obone"));
const sk = new Skeleton(doc);
seekAnimation(sk, doc.animations.find((a) => a.name === "launch")!, 1.5);

// Placement, skins and physics.
sk.x = 100;
sk.scaleX = -1; // mirror
sk.setSkin(null); // a skin by name or id; null = only the default skin
sk.resetPhysics(); // next frame starts at rest on the animated pose
```

Each `DrawItem` holds a `slot`, world `vertices`, `uvs`, `indices`, `color`, optional `dark` (two-colour tint),
`blend`, the `texture` to bind (image or atlas page), and optional `clip` (clipping mask), `colors` and `particles`
(particle batches) and `text` (text attachments).

### Skeleton without OpenBoneInstance

```ts
sk.setToSetupPose();
// apply animations here, e.g. applyAnimation(sk, anim, time, alpha)
sk.update(dt); // feeds physics and particles
sk.updateWorldTransform(); // bones, then constraints in their order
const items = sk.drawList();
```

## Documentation

- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md): the exact per-frame order, maths and state-machine rules
- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model, rendering, audio and scripts
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md): what a document contains
- The editor: [desktop app](https://github.com/UXCentury/open-bone/releases) or run it from the [repository](https://github.com/UXCentury/open-bone#quick-start)
- Related packages: [`@openbone/core`](https://www.npmjs.com/package/@openbone/core),
  [`@openbone/scripting`](https://www.npmjs.com/package/@openbone/scripting),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player),
  [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
  [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
