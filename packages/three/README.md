# @openbone/three

[OpenBone](https://github.com/UXCentury/open-bone#readme) runtime for **Three.js**: an OpenBone document as an `Object3D` (a `Group` of meshes in its XY plane), with one material per atlas page, state machines, raycast pointer listeners, events, skins and sound.

## Install

```bash
npm install @openbone/three three
```

`three` (r160 or later, MIT) is a peer dependency.

## Use

```ts
import * as THREE from "three";
import { OpenBoneObject3D } from "@openbone/three";

// stencil: true is needed for clipping masks (Three.js no longer creates a stencil buffer by default).
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 1, 5000);

const hero = await OpenBoneObject3D.from("hero.obone", { stateMachine: "character" });
hero.scale.setScalar(0.01); // skeleton units → world units
scene.add(hero);
hero.bindPointer(renderer.domElement, camera); // clicks and hovers raycast onto the skeleton plane

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  hero.update(clock.getDelta());
  renderer.render(scene, camera);
});

hero.setInput("speed", 1);
hero.onOpenBone("event", (e) => console.log(e.name));
```

Skeleton units map to local units, y up, origin at the skeleton origin; `hero.artboard` is the artboard rectangle. Pointers can also come from your own raycasts: `hero.pointer("down", raycaster.ray)`. Pass `audioListener` to play sounds on a `THREE.AudioListener`'s context.

| Option | |
|---|---|
| `stateMachine` / `animation` / `loop` / `skin` | What to run and wear. |
| `scripts` | `"quickjs"` (default when the document has scripts), `"none"` or your own `ScriptHost`. |
| `audio`, `audioListener` | Sound on/off/muted, shared context. |
| `depthTest` | Test against the scene's depth (default true). OpenBone never writes depth; order comes from `renderOrder`. |
| `textResolution` | Pixels per skeleton unit for text (default 2). |
| `mipmaps` (loading) | Mipmapped textures (default true). |

## How it draws

Batches are `@openbone/render-webgl`'s (one per atlas page or texture and blend mode). Each is a `Mesh` with dynamic buffers (no per-frame allocations) and a `ShaderMaterial` shared by every batch with the same texture and blend mode, using the reference renderer's shader and blend functions (premultiplied alpha). Batches with a two-colour tint (a slot `dark` colour) use the material's `DARK` variant and an `obDark` attribute; the others never declare or upload it. Draw order is `renderOrder` inside the group. Clipping masks write a stencil reference that the clipped meshes test. Text attachments become canvas textures; particles use the built-in soft sprite.

## Demo

`pnpm --filter @openbone/examples engines`, then open http://localhost:5190/three/ (`?example=campfire`, `rocket`, `crash`…).

MIT.
