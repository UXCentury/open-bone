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
    // Solved in this order each frame: ik, transform, path, physics.
    "ik":        [{ "id", "name", "bones": [parent, child], "target", "mix", "bendPositive", "softness", "stretch", "compress" }],
    "transform": [{ "id", "name", "bones", "target", "mixRotate", "mixTranslate", "mixScale", "mixShear",
                    "offsetRotation", "offsetX", "offsetY", "offsetScaleX", "offsetScaleY", "offsetShear", "local", "relative" }],
    "path":      [{ "id", "name", "bones", "target": slotId, "positionMode", "spacingMode", "rotateMode",
                    "offsetRotation", "position", "spacing", "mixRotate", "mixX", "mixY" }],
    "physics":   [{ "id", "name", "bone", "x", "y", "rotate", "scaleX", "inertia", "strength", "damping", "mass", "gravity", "wind", "mix", "fps" }]
  },
  "events":     [{ "id", "name", "int", "float", "string", "audio?", "volume?" }],   // audio: sound id played when it fires
  "animations": [{ "id", "name", "duration", "timelines": [Timeline], "events": [{ "time", "event", "int?", "float?", "string?" }],
                   "audio?": [{ "time", "sound", "volume?", "rate?", "loop?" }] }],
  "audio?": { "master", "muted", "assets": [{ "id", "name", "src", "duration" }], "buses": [{ "id", "name", "volume", "muted" }],
              "sounds": [{ "id", "name", "asset", "bus", "volume", "rate", "loop", "fadeIn", "fadeOut" }] },
  "stateMachines": [{ "id", "name", "inputs", "layers": [{ "states", "transitions", "entry" }], "listeners", "scripts" }],
  "scripts": [{ "id", "name", "code" }]
}
```

**Attachments**: `region` (image quad), `mesh` (uvs, triangles, vertices or per-vertex `weights: [{bone,x,y,weight}]`, hull), `shape` (rect/ellipse/polygon with fill/stroke), `boundingBox` (hit polygon), `point`, `clipping` (mask polygon `vertices` plus `end`: the slots after it in draw order, through the `end` slot or to the end when null, are drawn only inside the outline; the mask itself is not drawn; one mask is active at a time), `path` (cubic bezier spline: `vertices` flat, three points per knot `[inX,inY, x,y, outX,outY]`, optional `weights` like a mesh, `closed`, `color`).

**Sequence attachments** (`type: "sequence"`, frame-by-frame animation): `frames` is the ordered list `[{ "image", "rect?": {x,y,width,height}, "trim?": {x,y,sourceWidth,sourceHeight} }]`: a whole image per frame, or a cell of a sprite sheet image (`rect` in image pixels, y-down), optionally trimmed (`rect` sits at `trim.x, trim.y` inside the untrimmed frame). Placement and tint as a region: `x, y, rotation, scaleX, scaleY, width, height` (the untrimmed frame size) and `color`. Playback: `fps`, `mode` (`loop`; `once`, hidden after the last frame; `pingPong`, forward then back without repeating the ends; `holdLast`), `offset` (frames added to the counter) and optional `input` (a number input id). The frame counter is `floor(time × fps) + offset`, where time is the local time of the applied animation (or state), or the skeleton clock when nothing plays; a `sequence` timeline key, else the bound input's value, replaces `floor(time × fps)`. Frames are images, so atlas packing and pruning include them.

**Constraints**:
- *IK*: `softness` (2-bone) eases the chain toward straight over that distance before full reach; `stretch` scales the bones to reach a far target; `compress` (1-bone) shortens the bone for a near one.
- *Transform*: world mode blends world matrices; `local` blends the bones' local values instead. `relative` adds the target's change since its setup pose (plus offsets) rather than copying its absolute value. `mixShear` blends the angle between the bone's axes.
- *Path*: places `bones` along the path attachment shown by the `target` slot. `positionMode` `fixed` (distance) or `percent` (0..1 of length); `spacingMode` `length` (bone length + spacing), `fixed`, `percent` or `proportional` (spacing × length shared by bone length); `rotateMode` `tangent`, `chain` (aim at the next placed point) or `chainScale` (also stretch to reach it). Distances are arc lengths; open paths extend straight past their ends, closed paths wrap.
- *Physics*: two spring particles (bone origin and tip) lag behind the animated pose. `x`/`y`/`rotate`/`scaleX` (0..1) choose which channels move the bone, `inertia` how much of the bone's own motion is resisted, `strength`/`mass` the spring, `damping` velocity decay per second, `gravity`/`wind` constant accelerations. Simulated at `fps` fixed steps per second, so the same frame times always give the same result.

**Timelines**: `{target: "bone", id, property: "rotation"|"x"|"y"|"scaleX"|"scaleY"|"shearX"|"shearY", keys}`, `{target: "slot", property: "color"|"attachment"}`, `{target: "ik", property: "mix"|"softness"}`, `{target: "transform", property: "mix"|"mixRotate"|"mixTranslate"|"mixScale"|"mixShear"}` (`mix` multiplies all mixes), `{target: "path", property: "position"|"spacing"|"mixRotate"|"mixX"|"mixY"}`, `{target: "physics", property: "mix"|"inertia"|"strength"|"damping"|"mass"|"gravity"|"wind"}`, `{target: "deform", id: slotId, attachment, property: "offsets"}` (mesh or path), `{target: "sequence", id: slotId, attachment, property: "frame"}` (frame counter of a sequence), `{target: "drawOrder", id: "skeleton", property: "order"}`. Each key is `{time, value, curve}`, where curve is `"linear"`, `"stepped"` or bezier handles `[cx1, cy1, cx2, cy2]`.

Images can be embedded as `data:` URIs or stored as paths relative to the `.obone` file.

**Audio** (optional): `assets` are files (WAV, MP3, OGG; `data:` URI or relative path, `duration` in seconds, 0 if unknown). A **sound** plays an asset through a **bus** (`null` = straight into the master) with its own `volume`, `rate` (pitch), `loop` and `fadeIn`/`fadeOut` seconds. The gain of a playing sound is `master × bus.volume × sound.volume × key volume`, and 0 when the document, the bus or the host mutes it. New documents get the buses `sfx` (`bus_sfx`), `music` and `ui`. Sounds are played by: animation `audio` keys (unset fields use the sound's), an event's `audio` (every time it fires), state `sounds: [{ "sound", "on": "enter"|"exit", "action": "play"|"stop", "volume?" }]` and listener actions `{ "type": "playSound", "sound", "volume?" }` / `{ "type": "stopSound", "sound", "fade?" }`. Looping sounds started by a state or an animation stop (with their fade-out, or the transition's cross-fade if longer) when it ends. Binary files store embedded audio as raw bytes.

**Texture atlas** (optional, set with the `setAtlas` op): `pages` are packed textures. Each region says where an image lives in a page: `x, y, width, height` is the packed rect in page pixels (y-down), holding the part of the original `originalWidth x originalHeight` image that starts at `offsetX, offsetY` (offsets are 0 and the sizes equal when the image is not trimmed). Attachment uvs stay in 0..1 image space in the file; the runtime maps them into page space (`page_u = (x - offsetX + u * originalWidth) / page.width`, likewise for v). Trimmed region attachments are shrunk to the packed part. `white` is a solid white block that untextured shapes sample from, so they batch with images. An image whose `src` is `""` exists only in the atlas. Pages are packed with 2 px padding by default, and edge pixels are extruded into half of the padding so linear filtering matches a loose texture.

## Binary documents (`.obonb`)

The same document in a compact tagged encoding (about 40% of compact JSON; embedded images are stored as raw bytes instead of base64). The editor, `<openbone-player>` and `parseDocument()` load either format.

Layout: magic `OBNB`, a version byte (1), a varint count of strings followed by each string (varint byte length + UTF-8), then one value. Each value starts with a tag byte: `0` null, `1` false, `2` true, `3` unsigned varint, `4` negative integer (varint of `-n-1`), `5` float32 (little-endian), `6` float64, `7` string (varint index into the string table), `8` array (varint length, then values), `9` object (varint count, then key index + value pairs), `10` data URL (mime string index, varint length, raw bytes). Varints are unsigned LEB128. Non-integer numbers are float32 by default and are rounded to 7 significant digits when read; export with float64 precision for a lossless file.
