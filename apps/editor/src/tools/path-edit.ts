import { type Key, type PathAttachment, apply as applyM, invert, setupWorld } from "@openbone/core";
import { Skeleton } from "@openbone/runtime";
import { ensureAnimation, setKeysExtending } from "../edit.ts";
import { activeSkinId, apply, autoKey, mode, ownerSkinArg, selectedAttachment, store, time, toast, transaction } from "../state.ts";
import { type HandleMode, type Mat, applyMode, blendInfluences, deleteKnots, inferMode, insertKnot, knotCount, localOffset, rebindWorld, resetHandles, weightedOffset } from "./knots.ts";
import { type PenHost, boneMat, r3, setPenSel } from "./pen-host.ts";

/**
 * Path attachment editing (the Pen tool). Knots are edited as world positions in the viewport's current pose and
 * written back as one op: in Setup mode into the attachment (unweighted: slot-bone space; weighted: re-bound
 * through each knot's bones), in Animate mode as a deform key at the current time.
 */

export interface PathTarget {
  slotId: string;
  slotBone: string;
  name: string;
  att: PathAttachment;
}

export function pathTarget(): PathTarget | null {
  const sel = selectedAttachment();
  if (!sel || sel.att.type !== "path") return null;
  const slot = store.doc.skeleton.slots.find((s) => s.id === sel.slotId)!;
  return { slotId: sel.slotId, slotBone: slot.bone, name: sel.att.name, att: sel.att };
}

export function pathTargetFor(slotId: string, name: string): PathTarget | null {
  const slot = store.doc.skeleton.slots.find((s) => s.id === slotId);
  const att = slot && pathAttachment(slotId, name);
  return slot && att ? { slotId, slotBone: slot.bone, name, att } : null;
}

function pathAttachment(slotId: string, name: string): PathAttachment | null {
  for (const skin of [activeSkinId() ? store.doc.skeleton.skins.find((k) => k.id === activeSkinId()) : null, store.doc.skeleton.skins[0], ...store.doc.skeleton.skins]) {
    const a = skin?.attachments[slotId]?.[name];
    if (a) return a.type === "path" ? a : null;
  }
  return null;
}

/** World positions of every point of the path in the viewport's pose (includes deform keys in Animate mode). */
export function pathWorld(h: PenHost, t: PathTarget): number[] | null {
  const sk = h.sk();
  const slot = sk.slotById_(t.slotId);
  const att = slot && sk.getAttachment(slot, t.name);
  return slot && att?.type === "path" ? Array.from(sk.attachmentWorldVertices(slot, att)) : null;
}

/** The path is drawn: its slot shows it, its bone is active and the slot is not hidden. */
export function pathShown(sk: Skeleton, slotId: string, name: string, opacity: (id: string) => number): boolean {
  const slot = sk.slotById_(slotId);
  return !!slot && slot.bone.active && opacity(slotId) > 0 && sk.getAttachment(slot)?.name === name;
}

// ---------------- handle modes ----------------

/**
 * Explicit handle modes, for knots whose geometry does not say (a "broken" knot whose handles happen to line up).
 * Session-only: the file stores just the handles, and the mode is otherwise read from them.
 */
const overrides = new Map<string, { count: number; modes: (HandleMode | undefined)[] }>();
const okey = (t: { slotId: string; name: string }) => `${t.slotId}|${t.name}`;

export function knotMode(t: PathTarget, k: number, world?: ArrayLike<number>): HandleMode {
  const o = overrides.get(okey(t));
  const n = knotCount(t.att.vertices);
  if (o && o.count === n && o.modes[k]) return o.modes[k]!;
  return inferMode(world ?? t.att.vertices, k);
}

export function setKnotMode(t: PathTarget, k: number, m: HandleMode | undefined, count = knotCount(t.att.vertices)) {
  const o = overrides.get(okey(t));
  const modes = o && o.count === count ? o.modes : [];
  modes[k] = m;
  overrides.set(okey(t), { count, modes });
}

/** Keep the overrides lined up after knots are inserted (`ins` > 0) or removed. */
function spliceModes(t: { slotId: string; name: string }, oldCount: number, at: number, del: number, ins: number) {
  const o = overrides.get(okey(t));
  if (!o || o.count !== oldCount) return;
  o.modes.splice(at, del, ...Array<HandleMode | undefined>(ins).fill(undefined));
  o.count = oldCount - del + ins;
}

// ---------------- commit ----------------

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

