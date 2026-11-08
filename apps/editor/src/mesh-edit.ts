import { type Key, type MeshAttachment, apply as applyM, invert, setupWorld, triangulate } from "@openbone/core";
import { apply, meshSel, rev, selectedAttachment, setMeshSel, store, toast } from "./state.ts";

/**
 * Mesh vertex editing and weight painting. All edits work in the setup pose and are committed as ops
 * (`updateAttachment`, `setMeshWeights`, `setKeys` for deform keys), never by mutating the document.
 */

export interface MeshTarget {
  slotId: string;
  slotBone: string;
  name: string;
  att: MeshAttachment;
}

export function meshTarget(): MeshTarget | null {
  const sel = selectedAttachment();
  if (!sel || sel.att.type !== "mesh") return null;
  const slot = store.doc.skeleton.slots.find((s) => s.id === sel.slotId)!;
  return { slotId: sel.slotId, slotBone: slot.bone, name: sel.att.name, att: sel.att };
}

let svCache: { doc: object; att: object; rev: number; out: number[] } | null = null;

/** Setup-pose world positions of every vertex (flat x,y). Cached per document revision. */
export function setupVertices(t: MeshTarget): number[] {
  const r = rev();
  if (svCache && svCache.doc === store.doc && svCache.att === t.att && svCache.rev === r) return svCache.out.slice();
  const out = computeSetupVertices(t);
  svCache = { doc: store.doc, att: t.att, rev: r, out };
  return out.slice();
}

function computeSetupVertices(t: MeshTarget): number[] {
  const world = setupWorld(store.doc);
  const { att } = t;
  const out: number[] = [];
  const n = att.vertices.length / 2;
  for (let v = 0; v < n; v++) {
    if (att.weights) {
      let x = 0;
      let y = 0;
      for (const inf of att.weights[v]) {
        const [px, py] = applyM(world.get(inf.bone)!, inf.x, inf.y);
        x += px * inf.weight;
        y += py * inf.weight;
      }
      out.push(x, y);
    } else out.push(...applyM(world.get(t.slotBone)!, att.vertices[v * 2], att.vertices[v * 2 + 1]));
  }
  return out;
}

/** Least-squares affine map from slot-local vertex positions to uvs, used to place uvs of moved/new vertices. */
function uvMap(att: MeshAttachment, local: number[]): (x: number, y: number) => [number, number] {
  const n = local.length / 2;
  // Normal equations for [u v] = [x y 1] · M
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = [local[i * 2], local[i * 2 + 1], 1];
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) A[j * 3 + k] += r[j] * r[k];
      bu[j] += r[j] * att.uvs[i * 2];
      bv[j] += r[j] * att.uvs[i * 2 + 1];
    }
  }
  const mu = solve3(A, bu);
  const mv = solve3(A, bv);
  const affine = (x: number, y: number): [number, number] =>
    mu && mv ? [mu[0] * x + mu[1] * y + mu[2], mv[0] * x + mv[1] * y + mv[2]] : [0.5, 0.5];
  // Prefer barycentric interpolation inside the old triangle that contains the point.
  return (x, y) => {
    const T = att.triangles;
    for (let t = 0; t < T.length; t += 3) {
      const [a, b, c] = [T[t], T[t + 1], T[t + 2]];
      const ax = local[a * 2], ay = local[a * 2 + 1];
      const v0x = local[b * 2] - ax, v0y = local[b * 2 + 1] - ay;
      const v1x = local[c * 2] - ax, v1y = local[c * 2 + 1] - ay;
      const den = v0x * v1y - v1x * v0y;
      if (Math.abs(den) < 1e-12) continue;
      const s = ((x - ax) * v1y - v1x * (y - ay)) / den;
      const r = (v0x * (y - ay) - (x - ax) * v0y) / den;
      if (s < -1e-6 || r < -1e-6 || s + r > 1 + 1e-6) continue;
      const w = 1 - s - r;
      return [w * att.uvs[a * 2] + s * att.uvs[b * 2] + r * att.uvs[c * 2], w * att.uvs[a * 2 + 1] + s * att.uvs[b * 2 + 1] + r * att.uvs[c * 2 + 1]];
    }
    return affine(x, y);
  };
}

