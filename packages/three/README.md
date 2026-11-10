# @openbone/three

OpenBone runtime for Three.js: an OpenBone document as an `Object3D`, with one material per atlas page.

[![npm](https://img.shields.io/npm/v/@openbone/three)](https://www.npmjs.com/package/@openbone/three)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package puts an OpenBone document into a Three.js
scene as a `Group` of meshes in its XY plane, with state machines, raycast pointer listeners, events, skins, scripts
and sound. Playback comes from [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit); each mesh
is one batch of the reference renderer, [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
drawn with the same shader maths and blend functions.

## Install

```bash
npm install @openbone/three three
```

`three` is a peer dependency (r160 or later: `>=0.160.0`). It uses `WebGLRenderer`.

## Quick start

```ts
import * as THREE from "three";
import { OpenBoneObject3D } from "@openbone/three";

// stencil: true is needed for clipping masks (Three.js no longer creates a stencil buffer by default).
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setSize(900, 600);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 900 / 600, 0.1, 100);
camera.position.set(0, 0, 10);

const knight = await OpenBoneObject3D.from("/knight.obone", { stateMachine: "knight" });
knight.scale.setScalar(0.01); // skeleton units -> world units
const a = knight.artboard; // in skeleton units, y up
knight.position.set(-(a.x + a.width / 2) * 0.01, -(a.y + a.height / 2) * 0.01, 0); // centre the artboard
scene.add(knight);
knight.bindPointer(renderer.domElement, camera); // clicks and hovers raycast onto the skeleton's plane

knight.setInput("walk", true);
knight.onOpenBone("stateChange", (e) => console.log(e.layer, e.from, "->", e.to));

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  knight.update(clock.getDelta());
  renderer.render(scene, camera);
});
```

`knight.obone` is in the repository's `examples/` folder. Skeleton units map to local units, y up, with the skeleton
origin at the object's origin. Unlike the other engine objects, this one does not tick itself: call `update(dt)` from
your loop.

## API

| Export | |
|---|---|
| `OpenBoneObject3D` | The object (a `THREE.Group`). `await OpenBoneObject3D.from(src, options)` loads and creates it. |
| `loadOpenBone(src, options)` | Loads a document and its textures into an `OpenBoneAsset` that many objects can share. |
| `OpenBoneAsset` | `{ doc, baseUrl, textures }` (one `THREE.Texture` per image or atlas page id). |
| `prepareTexture(texture, mipmaps?, premultiplied?)` | Configures a texture the way OpenBone samples it (premultiplied, no flip, no colour space conversion, clamped). |
| `BLEND_FACTORS` | render-webgl's blend functions as Three.js factors. |
| `OpenBoneObjectOptions`, `LoadOptions`, `DriverOptions`, `InputValue`, `OpenBoneSource` | Option and value types. |

`src` is a URL, bytes (`ArrayBuffer` or `Uint8Array` of a `.obone` or `.obonb` file), a parsed document or, for
`OpenBoneObject3D.from`, an `OpenBoneAsset`.

### Options

| Option | Default | |
|---|---|---|
| `stateMachine` / `animation` / `loop` | first state machine, else first animation | What to run. |
| `skin` | default skin | Skin (outfit) by name or id. |
| `scripts` | `"quickjs"` when the document has scripts | `"none"` or your own `ScriptHost`. |
| `audio` | `true` | `false` or `"muted"`. |
| `audioListener` | | Play sounds on a `THREE.AudioListener`'s context. |
| `audioContext`, `audioBaseUrl`, `resolveAudioUrl`, `unlockTarget`, `onEvent`, `onStateChange` | | As in engine-kit. |
| `depthTest` | `true` | Test against the scene's depth. OpenBone never writes depth; order comes from `renderOrder`. |
| `textResolution` | `2` | Pixels per skeleton unit for text. |
| `baseUrl`, `fetch` (loading) | the document's folder | Where relative image and audio paths load from, and the fetch to use. |
| `resolveImageUrl(src)` (loading) | | Map an image path to the URL to load. |
| `mipmaps` (loading) | `true` | Mipmapped textures: smoother when the object is small or seen at an angle. |

### Methods and properties

| Member | |
|---|---|
| `update(dt)` | Advance by `dt` seconds and rebuild the meshes. Call it every frame. |
| `setInput(name, value)`, `getInput(name)`, `fire(name)` | State machine inputs and triggers. |
| `play(animation, loop?)`, `useStateMachine(name?)` | Switch to an animation or a state machine. |
| `setSkin(name)`, `setText(slot, text)` | Outfit, and text for a slot's text attachment (`null` restores it). |
| `pause()`, `resume()`, `paused`, `speed` | Playback; pausing also pauses sounds. |
| `opacity` | Opacity of the whole object. |
| `onOpenBone(name, fn)` | Listen to `"event"`, `"stateChange"` or `"audio"`. Returns an unsubscribe function. |
| `artboard` | The artboard rectangle in local space (skeleton units, y up; `x, y` is the bottom-left corner). |
| `bindPointer(dom, camera)` | Raycast a canvas's pointer events through `camera` to the state machine. Returns an unbind function. |
| `pointer(type, ray)`, `rayToSkeleton(ray)` | Send your own ray (for example `raycaster.ray`), or find where it hits the plane. |
| `boundingBoxes()`, `skeletonToWorld(x, y)` | Bounding-box queries in skeleton space (y up): `const p = obj.rayToSkeleton(raycaster.ray); const hit = p && obj.boundingBoxes().containsPoint(...p)`. `skeletonToWorld` maps a skeleton point back to world space. |
| `redraw()`, `drawCalls` | Rebuild meshes after changing the pose by hand; batches drawn by the last redraw. |
| `driver`, `instance`, `skeleton`, `stateMachine`, `asset` | Lower-level access. |
| `dispose()` | Frees geometry, materials and text textures. The asset's textures are kept, since they may be shared. |

### Pointer input

`bindPointer` listens to `pointerdown`, `pointerup`, `pointermove` and `pointerleave` on the element, raycasts each
point onto the object's plane and sends hits inside the artboard to the state machine's listeners. Leaving the
artboard ends hovers. For VR controllers or custom picking, call `pointer("down", ray)` yourself.

## How it draws

Batches are render-webgl's (one per atlas page or texture and blend mode). Each is a `Mesh` with dynamic buffers (no
per-frame allocations) and a `ShaderMaterial` shared by every batch with the same texture and blend mode, using the
reference renderer's shader and blend functions in premultiplied alpha. Straight-alpha images are premultiplied on
upload; premultiplied atlas pages are uploaded as they are.

- **Two-colour tint**: batches with a slot `dark` colour use the material's `DARK` variant and an `obDark` attribute;
  the others never declare or upload it.
- **Draw order** is `renderOrder` inside the group, which sorts as one unit against the rest of the scene.
- **Clipping** masks write a stencil reference that the clipped meshes test. Create the renderer with
  `stencil: true`; without it the object logs a warning and clipping cannot work.
- **Text** attachments become canvas textures; **particles** use the built-in soft sprite.

## Demo

From a checkout: `pnpm --filter @openbone/examples engines`, then open http://localhost:5190/three/
(`?example=campfire`, `rocket`, `crash`…).

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Demo source](https://github.com/UXCentury/open-bone/blob/main/examples/engines/three/main.ts)
- Related packages: [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit),
  [`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
  [`@openbone/phaser`](https://www.npmjs.com/package/@openbone/phaser),
  [`@openbone/canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
