# @openbone/phaser

[OpenBone](../../README.md) runtime for **Phaser 3** (3.60 or later): a scene plugin with a loader file type and a GameObject that plays OpenBone documents, with state machines, pointer listeners, events, skins and sound.

## Install

```bash
npm install @openbone/phaser phaser@3
```

`phaser` (3.x, MIT) is a peer dependency.

## Use

```ts
import * as Phaser from "phaser";
import { OpenBonePlugin } from "@openbone/phaser";

class Level extends Phaser.Scene {
  preload() {
    // .obone or .obonb; images load relative to the file (atlas pages when packed).
    this.load.openbone("hero", "assets/hero.obone");
  }
  create() {
    const hero = this.add.openbone(400, 500, "hero", { stateMachine: "character" });
    hero.setInput("speed", 1).fire("jump");
    hero.onOpenBone("event", (e) => console.log(e.name));
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  plugins: { scene: [{ key: "OpenBonePlugin", plugin: OpenBonePlugin, mapping: "openbone" }] },
  scene: Level,
});
```

The object's x/y is the skeleton origin; it supports position, rotation, scale, depth, alpha, visibility and scroll factor like any GameObject, and advances on the scene's update. Pointer events over its artboard (`hero.artboard`, in local space) reach the state machine's listeners (`interactive: false` turns that off). Sounds play through Phaser's own `AudioContext`. Documents with scripts load the QuickJS sandbox while preloading (`this.load.openbone(key, url, { scripts: false })` skips it).

Options for `this.add.openbone`: `stateMachine`, `animation`, `loop`, `skin`, `audio` (`true`/`false`/`"muted"`), `scripts`, `interactive`. Methods: `setInput`, `getInput`, `fire`, `setSkin`, `setText`, `play`, `useStateMachine`, `pause`, `resume`, `speed`, `onOpenBone`.

## How it draws

- **WebGL**: the pose is grouped into `@openbone/render-webgl`'s batches and streamed into Phaser's MultiPipeline, which can merge several textures into one draw call. Vertex colours use Phaser's tint (8 bits per channel). Batches with a two-colour tint (a slot `dark` colour) go through `OpenBoneTwoColorPipeline`, a MultiPipeline with a second packed colour per vertex, registered on the renderer the first time it is needed. Blend modes map to Phaser's (additive is registered as ONE, ONE like the reference renderer). Clipping masks write the stencil buffer, so an OpenBone object with clipping should not itself be inside a Phaser geometry mask. Text is rasterised to canvas textures; particles use the built-in soft sprite.
- **Canvas**: drawn by `@openbone/render-canvas` in the object's transform.

## Demo

`pnpm --filter @openbone/examples engines`, then open http://localhost:5190/phaser/ (`?canvas` for the Canvas renderer, `?example=campfire` for other examples).

MIT.
