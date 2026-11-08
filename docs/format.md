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
    // Solved in this order each frame: ik, transform, path, physics.
    "ik":        [{ "id", "name", "bones": [parent, child], "target", "mix", "bendPositive", "softness", "stretch", "compress" }],
    "transform": [{ "id", "name", "bones", "target", "mixRotate", "mixTranslate", "mixScale", "mixShear",
                    "offsetRotation", "offsetX", "offsetY", "offsetScaleX", "offsetScaleY", "offsetShear", "local", "relative" }],
    "path":      [{ "id", "name", "bones", "target": slotId, "positionMode", "spacingMode", "rotateMode",
                    "offsetRotation", "position", "spacing", "mixRotate", "mixX", "mixY" }],
    "physics":   [{ "id", "name", "bone", "x", "y", "rotate", "scaleX", "inertia", "strength", "damping", "mass", "gravity", "wind", "mix", "fps" }]
  },
  "events":     [{ "id", "name", "int", "float", "string", "audio?" }],
  "animations": [{ "id", "name", "duration", "timelines": [Timeline], "events": [{ "time", "event", "int?", "float?", "string?" }] }],
  "stateMachines": [{ "id", "name", "inputs", "layers": [{ "states", "transitions", "entry" }], "listeners", "scripts" }],
  "scripts": [{ "id", "name", "code" }]
}
```

**Attachments**: `region` (image quad), `mesh` (uvs, triangles, vertices or per-vertex `weights: [{bone,x,y,weight}]`, hull), `shape` (rect/ellipse/polygon with fill/stroke), `boundingBox` (hit polygon), `point`, `path` (cubic bezier spline: `vertices` flat, three points per knot `[inX,inY, x,y, outX,outY]`, optional `weights` like a mesh, `closed`, `color`).

**Constraints**:
- *IK*: `softness` (2-bone) eases the chain toward straight over that distance before full reach; `stretch` scales the bones to reach a far target; `compress` (1-bone) shortens the bone for a near one.
- *Transform*: world mode blends world matrices; `local` blends the bones' local values instead. `relative` adds the target's change since its setup pose (plus offsets) rather than copying its absolute value. `mixShear` blends the angle between the bone's axes.
- *Path*: places `bones` along the path attachment shown by the `target` slot. `positionMode` `fixed` (distance) or `percent` (0..1 of length); `spacingMode` `length` (bone length + spacing), `fixed`, `percent` or `proportional` (spacing × length shared by bone length); `rotateMode` `tangent`, `chain` (aim at the next placed point) or `chainScale` (also stretch to reach it). Distances are arc lengths; open paths extend straight past their ends, closed paths wrap.
- *Physics*: two spring particles (bone origin and tip) lag behind the animated pose. `x`/`y`/`rotate`/`scaleX` (0..1) choose which channels move the bone, `inertia` how much of the bone's own motion is resisted, `strength`/`mass` the spring, `damping` velocity decay per second, `gravity`/`wind` constant accelerations. Simulated at `fps` fixed steps per second, so the same frame times always give the same result.

**Timelines**: `{target: "bone", id, property: "rotation"|"x"|"y"|"scaleX"|"scaleY"|"shearX"|"shearY", keys}`, `{target: "slot", property: "color"|"attachment"}`, `{target: "ik", property: "mix"|"softness"}`, `{target: "transform", property: "mix"|"mixRotate"|"mixTranslate"|"mixScale"|"mixShear"}` (`mix` multiplies all mixes), `{target: "path", property: "position"|"spacing"|"mixRotate"|"mixX"|"mixY"}`, `{target: "physics", property: "mix"|"inertia"|"strength"|"damping"|"mass"|"gravity"|"wind"}`, `{target: "deform", id: slotId, attachment, property: "offsets"}` (mesh or path), `{target: "drawOrder", id: "skeleton", property: "order"}`. Each key is `{time, value, curve}`, where curve is `"linear"`, `"stepped"` or bezier handles `[cx1, cy1, cx2, cy2]`.

Images can be embedded as `data:` URIs or stored as paths relative to the `.obone` file.
