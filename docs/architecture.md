# Architecture

```
            ┌──────────── edits (ops) ────────────┐
 Editor ────┤                                     ├──── MCP server ◄── AI agent
 (Solid)    │  @openbone/core  DocumentStore      │     (64 tools)
   ▲        │  op registry · undo · validate      │        │
   │        └─────────────────────────────────────┘        │
   │  live bridge (WebSocket, ops replayed both ways)  ◄───┘
   │
   ▼
 @openbone/runtime  Skeleton · AnimationState · StateMachineInstance · ScriptHost
   │                            │
   ▼                            ▼
 render-webgl / render-canvas   scripting (QuickJS sandbox)
   │
   ▼
 player (<openbone-player>), CLI/MCP previews (PNG/GIF)
```

## One op registry for everything

Every change to a document is a named **op** (`addBone`, `setKeys`, `addTransition`, …) defined once in
`packages/core/src/ops/*.ts` with a zod schema, a description and an `apply(doc, args)` function.

- The **editor** calls ops through `DocumentStore.apply` (undo and redo are document snapshots).
- The **MCP server** turns every op into a tool automatically (`addBone` → `add_bone`), using the zod schema as the tool input schema and the description as the tool description. Adding an op adds a tool.
- The **live bridge** sends ops over WebSocket. Generated ids are written back into the op args before broadcast, so replaying an op on another replica yields an identical document.
- The **CLI** `apply` command runs any op against a file.

References accept **ids or names** everywhere, which keeps agent prompts short.

## Runtime model

- Skeleton space is **y-up**, with rotations in degrees counter-clockwise. The artboard is y-down pixels; `originX/originY` place skeleton (0,0).
- Animation values are **absolute** (Rive-like): a key says "rotation = 45", not "setup + 45". Each frame the runtime resets to the setup pose, applies layers or tracks with their alpha, applies script overrides, then solves the world transforms and constraints.
- IK is analytic (law of cosines) in world space. Transform constraints blend world matrices.
- State machine frame: pointer events → listeners → script `onUpdate` → transitions (specific before any-state; a transition with no conditions waits for exit time 1) → advance → pose → events → script `onEvent`.
- Blend states report events only from their dominant animation.

## Scripts

Scripts are plain JavaScript run through a `ScriptHost`. `@openbone/scripting` gives each script its own QuickJS runtime with a memory cap and a per-call deadline. Values cross the boundary as JSON through a single bridge function, so scripts cannot reach host objects. `trustedFunctionHost` (in the runtime) is available for trusted content and tests.

## Rendering

The runtime produces a renderer-agnostic draw list: world vertices, uvs, indices, colour and blend mode per slot. WebGL2 batches by texture and blend mode. Canvas2D maps each textured triangle with an affine transform and fills vector shapes as paths.
