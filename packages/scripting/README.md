# @openbone/scripting

Runs OpenBone state machine scripts in a QuickJS (WebAssembly) sandbox.

[![npm](https://img.shields.io/npm/v/@openbone/scripting)](https://www.npmjs.com/package/@openbone/scripting)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. A document can carry small JavaScript scripts that react
to inputs, pointer events and animation events, for example to ease an input, scroll a background or count clicks.
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime) runs them through a pluggable `ScriptHost`, and
skips them when no host is given. This package provides the host to use for content you did not write:
`createQuickJsHost()` gives every script its own QuickJS runtime with a memory cap and a time limit per call.
[`@openbone/player`](https://www.npmjs.com/package/@openbone/player) loads it on its own when a document has scripts.

It works in Node and in browsers. QuickJS comes from
[`quickjs-emscripten`](https://www.npmjs.com/package/quickjs-emscripten) (MIT), which loads its WebAssembly module the
first time a host is created.

## Install

```bash
npm install @openbone/core @openbone/runtime @openbone/scripting
```

```bash
pnpm add @openbone/core @openbone/runtime @openbone/scripting
```

```bash
yarn add @openbone/core @openbone/runtime @openbone/scripting
```

## Quick start

The Walker example has two scripts: one eases the `speed` input towards the `walk` switch, the other scrolls the
background.

```ts
import { readFileSync } from "node:fs";
import { parseDocument } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";

const scriptHost = await createQuickJsHost(); // loads the QuickJS WebAssembly module
const walker = new OpenBoneInstance(parseDocument(readFileSync("walker.obone")), { scriptHost });
const sm = walker.useStateMachine();

sm.on("log", (args) => console.log("[script]", ...args)); // console.log / ob.log in scripts
sm.on("error", (err) => console.error(err.message)); // exceptions and timeouts

sm.setInput("walk", true);
for (let i = 0; i < 60; i++) walker.advance(1 / 60);
console.log(sm.getInput("speed")); // close to 1: the script eased it up

walker.dispose(); // frees each script's QuickJS runtime
```

## API

| Export | What it does |
|---|---|
| `createQuickJsHost(options?)` | Returns a `Promise<ScriptHost>` to pass as `scriptHost` to `OpenBoneInstance` or `StateMachineInstance` |
| `QuickJsHostOptions` | Options type (below) |
| `ScriptHost`, `ScriptHandle`, `ScriptApi` | Re-exported from `@openbone/runtime` |

### createQuickJsHost(options?)

| Option | Default | What it does |
|---|---|---|
| `timeoutMs` | `16` | CPU time allowed for one call into a script, in milliseconds. Loading a script (running its top-level code) gets at least 50 ms |
| `memoryLimit` | `8 * 1024 * 1024` | Heap limit per script, in bytes |
| `module` | loaded on first use | A QuickJS WebAssembly module from `quickjs-emscripten` (for example `await getQuickJS()`), to share one module between hosts |

One host can serve many instances. Every script loaded through it gets a fresh QuickJS runtime and context. The
stack is limited to 512 KB.

```ts
import { createQuickJsHost } from "@openbone/scripting";

const host = await createQuickJsHost({ timeoutMs: 10, memoryLimit: 4 * 1024 * 1024 });
```

## Writing scripts

A script is plain JavaScript that defines any of these global functions:

| Function | When it runs |
|---|---|
| `onStart()` | Machine scripts: on the first `advance`. State scripts: each time the state is entered |
| `onUpdate(dt)` | Every `advance`: machine scripts, then the scripts of the current states |
| `onPointer({ type, x, y })` | Each queued pointer event, before listeners (machine scripts only) |
| `onEvent(e)` | After posing, for each event fired that frame |

A listener's `runScript` action can also call any other named function in a script.

Scripts see one global, `ob`, plus `console.log` (which goes to `ob.log`):

| `ob` | What it does |
|---|---|
| `time()` | Seconds since the state machine started |
| `input(name)`, `setInput(name, value)`, `fire(name)` | Read and change inputs by name or id |
| `emit(name, { int, float, string })` | Fire an event (plays its sound, if it has one) |
| `bone(name)` | `{ x, y, rotation, scaleX, scaleY, worldX, worldY, worldRotation }`, or `null` |
| `setBone(name, props)` | Override local `x`, `y`, `rotation`, `scaleX`, `scaleY`, `shearX`, `shearY` |
| `slot(name, { color, attachment })` | Override a slot's colour or attachment |
| `pointer()` | `{ x, y, down }` in skeleton space |
| `log(...args)` | Sent to the state machine's `log` event |

```js
// Count frames and turn the head with the count.
function onUpdate(dt) {
  const n = ob.input("count") + 1;
  ob.setInput("count", n);
  ob.setBone("head", { rotation: n * 10 });
}
function onEvent(e) {
  console.log("event", e.name);
}
```

Overrides from `setBone` and `slot` persist and are applied every frame until the host app calls
`clearOverrides()` on the state machine. Attach scripts to a whole state machine or to one state with the
`addScript` and `attachScript` ops from [`@openbone/core`](https://www.npmjs.com/package/@openbone/core), or in the
editor.

## Security model

- **Isolation.** Each script runs in its own QuickJS runtime. Scripts have no DOM, network, timers, file system,
  `process` or host globals. The only way out is `ob`.
- **JSON boundary.** Every `ob` call goes through a single bridge function, and arguments and return values cross
  it as JSON strings. A script never gets a reference to a host object, and only the `ob` methods listed above can
  be called.
- **CPU limit.** An interrupt handler stops a call that runs past its deadline (`timeoutMs`). An endless loop is
  stopped with an `InternalError: interrupted`.
- **Memory limit.** A script that allocates past `memoryLimit` fails instead of growing the host's memory.
- **Errors stay contained.** An exception or timeout in a script is reported on the state machine's `error`
  event and the frame continues. If you call a `ScriptHandle` directly, `call()` throws instead.

The runtime also exports `trustedFunctionHost`, which runs scripts with `new Function` in your own JavaScript realm.
It has none of these protections; use it only for your own files and tests.

## Documentation

- [Runtime specification, scripts](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md#11-scripts): hooks, the `ob` API and when overrides apply
- [Architecture, scripts](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md#scripts): how hosts work across the web and native runtimes
- [File format, state machines](https://github.com/UXCentury/open-bone/blob/main/docs/format.md#state-machines): where scripts live in a document
- The editor: [desktop app](https://github.com/UXCentury/open-bone/releases) or run it from the [repository](https://github.com/UXCentury/open-bone#quick-start)
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/core`](https://www.npmjs.com/package/@openbone/core),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
