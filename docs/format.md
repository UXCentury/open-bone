# File format (`.obone` / `.obonb`, version 1)

← [Docs](README.md)

An `.obone` file is a UTF-8 JSON document; `.obonb` is the same document in a compact binary encoding. The TypeScript
source of truth is [`packages/core/src/types.ts`](../packages/core/src/types.ts). How a runtime evaluates a document is
in the [runtime specification](runtime-spec.md).

- [The document at a glance](#the-document-at-a-glance)
- [Skeleton](#skeleton): [bones and slots](#bones-and-slots), [skins](#skins), [constraints](#constraints),
  [constraint order](#constraint-order), [reference scale](#reference-scale), [sliders](#sliders)
- [Attachments](#attachments): [text](#text), [sequences](#sequences), [particles](#particles)
- [Animations and timelines](#animations-and-timelines)
- [State machines](#state-machines)
- [Audio](#audio)
- [Images and the texture atlas](#images-and-the-texture-atlas)
- [Binary documents (`.obonb`)](#binary-documents-obonb)

## The document at a glance

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
    "skins":  [{ "id", "name", "attachments": { "<slotId>": { "<name>": Attachment } }, "bones?": [boneId], "constraints?": [constraintId] }],
    // Solved in one list each frame, sorted by "order?" (default: ik, transform, path, physics, each in array order).
    "ik":        [{ "id", "name", "order?", "bones": [parent, child], "target", "mix", "bendPositive", "softness", "stretch", "compress", "uniform"? }],
    "transform": [{ "id", "name", "bones", "target", "mixRotate", "mixTranslate", "mixScale", "mixShear",
                    "offsetRotation", "offsetX", "offsetY", "offsetScaleX", "offsetScaleY", "offsetShear", "local", "relative" }],
    "path":      [{ "id", "name", "bones", "target": slotId, "positionMode", "spacingMode", "rotateMode",
                    "offsetRotation", "position", "spacing", "mixRotate", "mixX", "mixY" }],
    "physics":   [{ "id", "name", "bone", "x", "y", "rotate", "scaleX", "inertia", "strength", "damping", "mass", "gravity", "wind", "mix", "fps" }],
    // transform, path and physics constraints take "order?" too.
    "referenceScale?": 100
  },
  "events":     [{ "id", "name", "int", "float", "string", "audio?", "volume?" }],   // audio: sound id played when it fires
  "animations": [{ "id", "name", "duration", "timelines": [Timeline], "events": [{ "time", "event", "int?", "float?", "string?" }],
                   "audio?": [{ "time", "sound", "volume?", "rate?", "loop?" }] }],
  "audio?": { "master", "muted", "assets": [{ "id", "name", "src", "duration" }], "buses": [{ "id", "name", "volume", "muted" }],
              "sounds": [{ "id", "name", "asset", "bus", "volume", "rate", "loop", "fadeIn", "fadeOut" }] },
  "stateMachines": [{ "id", "name", "inputs": [{ "id", "name", "type": "bool"|"number"|"string"|"trigger", "default" }],
                     "bindings": [{ "id", "input", "target", "object", "property", "inMin", "inMax", "outMin", "outMax" }],
                     "layers": [{ "states": [{ "…", "onComplete?": stateId }], "transitions", "entry" }], "listeners", "scripts" }],
  "scripts": [{ "id", "name", "code" }]
}
```

Fields marked `?` are optional. Coordinates in skeleton space are y-up, angles in degrees counter-clockwise; the
artboard (`width × height`) is y-down pixels with the skeleton origin at `originX, originY`.

## Skeleton

### Bones and slots

Bones form a tree through `parent`. `inherit` is `"normal"`, `"onlyTranslation"`, `"noRotation"` or `"noScale"`. Slots
attach to a bone; the `slots` array order is the draw order, and `blend` is `normal`, `additive`, `multiply` or
`screen`.

### Skins

A skin maps `slotId → attachment name → attachment`. Its optional `bones` and `constraints` list ids that exist only in
skins that list them:

- A bone or constraint listed in *any* skin is active only while a skin listing it is set (`Skeleton.setSkin`).
- A bone is active when no skin lists it or the current skin does, **and** its parent is active, so every bone below an
  inactive bone is inactive too.
- Inactive bones are not posed (their world transform is not updated); their slots are not drawn or hit-tested and their
  particle emitters do not step.
- A constraint is skipped when some skin lists it and the current skin does not, or when any of its bones, its target
  bone, its path slot's bone or its physics bone is inactive.
- The default (first) skin cannot list bones or constraints.

### Constraints

| Constraint | Fields worth knowing |
|---|---|
| **IK** | `softness` (2-bone) eases the chain toward straight over that distance before full reach; `stretch` scales the bones to reach a far target; `compress` (1-bone) shortens the bone for a near one; `uniform` makes stretch/compress scale both axes |
| **Transform** | World mode blends world matrices; `local` blends the bones' local values instead. `relative` adds the target's change since its setup pose (plus offsets) rather than copying its absolute value. `mixShear` blends the angle between the bone's axes |
| **Path** | Places `bones` along the path attachment shown by the `target` slot. `positionMode`: `fixed` (distance) or `percent` (0..1 of the length). `spacingMode`: `length` (bone length + spacing), `fixed`, `percent` or `proportional` (spacing × length shared by bone length). `rotateMode`: `tangent`, `chain` (aim at the next placed point) or `chainScale` (also stretch to reach it). Distances are arc lengths; open paths extend straight past their ends, closed paths wrap |
| **Physics** | Two spring particles (bone origin and tip) lag behind the animated pose. `x`, `y`, `rotate`, `scaleX` (0..1) choose which channels move the bone; `inertia` is how much of the bone's own motion is resisted; `strength`/`mass` set the spring; `damping` is velocity decay per second; `gravity`/`wind` are constant accelerations. Simulated at `fps` fixed steps per second, so the same frame times always give the same result |

### Constraint order

Every constraint may have a number `order`. Each frame, after the bones' world transforms, all constraints are applied
in one list sorted by a key: `order` when set, otherwise the constraint's index in the default list (all `ik`, then
`transform`, `path`, `physics`, each in array order). Equal keys keep the default list order, so with no `order`
anywhere this is exactly the default order. The `setConstraintOrder` op writes `order` 0..n-1 on every constraint (an
empty list removes them all); constraints added afterwards get the next number.

### Reference scale

`skeleton.referenceScale` (default 100) is the size, in percent, the rig's physics and IK values were made for:

| Value | Multiplied by |
|---|---|
| physics `wind` | `referenceScale / 100 × skeleton scaleX` |
| physics `gravity` | `referenceScale / 100 × skeleton scaleY` (signed: a flipped skeleton keeps gravity pointing down the skeleton) |
| IK `softness` | `referenceScale / 100 × |skeleton scaleX|` |

The skeleton scale is its placement scale (`Skeleton.scaleX/scaleY`), not bone scales. A tool that exports a rig at
another size (bone positions and lengths × k) should multiply `referenceScale` by k too, so the rig behaves the same.

### Sliders

`skeleton.sliders` (optional): `[{ id, name, animation, bone?, property?, input?, from, to, timeFrom?, timeTo?, mix, loop, additive }]`.

A driver (a bone's local `property`, default rotation, or a number `input` id) scrubs `animation`: the driver's
`from`..`to` maps to `timeFrom`..`timeTo` seconds (default 0..the animation's length), clamped or wrapped (`loop`).
The pose is blended in by `mix`, or with `additive` the animation's change from the setup pose is added on top.
Sliders apply in order, before IK and the other constraints.

## Attachments

| `type` | What it is |
|---|---|
| `region` | An image quad |
| `mesh` | `uvs`, `triangles`, `vertices` or per-vertex `weights: [{bone, x, y, weight}]`, and the `hull` |
| `shape` | A rect, ellipse or polygon with fill and stroke |
| `boundingBox` | A hit polygon |
| `point` | A position and rotation on a bone |
| `text` | A text box whose content can be a template ([below](#text)) |
| `sequence` | Frame-by-frame animation ([below](#sequences)) |
| `particles` | A particle emitter ([below](#particles)) |
| `clipping` | A mask polygon `vertices` plus `end`: the slots after it in draw order, through the `end` slot (or to the end when `null`), are drawn only inside the outline. The mask itself is not drawn, and one mask is active at a time |
| `path` | A cubic bezier spline: `vertices` flat, three points per knot `[inX, inY, x, y, outX, outY]`, optional `weights` like a mesh, `closed`, `color` |

### Text

```jsonc
{ "type": "text", "text", "x", "y", "rotation", "width", "height", "font", "size", "weight", "color",
  "align": "left" | "center" | "right", "outline?", "outlineWidth?" }
```

The `width × height` box is centred at `x, y` in slot-bone space; it is the alignment frame and the hit area, and lines
are centred vertically in it. `text` is a template:

| Template | Shows |
|---|---|
| `{name}` | the state machine input `name` |
| `{name:pattern}` | a formatted number: `0.00` fixed decimals, `0.0#` optional ones, `#,##0` thousands separators, a leading `+` always signs, a trailing `%` multiplies by 100, other characters are copied (`{multiplier:0.00x}`) |
| `{{` / `}}` | literal braces |
| `{unknown}` | stays as written |

Hosts can replace the template per slot at runtime (`setText`).

### Sequences

`type: "sequence"` plays frame-by-frame animation.

- **Frames**: `frames` is the ordered list `[{ "image", "rect?": {x, y, width, height}, "trim?": {x, y, sourceWidth, sourceHeight} }]`:
  a whole image per frame, or a cell of a sprite-sheet image (`rect` in image pixels, y-down), optionally trimmed
  (`rect` sits at `trim.x, trim.y` inside the untrimmed frame).
- **Placement and tint**, as a region: `x, y, rotation, scaleX, scaleY, width, height` (the untrimmed frame size) and `color`.
- **Playback**: `fps`; `mode` (`loop`; `once`, hidden after the last frame; `pingPong`, forward then back without
  repeating the ends; `holdLast`); `offset` (frames added to the counter); optional `input` (a number input id).
- **Frame counter**: `floor(time × fps) + offset`, where time is the local time of the applied animation (or state), or
  the skeleton clock when nothing plays. A `sequence` timeline key, else the bound input's value, replaces
  `floor(time × fps)`.

Frames are images, so atlas packing and pruning include them.

### Particles

A `particles` attachment is an emitter on the slot's bone. Ranges are `[min, max]`, sampled per particle.

| Group | Fields |
|---|---|
| **Emission** | `emitting` (setup on/off), `rate` (per second), `bursts` (`[{time, count}]`, seconds into each cycle), `maxParticles`, `duration` (cycle length), `loop`, `prewarm` (start as if one cycle had run) |
| **Shape** | `shape`: `point`, `circle` (emits outwards), `box` (`width` across the direction, `height` along it) or `cone` (a mouth of half-width `radius`); at `x, y` in slot-bone space, emitting along `rotation` degrees ± `angle`/2. `space`: `world` (particles stay where they were born) or `local` (they move with the bone) |
| **Particles** | `lifetime`, `speed`, `gravity` (downwards, units/s²), `drag` (velocity decay per second), `startSize`/`endSize`, `startRotation`/`endRotation` (interpolated over the life) plus `angularVelocity`, `colors` (gradient stops `{t, color}` over the life, alpha included), `blend` |
| **Look** | `look`: `circle` (soft dot), `square`, `spark` (a streak along the velocity, `stretch` seconds long) or `image` (`image` id; packed images are drawn from their atlas page) |
| **Determinism** | `seed`: the simulation runs at fixed 1/60 s steps with a seeded generator (mixed with the slot name), so the same seed and time give the same particles |

## Animations and timelines

An animation has a `duration`, `timelines`, `events` and optional `audio` keys. It may also carry `export: false`
(left out of exports unless picked) and `color` (for the editor's lists).

| `target` | `property` | Notes |
|---|---|---|
| `bone` | `rotation`, `x`, `y`, `scaleX`, `scaleY`, `shearX`, `shearY` | |
| `bone` | `inherit` | String values `"normal"`, `"onlyTranslation"`, `"noRotation"`, `"noScale"`, always stepped: the bone uses the last key's mode at or before the time (the first key's before it); in a mix the side with alpha ≥ 0.5 wins; `setToSetupPose` restores the bone's own mode |
| `slot` | `color`, `attachment` | |
| `ik` | `mix`, `softness`, `bend`, `stretch`, `compress` | `bend`: 1 positive / -1 negative; `stretch`, `compress`: 1 on / 0 off. These three switch at keys |
| `transform` | `mix`, `mixRotate`, `mixTranslate`, `mixScale`, `mixShear` | `mix` multiplies all the mixes |
| `path` | `position`, `spacing`, `mixRotate`, `mixX`, `mixY` | |
| `physics` | `mix`, `inertia`, `strength`, `damping`, `mass`, `gravity`, `wind` | |
| `sequence` (`id`: slot, `attachment`) | `frame` | The frame counter of a sequence |
| `particles` (`id`: slot) | `emitting` (boolean keys), `rate` | For the emitter the slot shows; switching `emitting` on restarts its cycle, so bursts replay |
| `deform` (`id`: slot, `attachment`) | `offsets` | Mesh or path vertex offsets |
| `drawOrder` (`id`: `"skeleton"`) | `order` | |

Each key is `{time, value, curve}`, where `curve` is `"linear"`, `"stepped"` or bezier handles `[cx1, cy1, cx2, cy2]`.

## State machines

A state machine has `inputs` (`bool`, `number`, `string`, `trigger`), `bindings`, `layers` of states and
transitions, `listeners` and `scripts`.

- **Flow**: a state's `onComplete` names the state to go to once its animation has played through (after the first
  cycle when it loops). The state's own transitions are checked first, so a trigger can still interrupt it.
- **Conditions** on `string` inputs compare with `==` / `!=`.
- **Inputs on enter**: `inputs: [{input, value}]` sets bool, number or string inputs (not triggers) when the state is
  entered, e.g. an idle state that puts `multiplier` back to 1 after a crash or cash-out (op `setStateInput`).
- **Emitters**: a state's optional `emitters: [{slot, emitting}]` are applied when it is entered; listeners have the
  actions `{type: "setEmitter", slot, emitting}` and `{type: "emitParticles", slot, count}`.

**Input bindings**: each frame, after animations and script overrides, a binding maps its number input (or bool, as
0/1) linearly from `[inMin, inMax]` to `[outMin, outMax]`, clamped, and writes it to `object`'s `property`:

| `object` | `property` |
|---|---|
| bone | `rotation`, `x`, `y`, `scaleX`, `scaleY`, `shearX`, `shearY` |
| slot | `color` (hex outputs, blended per channel) or `alpha` |
| constraint | any keyable value listed under [timelines](#animations-and-timelines) |

Later bindings win on the same property.

## Audio

The optional `audio` section holds the files, buses and sounds.

| Part | What it is |
|---|---|
| **Assets** | Files (WAV, MP3, OGG): a `data:` URI or a path relative to the document, and `duration` in seconds (0 if unknown) |
| **Buses** | Named groups with `volume` and `muted`; new documents get `sfx` (`bus_sfx`), `music` and `ui` |
| **Sounds** | Play an asset through a bus (`null` = straight into the master) with their own `volume`, `rate` (pitch), `loop` and `fadeIn`/`fadeOut` seconds |

The gain of a playing sound is `master × bus.volume × sound.volume × key volume`, and 0 when the document, the bus or
the host mutes it. Sounds are played by:

- animation `audio` keys (unset fields use the sound's),
- an event's `audio` (every time it fires),
- state `sounds: [{ "sound", "on": "enter" | "exit", "action": "play" | "stop", "volume?" }]`,
- listener actions `{ "type": "playSound", "sound", "volume?" }` and `{ "type": "stopSound", "sound", "fade?" }`.

Looping sounds started by a state or an animation stop (with their fade-out, or the transition's cross-fade if longer)
when it ends. Binary files store embedded audio as raw bytes.

## Images and the texture atlas

Images are embedded as `data:` URIs or stored as paths relative to the `.obone` file. An image whose `src` is `""`
exists only in the atlas.

The optional atlas (set with the `setAtlas` op) has `pages`, packed textures, and `regions`, each saying where an image
lives in a page:

- `x, y, width, height` is the packed rect in page pixels (y-down). It holds the part of the original
  `originalWidth × originalHeight` image that starts at `offsetX, offsetY` (offsets 0 and equal sizes when the image is
  not trimmed). Trimmed region attachments are shrunk to the packed part.
- Attachment uvs stay in 0..1 image space in the file; the runtime maps them into page space:
  `page_u = (x - offsetX + u × originalWidth) / page.width`, likewise for v.
- `rotated: true` means the image is stored turned 90° clockwise. It covers `height × width` page pixels at `x, y`, and
  image pixel `(ix, iy)` of the packed part sits at page `(x + height - iy, y + ix)`, so
  `page_u = (x + height + offsetY - v × originalHeight) / page.width` and
  `page_v = (y - offsetX + u × originalWidth) / page.height`.
- `atlas.scale` (optional) records that images were stored smaller than their asset size (region sizes are page pixels;
  uvs only use their ratios).
- `white` is a solid white block that untextured shapes sample from, so they batch with images.
- Pages are packed with 2 px padding by default, and edge pixels are extruded into half of the padding so linear
  filtering matches a loose texture.

| Option | Meaning |
|---|---|
| **Premultiplied alpha** (`atlas.premultipliedAlpha: true`) | Page pixels are stored as rgb × a. Renderers upload such pages as they are (no premultiply on upload) and blend with `ONE, ONE_MINUS_SRC_ALPHA`; 2D-canvas renderers, which only composite straight alpha, divide by alpha once when they load the page. Loose images are always straight alpha |
| **Whitespace stripping** (`atlas.stripWhitespace`, informational) | Each image is packed by its visible bounds, recorded in the usual trim fields. Images that meshes sample keep everything their uvs cover, and particle images are never trimmed |
| **Polygon packing** (`atlas.polygons`, informational) | A region may carry `polygon`, a convex outline `[x0, y0, x1, y1, …]` in original image pixels (y-down, the same space as the offsets) that lies inside the packed rect and covers every visible pixel. Region attachments then draw that polygon (a triangle fan) instead of their quad: point `(px, py)` is placed at image uv `(px / originalWidth, py / originalHeight)` on the region's quad. Meshes, sequences and particles ignore it |

## Binary documents (`.obonb`)

The same document in a compact tagged encoding: about 40% of compact JSON, with embedded images and sounds stored as
raw bytes instead of base64. The editor, `<openbone-player>` and `parseDocument()` load either format.

**Layout**: the magic `OBNB`, a version byte (1), a varint count of strings followed by each string (varint byte length
+ UTF-8), then one value. Varints are unsigned LEB128. Each value starts with a tag byte:

| Tag | Value |
|---|---|
| `0` | null |
| `1` | false |
| `2` | true |
| `3` | unsigned varint |
| `4` | negative integer (varint of `-n-1`) |
| `5` | float32, little-endian |
| `6` | float64 |
| `7` | string (varint index into the string table) |
| `8` | array (varint length, then the values) |
| `9` | object (varint count, then key index + value pairs) |
| `10` | data URL (mime string index, varint length, raw bytes) |

> [!NOTE]
> Non-integer numbers are float32 by default and are rounded to 7 significant digits when read. Export with float64
> precision for a lossless file.
