/**
 * Conformance suite generator: runs the TypeScript runtime (the reference) over every fixture and example and writes
 * what it produced, so runtimes in other languages can prove they pose, draw and react identically.
 *
 *   pnpm conformance          regenerate conformance/expected/*.json (and conformance/fixtures/*.obone)
 *
 * Each expected file holds "cases": the setup pose per skin, every animation played on track 0, and a scripted run of
 * every state machine. A case is a list of samples taken at fixed steps (dt = 1/60, sample every 10 steps). See
 * conformance/README.md for the format and tolerances, docs/runtime-spec.md for the rules being tested.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenBoneDocument, animationDuration, applyOp, deserialize, layoutAtlas, serialize } from "@openbone/core";
import { type AudioCommand, type DrawItem, type FiredEvent, OpenBoneInstance, type ScriptHost, type Skeleton, SkeletonBounds } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { BOUNDS_QUERIES, type BoundsQueries, FIXTURES } from "./fixtures.ts";

export const FORMAT = 1;
export const DT = 1 / 60;
export const SAMPLE_EVERY = 10;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const r4 = (n: number) => {
  const v = Math.round(n * 1e4) / 1e4;
  return Object.is(v, -0) ? 0 : v;
};
const arr = (a: ArrayLike<number>) => Array.from(a, r4);

export interface DrawRecord {
  slot: string;
  attachment: string;
  type: string;
  blend: string;
  texture: string | null;
  vertices: number[];
  uvs: number[];
  indices: number[];
  color: number[];
  dark?: number[];
  colors?: number[];
  /** Index of the clipping mask (per sample, in draw order) this item is drawn inside. */
  clip?: number;
  text?: string;
}
export interface Sample {
  /** Seconds since the case started. */
  t: number;
  /** World matrix per bone, in document bone order: a, b, c, d, x, y. */
  bones: number[][];
  /** Per slot, in document slot order: attachment name, colour RGBA, dark RGB (or null). */
  slots: [string | null, number[], number[] | null][];
  draw: DrawRecord[];
  /** Events fired since the previous sample. */
  events: { name: string; time: number; int: number; float: number; string: string }[];
  /** Audio commands since the previous sample (play ids renumbered p1, p2… per case). */
  audio: Record<string, unknown>[];
  /** State machine: active state per layer after this sample's step. */
  states?: Record<string, string | null>;
  /** Fixtures with `queries` only: the active bounding boxes and the query results in this pose. */
  bounds?: BoundsRecord;
}
export interface BoundsRecord {
  /** Active bounding boxes in draw order: slot name, attachment name, world vertices. */
  boxes: { slot: string; attachment: string; vertices: number[] }[];
  /** Overall [minX, minY, maxX, maxY], or null with no active box. */
  aabb: number[] | null;
  /** Per query point: indices (into `boxes`) of every box containing it, in order. */
  points: number[][];
  /** Per query segment: indices of every box it touches (crosses an edge or lies inside). */
  segments: number[][];
  /** Per query rectangle: whether the overall AABB overlaps it. */
  aabbs: boolean[];
  /** Per placement in `queries.others`: the first overlapping pair [mine, theirs] (box indices), or null. */
  others: ([number, number] | null)[];
}
/** One scripted action in a state machine case, applied before the step that starts at `t`. */
export type Action =
  | { t: number; input: string; value: number | boolean | string }
  | { t: number; fire: string }
  | { t: number; pointer: "down" | "up" | "move"; x: number; y: number };
export interface Case {
  name: string;
  kind: "setup" | "animation" | "stateMachine";
  skin: string | null;
  animation?: string;
  stateMachine?: string;
  /** Seconds simulated. */
  duration: number;
  actions?: Action[];
  samples: Sample[];
}
export interface Expected {
  format: number;
  fixture: string;
  /** Path of the document, relative to the repo root. */
  document: string;
  dt: number;
  sampleEvery: number;
  /** Bounding-box queries asked of every sample (fixtures listed in BOUNDS_QUERIES only). */
  queries?: BoundsQueries;
  cases: Case[];
}

