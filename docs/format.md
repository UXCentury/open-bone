# `.obone` file format (version 1)

A UTF-8 JSON document. The TypeScript source of truth is `packages/core/src/types.ts`.

```jsonc
{
  "format": "openbone", "version": 1, "name": "Walker",
  "width": 800, "height": 600, "originX": 400, "originY": 500, "background": "#eef2f7", "fps": 30,
  "images":   [{ "id": "img_…", "name": "cape", "src": "assets/cape.png", "width": 120, "height": 60 }],
  "atlas?":   { "pages": [{ "id", "name", "src", "width", "height" }],
                "regions": [{ "image", "page", "x", "y", "width", "height", "offsetX", "offsetY", "originalWidth", "originalHeight" }],
                "white?": { "page", "x", "y", "width", "height" }, "padding" },
  "skeleton": {
    "bones":  [{ "id", "name", "parent", "length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit" }],
    "slots":  [{ "id", "name", "bone", "color", "attachment", "blend" }],          // array order = draw order
    "skins":  [{ "id", "name", "attachments": { "<slotId>": { "<name>": Attachment } } }],
    "ik":        [{ "id", "name", "bones": [parent, child], "target", "mix", "bendPositive" }],
    "transform": [{ "id", "name", "bones", "target", "mixRotate", "mixTranslate", "mixScale", "offsetRotation", "offsetX", "offsetY" }]
  },
  "events":     [{ "id", "name", "int", "float", "string", "audio?" }],
  "animations": [{ "id", "name", "duration", "timelines": [Timeline], "events": [{ "time", "event", "int?", "float?", "string?" }] }],
  "stateMachines": [{ "id", "name", "inputs", "layers": [{ "states", "transitions", "entry" }], "listeners", "scripts" }],
  "scripts": [{ "id", "name", "code" }]
}
```

**Attachments**: `region` (image quad), `mesh` (uvs, triangles, vertices or per-vertex `weights: [{bone,x,y,weight}]`, hull), `shape` (rect/ellipse/polygon with fill/stroke), `boundingBox` (hit polygon), `point`, `clipping` (mask polygon `vertices` plus `end`: the slots after it in draw order, through the `end` slot or to the end when null, are drawn only inside the outline; the mask itself is not drawn; one mask is active at a time).

**Timelines**: `{target: "bone", id, property: "rotation"|"x"|"y"|"scaleX"|"scaleY"|"shearX"|"shearY", keys}`, `{target: "slot", property: "color"|"attachment"}`, `{target: "ik"|"transform", property: "mix"}`, `{target: "deform", id: slotId, attachment, property: "offsets"}`, `{target: "drawOrder", id: "skeleton", property: "order"}`. Each key is `{time, value, curve}`, where curve is `"linear"`, `"stepped"` or bezier handles `[cx1, cy1, cx2, cy2]`.

Images can be embedded as `data:` URIs or stored as paths relative to the `.obone` file.

**Texture atlas** (optional, set with the `setAtlas` op): `pages` are packed textures. Each region says where an image lives in a page: `x, y, width, height` is the packed rect in page pixels (y-down), holding the part of the original `originalWidth x originalHeight` image that starts at `offsetX, offsetY` (offsets are 0 and the sizes equal when the image is not trimmed). Attachment uvs stay in 0..1 image space in the file; the runtime maps them into page space (`page_u = (x - offsetX + u * originalWidth) / page.width`, likewise for v). Trimmed region attachments are shrunk to the packed part. `white` is a solid white block that untextured shapes sample from, so they batch with images. An image whose `src` is `""` exists only in the atlas. Pages are packed with 2 px padding by default, and edge pixels are extruded into half of the padding so linear filtering matches a loose texture.