function solve3(A: number[], b: number[]): number[] | null {
  const [a, bb, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [e * i - f * h, c * h - bb * i, bb * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, bb * g - a * h, a * e - bb * d].map((x) => x / det);
  return [0, 1, 2].map((r) => inv[r * 3] * b[0] + inv[r * 3 + 1] * b[1] + inv[r * 3 + 2] * b[2]);
}

/**
 * Write new geometry for the mesh. `world` are setup-pose world positions of the new vertex list, `hull` how
 * many of them form the outline, and `source[i]` the old index vertex i came from (null for a new vertex).
 * Uvs follow the image (vertices slide over it) unless `warp` is set, in which case existing vertices keep
 * their uvs and the image stretches. Weights, deform keys and triangles are rebuilt to match.
 */
export interface Geometry {
  vertices: number[];
  uvs: number[];
  triangles: number[];
  hull: number;
  weights?: MeshAttachment["weights"];
}

export function buildGeometry(t: MeshTarget, world: number[], hull: number, source: (number | null)[], warp = false): Geometry | string {
  const { att } = t;
  const n = world.length / 2;
  if (hull < 3) return "A mesh needs at least 3 hull vertices";
  const setup = setupWorld(store.doc);
  const slotInv = invert(setup.get(t.slotBone)!);
  const oldWorld = setupVertices(t);
  const oldLocal: number[] = [];
  for (let i = 0; i < oldWorld.length; i += 2) oldLocal.push(...applyM(slotInv, oldWorld[i], oldWorld[i + 1]));
  const toUv = uvMap(att, oldLocal);
  const vertices: number[] = [];
  const uvs: number[] = [];
  const weights: MeshAttachment["weights"] = att.weights ? [] : undefined;
  for (let i = 0; i < n; i++) {
    const wx = world[i * 2];
    const wy = world[i * 2 + 1];
    const [lx, ly] = applyM(slotInv, wx, wy);
    vertices.push(round(lx), round(ly));
    const src = source[i];
    const unmoved = src != null && Math.abs(oldWorld[src * 2] - wx) < 1e-6 && Math.abs(oldWorld[src * 2 + 1] - wy) < 1e-6;
    const uv = src != null && (warp || unmoved) ? [att.uvs[src * 2], att.uvs[src * 2 + 1]] : toUv(lx, ly);
    uvs.push(round(uv[0], 1e5), round(uv[1], 1e5));
    if (weights && att.weights) {
      const from = src ?? nearest(oldWorld, wx, wy);
      weights.push(
        att.weights[from].map((inf) => {
          const [x, y] = applyM(invert(setup.get(inf.bone)!), wx, wy);
          return { bone: inf.bone, x, y, weight: inf.weight };
        }),
      );
    }
  }
  if (hullCrosses(vertices, hull)) return "The mesh outline would cross itself";
  const triangles = triangulate(vertices.slice(0, hull * 2), vertices.slice(hull * 2));
  if (!triangles.length) return "Could not triangulate the mesh (hull edges cross?)";
  return { vertices, uvs, triangles, hull, ...(weights ? { weights } : {}) };
}

/**
 * Write new geometry for the mesh. `world` are setup-pose world positions of the new vertex list, `hull` how
 * many of them form the outline, and `source[i]` the old index vertex i came from (null for a new vertex).
 * Moved and new vertices slide over the image (uvs follow) unless `warp` is set, in which case existing
 * vertices keep their uvs and the image stretches. Weights, deform keys and triangles are rebuilt to match.
 */
export function commitGeometry(t: MeshTarget, world: number[], hull: number, source: (number | null)[], warp = false, label = "edit mesh"): boolean {
  const g = buildGeometry(t, world, hull, source, warp);
  if (typeof g === "string") {
    toast(g, "error");
    return false;
  }
  const { att } = t;
  try {
    store.transaction(label, () => {
    store.apply("updateAttachment", { slot: t.slotId, attachment: t.name, props: { ...g } });
    // Keep deform keys aligned with the new vertex list.
    if (source.length !== att.vertices.length / 2 || source.some((s, i) => s !== i))
      for (const anim of store.doc.animations)
        for (const tl of anim.timelines) {
          if (tl.target !== "deform" || tl.id !== t.slotId || tl.attachment !== t.name) continue;
          const keys = (tl.keys as Key<number[]>[]).map((k) => ({
            time: k.time,
            curve: k.curve,
            value: source.flatMap((s) => (s == null ? [0, 0] : [k.value[s * 2] ?? 0, k.value[s * 2 + 1] ?? 0])),
          }));
          store.apply("setKeys", { animation: anim.id, target: "deform", id: t.slotId, attachment: t.name, property: "offsets", keys });
        }
    });
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Move vertices (by index) to new world positions. */
export function movedWorld(t: MeshTarget, moved: Map<number, [number, number]>): number[] {
  const world = setupVertices(t);
  for (const [i, [x, y]] of moved) {
    world[i * 2] = x;
    world[i * 2 + 1] = y;
  }
  return world;
}

export function moveVertices(t: MeshTarget, moved: Map<number, [number, number]>, warp: boolean) {
  const world = movedWorld(t, moved);
  commitGeometry(t, world, t.att.hull, identity(world.length / 2), warp, "move vertices");
}

/**
 * Add a vertex at a world position. Inside the hull it becomes an interior vertex; outside it is inserted
 * into the hull on the nearest outline edge. Returns its new index.
 */
export function addVertex(t: MeshTarget, x: number, y: number, inside: boolean): number {
  const world = setupVertices(t);
  const n = world.length / 2;
  const hull = t.att.hull;
  const source: (number | null)[] = identity(n);
  if (inside) {
    world.push(x, y);
    source.push(null);
    return commitGeometry(t, world, hull, source, false, "add vertex") ? n : -1;
  }
  // Insert after the start of the nearest hull edge.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < hull; i++) {
    const j = (i + 1) % hull;
    const d = segDistSq(x, y, world[i * 2], world[i * 2 + 1], world[j * 2], world[j * 2 + 1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const at = best + 1;
  world.splice(at * 2, 0, x, y);
  source.splice(at, 0, null);
  return commitGeometry(t, world, hull + 1, source, false, "add vertex") ? at : -1;
}

export function deleteVertices(t: MeshTarget, indices: number[]) {
  const drop = new Set(indices);
  const world = setupVertices(t);
  const n = world.length / 2;
  const keep = identity(n).filter((i) => !drop.has(i));
  const hull = keep.filter((i) => i < t.att.hull).length;
  if (keep.length < 3 || hull < 3) return toast("A mesh needs at least 3 hull vertices", "error");
  commitGeometry(t, keep.flatMap((i) => [world[i * 2], world[i * 2 + 1]]), hull, keep, true, "delete vertices");
}

/** Delete the vertices selected with the mesh tool. Returns false when there was nothing to delete. */
export function deleteSelectedVertices(): boolean {
  const t = meshTarget();
  const sel = meshSel();
  if (!t || !sel.length) return false;
  deleteVertices(t, sel);
  setMeshSel([]);
  return true;
}

/** Select every vertex of the selected mesh. Returns false when no mesh is selected. */
export function selectAllVertices(): boolean {
  const t = meshTarget();
  if (!t) return false;
  setMeshSel(identity(t.att.vertices.length / 2));
  return true;
}

/** Move the selected vertices by (dx, dy) world units. */
export function nudgeSelected(dx: number, dy: number): boolean {
  const t = meshTarget();
  const sel = meshSel();
  if (!t || !sel.length) return false;
  const world = setupVertices(t);
  moveVertices(t, new Map(sel.map((i) => [i, [world[i * 2] + dx, world[i * 2 + 1] + dy] as [number, number]])), false);
  return true;
}

// ---------------- weight painting ----------------

export type WeightTable = Map<string, number>[];

/** Per-vertex bone → weight maps (an unweighted mesh is 100% its slot bone). */
export function weightTable(t: MeshTarget): WeightTable {
  const n = t.att.vertices.length / 2;
  return Array.from({ length: n }, (_, v) => new Map(t.att.weights ? t.att.weights[v].map((i) => [i.bone, i.weight]) : [[t.slotBone, 1]]));
}

/**
 * One brush dab at world (cx, cy). Adds (or removes) weight for `bone` with a smooth falloff and
 * renormalises the other influences. Returns the vertices it changed.
 */
export function paintDab(table: WeightTable, world: number[], cx: number, cy: number, radius: number, strength: number, bone: string, mode: "add" | "subtract"): number[] {
  const changed: number[] = [];
  for (let v = 0; v < table.length; v++) {
    const d = Math.hypot(world[v * 2] - cx, world[v * 2 + 1] - cy);
    if (d > radius) continue;
    const f = strength * (1 - (d / radius) ** 2);
    if (f <= 0) continue;
    const m = table[v];
    const old = m.get(bone) ?? 0;
    const others = 1 - old;
    let next = mode === "add" ? old + f * (1 - old) : old - f * old;
    // A vertex must keep some influence: can't remove weight from its only bone.
    if (mode === "subtract" && others <= 1e-6) continue;
    next = Math.min(1, Math.max(0, next));
    if (Math.abs(next - old) < 1e-6) continue;
    const k = others > 1e-6 ? (1 - next) / others : 0;
    for (const [b, w] of m) if (b !== bone) m.set(b, w * k);
    m.set(bone, next);
    for (const [b, w] of m) if (w < 1e-3) m.delete(b);
    // Renormalise after pruning.
    const total = [...m.values()].reduce((s, w) => s + w, 0) || 1;
    for (const [b, w] of m) m.set(b, w / total);
    changed.push(v);
  }
  return changed;
}

export function commitWeights(t: MeshTarget, table: WeightTable, changed: Iterable<number>) {
  const vertices = [...new Set(changed)].sort((a, b) => a - b).map((v) => ({
    vertex: v,
    influences: [...table[v]].map(([bone, weight]) => ({ bone, weight: round(weight, 1e4) })),
  }));
  if (vertices.length) apply("setMeshWeights", { slot: t.slotId, attachment: t.name, vertices });
}

/** True when two non-adjacent edges of the closed outline (first `hull` vertices) intersect. */
export function hullCrosses(pts: number[], hull: number): boolean {
  const P = (i: number): [number, number] => [pts[(i % hull) * 2], pts[(i % hull) * 2 + 1]];
  const orient = (a: number[], b: number[], c: number[]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < hull; i++)
    for (let j = i + 2; j < hull; j++) {
      if (i === 0 && j === hull - 1) continue; // adjacent through the wrap-around
      const [a, b, c, d] = [P(i), P(i + 1), P(j), P(j + 1)];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
  return false;
}

export function nearest(world: ArrayLike<number>, x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < world.length / 2; i++) {
    const d = (world[i * 2] - x) ** 2 + (world[i * 2 + 1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}

const round = (n: number, k = 1e3) => Math.round(n * k) / k;

// ---------- Weights panel (Direct mode, Smooth, Auto, Prune) ----------

/** Average weight of each bone over some vertices, biggest first. */
export function averageWeights(table: WeightTable, verts: number[]): { bone: string; w: number }[] {
  const sum = new Map<string, number>();
  for (const v of verts) for (const [b, w] of table[v] ?? []) sum.set(b, (sum.get(b) ?? 0) + w);
  return [...sum].map(([bone, s]) => ({ bone, w: s / Math.max(1, verts.length) })).sort((a, b) => b.w - a.w);
}

const normalise = (m: Map<string, number>, min = 1e-4) => {
  for (const [b, w] of m) if (w < min) m.delete(b);
  const total = [...m.values()].reduce((s, w) => s + w, 0);
  if (total > 0) for (const [b, w] of m) m.set(b, w / total);
};

/** Set `bone` to `value` on each vertex; the other influences share the rest in their current proportions. */
export function setBoneWeight(table: WeightTable, verts: number[], bone: string, value: number): number[] {
  const changed: number[] = [];
  const v01 = Math.min(1, Math.max(0, value));
  for (const v of verts) {
    const m = table[v];
    const others = [...m].filter(([b]) => b !== bone).reduce((s, [, w]) => s + w, 0);
    // The only influence can't drop below 100%: there is nothing to take the rest.
    if (others <= 1e-6 && v01 < 1) continue;
    const k = others > 1e-6 ? (1 - v01) / others : 0;
    for (const [b, w] of m) if (b !== bone) m.set(b, w * k);
    m.set(bone, v01);
    normalise(m);
    changed.push(v);
  }
  return changed;
}

/** Blend each vertex's weights toward the average of its mesh neighbours (strength 0..1). */
export function smoothWeights(table: WeightTable, verts: number[], triangles: number[], strength = 0.5): number[] {
  const neighbours = new Map<number, Set<number>>();
  for (let i = 0; i < triangles.length; i += 3) {
    const t = [triangles[i], triangles[i + 1], triangles[i + 2]];
    for (const a of t) for (const b of t) if (a !== b) (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
  }
  const next = verts.map((v) => {
    const ns = [...(neighbours.get(v) ?? [])];
    if (!ns.length) return null;
    const avg = new Map<string, number>();
    for (const n of ns) for (const [b, w] of table[n]) avg.set(b, (avg.get(b) ?? 0) + w / ns.length);
    const m = new Map<string, number>();
    for (const b of new Set([...table[v].keys(), ...avg.keys()])) m.set(b, (1 - strength) * (table[v].get(b) ?? 0) + strength * (avg.get(b) ?? 0));
    normalise(m);
    return m;
  });
  const changed: number[] = [];
  verts.forEach((v, i) => {
    if (next[i]) {
      table[v] = next[i]!;
      changed.push(v);
    }
  });
  return changed;
}

/** Drop influences below `threshold` and keep at most `maxInfluences` per vertex, then renormalise. */
export function pruneWeights(table: WeightTable, verts: number[], threshold = 0.05, maxInfluences = 4): number[] {
  const changed: number[] = [];
  for (const v of verts) {
    const m = table[v];
    const kept = [...m].sort((a, b) => b[1] - a[1]).filter(([, w], i) => i === 0 || (w >= threshold && i < maxInfluences));
    if (kept.length === m.size) continue;
    table[v] = new Map(kept);
    normalise(table[v]);
    changed.push(v);
  }
  return changed;
}

/** Recompute weights from the nearest bone segments (like the autoWeights op), for some vertices only. */
export function autoWeightsFor(table: WeightTable, verts: number[], world: number[], bones: string[], maxInfluences = 2, falloff = 2): number[] {
  const sw = setupWorld(store.doc);
  const segs = bones
    .map((id) => {
      const b = store.doc.skeleton.bones.find((x) => x.id === id);
      const m = sw.get(id);
      if (!b || !m) return null;
      const [ex, ey] = applyM(m, Math.max(b.length, 1e-3), 0);
      return { id, ax: m.x, ay: m.y, ex, ey };
    })
    .filter(Boolean) as { id: string; ax: number; ay: number; ex: number; ey: number }[];
  if (!segs.length) return [];
  for (const v of verts) {
    const x = world[v * 2];
    const y = world[v * 2 + 1];
    const scored = segs.map((s) => ({ id: s.id, score: 1 / Math.pow(Math.sqrt(segDistSq(x, y, s.ax, s.ay, s.ex, s.ey)) + 1, falloff) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxInfluences);
    const total = top.reduce((s, t) => s + t.score, 0) || 1;
    table[v] = new Map(top.map((t) => [t.id, t.score / total]));
  }
  return verts;
}
