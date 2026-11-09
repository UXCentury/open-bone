# @openbone/engine-kit

Shared plumbing for the OpenBone game-engine runtimes ([`@openbone/pixi`](../pixi), [`@openbone/phaser`](../phaser), [`@openbone/three`](../three), [`@openbone/canvaskit`](../canvaskit)). You only need it directly to write a runtime for another engine.

- **`loadDocument(src, { baseUrl, fetch })`**: fetch and parse a `.obone` (JSON) or `.obonb` (binary) document, or take bytes / a parsed document. Returns the document and the folder its relative image and audio paths resolve against.
- **`textureRequests(doc, baseUrl)` / `loadTextures(doc, baseUrl, { load })`**: the textures to load (atlas pages when the document is packed, otherwise each image with a source), with URLs resolved.
- **`OpenBoneDriver`**: one `OpenBoneInstance` (posing, animations, state machines, listeners, events, scripts) plus Web Audio playback through `WebAudioBackend` from `@openbone/player`, optionally on the engine's own `AudioContext`. `setInput`, `fire`, `setSkin`, `setText`, `play`, `pointer(type, x, y)` in skeleton space, `pointerLeave()`, `speed`, `pause()`/`resume()`.
- **`buildBatches(drawList, { hasTexture })`**: groups `Skeleton.drawList()` into draw calls exactly where `@openbone/render-webgl` splits them (texture or atlas page, blend mode, clipping mask, text, 16-bit index limit), with positions, uvs, straight per-vertex colours and indices, plus a per-vertex `dark` rgb (two-colour tint: `rgb = dark + (light − dark) × texture rgb`) only when a slot in the batch has a dark colour. `tintRuns(batch)` and `tintMatrix(light, dark)` split such a batch into runs of one flat tint for engines without a second vertex colour. An engine that draws each batch as one indexed triangle list with `texture × vec4(rgb·a, a)` in premultiplied alpha shows the same picture as the reference renderer.
- **`TextRasterizer`**: text attachments drawn into canvases (cached per slot, redrawn only when the content or pixel scale changes), as render-webgl does.
- **`particleDotPixels()` / `particleDotCanvas()`**: the built-in soft particle sprite.

Tests in `test/reference.ts` run render-webgl against a recording WebGL stand-in, so every runtime can check its geometry against the reference renderer for the same frame.

MIT.