function drawRecords(items: DrawItem[]): DrawRecord[] {
  const clips: unknown[] = [];
  return items.map((it) => {
    let clip: number | undefined;
    if (it.clip) {
      if (!clips.includes(it.clip)) clips.push(it.clip);
      clip = clips.indexOf(it.clip);
    }
    return {
      slot: it.slot.data.name,
      attachment: it.attachment.name,
      type: it.particles ? "particles" : it.text ? "text" : it.attachment.type,
      blend: it.blend,
      texture: it.texture?.id ?? null,
      vertices: arr(it.vertices),
      uvs: arr(it.uvs),
      indices: Array.from(it.indices),
      color: arr(it.color),
      ...(it.dark ? { dark: arr(it.dark).slice(0, 3) } : {}),
      ...(it.colors ? { colors: arr(it.colors) } : {}),
      ...(clip !== undefined ? { clip } : {}),
      ...(it.text ? { text: it.text.content } : {}),
    };
  });
}

class Recorder {
  events: Sample["events"] = [];
  audio: Sample["audio"] = [];
  private ids = new Map<string, string>();
  constructor(
    inst: OpenBoneInstance,
    private probe?: BoundsProbe,
  ) {
    inst.on("event", (e: FiredEvent) => this.events.push({ name: e.name, time: r4(e.time), int: e.int, float: r4(e.float), string: e.string }));
    inst.on("audio", (c: AudioCommand) => {
      const id = this.ids.get(c.id) ?? `p${this.ids.size + 1}`;
      this.ids.set(c.id, id);
      const out: Record<string, unknown> = { ...c, id };
      for (const [k, v] of Object.entries(out)) if (typeof v === "number") out[k] = r4(v);
      this.audio.push(out);
    });
  }
  sample(inst: OpenBoneInstance, t: number): Sample {
    const sk = inst.skeleton;
    const s: Sample = {
      t: r4(t),
      bones: sk.bones.map((b) => arr([b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y])),
      slots: sk.slots.map((x) => [x.attachmentName, arr(x.color), x.dark ? arr(x.dark).slice(0, 3) : null]),
      draw: drawRecords(sk.drawList()),
      events: this.events,
      audio: this.audio,
      ...(inst.stateMachine ? { states: { ...inst.stateMachine.activeStates } } : {}),
      ...(this.probe ? { bounds: this.probe.record(sk) } : {}),
    };
    this.events = [];
    this.audio = [];
    return s;
  }
}

const NUDGE = 2e-3;
const NUDGES = [[NUDGE, 0], [-NUDGE, 0], [0, NUDGE], [0, -NUDGE]];

/**
 * Records bounding-box query results and notes every candidate query whose answer changes when it is nudged by
 * NUDGE in any direction (it sits on an edge, so float differences between runtimes could flip it). Those are
 * dropped from the expected file once every case has run.
 */
