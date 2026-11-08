# `.obone` file format (version 1)

A UTF-8 JSON document. The TypeScript source of truth is `packages/core/src/types.ts`.

```jsonc
{
  "format": "openbone", "version": 1, "name": "Walker",
  "width": 800, "height": 600, "originX": 400, "originY": 500, "background": "#eef2f7", "fps": 30,
  "images":   [{ "id": "img_…", "name": "cape", "src": "assets/cape.png", "width": 120, "height": 60 }],
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

**Attachments**: `region` (image quad), `mesh` (uvs, triangles, vertices or per-vertex `weights: [{bone,x,y,weight}]`, hull), `shape` (rect/ellipse/polygon with fill/stroke), `boundingBox` (hit polygon), `point`.

**Timelines**: `{target: "bone", id, property: "rotation"|"x"|"y"|"scaleX"|"scaleY"|"shearX"|"shearY", keys}`, `{target: "slot", property: "color"|"attachment"}`, `{target: "ik"|"transform", property: "mix"}`, `{target: "deform", id: slotId, attachment, property: "offsets"}`, `{target: "drawOrder", id: "skeleton", property: "order"}`. Each key is `{time, value, curve}`, where curve is `"linear"`, `"stepped"` or bezier handles `[cx1, cy1, cx2, cy2]`.

Images can be embedded as `data:` URIs or stored as paths relative to the `.obone` file.
