# OpenBone conformance suite

Reference results from the TypeScript runtime (`packages/runtime`), so runtimes in other languages (C++, C#, Java, Swift, Dart…) can prove they pose, draw and react exactly like it. The rules they implement are in [docs/runtime-spec.md](../docs/runtime-spec.md).

```
conformance/
  fixtures.ts         focused rigs built from ops (one area each: transforms, constraints, meshes, dynamics, interactive)
  fixtures/*.obone    those rigs as files (generated; runtimes load these)
  expected/*.json     what the TypeScript runtime produced, per fixture and per example in examples/
  generate.ts         writes fixtures/ and expected/   →   pnpm conformance
  conformance.test.ts fails when the TypeScript runtime no longer matches expected/ (part of pnpm test)
```

When the runtime changes on purpose, run `pnpm conformance` and commit the new files with the change. Every other runtime then has to follow.

## Running a case

Each `expected/<name>.json` has `document` (path from the repo root), `dt` (1/60) and `sampleEvery` (10), plus a list of `cases`:

| kind | how to run it |
| --- | --- |
| `setup` | Load the document, set skin `skin`, pose the setup pose (advance 0). One sample. |
| `animation` | Load, set `skin`, play `animation` looping on track 0, then `advance(0)` and sample, then step `advance(dt)` `duration / dt` times, sampling after every `sampleEvery` steps. |
| `stateMachine` | Load, start state machine `stateMachine`, `advance(0)` and sample, then step as above. Before the step that starts at time *t*, apply every action whose `t` is within dt/2 of *t*, in order: `{input, value}` sets an input, `{fire}` fires a trigger, `{pointer, x, y}` sends a pointer event in skeleton space (y up). |

A step must do what `OpenBoneInstance.advance(dt)` does (see `packages/runtime/src/instance.ts`): update the animation state or state machine, set the setup pose, apply animations, advance physics and particles, update world transforms.

## What a sample holds

| field | meaning | tolerance |
| --- | --- | --- |
| `t` | seconds since the case started | exact (4 decimals) |
| `bones` | world matrix `[a, b, c, d, x, y]` per bone, in document order | 1e-3 for x/y, 1e-4 for a–d |
| `slots` | per slot in document order: `[attachment name or null, [r,g,b,a], [r,g,b] dark or null]` | names exact, colours 1/255 |
| `draw` | the draw list in draw order: `slot`, `attachment`, `type`, `blend`, `texture` (image or atlas page id), `vertices` (world x,y pairs), `uvs`, `indices`, `color`, optional `dark`, `colors` (per-vertex RGBA, particles), `clip` (index of the clipping mask in this sample), `text` (resolved text content) | vertices/uvs 1e-3, colours 1/255, everything else exact; particle vertices 1e-2 |
| `events` | events fired since the previous sample: `name`, `time`, `int`, `float`, `string` | exact (float 1e-4) |
| `audio` | audio commands since the previous sample (`play` / `stop` / `fade`); play ids are renumbered `p1`, `p2`… in order of appearance | exact (numbers 1e-4) |
| `states` | state machines only: the active state per layer after the step | exact |

Numbers are rounded to 4 decimals and `-0` is written as `0`; round the same way (or compare with the tolerances above).

## Fixtures

| fixture | covers |
| --- | --- |
| `transforms` | every inherit mode, shear, non-uniform scale, all curve types (linear, stepped, presets, custom bezier with overshoot), colour, dark colour, attachment and draw-order keys, events with payloads |
| `constraints` | 2-bone IK with softness, stretch, bend keys and mix keys; 1-bone IK with stretch/compress/uniform; world and local/relative transform constraints with offsets |
| `meshes` | weighted mesh with deform keys, a linked mesh in another skin that follows them, an ellipse clipping mask, a path constraint (chain rotate mode) with a keyed position, two-colour tint |
| `dynamics` | physics chain (inertia, strength, damping, gravity, wind) driven by a moving root, a bone-driven slider, a ping-pong sequence, a seeded particle emitter, a text template |
| `interactive` | a state machine with number / trigger / bool / number / string inputs, a blend1d state, any-state transition, exit time, a pointer listener on a hit box (fire trigger + report event), an input binding, an event that plays a sound, and a script that counts clicks into a text template |
| `example-*` | every project in `examples/`, all animations and state machines |
| `atlas-knight`, `atlas-walker` | the knight and walker packed into a texture atlas: uv remapping, trimmed regions, one shared page |