class BoundsProbe {
  unstable = { points: new Set<number>(), segments: new Set<number>(), aabbs: new Set<number>(), others: new Set<number>() };
  /** Per placement: the other skeleton's boxes, then the same nudged four ways. */
  private others: SkeletonBounds[][];
  constructor(
    doc: OpenBoneDocument,
    host: ScriptHost,
    public q: BoundsQueries,
  ) {
    this.others = q.others.map(([x, y]) =>
      [[0, 0], ...NUDGES].map(([dx, dy]) => {
        const o = new OpenBoneInstance(doc, { scriptHost: host });
        o.skeleton.x = x + dx;
        o.skeleton.y = y + dy;
        o.advance(0);
        const b = o.skeleton.boundingBoxes();
        o.dispose();
        return b;
      }),
    );
  }
  record(sk: Skeleton): BoundsRecord {
    const b = sk.boundingBoxes();
    const idx = (list: unknown[]) => list.map((x) => b.boxes.indexOf(x as never));
    const key = (v: unknown) => JSON.stringify(v);
    const check = (set: Set<number>, i: number, base: unknown, nudged: unknown[]) => {
      if (nudged.some((n) => key(n) !== key(base))) set.add(i);
    };
    const points = this.q.points.map(([x, y], i) => {
      const r = idx(b.containsPointAll(x, y));
      check(this.unstable.points, i, r, NUDGES.map(([dx, dy]) => idx(b.containsPointAll(x + dx, y + dy))));
      const first = b.containsPoint(x, y);
      if ((first ? b.boxes.indexOf(first) : -1) !== (r.length ? r[0] : -1)) throw new Error("containsPoint disagrees with containsPointAll");
      return r;
    });
    const segments = this.q.segments.map(([x1, y1, x2, y2], i) => {
      const r = idx(b.intersectsSegmentAll(x1, y1, x2, y2));
      check(this.unstable.segments, i, r, NUDGES.map(([dx, dy]) => idx(b.intersectsSegmentAll(x1 + dx, y1 + dy, x2 + dx, y2 + dy))));
      const first = b.intersectsSegment(x1, y1, x2, y2);
      if ((first ? b.boxes.indexOf(first) : -1) !== (r.length ? r[0] : -1)) throw new Error("intersectsSegment disagrees with intersectsSegmentAll");
      return r;
    });
    const aabbs = this.q.aabbs.map(([x0, y0, x1, y1], i) => {
      const r = b.aabbIntersects(x0, y0, x1, y1);
      check(this.unstable.aabbs, i, r, NUDGES.map(([dx, dy]) => b.aabbIntersects(x0 + dx, y0 + dy, x1 + dx, y1 + dy)));
      return r;
    });
    const others = this.others.map((variants, i) => {
      const pair = (o: SkeletonBounds) => {
        const p = b.intersectsBounds(o);
        return p ? ([b.boxes.indexOf(p[0]), o.boxes.indexOf(p[1])] as [number, number]) : null;
      };
      const r = pair(variants[0]);
      check(this.unstable.others, i, r, variants.slice(1).map(pair));
      return r;
    });
    return {
      boxes: b.boxes.map((x) => ({ slot: x.slot.data.name, attachment: x.attachment, vertices: arr(x.vertices) })),
      aabb: b.boxes.length ? arr([b.minX, b.minY, b.maxX, b.maxY]) : null,
      points,
      segments,
      aabbs,
      others,
    };
  }
  /** Drop the unstable candidates from the queries and from every recorded sample. */
  finish(cases: Case[]): BoundsQueries {
    const keep = <T>(list: T[], bad: Set<number>) => list.filter((_, i) => !bad.has(i));
    const u = this.unstable;
    for (const c of cases)
      for (const s of c.samples) {
        const r = s.bounds!;
        r.points = keep(r.points, u.points);
        r.segments = keep(r.segments, u.segments);
        r.aabbs = keep(r.aabbs, u.aabbs);
        r.others = keep(r.others, u.others);
      }
    return { points: keep(this.q.points, u.points), segments: keep(this.q.segments, u.segments), aabbs: keep(this.q.aabbs, u.aabbs), others: keep(this.q.others, u.others) };
  }
}

/** A run of `steps` fixed steps, sampling every SAMPLE_EVERY (and at step 0). */
function run(inst: OpenBoneInstance, rec: Recorder, steps: number, before?: (step: number, t: number) => void): Sample[] {
  const out: Sample[] = [];
  inst.advance(0);
  out.push(rec.sample(inst, 0));
  for (let i = 1; i <= steps; i++) {
    before?.(i, (i - 1) * DT);
    inst.advance(DT);
    if (i % SAMPLE_EVERY === 0) out.push(rec.sample(inst, i * DT));
  }
  return out;
}

