# OpenBone runtime specification

How the TypeScript runtime (`packages/runtime`, `packages/core`) turns a document into poses, draw lists, events,
audio commands and state-machine states. A port (C++, C#, Java, Swift, Dart…) that follows this text reproduces the
reference files in [`conformance/expected/`](../conformance/expected) (format: [`conformance/README.md`](../conformance/README.md),
generator: `conformance/generate.ts`). The file format itself is in [format.md](format.md); it is not repeated here.

Where this text and the code disagree, the code wins and this file is the bug. Section headings cite `file:function`.
Angles in documents are degrees, counter-clockwise, y-up. "wrap" always means `wrapDeg` (§4.4).

---

## 1. Scope and conformance

A port is conformant when, for every case of every `expected/*.json`, each sample matches within:

| quantity | tolerance |
| --- | --- |
| bone world `x, y`, draw `vertices`, `uvs` | 1e-3 |
| bone world `a, b, c, d` | 1e-4 |
| colours (`slots` colours, `color`, `dark`, `colors`) | 1/255 |
| particle draw `vertices` | 1e-2 (single-precision drift over many steps) |
| event `float`, audio numbers | 1e-4 |
| names, attachment names, `type`, `blend`, `texture`, `indices`, `clip`, `text`, event order, audio command order, `states` | exact |

Reference numbers are rounded to 4 decimals (`Math.round(n·1e4)/1e4`, `-0` → `0`), so compare after rounding the
same way or allow the extra ±5e-5. Out of scope: rendering itself (blending, texture filtering, text rasterising,
strokes), the editor, ops, and anything not observable in a sample.

## 2. Loading

`core/document.ts:deserialize`, `core/binary.ts:deserializeBinary`, `core/document.ts:normalizeDocument`

1. **JSON (`.obone`)**: parse; reject unless `format === "openbone"`; reject `version > 1`; then normalise.
2. **Binary (`.obonb`)**: layout in [format.md § Binary](format.md#binary-documents-obonb). Decode to the same JSON
   value, then run step 1 on it. A `float32` value (tag 5) is widened and **rounded to 7 significant digits**:
   `Number(f32.toPrecision(7))` (JS rounds exact ties *up*, see §12). `float64` is used as is. Tag 10 becomes
   `data:<mime>;base64,<bytes>`.
3. **Normalisation** (in place; missing ⇒ default):
   - `scripts`, `stateMachines`, `events`, `skeleton.ik/transform/path/physics` ⇒ `[]`; each state machine `bindings` ⇒ `[]`.
   - IK: `softness` 0, `stretch` false, `compress` false (`uniform` absent ⇒ false at use).
   - Transform: `mixShear` 0, `offsetScaleX/Y` 0, `offsetShear` 0, `local` false, `relative` false.
   - Every `particles` attachment: each missing field from `core/particles.ts:defaultParticleSettings` (except `image`).
   - Nothing else is filled. `skeleton.sliders`, `slot.dark`, `animation.audio`, `event.volume`, `state.*` optional
     lists are treated as absent/empty where read.
4. **Linked meshes** are *not* resolved at load: the file already holds the parent's copied geometry
   (`core/linked.ts:syncLinkedMeshes` runs in the editor). A port treats a linked mesh as a plain mesh, except for
   deform lookup (§8.3).

**Skeleton construction** (`skeleton.ts:Skeleton.constructor`): bones in document order; a bone's parent is looked
up among bones *already created*, so a parent listed after its child makes the child a root (documents are
written parent-first, `core/document.ts:sortBones`). Slots whose bone is missing are dropped (they are absent from
`slots` in samples too). Atlas regions whose page or image is missing are ignored. The constructor ends with
`setToSetupPose()` and **one `updateWorldTransform()`** (with no time pending: this creates physics state at rest,
§7.4). The active skin starts as none (`null`); `setSkin(ref)` finds a skin by id, then by name.

## 3. Per-frame pipeline

`instance.ts:OpenBoneInstance.advance(dt)`. Without a state machine:

```
animationState.update(dt)      // §6: times, events, audio, completion, queue
skeleton.setToSetupPose()      // §3.1
animationState.apply()         // §6: timelines, track order
skeleton.update(dt)            // adds dt (if > 0) to clock, physics pending time, particle pending time
skeleton.updateWorldTransform()// §3.2
```

With a state machine, `StateMachineInstance.advance(dt)` replaces all of it (§9).

### 3.1 `skeleton.ts:Skeleton.setToSetupPose`
Bones' local pose ← bone data; slot colour ← `parseHex(color)`, dark ← `parseHex(dark)` or none, attachment name ←
`slot.attachment`, deform offsets and keyed sequence frames cleared; `drawOrder` ← document slot order;
`animationTime` ← null; constraint values ← setup values (`setupValues`: every keyable property from the constraint,
non-number ⇒ 0; transform constraints also get `mix = 1`; IK `bend = bendPositive ? 1 : -1`, `stretch`,
`compress` as 1/0); particle values cleared. **Not** reset: skin, clock, physics state, particle emitters,
input values, text overrides.

### 3.2 `skeleton.ts:Skeleton.updateWorldTransform`
```
applySliders()                                  // §7.5, writes bones' local pose
root = [scaleX 0; 0 scaleY | x, y]              // skeleton placement, identity in the suite
for bone in bones (document order):
    bone.applied ← bone local pose              // resetApplied
    bone.world ← boneWorld(parent ? parent.world : root, applied, parent ? inherit : "normal")
for c in ik:        applyIk(c)                  // §7.1
for c in transform: applyTransform(c)           // §7.2
for c in path:      applyPath(c)                // §7.3
dt = pendingDt; pendingDt = 0
for c in physics:   applyPhysics(c, dt)         // §7.4
if particleClock == "realtime" and particlePending > 0: advanceParticles(particlePending)   // §8.8
particlePending = 0
```
Constraints read their *live values* (setup values overwritten by timelines and bindings), not the data.

`bone.updateSubtree(root, includeSelf)` recomputes world matrices from `applied` for the bone (optionally) and all
descendants, depth-first, children in creation order. Constraints that change a world matrix directly and then call
`updateSubtree(root, false)` keep that change only until something recomputes the bone from `applied` (§12).

## 4. Maths

`core/math.ts`. Matrices are 2×3 affine `{a b; c d | x y}`, column vectors: `world·(x,y) = (a·x + b·y + x0, c·x + d·y + y0)`.
`multiply(P, L)` is `P·L`. `invert` uses `det = a·d − b·c`, replaced by `1e-9` when exactly 0.

### 4.1 Local matrix (`localMatrix`)
```
rx = (rotation + shearX)·DEG ;  ry = (rotation + 90 + shearY)·DEG
a = cos(rx)·scaleX   b = cos(ry)·scaleY
c = sin(rx)·scaleX   d = sin(ry)·scaleY   x = x   y = y
```

### 4.2 Inherit modes (`boneWorld(P, local, inherit)`)
`L = localMatrix(local)`, `(wx, wy) = P·(local.x, local.y)`. Root bones always use `normal` with `P = root`.

| mode | linear part | translation |
| --- | --- | --- |
| `normal` | `P·L` | `P·(x,y)` |
| `onlyTranslation` | `L` | `(wx, wy)` |
| `noRotation` | `sx = hypot(P.a, P.c)`, `sy = hypot(P.b, P.d)`; `a = L.a·sx, b = L.b·sy, c = L.c·sx, d = L.d·sy` | `(wx, wy)` |
| `noScale` | `sx = hypot(P.a,P.c) ‖ 1`, `sy = hypot(P.b,P.d) ‖ 1`; `N = [P.a/sx P.b/sy; P.c/sx P.d/sy]`; `N·L` | `(wx, wy)` |

`noRotation` loses parent reflection (magnitudes only); `noScale` keeps parent rotation, shear and reflection.

Derived values: `worldRotation = atan2(c, a)·RAD`, `worldScaleX = hypot(a, c)`, `worldScaleY = hypot(b, d)`.

### 4.3 Curves (`evalCurve`)
Key curve applies to the span from that key to the next. `linear` ⇒ `t`; `stepped` ⇒ hold the left key (handled in
sampling, §5). Bezier `[x1, y1, x2, y2]` (endpoints (0,0) and (1,1)) is solved **by bisection only**:
```
bx(s) = 3(1−s)²s·x1 + 3(1−s)s²·x2 + s³ ;  by(s) likewise with y1, y2
lo = 0; hi = 1; s = t
repeat 24 times:
    e = bx(s) − t
    if |e| < 1e-6: break
    if e > 0: hi = s else lo = s
    s = (lo + hi) / 2
return by(s)
```
The first probe is `s = t`, not 0.5. `y` may overshoot 0..1 (no clamp).

### 4.4 Angles
`wrapDeg(d)`: `d = fmod(d, 360)` (result has the sign of `d`, as JS `%`); `if d > 180: d −= 360 elif d ≤ −180: d += 360`.
Range (−180, 180]. `lerpAngle(a, b, t) = a + wrapDeg(b − a)·t` (used for mixing a bone rotation over the current
pose, §5.1). Interpolation *between keys* is plain linear on the stored values (no shortest path).

### 4.5 Colours (`parseHex`, `lerpColor`)
Remove the first `#`; a 3- or 4-digit string has each digit doubled; channel `i` = `parseInt(h[2i..2i+2], 16) / 255`;
alpha = 1 unless the string has ≥ 8 digits. Colours are RGBA doubles, *not* premultiplied, never clamped.
`lerpColor` is per-channel linear. Tints multiply per channel (`mulColor`).

## 5. Timelines

`animation.ts:applyAnimation(sk, anim, time, alpha)`. Timelines are applied in array order; empty timelines and
timelines whose target is missing are skipped; `alpha ≤ 0` does nothing. If `alpha ≥ 0.5` or
`sk.animationTime === null`, `sk.animationTime = time` (sequences follow it, §8.6).

**Sampling** (`locate`): `time ≤ keys[0].time` ⇒ first key, no interpolation; `time ≥ last.time` ⇒ last key; else
binary search for the last key with `key.time ≤ time` (= `a`) and the next one (`b`),
`f = (time − a.time) / ((b.time − a.time) ‖ 1)`, `t = evalCurve(a.curve, f)`. If `a.curve` is `stepped` (or no `b`)
the value is `a.value`, else `lerp(a.value, b.value, t)`. Step sampling (`sampleStep`) returns `a.value`.
Arrays (`sampleArray`) lerp element-wise to the longer length, missing elements read as 0.

### 5.1 Per target

| target / property | value written |
| --- | --- |
| `bone` rotation | `bone.rotation = lerpAngle(bone.rotation, v, alpha)` (even at alpha 1: result is `cur + wrap(v − cur)`, equal to `v` only modulo 360) |
| `bone` x, y, scaleX, scaleY, shearX, shearY | `lerp(cur, v, alpha)` |
| `slot` color | key colours lerped by `t` (stepped ⇒ left); `alpha ≥ 1` ⇒ replace, else `lerpColor(slot.color, v, alpha)` |
| `slot` dark | as colour; mixing base is current dark or `[0,0,0,1]` |
| `slot` attachment | if `alpha ≥ 0.5`: `attachmentName = sampleStep` (null hides) |
| `ik` bend, stretch, compress | if `alpha ≥ 0.5`: `values[p] = Number(sampleStep)` (true ⇒ 1) |
| `ik` mix, softness; `transform` *; `path` *; `physics` * | `values[p] = lerp(values[p] ‖ 0, v, alpha)` (transform `mix` multiplies all four mixes, setup 1) |
| `particles` emitting | if `alpha ≥ 0.5`: `particleValues[slot].emitting = sampleStep` |
| `particles` rate | `rate = lerp(current rate ‖ attachment rate (0 if not particles), v, alpha)` |
| `deform` offsets | `v = sampleArray`; existing offsets and `alpha < 1` ⇒ element-wise `lerp(cur[i] ‖ 0, v[i], alpha)`; none and `alpha < 1` ⇒ `v·alpha`; else replace (store a copy) |
| `sequence` frame | if `alpha ≥ 0.5`: `slot.sequenceFrames[attachment] = sampleNumber` |
| `drawOrder` | if `alpha ≥ 0.5`: listed slot ids that exist, in listed order, **then every unlisted slot in document order** (unlisted slots end up on top) |

`localTime(anim, total, loop)`: `d = animationDuration` (explicit `duration` if > 0, else the max time of every key,
event key and audio key); `d ≤ 0` ⇒ 0; loop ⇒ `((total % d) + d) % d`; else `clamp(total, 0, d)`.

### 5.2 Events crossed (`animation.ts:eventsBetween`)
For total (unwrapped) times `prev` (exclusive) → `next` (inclusive), nothing if `next ≤ prev`. For each event key **in
array order** whose event exists: not looping or `d ≤ 0` ⇒ fire if `prev < k.time ≤ next`; looping ⇒ for each cycle
`c` from `floor(prev/d)` to `floor(next/d)`, fire if `prev < c·d + k.time ≤ next`. A fired event carries
`time = k.time` (the key's local time), `int/float/string` from the key or else the event, the event's `audio`/`volume`,
and the animation name. Audio keys use the same rule (`audio.ts:audioKeysBetween`), keeping their array index.

## 6. AnimationState

`animation-state.ts`. Each track holds a `TrackEntry {time = 0, prevTime = −1e-6, speed = 1, alpha = 1, mixingFrom,
mixTime, mixDuration, completedLoops = 0}`.

- `setAnimation(track, anim, loop, mix = 0.2)`: stops the current entry's looping sounds (fade `max(mix, fadeOut)`);
  if there was an entry and `mix > 0`, the new entry mixes from it (`mixingFrom = cur`, `cur.mixingFrom = null`,
  `mixDuration = mix`); queued entries for the track are dropped. The suite only calls it on an empty track 0.
- `addAnimation(track, anim, loop, delay, mix)`: empty track ⇒ start now; else queue.
- `update(dt)`: `audio.update(dt)`, then for each track in index order:
  ```
  e.prevTime = e.time > 0 ? e.time : min(e.prevTime, e.time)   // first step keeps −1e-6: keys at 0 fire once
  e.time += dt·e.speed
  if e.mixingFrom: from.prevTime = from.time; from.time += dt·from.speed
                   e.mixTime += dt; if e.mixTime ≥ e.mixDuration: e.mixingFrom = null
  if dt > 0: play audio keys crossed (prevTime, time]   (§10), then for each event crossed:
             play its audio (owner = entry), emit "event"
  d = duration; if d > 0:
      loops = floor(time / d)
      if (loop ? loops > completedLoops : prevTime < d ≤ time): completedLoops = loops; emit "complete";
                                                                if !loop: stop the entry's looping sounds
  queued q for this track: if (q.delay > 0 ? time ≥ q.delay : (!loop && time ≥ d) || (loop && d > 0 && time ≥ d)):
      stop entry's loops (fade q.mix); q.entry.mixingFrom = e; mixDuration = q.mix; replace; emit "start"
  ```
  The mixed-out entry fires no events or audio.
- `apply()`: tracks in index order (higher tracks lerp over lower ones):
  `mixingFrom` ⇒ `applyAnimation(from, from.localTime, alpha)` then
  `applyAnimation(entry, entry.localTime, alpha·min(1, mixTime / (mixDuration ‖ 1)))`; else `applyAnimation(entry, localTime, alpha)`.
  The outgoing animation is applied at full alpha and the incoming one lerped over it.

## 7. Constraints

All in `skeleton.ts`. Order per frame: sliders (before world transforms), then IK, transform, path, physics, each
list in array order (§3.2). `root` is the skeleton placement matrix. `det(m) = sign(a·d − b·c) ‖ 1`.

### 7.1 IK (`applyIk`)
Skip if `mix ≤ 0`, the target is missing or no bone exists. `bendPositive = bend > 0`, `stretch = stretch > 0`,
`compress = compress > 0` (live values), `uniform = !!c.uniform`. `(tx, ty)` = target world position.

**One bone** `b`, parent matrix `P = parent ? parent.world : root`:
```
(dx, dy) = (tx − b.world.x, ty − b.world.y)
(lx, ly) = linear part of invert(P) · (dx, dy)
want = atan2(ly, lx)·RAD − applied.shearX
applied.rotation += wrap(want − applied.rotation)·mix;  b.updateWorld
len = data.length · worldScaleX(b.world)
if (stretch or compress) and len > 1e-6:
    k = hypot(dx, dy) / len
    if (k > 1 and stretch) or (k < 1 and compress):
        s = 1 + (k − 1)·mix;  world.a,c *= s;  if uniform: world.b,d *= s
b.updateSubtree(root, false)
```

**Two bones** `p`, `ch` (`ch` should be `p`'s child); `compress` is ignored:
```
(px, py) = p.world position
l1 = |ch.world.pos − p.world.pos| ;  l2 = ch.data.length · worldScaleX(ch.world) ;  reach = l1 + l2
dRaw = |(tx, ty) − (px, py)|
soft = min(softness, reach)
dSoft = (soft > 1e-6 and dRaw > reach − soft) ? reach − soft + soft·(1 − exp(−(dRaw − (reach − soft)) / soft)) : dRaw
dEff = min(max(dSoft, |l1 − l2| + 1e-4), reach − 1e-4)
(ux, uy) = dRaw > 1e-9 ? ((tx,ty) − (px,py)) / dRaw : (1, 0)
(ax, ay) = (px, py) + (ux, uy)·dEff                      // aim point
cosA = (l1² + dEff² − l2²) / ((2·l1·dEff) ‖ 1)
a1 = atan2(uy, ux) + (bendPositive ? −1 : +1)·acos(clamp(cosA, −1, 1))
curDir = atan2(ch.world.y − py, ch.world.x − px)
deltaP = wrap((a1 − curDir)·RAD) · det(p.parent ? p.parent.world : root)
pRot = p.applied.rotation;  cRot = ch.applied.rotation
p.applied.rotation = pRot + deltaP;  p.updateSubtree(root)           // full solve first
deltaC = wrap(atan2(ay − ch.world.y, ax − ch.world.x)·RAD − worldRotation(ch.world)) · det(p.world)
p.applied.rotation = pRot + deltaP·mix;  ch.applied.rotation = cRot + deltaC·mix
p.updateWorld; ch.updateWorld
if stretch and dRaw > dEff + 1e-9:
    s = 1 + (dRaw/dEff − 1)·mix;  u = uniform ? s : 1
    p.world.a,c *= s;  p.world.b,d *= u
    ch.world = {a: ch.a·s, b: ch.b·u, c: ch.c·s, d: ch.d·u, pos: p.world·(ch.applied.x, ch.applied.y)}   // ignores ch inherit mode
ch.updateSubtree(root, false);  every other child of p: updateSubtree(root)
```

### 7.2 Transform (`applyTransform`)
`m = values.mix ‖ 1`; `mr = mixRotate·m`, `mt = mixTranslate·m`, `ms = mixScale·m`, `mh = mixShear·m`; skip if all
four ≤ 0 or the target is missing. For each listed bone `b ≠ target`:

**Local** (`c.local`), on `applied` values (`p` = bone, `t` = target applied, `s` = target data):

| | absolute | relative |
| --- | --- | --- |
| rotation | `p.r += wrap(t.r + offR − p.r)·mr` | `p.r += (wrap(t.r − s.r) + offR)·mr` |
| x / y | `p.x += (t.x + offX − p.x)·mt` | `p.x += (t.x − s.x + offX)·mt` |
| scaleX / Y | `p.sx += (t.sx + offSX − p.sx)·ms` | `p.sx *= 1 + ((s.sx ? t.sx/s.sx : 1) − 1 + offSX)·ms` |
| shearY | `p.shY += (t.shY + offSh − p.shY)·mh` | `p.shY += (t.shY − s.shY + offSh)·mh` |

then `b.updateSubtree(root)` (self included).

**World** (default), on `w = b.world`, `t = target.world`. Helpers: `rotateAxes(w, r)` left-multiplies the linear part
by rotation `r` (no-op if `r === 0`); `skewOf(m) = wrap((atan2(d, b) − atan2(c, a))·RAD − 90)`;
`setSkew(w, k)`: `ly = hypot(b, d)`, `ang = atan2(c, a) + (90 + k)·DEG`, `b = cos(ang)·ly`, `d = sin(ang)·ly`.
Each channel runs only when its mix > 0, in this order:
- absolute: rotate `wrap(rot(t) + offR − rot(w))·mr`; translate toward `t·(offX, offY)` by `mt`;
  scale: `sx = |w col0| ‖ 1`, `kx = (sx + (|t col0| + offSX − sx)·ms) / sx` (same for y), `a,c *= kx`, `b,d *= ky`;
  shear: `setSkew(w, sb + wrap(skewOf(t) + offSh − sb)·mh)` with `sb = skewOf(w)`.
- relative, with `s` = target setup world (`core/setup.ts:setupWorld`, no constraints, then `root·s`; computed once
  and cached): rotate `(wrap(rot(t) − rot(s)) + offR)·mr`; `w.pos += (t.pos − s.pos + off)·mt`;
  `kx = 1 + (|t col0| / (|s col0| ‖ 1) − 1 + offSX)·ms` (y likewise); `setSkew(w, skewOf(w) + (wrap(skewOf(t) − skewOf(s)) + offSh)·mh)`.

then `b.updateSubtree(root, false)`.

### 7.3 Path (`applyPath`)
Skip if `mixRotate, mixX, mixY` all ≤ 0, the target slot is missing or its current attachment is not a path.
Spline from the attachment's **world** vertices (§8.3, deform and weights included; float32-rounded) with
`core/path.ts:buildSpline`:
- knots = `floor(len/6)`; segments = `knots < 2 ? 0 : closed ? knots : knots − 1`; segment `s` = anchor `s`, out-handle `s`,
  in-handle `s+1`, anchor `s+1` (index `(s+1) % knots`).
- Arc-length table: 32 uniform parameter steps per segment, cumulative chord lengths (doubles). Total length `L`;
  skip if `L ≤ 1e-9`.
- `sample(dist)`: no segments ⇒ first anchor, angle 0. Closed ⇒ `dist = ((dist % L) + L) % L`. Open and `dist ≤ 0` or
  `dist ≥ L` ⇒ straight extension from the start (`point(0,0)`) or end (`point(last,1)`) along its tangent by
  `dist` or `dist − L`. Otherwise binary-search the table for the last entry `≤ dist` (`lo`, `hi = lo+1`),
  `f = (dist − T[lo]) / (T[hi] − T[lo])` (0 if span 0), `seg = min(segs−1, floor(lo/32))`,
  `t = (lo − seg·32 + f) / 32`, return `point(seg, min(1, t))`.
- `point` = cubic bezier position; tangent = derivative, or if its squared length < 1e-12 the difference across
  `t ± 1e-3` (clamped), or if that is < 1e-18 the chord anchor→anchor; `angle = atan2`.

Placement:
```
lengths[i] = bone.data.length · worldScaleX(bone.world) ;  sum = Σ lengths
dist[0] = positionMode == percent ? position·L : position
gap_i = fixed: spacing | percent: spacing·L | proportional: spacing·L·(sum > 0 ? lengths[i]/sum : 1/n) | length: lengths[i] + spacing
dist[i+1] = dist[i] + gap_i ;  pts = sample(dist[0..n])        // all sampled before any bone moves
for i in bones (listed order):
    w.x += (pts[i].x − w.x)·mixX ;  w.y += (pts[i].y − w.y)·mixY
    if mixRotate > 0:
        ang = pts[i].angle
        if rotateMode != tangent:
            (dx, dy) = pts[i+1] − w.pos ;  d = hypot
            if d > 1e-6: ang = atan2(dy, dx);  if chainScale and lengths[i] > 1e-6: k = 1 + (d/lengths[i] − 1)·mixRotate; w.a,c *= k
        rotateAxes(w, wrap((ang + offsetRotation·DEG)·RAD − rot(w))·mixRotate·DEG)
    bone.updateSubtree(root, false)
```
Later bones are read after earlier bones' subtrees were recomputed.

### 7.4 Physics (`applyPhysics`)
State per constraint id: two particles `origin`, `tip` `{x, y, vx, vy, px, py}`, `lastO`, `lastT`, `time`, `steps`.
```
w = bone.world ;  len = data.length > 1e-6 ? data.length : 1
(ox, oy) = w.pos ;  (tx, ty) = w·(len, 0)
first call: particles at rest at (ox,oy) / (tx,ty), last = those, time = steps = 0
carry = 1 − clamp(inertia, 0, 1)
shift origin (x, px) by (ox − lastO)·carry, tip by (tx − lastT)·carry ;  lastO, lastT = current
h = 1 / max(1, fps ‖ 60)
time += dt ;  due = floor(time/h + 1e-6) ;  if due − steps > 8: steps = due − 8      // drop excess
k = min(max(0, strength) / max(1e-6, mass), 1/h²) ;  decay = exp(−max(0, damping)·h)
while steps < due:  step(origin → (ox,oy)), step(tip → (tx,ty)), steps++
    step(p, g): p.px,py = p.x,y
                p.vx = (p.vx + ((g.x − p.x)·k + wind)·h)·decay
                p.vy = (p.vy + ((g.y − p.y)·k − gravity)·h)·decay
                p.x += p.vx·h ;  p.y += p.vy·h
mix = clamp(values.mix, 0, 1) ;  if mix ≤ 0: return          // state still advanced
f = clamp(time/h − steps, 0, 1) ;  S(p) = p.prev + (p − p.prev)·f
w.x = ox + (S(origin).x − ox)·c.x·mix ;  w.y = oy + (S(origin).y − oy)·c.y·mix
if c.rotate > 0 or c.scaleX > 0:
    (dx, dy) = S(tip) − w.pos ;  d = hypot ;  if d > 1e-9:
        rotateAxes(w, wrap((atan2(dy,dx) − atan2(ty−oy, tx−ox))·RAD)·c.rotate·mix·DEG)
        if c.scaleX > 0 and data.length > 1e-6: s = 1 + (d/len − 1)·c.scaleX·mix; w.a,c *= s   // len is unscaled
bone.updateSubtree(root, false)
```
`dt` is everything passed to `Skeleton.update` since the previous `updateWorldTransform`. `x, y, rotate, scaleX`
are read from the data (not keyable); the rest from live values.

### 7.5 Sliders (`applySliders`)
Run first in `updateWorldTransform`, in array order, on the bones' **local pose** (which then persists until the next
`setToSetupPose`). Skip if `mix ≤ 0` or the animation is missing.
```
v = bone ? bone[property ‖ "rotation"] (local pose, as left by animations and earlier sliders; skip if bone missing)
    : input ? inputValues[input] ‖ first state-machine default for that input id ‖ 0
f = to == from ? 0 : (v − from)/(to − from) ;  f = loop ? f − floor(f) : clamp(f, 0, 1)
t = timeFrom ‖ 0 + f·((timeTo ‖ duration) − (timeFrom ‖ 0))
not additive: applyAnimation(anim, t, mix)     // every timeline type
additive:     save bones' 7 local values; all bones ← setup pose; applyAnimation(anim, t, 1)
              per bone & property: delta = cur − setup (rotation: wrap(cur − setup)); value = saved + delta·mix
              (non-bone timelines of the animation stay applied at alpha 1)
```
`animationTime` is restored after all sliders.

## 8. Skins, attachments and the draw list

### 8.1 Attachment lookup (`Skeleton.getAttachment`)
`skin.attachments[slotId][name] ?? skins[0].attachments[slotId][name] ?? null` — `skins[0]` is the default skin
whatever its name; `null` name ⇒ none.

### 8.2 Quads: region, sequence, text (`attachmentWorldVertices`)
```
hw = width/2 · (text ? 1 : scaleX) ;  hh = height/2 · (text ? 1 : scaleY)
corners (y-up) TL(−hw, hh) TR(hw, hh) BR(hw, −hh) BL(−hw, −hh)
skew (not text; kx = tan(skewX·DEG), ky = tan(skewY·DEG)): (x, y) → (x + kx·y, y + ky·x)
rotate by rotation, add (att.x, att.y), then slot bone world
```
UVs `TL(0,0) TR(1,0) BR(1,1) BL(0,1)` (v down); indices `[0,1,2, 0,2,3]`.

### 8.3 Meshes and paths
Deform offsets: for a mesh with `linked.deform`, `slot.deform[linked.mesh]` if present, else `slot.deform[own name]`.
- Unweighted: vertex `(vx + dx, vy + dy)` through the slot bone's world.
- Weighted: `Σ_inf weight · bone(inf).world·(inf.x + dx, inf.y + dy)` (missing bone ⇒ slot bone); the same `dx, dy`
  is added to every influence.
Deform arrays must hold 2 values per vertex. Mesh uvs are the file's `uvs`; indices its `triangles`.
Other polygons: shape outline (§8.5), `boundingBox`/`clipping` vertices, point `(x, y)` — all through the slot bone.
World vertices and uvs are stored as **float32**.

### 8.4 Draw list (`Skeleton.drawList`)
For each slot in `drawOrder`, with its current attachment:

| attachment | item |
| --- | --- |
| `clipping` | not drawn. If no mask is active and it has ≥ 3 points: becomes the active mask (polygon in world space, indices = earcut of the local vertices), ending at slot `end` (null = never). A mask met while one is active is ignored. |
| `region`, `mesh` | `color = slot.color × att.color`; skip if alpha ≤ 0. Region: quad (§8.2), trimmed packed regions shrink it (§8.7). Mesh: §8.3. `texture` = atlas page if the image is packed, else the image (null if missing — still emitted). `dark` = slot dark if set. `blend` = slot blend. |
| `sequence` | §8.6 |
| `particles` | §8.8 (`blend` = attachment blend) |
| `text` | `color = slot.color` (attachment colour goes to the text record); skip if alpha ≤ 0; vertices = the unscaled box quad; uvs/indices as a region; `texture` null; record content (§8.9). |
| `shape` | vertices = world outline; indices = earcut of the local outline; `color = slot.color × fill` (**no alpha skip**); texture = atlas white page with every uv at the white block's centre, else null with zero uvs. |
| `boundingBox`, `point`, `path`, none | nothing |

After the slot's items: if a mask is active and its slot is not this slot, every item from this slot gets `clip`; then if
a mask is active and this slot's id equals its `end`, the mask ends (also when the slot drew nothing). The suite's
`clip` is the index of the mask among masks used in that sample.

### 8.5 Shape outline (`core/geometry.ts:shapeOutline`, 32 segments)
rect, `r = min(radius, hw, hh)`: `r ≤ 0` ⇒ `(−hw,−hh) (hw,−hh) (hw,hh) (−hw,hh)`; else 4 arcs of `seg = max(2, round(32/4)) = 8`
steps (9 points each) centred at `(hw−r, −hh+r)` from −90°, `(hw−r, hh−r)` from 0°, `(−hw+r, hh−r)` from 90°,
`(−hw+r, −hh+r)` from 180°, point `i` at `start + 90·i/seg`. ellipse: `i = 0..31`, `(cos(2πi/32)·hw, sin(…)·hh)`.
polygon: `points`. Then rotate by `rotation` and add `(x, y)`. Triangulation: `earcut(outline)` (earcut 3.x); clipping
masks use `earcut(vertices)` too. Indices are compared exactly, so the port's earcut must match mapbox earcut 3.x output.

### 8.6 Sequences (`Skeleton.sequenceCounter`, `core/sequence.ts`)
```
counter = keyed frame k  ⇒ floor(k + 1e-6) + offset
        | input set (number input value, else its default) ⇒ floor(v + 1e-6) + offset
        | floor((animationTime ?? clock)·fps + 1e-6) + offset
index (count frames, f = floor(counter)):
  loop: ((f % n) + n) % n ;  once: f < 0 ? 0 : f ≥ n ? hidden : f ;  holdLast: clamp(f, 0, n−1)
  pingPong: n == 1 ? 0 : (k = ((f % P) + P) % P with P = 2n−2;  k < n ? k : P − k)
```
Item: hidden or missing image ⇒ none; `color = slot.color × att.color`, skip if alpha ≤ 0. Frame layout:
`uv = rect / imageSize` (`[u0,v0,u1,v1]`, whole image without `rect`); `quad` = `[trim.x/sw, trim.y/sh, (trim.x+rect.w)/sw, (trim.y+rect.h)/sh]`
or `[0,0,1,1]`. Packed and trimmed: intersect `uv` with the packed part, none if empty, map the quad fractions linearly.
Vertices: the region quad (§8.2), shrunk by `trimQuad(quad)` if the quad is not `[0,0,1,1]`. Uvs:
`[u0,v0, u1,v0, u1,v1, u0,v1]`, remapped if packed.

`trimQuad(q, [u0,v0,u1,v1])`: with `U = TR − TL`, `V = BL − TL`, corners `TL + U·u + V·v` for `(u0,v0) (u1,v0) (u1,v1) (u0,v1)`.

### 8.7 Packed atlas (`core/atlas.ts:atlasUvMap`, `remapUvs`)
For a region `r` on page `P`:
- not rotated: `u' = (r.x − offX)/P.w + u·origW/P.w`, `v' = (r.y − offY)/P.h + v·origH/P.h`
- rotated: `u' = (r.x + r.height + offY)/P.w − v·origH/P.w`, `v' = (r.y − offX)/P.h + u·origW/P.h`
Trimmed (`offsets ≠ 0` or size ≠ original): trim box `[offX/origW, offY/origH, (offX+w)/origW, (offY+h)/origH]`;
region quads use the remapped trim box uvs and `trimQuad` on vertices. Mesh uvs are remapped as is.
The white block's uv is its centre. (No fixture or example currently uses an atlas.)

### 8.8 Particles (`particles.ts`, `skeleton.ts:stepParticles/advanceParticles/particleItem`)
**Clock** (realtime): `acc = frac + dt`, `n = floor(acc/STEP + 1e-6)` with `STEP = 1/60`, take `min(n, 30)` steps,
`frac = clamp(acc − n·STEP, 0, STEP)`. Each step, for every slot **in document order**: attachment not particles ⇒
drop its emitter; no emitter or a different attachment object ⇒ new emitter; add pending `emitParticles` counts;
`emitter.step(STEP, slot.bone.world, particleValues[slot])`. All steps of one frame see the same bone matrix.

**RNG**: mulberry32, seed `(attachment.seed XOR fnv1a(slot.name)) >>> 0`. `fnv1a`: `h = 0x811c9dc5`; for each UTF-16
code unit `h = imul(h XOR unit, 0x01000193)`; unsigned. `next()`:
```
s = (s + 0x6D2B79F5) mod 2³² ;  t = s
t = imul(t ^ (t >>> 15), t | 1)
t ^= t + imul(t ^ (t >>> 7), t | 61)          // all mod 2³²
return ((t ^ (t >>> 14)) >>> 0) / 2³²
```
`range([a, b])` = `a` **without consuming** if `a == b`, else `a + (b − a)·next()`. `between(a, b)` always consumes.

**step(h, m, values)**: `emitting = values.emitting ?? data.emitting`, `rate = values.rate ?? data.rate`. On the
emitter's first step, if `emitting && prewarm && loop`: `last = m.pos`, run `advance(emitting = true)`
`min(600, ceil(duration/h − 1e-6))` times. Then `advance(emitting)`; `steps++`.

**advance**:
```
damp = drag > 0 ? exp(−drag·h) : 1
for each particle in order: age += h; drop if age ≥ life; vy −= gravity·h; vx,vy *= damp; x += vx·h; y += vy·h
if emitting and !wasEmitting: cycle = acc = 0          // also after restart()
wasEmitting = emitting
active = emitting and (loop or cycle < duration)
burst = pending; pending = 0; streamed = 0
if active:
    acc += max(0, rate)·h; streamed = floor(acc); acc −= streamed
    start = cycle; end = start + h; wraps = end ≥ duration − 1e-9; rest = end − duration
    for b in bursts: skip if b.time > duration + 1e-9
        if start − 1e-9 ≤ b.time < end − 1e-9: burst += b.count
        elif wraps and loop and b.time < rest − 1e-9: burst += b.count
    cycle = wraps ? (loop ? max(0, rest) : duration) : end
room = max(0, maxParticles − alive); nb = min(burst, room); ns = min(streamed, room − nb)
(lx, ly) = last ?? m.pos
nb × spawn(preAge 0, origin m.pos)
for i in 0..ns−1: k = (i+1)/ns; spawn(preAge (1−k)·h, origin lerp(l, m.pos, k))
last = m.pos
```
**spawn** (RNG calls in exactly this order):
```
rot = rotation·DEG; half = angle/2·DEG; f = s = 0
dir = rot + between(−half, half)
circle: a = next()·2π; r = sqrt(next())·radius; f = cos(a)·r; s = sin(a)·r; dir = rot + a
box:    s = between(−width/2, width/2); f = between(−height/2, height/2)
cone:   s = between(−radius, radius); if radius > 0: dir = rot + (s/radius)·half
pos = (x + f·cos rot − s·sin rot,  y + f·sin rot + s·cos rot);  speed = range(speed); vel = (cos dir, sin dir)·speed
world space: pos = linear(m)·pos + origin;  v = linear(m)·vel, renormalised to |speed| (0 if |v| ≤ 1e-9)
life = max(1e-3, range(lifetime)); size0 = range(startSize); size1 = range(endSize)
rot0 = range(startRotation); rot1 = range(endRotation); spin = range(angularVelocity)
if preAge > 0: age = preAge; vy −= gravity·preAge; x += vx·preAge; y += vy·preAge     // no drag
keep if age < life
```
Local-space particles live in slot-bone space (gravity acts along bone-space −y).

**geometry(frac, m, tint)** (at most 16383 particles), per particle in array order:
```
age = min(p.age + frac, life); t = age/life; pos = p.pos + p.vel·frac; vel = p.vel
local: pos = m·pos; vel = linear(m)·vel; sizeScale = sqrt(|det m|) (world: 1)
size = max(0, lerp(size0, size1, t))·sizeScale; c = gradient(t); alpha = c.a·tint.a; skip if size ≤ 0 or alpha ≤ 0
spark: sp = |vel|; len = size/2 + sp·stretch/2; ang = sp > 1e-6 ? atan2(vel) : (lerp(rot0,rot1,t) + spin·age)·DEG; U = (cos, sin)·len
else:  ang = (lerp(rot0,rot1,t) + spin·age)·DEG; U = (cos, sin)·size/2
V = perp(U)/|U|·size/2  with perp(x, y) = (−y, x)   (|U| = 0 ⇒ 1)
quad TL = pos − U + V, TR = pos + U + V, BR = pos + U − V, BL = pos − U − V; uvs unit; indices base+[0,1,2,0,2,3]
per-vertex colour = (c.rgb × tint.rgb, alpha)
```
`gradient`: stops sorted by `t` (stable) only if unsorted; clamp to first/last; else lerp between bracketing stops.
Item: none if no emitter for this attachment or no particle drawn. `color = slot.color`, `colors` per vertex.
Texture: `image` look ⇒ atlas page (uvs remapped) or the image, none if missing; `square` ⇒ white page with
centre uvs, else null with unit uvs; `circle`, `spark` ⇒ id `@openbone/particle-dot`.

### 8.9 Text (`Skeleton.textContent`, `core/template.ts`)
Recorded: `text` = `formatTemplate(override ?? att.text, lookup)`. `lookup(name)` = the running state machine's
input by id or name (triggers read `false`); without one, the default of the first non-trigger input with that name
across state machines. Template: fast path if no `{`/`}`; else replace `/\{\{|\}\}|\{([^{}:]+)(?::([^{}]*))?\}/g`:
`{{`→`{`, `}}`→`}`, `{name[:pattern]}` → value of `trim(name)` (unknown ⇒ left as written). Values: number with
pattern ⇒ `formatNumber`; number without ⇒ `String(Number(v.toFixed(6)))` (JS shortest form); others `String(v)`.

`formatNumber(v, pattern)`: match `^([^#0]*?)(\+?)([#0,]+)(?:\.([0#]+))?(%?)(.*)$` (dot-all) into
`prefix, plus, int, frac, pct, suffix`; no match ⇒ plain(v) + pattern. `%` ⇒ `v·100`; non-finite ⇒
`prefix + String(v) + pct + suffix`. `minFrac` = leading `0`s of `frac`, `maxFrac = |frac|`; `s = |v|.toFixed(maxFrac)`;
strip up to `maxFrac − minFrac` trailing zeros (and a bare `.`); pad the integer part to the number of `0`s in `int`;
if that count is 0, the integer part is `"0"` and a fraction remains, drop it; `,` in `int` ⇒ thousands separators;
sign `-` only if negative and some digit is non-zero, else `+` if `plus` and not negative.

Also emitted (not compared by the suite): font, size, weight, align, box size, fill/outline colours,
`matrix = bone.world · [cos −sin; sin cos | x, y]`.

## 9. State machines

`state-machine.ts:StateMachineInstance`. Inputs start at their defaults (triggers `false`). Layers each hold
`current`, `from`, `mixTime`, `mixDuration`, `exited`. A state instance has `time = 0`, `prevTime = −1e-6`.

### 9.1 `advance(dt)` order
```
1  first call only: start()  — load every machine script (onStart each), then per layer enter(entry, mix 0)
2  elapsed += dt;  audio.update(dt)
3  processPointer()                                    // §9.5
4  onUpdate(dt): machine scripts, then each layer's current-state scripts
5  per layer: settle(l)                                // §9.3
6  clear all fired triggers
7  per layer: for s in [current, from]: s.prevTime = s.time > 0 ? s.time : min(s.prevTime, s.time); s.time += dt·speed
             if current and dt > 0: collectEvents(current)          // §9.4
             if from: mixTime += dt; if mixTime ≥ mixDuration: from = null
8  skeleton.setToSetupPose()
   per layer: mixA = mixDuration > 0 ? min(1, mixTime/mixDuration) : 1
              if from: applyState(from, exited ? 1 − mixA : 1)
              if current: applyState(current, from ? mixA : 1)
9  script overrides: bone props (Object.assign onto the local pose), slot colour (parseHex) and attachment
10 every number input → skeleton.inputValues;  emitter overrides → particleValues[slot].emitting
11 applyBindings()                                     // §9.6
12 skeleton.update(dt); skeleton.updateWorldTransform()
13 pending events in order: emit "event"; machine scripts onEvent(e); current-state scripts onEvent(e)
```
`activeStates`: per layer, `"exit"` if exited, else the current state's name or null.

### 9.2 Entering a state (`enter(l, state, mix)`)
If there is a current state: dispose its scripts, stop its looping sounds (fade `max(mix, fadeOut)`), run its
`exit` sound hooks. Exit state: `exited = true`, `from = previous`, `current = null`, `mixTime = 0`, `mixDuration = mix`
(the layer fades out and never evaluates again). Otherwise: new instance; `from = mix > 0 ? previous : null` (an older
`from` is dropped); `mixTime = 0`; `mixDuration = mix`; `exited = false`; `enter` sound hooks (owner = instance,
tag `hook:<sound>`); `emitters` (`setEmitter`: override, and restart the emitter if switching on); `inputs`
(`setInput`, only for inputs that exist); state scripts loaded fresh and `onStart` called. Emits `stateChange`.

### 9.3 Transitions (`settle`, `evaluate`, `canTake`, `conditionPasses`, `progress`)
`settle`: up to 4 hops per layer: `t = evaluate(l)`; stop if null; else remove from the fired set every input named in
`t`'s conditions. `evaluate`: nothing if exited. Candidates = transitions with `from` = current id or `@any`, stably
sorted specific-first. Take the first with `canTake`; enter its target with `duration` (a missing target is still
"taken"). If none: if the current state has `onComplete` and `progress ≥ 1`, enter it with mix **0.1** and return null.
```
canTake(t, s):
  from != @any and to == s.id and no conditions ⇒ false
  from == @any and to == s.id ⇒ false
  exitTime = t.exitTime ?? (no conditions ? 1 : null)
  exitTime != null and s and progress(s) < exitTime ⇒ false
  every condition passes
progress(s) = d > 0 ? s.time / d : 1     with d = duration of s.data.animation (blend1d states usually have none ⇒ 1)
```
Conditions: trigger ⇒ fired this frame. Otherwise `v` = input value, `w` = condition value. String inputs: `==`/`!=`
compare `String(v)` and `String(w)`. `==`: `v === w` (strict: `true ≠ 1`) or both numbers within 1e-9. `!=`: `v !== w`
(strict, no epsilon). `> < >= <=`: `Number(v)` vs `Number(w)` (bool ⇒ 0/1). Missing input ⇒ false.
Transitions use state time from *before* this frame's increment.

### 9.4 Applying states and collecting events
`animation` state: `applyAnimation(anim, localTime(anim, s.time, loop), alpha)`. `blend1d`: `v = Number(input ?? 0)`;
entries sorted by value (stable); `v ≥ last` ⇒ `lo = hi = last, t = 0`; else the first `i` with
`e[i] ≤ v ≤ e[i+1]` gives `lo, hi`, `t = (v − lo)/((hi − lo) ‖ 1)`; below the first ⇒ `lo = hi = first`. Apply `lo` at
`alpha`, then `hi` at `alpha·t` if it is a different animation and `t > 0` (each with its own `localTime`).
`collectEvents(current)` (only the current state; for blend1d only `t ≥ 0.5 ? hi : lo`): audio keys crossed
`(prevTime, time]` (owner = state instance), then each event crossed: play its audio (owner = state instance) and
queue it for step 13.

### 9.5 Pointer and listeners (`pointer`, `processPointer`, `hit`, `runActions`)
`pointer(type, x, y)` queues `{type, x, y}` in skeleton space. Processing each queued event in order: update
`pointer()` state (`down` true on down, false on up); machine scripts `onPointer({type, x, y})`; then every listener in
order: `hit` = slot null ? true : `hitTest(slot)`, where the hit polygon is the current attachment if it is a bounding
box, else the first `boundingBox` among the slot's attachments (default skin's names overlaid by the active skin's, JS
object key order), else the current attachment (shape/clipping/region/sequence/text polygon, mesh hull = first
`hull` vertices), tested with the even-odd rule (`core/math.ts:pointInPolygon`). It uses **last frame's** world pose.

| listener event | fires when |
| --- | --- |
| down / up / move | the pointer event has that type and `hit` |
| click | on `down` with hit: mark pressed; on `up`: fire if hit and pressed; unmark |
| enter / exit | any pointer event: `hit` and not hovered ⇒ hovered, fire enter; not `hit` and hovered ⇒ unhovered, fire exit |

Actions, in order: `setInput` (by id or name); `toggleInput` (`setInput(id, !value)`); `fireTrigger`; `reportEvent`
(event by id: play its audio, unowned; queue `{name, id, time: elapsed, int, float, string}`); `playSound`
(unowned, source `listener:<name>`); `stopSound` (every instance, fade default the sound's fadeOut); `runScript`
(the machine-level handle for that script, call `fn`); `setEmitter`; `emitParticles` (added on the next particle step).

`setInput(ref, value)`: trigger ⇒ `fire`; string ⇒ `String(value)`; bool ⇒ string `"true"` or truthiness; number ⇒
`Number(value)`, ignored if not finite. No change ⇒ no `inputChange`. `fire` marks the trigger fired until step 6.

### 9.6 Bindings (`applyBindings`)
In array order, for each binding whose input exists: `t = bindingT(Number(value), inMin, inMax)` where `bindingT` =
`inMax == inMin ? (v ≥ inMax ? 1 : 0) : clamp((v − inMin)/(inMax − inMin), 0, 1)`. Bone: local `property` =
`outMin + (outMax − outMin)·t`. Slot `alpha`: replace colour alpha; slot `color`: colour = per-channel lerp of
`parseHex(outMin)`, `parseHex(outMax)` (replaces RGBA). Constraint targets: live value `property` = lerp.

## 10. Events and audio commands

`audio.ts:AudioDirector` (one per AnimationState and per state machine). Commands, in emission order:
`play {id, sound, asset, bus, volume, rate, loop, fadeIn, source}`, `stop {id, fade}`, `fade {id, volume, duration}`.

- `play(ref, {volume, rate, loop, owner, tag, source})`: `resolveSound` = sound by id, then name; else audio asset by
  id, then name, played as `{id = asset id, bus = id of the bus named "sfx" or null, volume 1, rate 1, loop false,
  fades 0}`; unknown ⇒ nothing. `loop = opt ?? sound.loop`; a looping play with a tag whose `(owner, tag)` is already
  playing and looping is skipped (no command). `volume = sound.volume × (opt ?? 1)`, `rate = opt ?? sound.rate`,
  `fadeIn = sound.fadeIn`. Bookkeeping end time: loop ⇒ never; else `now + (assetDuration > 0 ? duration/rate : 10)`.
- `update(dt)`: `now += dt`; forget instances whose end time ≤ now (no command).
- `stop(id, fade ?? sound.fadeOut)`; `stopSound(ref, fade)` stops every instance of that sound;
  `stopOwner(owner, fade = 0)` stops the owner's *looping* instances with `max(fade, fadeOut)`; `stopAll()` uses fade 0.
- Audio keys: `play(key.sound, {volume, rate, loop from the key, owner, tag: "<animId>#<keyIndex>", source: "key:<anim name>"})`.
  Event audio: `source "event:<event name>"`; state hooks `"state:<state name>"`; listeners `"listener:<listener name>"`.
- Ids are fresh strings (`play_<n>`); the suite renumbers them `p1, p2, …` per case in order of first appearance,
  so a port only needs unique ids consistently reused by its `stop`/`fade` commands.

Event records in the suite: `{name, time, int, float, string}` where `time` is the key's local time for animation
events and `elapsed` (after the increment) for listener and script events. Within one frame, animation events come
out in key-array order (cycles ascending per key), not time order.

## 11. Scripts

`scripting.ts`, `scripting/src/index.ts` (QuickJS host, used by the suite). A script is JavaScript defining optional
global functions; it sees only the global `ob` (and `console.log` → `ob.log`). Arguments and return values cross the
boundary as JSON (so `undefined` fields disappear). Errors and timeouts (16 ms per call, 50 ms for load) are
reported as `error` and swallowed.

| hook | when |
| --- | --- |
| `onStart()` | machine scripts: first `advance`, before entry states; state scripts: each time the state is entered (fresh instance) |
| `onUpdate(dt)` | every `advance`, step 4: machine scripts, then current-state scripts |
| `onPointer({type,x,y})` | step 3, machine scripts only, per queued pointer event, before listeners |
| `onEvent(e)` | step 13, after posing; `e` = the fired event (`name, id, time, int, float, string, animation, audio?, volume?`) |

| `ob` | effect |
| --- | --- |
| `time()` | `elapsed` |
| `input(n)` / `setInput(n, v)` / `fire(n)` | by id or name (§9.5) |
| `emit(name, {int, float, string})` | event by name or id: play its audio; queue `{name, id: event id ?? name, time: elapsed, payload ?? event ?? 0/""}` |
| `bone(n)` | `{x, y, rotation, scaleX, scaleY}` (local pose now) and `worldX, worldY, worldRotation` (last update) or null |
| `setBone(n, props)` | merged into a persistent override applied each frame at step 9 |
| `slot(n, {color, attachment})` | persistent slot override (step 9) |
| `pointer()` | `{x, y, down}` |
| `log(...)` | `log` event |

Overrides persist until the host calls `clearOverrides()`. Changes made in `onEvent` take effect next frame; triggers
fired there survive until the next frame's step 6.

## 12. Float sensitivity and porting traps

- **Time accumulation.** Times are summed in IEEE double exactly as written (`time += dt·speed`, `elapsed += dt`,
  physics `time += dt`, particle `acc`). Do not compute `step·dt`: keys and exit times that fall on a multiple of dt
  depend on the summed value. The `+1e-6` in `floor(x/h + 1e-6)` (physics, particles, sequences) exists for this;
  copy it.
- **JS number semantics.** `%` is `fmod` (sign of the dividend); `Math.round` rounds .5 up; `toFixed`/`toPrecision`
  round exact decimal ties *up* (C `printf` rounds them to even; e.g. `(2.5).toFixed(0)` is `"3"`);
  `String(number)` is the shortest round-trip form (`0.1`, `1e21`, no trailing zeros). Text templates and binary
  float32 decoding depend on these.
- **32-bit integer maths** in the RNG and FNV hash: wrap mod 2³²; the hash runs over UTF-16 code units.
- **float32 storage**: world vertices (including the path-constraint input), uvs and particle buffers are float32;
  everything else is double. Particles accumulate error over hundreds of steps (hence the 1e-2 tolerance).
- **Exact indices**: shape and clipping triangles come from earcut 3.x; a different triangulator fails the suite.
- **Bisection curve** (§4.3): not Newton; 24 iterations; first probe at `s = t`.
- **Rotation values are not normalised**: mixing gives `cur + wrap(v − cur)`, which sliders, bindings and `ob.bone()` can observe.
- **World-only edits are fragile**: IK stretch, world transform constraints, path and physics edit `world` directly;
  a later constraint that runs `updateSubtree(root)` on an ancestor recomputes these bones from `applied` and discards them.
- **Stable sorts** (blend entries, transition candidates, gradient stops) are required.
- **Hit-test fallback** picks the first bounding box in JS object key order (integer-like names first, then insertion order).