export interface PathCommit {
  /** Old point index each new point came from (null = new point). Default: unchanged indexing. */
  source?: (number | null)[];
  /** Bone → weight of a new point on a weighted path (default: the nearest old point's). */
  weightsFor?: (i: number) => Map<string, number>;
  closed?: boolean;
  label: string;
}

/**
 * Write new world positions for the path's points (Setup mode). Unweighted points go to slot-bone space; weighted
 * ones keep their bones and weights and get new bone-local positions, so each lands exactly where it was put.
 * Deform keys are re-indexed when points were added or removed. One undo step.
 */
export function commitPath(h: PenHost, t: PathTarget, world: number[], o: PathCommit): boolean {
  const n = world.length / 2;
  const source = o.source ?? identity(n);
  const mats = boneMat(h);
  const slotInv = invert(mats(t.slotBone));
  const vertices: number[] = [];
  for (let i = 0; i < n; i++) vertices.push(...applyM(slotInv, world[i * 2], world[i * 2 + 1]).map(r3));
  let weights: PathAttachment["weights"];
  const old = t.att.weights;
  if (old) {
    const oldWorld = pathSetupWorld(t);
    weights = [];
    for (let i = 0; i < n; i++) {
      const src = source[i];
      const inf =
        src != null && old[src]
          ? old[src].map((x) => ({ bone: x.bone, weight: x.weight }))
          : [...(o.weightsFor?.(i) ?? weightMap(old[nearestIndex(oldWorld, world[i * 2], world[i * 2 + 1])] ?? []))].map(([bone, weight]) => ({ bone, weight }));
      weights.push(rebindWorld(inf, mats, world[i * 2], world[i * 2 + 1]).map((x) => ({ bone: x.bone, x: r3(x.x), y: r3(x.y), weight: Math.round(x.weight * 1e4) / 1e4 })));
    }
  }
  const reindexed = source.length !== t.att.vertices.length / 2 || source.some((s, i) => s !== i);
  try {
    store.transaction(o.label, () => {
      store.apply("updateAttachment", {
        slot: t.slotId,
        attachment: t.name,
        ...ownerSkinArg(t.slotId, t.name),
        props: { vertices, ...(weights ? { weights } : {}), ...(o.closed !== undefined ? { closed: o.closed } : {}) },
      });
      if (reindexed) reindexDeform(t.slotId, t.name, source);
    });
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

/** Keep deform keys of a mesh or path aligned with a new point list (new points get no offset). */
export function reindexDeform(slotId: string, name: string, source: (number | null)[]) {
  for (const anim of store.doc.animations)
    for (const tl of anim.timelines) {
      if (tl.target !== "deform" || tl.id !== slotId || tl.attachment !== name) continue;
      const keys = (tl.keys as Key<number[]>[]).map((k) => ({
        time: k.time,
        curve: k.curve,
        value: source.flatMap((s) => (s == null ? [0, 0] : [k.value[s * 2] ?? 0, k.value[s * 2 + 1] ?? 0])),
      }));
      store.apply("setKeys", { animation: anim.id, target: "deform", id: slotId, attachment: name, property: "offsets", keys });
    }
}

/** Setup-pose world positions (no constraints, no deform): used to find nearest weights. */
function pathSetupWorld(t: PathTarget): number[] {
  const w = setupWorld(store.doc);
  const out: number[] = [];
  const n = t.att.vertices.length / 2;
  for (let i = 0; i < n; i++) {
    const inf = t.att.weights?.[i];
    if (inf) {
      let x = 0;
      let y = 0;
      for (const b of inf) {
        const [px, py] = applyM(w.get(b.bone) ?? IDENT, b.x, b.y);
        x += px * b.weight;
        y += py * b.weight;
      }
      out.push(x, y);
    } else out.push(...applyM(w.get(t.slotBone) ?? IDENT, t.att.vertices[i * 2], t.att.vertices[i * 2 + 1]));
  }
  return out;
}
const IDENT = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

const weightMap = (inf: { bone: string; weight: number }[]) => new Map(inf.map((i) => [i.bone, i.weight]));

function nearestIndex(world: ArrayLike<number>, x: number, y: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < world.length / 2; i++) {
    const d = (world[i * 2] - x) ** 2 + (world[i * 2 + 1] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/**
 * Animate mode: key the path's deform at the current time so its points sit at `world` in this pose. Offsets are
 * solved through the weights (weighted) or the slot bone (unweighted), the way the runtime applies them.
 */
export function keyPathDeform(h: PenHost, t: PathTarget, world: number[]): boolean {
  if (!autoKey()) {
    toast("Auto-key is off: turn it on to key path knots", "info");
    return false;
  }
  const anim = ensureAnimation();
  if (!anim) return false;
  const mats = boneMat(h);
  const n = world.length / 2;
  const value: number[] = [];
  for (let i = 0; i < n; i++) {
    const wx = world[i * 2];
    const wy = world[i * 2 + 1];
    const inf = t.att.weights?.[i];
    const off = inf ? weightedOffset(inf, mats, wx, wy) : localOffset(mats(t.slotBone), t.att.vertices[i * 2], t.att.vertices[i * 2 + 1], wx, wy);
    value.push(r3(off[0]), r3(off[1]));
  }
  setKeysExtending({ animation: anim, target: "deform", id: t.slotId, attachment: t.name, property: "offsets", keys: [{ time: Math.round(time() * 1000) / 1000, value }] });
  return true;
}

/** Move points: Setup mode writes the path, Animate mode keys its deform. */
export function editPath(h: PenHost, t: PathTarget, world: number[], label: string): boolean {
  return mode() === "animate" ? keyPathDeform(h, t, world) : commitPath(h, t, world, { label });
}

/** Structural edits (adding/removing knots, closing) change setup data only. */
export function setupOnly(what: string): boolean {
  if (mode() !== "animate") return true;
  toast(`${what} changes the setup pose: switch to Setup mode (dragging knots in Animate mode keys their deform)`, "info");
  return false;
}

// ---------------- knot operations ----------------

/** Insert a knot on segment `s` at `t` without changing the curve's shape. Selects it. */
export function insertKnotAt(h: PenHost, t: PathTarget, s: number, tt: number): number {
  if (!setupOnly("Adding a knot")) return -1;
  const world = pathWorld(h, t);
  if (!world) return -1;
  const n = knotCount(world);
  const { vertices, knot } = insertKnot(world, s, tt);
  const source: (number | null)[] = identity(n * 3);
  source.splice(knot * 3, 0, null, null, null);
  const a = s;
  const b = (s + 1) % n;
  const blended = t.att.weights ? blendInfluences(weightMap(t.att.weights[a * 3 + 1]), weightMap(t.att.weights[b * 3 + 1]), tt) : undefined;
  if (!commitPath(h, t, vertices, { source, weightsFor: () => blended!, label: "add knot" })) return -1;
  spliceModes(t, n, knot, 0, 1);
  setPenSel([knot * 3 + 1]);
  return knot;
}

export function deleteKnotsOf(h: PenHost, t: PathTarget, knots: number[]): boolean {
  if (!setupOnly("Deleting knots")) return false;
  const world = pathWorld(h, t);
  if (!world) return false;
  const n = knotCount(world);
  const drop = new Set(knots);
  if (n - drop.size < 2) {
    toast("A path needs at least two knots (delete the attachment to remove it)", "error");
    return false;
  }
  const keep = identity(n).filter((k) => !drop.has(k));
  const source = keep.flatMap((k) => [k * 3, k * 3 + 1, k * 3 + 2]);
  if (!commitPath(h, t, deleteKnots(world, drop), { source, label: drop.size > 1 ? `delete ${drop.size} knots` : "delete knot" })) return false;
  const o = overrides.get(okey(t));
  if (o && o.count === n) overrides.set(okey(t), { count: keep.length, modes: keep.map((k) => o.modes[k]) });
  setPenSel([]);
  return true;
}

/** Put knots' handles into a mode (smooth/mirrored line them up; broken only frees them). */
export function setModeOf(h: PenHost, t: PathTarget, knots: number[], m: HandleMode) {
  let world = pathWorld(h, t);
  if (!world) return;
  const n = knotCount(world);
  for (const k of knots) {
    world = applyMode(world, k, m);
    setKnotMode(t, k, m, n);
  }
  if (m !== "broken") editPath(h, t, world, `${m} handles`);
}

export function resetHandlesOf(h: PenHost, t: PathTarget, knots: number[]) {
  let world = pathWorld(h, t);
  if (!world) return;
  const n = knotCount(world);
  for (const k of knots) {
    world = resetHandles(world, t.att.closed, k);
    setKnotMode(t, k, undefined, n);
  }
  editPath(h, t, world, knots.length > 1 ? "reset handles" : "reset handle");
}

export function setClosed(t: PathTarget, closed: boolean) {
  apply("updateAttachment", { slot: t.slotId, attachment: t.name, ...ownerSkinArg(t.slotId, t.name), props: { closed } });
}

// ---------------- drawing ----------------

/** A path being drawn with the Pen tool: new knots (world space, 6 numbers each) in path order. */
export interface Drawing {
  bone: string;
  knots: number[];
  closed: boolean;
  /** Extending an existing open path at its end (or, `prepend`, its start). */
  extend?: { slotId: string; name: string; prepend: boolean };
}

/** Commit a drawn path: a new slot + path on `bone`, or the knots added to the extended path. One undo step. */
export function commitDrawing(h: PenHost, d: Drawing): { slotId: string; name: string } | null {
  const added = d.knots.length / 6;
  if (d.extend) {
    const t = pathTargetFor(d.extend.slotId, d.extend.name);
    const world = t && pathWorld(h, t);
    if (!t || !world) return null;
    if (!added && d.closed === t.att.closed) return d.extend;
    const n = world.length / 2;
    const nw = d.extend.prepend ? [...d.knots, ...world] : [...world, ...d.knots];
    const fresh = Array<null>(added * 3).fill(null);
    const source = d.extend.prepend ? [...fresh, ...identity(n)] : [...identity(n), ...fresh];
    const endAnchor = d.extend.prepend ? 1 : n - 2;
    const w = t.att.weights?.[endAnchor];
    const nk = knotCount(world);
    if (!commitPath(h, t, nw, { source, weightsFor: w ? () => weightMap(w) : undefined, closed: d.closed, label: added ? "extend path" : "close path" })) return null;
    spliceModes(t, nk, d.extend.prepend ? 0 : nk, 0, added);
    return d.extend;
  }
  if (added < 2) {
    if (added === 1) toast("A path needs at least two knots", "info");
    return null;
  }
  const inv = invert(boneMat(h)(d.bone));
  const vertices: number[] = [];
  for (let i = 0; i < d.knots.length; i += 2) vertices.push(...applyM(inv, d.knots[i], d.knots[i + 1]).map(r3));
  let out: { slotId: string; name: string } | null = null;
  transaction("draw path", () => {
    const slot = store.apply("addSlot", { bone: d.bone, name: "path" }) as { id: string };
    const skin = activeSkinId() && store.doc.skeleton.skins.slice(1).some((s) => s.id === activeSkinId()) ? { skin: activeSkinId()! } : {};
    store.apply("addPath", { slot: slot.id, name: "path", vertices, closed: d.closed, ...skin });
    out = { slotId: slot.id, name: "path" };
  });
  return out;
}

// ---------------- binding knots to bones ----------------

/** Per-point bone → weight maps (an unweighted path is 100% its slot bone). */
export function pathWeightTable(t: PathTarget): Map<string, number>[] {
  const n = t.att.vertices.length / 2;
  return Array.from({ length: n }, (_, v) => new Map(t.att.weights ? t.att.weights[v].map((i) => [i.bone, i.weight]) : [[t.slotBone, 1]]));
}

/** The three point indices of each knot. */
export const knotPoints = (knots: number[]) => knots.flatMap((k) => [k * 3, k * 3 + 1, k * 3 + 2]);

/**
 * Write per-knot weights: every point of a knot (its anchor and both handles) gets the same influences, so the
 * handles follow their anchor. Positions keep their setup-pose place (the op re-binds them).
 */
export function commitKnotWeights(t: PathTarget, table: Map<string, number>[], knots: number[]) {
  const vertices = knotPoints(knots).map((p) => ({ vertex: p, influences: [...table[Math.floor(p / 3) * 3 + 1]].map(([bone, weight]) => ({ bone, weight: Math.round(weight * 1e4) / 1e4 })) }));
  if (vertices.length) apply("setMeshWeights", { slot: t.slotId, attachment: t.name, ...ownerSkinArg(t.slotId, t.name), vertices });
}

/** Remove the weights: knots stay where they are in the setup pose, back in slot-bone space. */
export function unbindPath(t: PathTarget) {
  if (!t.att.weights) return;
  const w = pathSetupWorld(t);
  const inv = invert(setupWorld(store.doc).get(t.slotBone) ?? IDENT);
  const vertices: number[] = [];
  for (let i = 0; i < w.length; i += 2) vertices.push(...applyM(inv, w[i], w[i + 1]).map(r3));
  apply("updateAttachment", { slot: t.slotId, attachment: t.name, ...ownerSkinArg(t.slotId, t.name), props: { vertices, weights: null } });
}

/** Setup-pose world position of each knot's anchor (for distance-based auto weights). */
export function anchorSetupWorld(t: PathTarget): number[] {
  return pathSetupWorld(t);
}

export type { Mat };