/** Inputs and pointer presses for a state machine: each input changed in turn, then a press on every listener's hit area. */
function autoActions(doc: OpenBoneDocument, inst: OpenBoneInstance, smName: string): Action[] {
  const sm = doc.stateMachines.find((s) => s.name === smName)!;
  const actions: Action[] = [];
  let t = 0.5;
  for (const input of sm.inputs) {
    if (input.type === "trigger") actions.push({ t, fire: input.name });
    else if (input.type === "bool") actions.push({ t, input: input.name, value: !input.default });
    else if (input.type === "number") {
      actions.push({ t, input: input.name, value: 0.5 });
      actions.push({ t: t + 0.5, input: input.name, value: 1 });
    } else actions.push({ t, input: input.name, value: "test" });
    t += 1;
  }
  inst.advance(0);
  for (const l of sm.listeners ?? []) {
    const slot = inst.skeleton.slots.find((s) => s.data.id === l.slot);
    const poly = slot && inst.skeleton.hitPolygon(slot);
    if (!poly) continue;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < poly.length; i += 2) {
      cx += poly[i];
      cy += poly[i + 1];
    }
    cx = r4(cx / (poly.length / 2));
    cy = r4(cy / (poly.length / 2));
    actions.push({ t, pointer: "move", x: cx, y: cy }, { t, pointer: "down", x: cx, y: cy }, { t: t + 0.1, pointer: "up", x: cx, y: cy });
    t += 1;
  }
  return actions;
}

export async function expectedFor(name: string, doc: OpenBoneDocument, docPath: string, host: ScriptHost): Promise<Expected> {
  const cases: Case[] = [];
  const queries = BOUNDS_QUERIES[name]?.();
  const probe = queries && new BoundsProbe(doc, host, queries);
  const skins = doc.skeleton.skins.map((k) => k.name);
  for (const skin of skins) {
    const inst = new OpenBoneInstance(doc, { scriptHost: host });
    inst.skeleton.setSkin(skin);
    const rec = new Recorder(inst, probe);
    cases.push({ name: `setup:${skin}`, kind: "setup", skin, duration: 0, samples: run(inst, rec, 0) });
  }
  for (const anim of doc.animations) {
    for (const skin of skins.length > 1 ? skins : [skins[0]]) {
      const inst = new OpenBoneInstance(doc, { scriptHost: host });
      inst.skeleton.setSkin(skin);
      const rec = new Recorder(inst, probe);
      inst.play(anim.name, true);
      // Play past the end so looping (and events on the wrap) are covered.
      const duration = Math.min(4, Math.max(1, animationDuration(anim) * 1.5));
      const steps = Math.round(duration / DT);
      cases.push({ name: `animation:${anim.name}:${skin}`, kind: "animation", skin, animation: anim.name, duration: r4(steps * DT), samples: run(inst, rec, steps) });
    }
  }
  for (const sm of doc.stateMachines) {
    const inst = new OpenBoneInstance(doc, { scriptHost: host });
    inst.useStateMachine(sm.name);
    const actions = autoActions(doc, inst, sm.name);
    // A fresh instance for the recorded run (autoActions posed the first one to find hit areas).
    inst.dispose();
    const run2 = new OpenBoneInstance(doc, { scriptHost: host });
    const machine = run2.useStateMachine(sm.name);
    const rec = new Recorder(run2, probe);
    const last = actions.reduce((m, a) => Math.max(m, a.t), 0);
    const steps = Math.round(Math.min(10, last + 1.5) / DT);
    const samples = run(run2, rec, steps, (_i, t) => {
      for (const a of actions) {
        if (Math.abs(a.t - t) > DT / 2) continue;
        if ("fire" in a) machine.fire(a.fire);
        else if ("input" in a) machine.setInput(a.input, a.value);
        else run2.pointer(a.pointer, a.x, a.y);
      }
    });
    run2.dispose();
    cases.push({ name: `stateMachine:${sm.name}`, kind: "stateMachine", skin: null, stateMachine: sm.name, duration: r4(steps * DT), actions, samples });
  }
  return { format: FORMAT, fixture: name, document: docPath, dt: r4(DT), sampleEvery: SAMPLE_EVERY, ...(probe ? { queries: probe.finish(cases) } : {}), cases };
}

