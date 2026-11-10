# @openbone/core

The OpenBone document model: types, the `.obone` and `.obonb` file formats, edit ops with undo, and validation.

[![npm](https://img.shields.io/npm/v/@openbone/core)](https://www.npmjs.com/package/@openbone/core)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package holds the data. It defines what a document
is, reads and writes it, and changes it through named **ops** (`addBone`, `setKeys`, `addTransition`, ...). The
editor, the [CLI](https://www.npmjs.com/package/@openbone/cli) and the [MCP server](https://www.npmjs.com/package/@openbone/mcp)
all edit documents through the same ops. To pose and play a document, use
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime).

It has no Node or DOM dependencies, so it runs in Node, browsers and workers. Its dependencies are `zod` (op
schemas) and `earcut` (triangulation).

## Install

```bash
npm install @openbone/core
```

```bash
pnpm add @openbone/core
```

```bash
yarn add @openbone/core
```

## Quick start

Build a small rig with ops, check it and save it:

```ts
import { writeFileSync } from "node:fs";
import { DocumentStore, createDocument, serialize, validate } from "@openbone/core";

const store = new DocumentStore(createDocument("Pendulum"));

store.apply("addBone", { name: "arm", parent: "root", rotation: -90, length: 120 });
store.apply("addSlot", { name: "arm", bone: "arm" });
store.apply("addShape", { slot: "arm", shape: "rect", width: 20, height: 120, fill: "#3366ff" });

store.apply("createAnimation", { name: "swing", duration: 2 });
store.apply("setKeys", {
  animation: "swing",
  target: "bone",
  id: "arm",
  property: "rotation",
  keys: [
    { time: 0, value: -120, curve: "easeInOut" },
    { time: 1, value: -60, curve: "easeInOut" },
    { time: 2, value: -120 },
  ],
});

console.log(validate(store.doc)); // [] when the document is sound
writeFileSync("pendulum.obone", serialize(store.doc));
```

Ops accept ids or names wherever they take a reference (`parent: "root"`, `bone: "arm"`).

## API

| Export | What it does |
|---|---|
| `createDocument(name?, opts?)` | A new empty document with a `root` bone and a `default` skin |
| `parseDocument(bytes)` | Load a document from file bytes, `.obone` (JSON) or `.obonb` (binary) |
| `serialize(doc, pretty?)` / `deserialize(json)` | Write and read the JSON format. `deserialize` checks `format` and `version`, then fills defaults |
| `serializeBinary(doc, opts?)` / `deserializeBinary(bytes)` / `isBinaryDocument(bytes)` | The compact binary format |
| `DocumentStore` | Holds a document, applies ops, keeps undo/redo history and notifies subscribers |
| `applyOp(doc, op, args)` | Validate and apply one op to a document directly (no history) |
| `registry` | `Map` of every op: name, group, description and zod schema |
| `validate(doc)` | Structural and reference checks; returns a list of issues |
| `summarize(doc)` | A short text outline of a document (bones, slots, animations, state machines, ...) |
| `exportDocument(doc, opts?)` | A copy with only the chosen animations, state machines, scripts and skins |
| `cloneDocument`, `normalizeDocument` | Deep copy; fill missing optional lists and defaults in place |
| `find.*` / `get.*` | Look up a bone, slot, animation, state machine, ... by id or name (`get` throws `RefError`) |
| `animationDuration(anim)` | Length of an animation in seconds |
| `setupWorld(doc)` | World matrices of every bone in the setup pose |
| `encodeHistory(store)` / `restoreHistory(store, saved)` | Save undo/redo history as small JSON patches and restore it |
| `layoutAtlas`, `packRects`, `atlasRegion`, `premultipliedTextures` | Texture atlas layout and lookup (pure; drawing pages is done by `@openbone/render-canvas`) |
| `lipSync(samples, sampleRate, opts?)` | Mouth-shape keys from mono audio samples |
| `traceMesh(alpha, width, height, place, opts?)` | A mesh outline traced from an image's alpha channel |
| Types | `OpenBoneDocument`, `BoneData`, `SlotData`, `Attachment`, `AnimationData`, `StateMachineData`, `InputData`, ... |

### DocumentStore

```ts
new DocumentStore(doc?: OpenBoneDocument)
```

| Member | What it does |
|---|---|
| `doc` | The current document |
| `apply(op, args?, origin?)` | Apply one op as one undo step and return its result. If the op throws, the document is left unchanged |
| `transaction(label, fn, origin?)` | Run several `apply` calls as one undo step. Everything is rolled back if `fn` throws |
| `applyQuiet(op, args?, origin?)` | Apply an op without an undo step, also to every history snapshot it fits |
| `undo()` / `redo()` | Step through history; return `false` when there is nothing to do |
| `canUndo` / `canRedo` | Whether `undo()` / `redo()` would do anything |
| `load(doc, origin?)` | Replace the document and clear the history |
| `subscribe(fn)` | `fn(doc, event)` after every change; returns an unsubscribe function |
| `history()` / `setHistory(past, future)` | Read or replace the undo and redo stacks |
| `historyLimit` | Undo steps kept (default 200) |

The change event is `{ kind, ops, origin?, quiet? }`, where `kind` is `"op"`, `"transaction"`, `"undo"`, `"redo"` or
`"load"`. `ops` lists `{ op, args }` with defaults and generated ids filled in, so replaying them on a copy of the
document gives an identical result. This is how the live bridge between the MCP server and the editor stays in sync.

```ts
import { readFileSync } from "node:fs";
import { DocumentStore, OpError, RefError, parseDocument } from "@openbone/core";

const store = new DocumentStore(parseDocument(readFileSync("knight.obone")));
const off = store.subscribe((_doc, e) => console.log(e.kind, e.ops.map((o) => o.op)));

store.transaction("Add a plume", (s) => {
  s.apply("addBone", { name: "plume", parent: "head", y: 40, length: 30 });
  s.apply("addSlot", { name: "plume", bone: "plume" });
});
store.undo();
store.redo();
off();

try {
  store.apply("addSlot", { bone: "no-such-bone" });
} catch (e) {
  // RefError: a reference was not found. OpError: unknown op or invalid arguments.
  console.log(e instanceof RefError || e instanceof OpError, (e as Error).message);
}
```

### Ops

There are over 100 ops in seven groups: `project`, `rig`, `attachment`, `constraint`, `animation`,
`interactivity` and `audio`. Each one has a zod schema and a description, which the MCP server turns into its tool
list. List them from the registry:

```ts
import { registry } from "@openbone/core";

for (const [name, def] of registry) console.log(def.group, name, "-", def.description);
```

Animation values are absolute: a rotation key of `45` means 45 degrees, not setup + 45. Key curves are `"linear"`,
`"stepped"`, bezier handles `[cx1, cy1, cx2, cy2]`, or one of `easeIn`, `easeOut`, `easeInOut` and `backOut`.
Skeleton space is y-up with angles in degrees counter-clockwise; the artboard is y-down pixels, with the skeleton
origin at `originX, originY`.

### Validation

```ts
validate(doc: OpenBoneDocument): Issue[] // Issue = { level: "error" | "warning"; path: string; message: string }
```

It checks ids, parents, references between bones, slots, skins, images, constraints, animations, state machines and
sounds, and mesh, path and clipping geometry. An empty list means the document is sound.

### File formats

`.obone` is UTF-8 JSON. `.obonb` holds the same document in a tagged binary encoding, about 40% of compact JSON, with
embedded images and sounds stored as raw bytes. Non-integer numbers are float32 by default and rounded to 7
significant digits when read; pass `{ precision: "float64" }` for a lossless file.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument, serializeBinary } from "@openbone/core";

const doc = parseDocument(readFileSync("knight.obone"));
writeFileSync("knight.obonb", serializeBinary(doc));
writeFileSync("knight-exact.obonb", serializeBinary(doc, { precision: "float64" }));
```

### Exporting a subset

```ts
import { readFileSync } from "node:fs";
import { exportDocument, parseDocument } from "@openbone/core";

const knight = parseDocument(readFileSync("knight.obone"));
const { doc, warnings, stats } = exportDocument(knight, {
  animations: knight.animations.filter((a) => a.name !== "salute").map((a) => a.id),
  nonessential: false, // drop editor-only data
});
console.log(warnings, stats); // e.g. a state that played "salute" no longer has an animation
```

Options (all optional): `animations`, `stateMachines`, `scripts` and `skins` (id lists; the default skin is always
kept), `pruneUnused` (default `true`), `nonessential` (default `true`) and `cleanUpAnimations` (default `false`).

## `@openbone/core/lite`

```ts
import { animationDuration, parseDocument, setupWorld } from "@openbone/core/lite";
```

The same types, maths, loading (`parseDocument`, `deserialize`, `deserializeBinary`), geometry, atlas, audio,
sequence, particle and text-template helpers, without the op registry, `DocumentStore`, validation, history and the
other editing helpers. It does not import zod. Use it in code that only loads and plays documents.
`@openbone/runtime` only uses names that `/lite` exports, so a play-only bundle can alias `@openbone/core` to
`@openbone/core/lite`; the `@openbone/player` bundles do this.

## Documentation

- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md): every field of `.obone` and the `.obonb` layout
- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): the op registry, the runtime model, rendering, audio and scripts
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md): loading rules and how a document is evaluated
- [MCP server](https://github.com/UXCentury/open-bone/blob/main/docs/mcp.md): the ops as agent tools
- The editor: [desktop app](https://github.com/UXCentury/open-bone/releases) or run it from the [repository](https://github.com/UXCentury/open-bone#quick-start)
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player),
  [`@openbone/export`](https://www.npmjs.com/package/@openbone/export),
  [`@openbone/mcp`](https://www.npmjs.com/package/@openbone/mcp),
  [`@openbone/cli`](https://www.npmjs.com/package/@openbone/cli)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