/** Build with a seeded Math.random, so generated ids (and so the fixture files) are the same on every run. */
function seeded<T>(seed: string, build: () => T): T {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const real = Math.random;
  Math.random = () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return build();
  } finally {
    Math.random = real;
  }
}

/** Every fixture: the focused rigs (written to conformance/fixtures) and the examples. */
export function documents(): { name: string; doc: OpenBoneDocument; path: string }[] {
  const out: { name: string; doc: OpenBoneDocument; path: string }[] = [];
  for (const [name, build] of Object.entries(FIXTURES)) out.push({ name, doc: seeded(name, build), path: `conformance/fixtures/${name}.obone` });
  for (const f of fs.readdirSync(path.join(root, "examples")).filter((x) => x.endsWith(".obone")).sort()) {
    const name = f.replace(/\.obone$/, "");
    out.push({ name: `example-${name}`, doc: deserialize(fs.readFileSync(path.join(root, "examples", f), "utf8")), path: `examples/${f}` });
  }
  // Packed into a texture atlas (layout only; page pixels don't matter): uv remapping, trimming, shared pages.
  for (const name of ["knight", "walker"]) {
    const doc = deserialize(fs.readFileSync(path.join(root, "examples", `${name}.obone`), "utf8"));
    const atlas = layoutAtlas(doc.images);
    for (const p of atlas.pages) p.src = "data:,";
    applyOp(doc, "setAtlas", { atlas });
    out.push({ name: `atlas-${name}`, doc, path: `conformance/fixtures/atlas-${name}.obone` });
  }
  // Polygon packing and premultiplied alpha: every packed region of the knight draws an octagon inside its rect.
  {
    const doc = deserialize(fs.readFileSync(path.join(root, "examples", "knight.obone"), "utf8"));
    const atlas = layoutAtlas(doc.images);
    for (const p of atlas.pages) p.src = "data:,";
    for (const r of atlas.regions) {
      const [w, h, x0, y0] = [r.width, r.height, r.offsetX, r.offsetY];
      const q = Math.min(w, h) * 0.25;
      r.polygon = [x0 + q, y0, x0 + w - q, y0, x0 + w, y0 + q, x0 + w, y0 + h - q, x0 + w - q, y0 + h, x0 + q, y0 + h, x0, y0 + h - q, x0, y0 + q];
    }
    atlas.premultipliedAlpha = true;
    atlas.polygons = true;
    applyOp(doc, "setAtlas", { atlas });
    out.push({ name: "atlas-polygons", doc, path: "conformance/fixtures/atlas-polygons.obone" });
  }
  return out;
}

export const stringify = (e: Expected) => `${JSON.stringify(e)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = await createQuickJsHost();
  fs.mkdirSync(path.join(here, "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(here, "expected"), { recursive: true });
  let total = 0;
  for (const d of documents()) {
    if (d.path.startsWith("conformance/")) fs.writeFileSync(path.join(root, d.path), `${serialize(d.doc)}\n`);
    const e = await expectedFor(d.name, d.doc, d.path, host);
    const text = stringify(e);
    fs.writeFileSync(path.join(here, "expected", `${d.name}.json`), text);
    total += text.length;
    console.log(`${d.name.padEnd(20)} ${String(e.cases.length).padStart(3)} cases  ${(text.length / 1024).toFixed(0).padStart(6)} KB`);
  }
  console.log(`total ${(total / 1024 / 1024).toFixed(1)} MB`);
}
