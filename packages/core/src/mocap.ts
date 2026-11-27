/**
 * Video to animation: turn a tracked body (33 pose landmarks per frame, as MediaPipe's Pose Landmarker reports them)
 * into bone keys. Tracking happens elsewhere (the editor runs the model in the browser); everything here is pure, so the
 * editor and the MCP server produce the same keys from the same track.
 *
 * Limb bones follow the direction of a body segment (upper arm = shoulder → elbow, …). Bones that are the target of an
 * IK constraint follow a point instead (the ankle or the wrist), and one bone can carry the hips' movement.
 */
import { type Affine, RAD, apply, boneWorld, invert, simplifyKeys, wrapDeg } from "./math.ts";
import { setupWorld } from "./setup.ts";
import type { BoneData, Id, OpenBoneDocument } from "./types.ts";

/** One landmark: x and y as fractions of the video's width and height (y down), and a visibility score 0..1. */
export type PosePoint = [x: number, y: number, visibility: number] | null;

export interface PoseFrame {
  /** Seconds from the start of the video. */
  time: number;
  /** The 33 Pose Landmarker points (index = landmark number); null where the body was not found. */
  points: PosePoint[];
}

/** A tracked clip, saved as JSON so it can be mapped again without tracking the video again. */
export interface PoseTrack {
  format?: "openbone-pose-track";
  version?: 1;
  /** Video size in pixels (keeps proportions right: points are fractions of it). */
  width: number;
  height: number;
  /** Frames per second the video was sampled at. */
  fps: number;
  frames: PoseFrame[];
}

/** Pose Landmarker point numbers used here. */
export const POSE_LANDMARKS = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftToe: 31,
  rightToe: 32,
} as const;

type Joint = keyof typeof POSE_LANDMARKS | "hipCentre" | "shoulderCentre" | "earCentre";

/** Body segments a bone can follow (the bone points from the first joint to the second). */
export const POSE_SEGMENTS = {
  leftUpperArm: ["leftShoulder", "leftElbow"],
  leftForearm: ["leftElbow", "leftWrist"],
  leftHand: ["leftWrist", "leftIndex"],
  rightUpperArm: ["rightShoulder", "rightElbow"],
  rightForearm: ["rightElbow", "rightWrist"],
  rightHand: ["rightWrist", "rightIndex"],
  leftThigh: ["leftHip", "leftKnee"],
  leftShin: ["leftKnee", "leftAnkle"],
  leftFoot: ["leftHeel", "leftToe"],
  rightThigh: ["rightHip", "rightKnee"],
  rightShin: ["rightKnee", "rightAnkle"],
  rightFoot: ["rightHeel", "rightToe"],
  spine: ["hipCentre", "shoulderCentre"],
  neck: ["shoulderCentre", "earCentre"],
  head: ["shoulderCentre", "earCentre"],
} as const satisfies Record<string, readonly [Joint, Joint]>;

/** Points a bone can follow with its position: the hips (body movement) and the ends of the limbs (IK targets). */
export const POSE_POINTS = {
  hips: "hipCentre",
  leftWrist: "leftWrist",
  rightWrist: "rightWrist",
  leftAnkle: "leftAnkle",
  rightAnkle: "rightAnkle",
} as const satisfies Record<string, Joint>;

export type PoseSegment = keyof typeof POSE_SEGMENTS;
export type PosePointRole = keyof typeof POSE_POINTS;
/** What a bone follows: a segment (rotation keys) or a point (x and y keys). */
export type PoseSource = PoseSegment | PosePointRole;
/** Bone id or name → what it follows. */
export type PoseMapping = Record<string, PoseSource>;

export const POSE_SOURCES: PoseSource[] = [...(Object.keys(POSE_SEGMENTS) as PoseSegment[]), ...(Object.keys(POSE_POINTS) as PosePointRole[])];

export const isPosePoint = (s: PoseSource): s is PosePointRole => s in POSE_POINTS;

// ---------------------------------------------------------------------------------------------------------------------
// Guessing the mapping from bone names

type Part = "upperArm" | "forearm" | "hand" | "thigh" | "shin" | "foot" | "spine" | "neck" | "head" | "hips";

const PARTS: [Part, RegExp][] = [
  ["forearm", /fore ?arm|lower ?arm|lowarm|elbow|ulna|radius/],
  ["upperArm", /upper ?arm|uparm|bicep|humerus|shoulder|\barm\b/],
  ["hand", /hand|wrist|palm|fist/],
  ["thigh", /thigh|up ?leg|upper ?leg|femur/],
  ["shin", /shin|calf|lower ?leg|low ?leg|knee|tibia|\bleg\b/],
  ["foot", /foot|feet|ankle|boot|shoe/],
  ["neck", /neck/],
  ["head", /head|skull|face/],
  ["spine", /spine|torso|chest|body|abdomen|belly|trunk|upper ?body/],
  ["hips", /hips?|pelvis|waist|lower ?body/],
];

/** Lower-cased words of a bone name: "frontForearm_L" → "front forearm l". */
function words(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\d+/g, " ")
    .trim();
}

function sideOf(w: string, frontSide: "left" | "right"): "left" | "right" | null {
  if (/\b(l|left|lf|lft)\b/.test(w)) return "left";
  if (/\b(r|right|rt|rgt)\b/.test(w)) return "right";
  if (/\b(front|near|fore)\b/.test(w)) return frontSide;
  if (/\b(back|far|rear|behind)\b/.test(w)) return frontSide === "left" ? "right" : "left";
  return null;
}

function partOf(w: string): Part | null {
  for (const [part, re] of PARTS) if (re.test(w)) return part;
  return null;
}

export interface GuessPoseOptions {
  /** Which side of the body the "front"/"near" bones are (for side-view rigs named front-/back-). Default "left". */
  frontSide?: "left" | "right";
}

/**
 * Guess what each bone follows from its name (arm, forearm, hand, thigh, shin, foot with a side; spine, neck, head,
 * hips). Bones in an IK chain are left to the constraint: its target bone follows the ankle or wrist instead.
 */
export function guessPoseMapping(doc: OpenBoneDocument, o: GuessPoseOptions = {}): Record<Id, PoseSource> {
  const frontSide = o.frontSide ?? "left";
  const bones = doc.skeleton.bones;
  const info = new Map(bones.map((b) => [b.id, { w: words(b.name), part: partOf(words(b.name)) }]));
  const inIk = new Set<Id>();
  const ikTargets = new Map<Id, PosePointRole>();
  for (const c of doc.skeleton.ik) {
    if (c.mix <= 0) continue;
    for (const id of c.bones) inIk.add(id);
    const parts = c.bones.map((id) => info.get(id)!);
    const side = parts.map((p) => sideOf(p.w, frontSide)).find((s) => s) ?? sideOf(words(c.name), frontSide) ?? sideOf(info.get(c.target)?.w ?? "", frontSide);
    if (!side) continue;
    const isArm = parts.some((p) => p.part === "upperArm" || p.part === "forearm") || /arm|hand/.test(words(c.name));
    const isLeg = parts.some((p) => p.part === "thigh" || p.part === "shin") || /leg|foot/.test(words(c.name));
    if (isLeg) ikTargets.set(c.target, side === "left" ? "leftAnkle" : "rightAnkle");
    else if (isArm) ikTargets.set(c.target, side === "left" ? "leftWrist" : "rightWrist");
  }
  const out: Record<Id, PoseSource> = {};
  let hipsTaken = false;
  for (const b of bones) {
    const target = ikTargets.get(b.id);
    if (target) {
      out[b.id] = target;
      continue;
    }
    if (inIk.has(b.id)) continue;
    const { w, part } = info.get(b.id)!;
    if (!part) continue;
    if (part === "hips") {
      if (!hipsTaken) out[b.id] = "hips";
      hipsTaken = true;
      continue;
    }
    if (part === "spine" || part === "neck" || part === "head") {
      out[b.id] = part;
      continue;
    }
    const side = sideOf(w, frontSide);
    if (!side) continue;
    out[b.id] = `${side}${part[0].toUpperCase()}${part.slice(1)}` as PoseSegment;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cleaning the track

export interface SmoothOptions {
  /** Points below this visibility count as missing and hold their last good position. Default 0.5. */
  minVisibility?: number;
  /** 0 = raw, 1 = very smooth (One Euro filter). Default 0.5. */
  smoothing?: number;
}

/** One Euro filter (Casiez et al. 2012): smooths jitter at low speed, keeps fast moves responsive. */
function oneEuro(times: number[], values: number[], minCutoff: number, beta: number): number[] {
  const out = values.slice();
  const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  let dx = 0;
  for (let i = 1; i < values.length; i++) {
    const dt = Math.max(1e-4, times[i] - times[i - 1]);
    const rawDx = (values[i] - out[i - 1]) / dt;
    dx += alpha(1, dt) * (rawDx - dx);
    out[i] = out[i - 1] + alpha(minCutoff + beta * Math.abs(dx), dt) * (values[i] - out[i - 1]);
  }
  return out;
}

/** Hide weak points, fill gaps from the nearest good frame, and filter jitter. Returns a new track. */
export function smoothTrack(track: PoseTrack, o: SmoothOptions = {}): PoseTrack {
  const minVis = o.minVisibility ?? 0.5;
  const smoothing = Math.min(1, Math.max(0, o.smoothing ?? 0.5));
  const frames = track.frames;
  const times = frames.map((f) => f.time);
  const count = Math.max(0, ...frames.map((f) => f.points.length));
  const out: PoseFrame[] = frames.map((f) => ({ time: f.time, points: new Array<PosePoint>(count).fill(null) }));
  for (let p = 0; p < count; p++) {
    const good = frames.map((f) => {
      const pt = f.points[p];
      return pt && pt[2] >= minVis ? pt : null;
    });
    if (!good.some(Boolean)) continue;
    // Fill gaps: hold the last good point, and before the first one use the first one.
    const first = good.find(Boolean)!;
    let last: [number, number, number] = first;
    const xs: number[] = [];
    const ys: number[] = [];
    const vis: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const g = good[i];
      if (g) last = g;
      xs.push(last[0]);
      ys.push(last[1]);
      vis.push(g ? g[2] : 0);
    }
    const fx = smoothing > 0 ? oneEuro(times, xs, 8 - 7.5 * smoothing, 0.6 * (1 - smoothing) + 0.05) : xs;
    const fy = smoothing > 0 ? oneEuro(times, ys, 8 - 7.5 * smoothing, 0.6 * (1 - smoothing) + 0.05) : ys;
    for (let i = 0; i < frames.length; i++) out[i].points[p] = [fx[i], fy[i], vis[i]];
  }
  return { ...track, frames: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Track → keys

export interface PoseToKeysOptions {
  /** Animation id or name; created when no animation has that name. */
  animation: string;
  /** Bone id or name → what it follows. Default: `guessPoseMapping`. */
  mapping?: PoseMapping;
  /** Seconds of the video to use. Default: the whole track. */
  start?: number;
  end?: number;
  /** Where the clip starts in the animation, in seconds. Default 0. Keys already in that range are replaced. */
  at?: number;
  /** Key rate. Default: the document's fps. */
  fps?: number;
  /** Flip the video left to right (and swap left and right), e.g. for a selfie camera or a rig facing the other way. */
  mirror?: boolean;
  /**
   * The bone following the hips: "full" moves it as the body moves in the video, "inPlace" keeps the up and down but not
   * the travel across, "off" leaves it still. Default "full".
   */
  rootMotion?: "full" | "inPlace" | "off";
  /**
   * "direction" (default): a bone points the way its body segment points. "relative": a bone keeps its setup angle at
   * the first frame and turns as much as the segment turns, for rigs whose bones don't point along the limbs.
   */
  mode?: "direction" | "relative";
  /** Simplification tolerance in degrees (rotation) and pixels (position). 0 keeps every frame. Default 1. */
  tolerance?: number;
  /** Track cleaning (see `smoothTrack`). */
  minVisibility?: number;
  smoothing?: number;
}

export interface PoseToKeysResult {
  /** Ops to apply in one transaction, in order (createAnimation, deleteKeys, setKeys…). */
  ops: { op: string; args: Record<string, unknown> }[];
  /** The mapping used, by bone id. */
  mapping: Record<Id, PoseSource>;
  /** Number of keys written. */
  keys: number;
  /** Seconds covered and the number of samples. */
  duration: number;
  samples: number;
  /** Skeleton units per video pixel. */
  scale: number;
  warnings: string[];
}

type V2 = [number, number];

const JOINT_PARTS: Partial<Record<Joint, [Joint, Joint]>> = {
  hipCentre: ["leftHip", "rightHip"],
  shoulderCentre: ["leftShoulder", "rightShoulder"],
  earCentre: ["leftEar", "rightEar"],
};

const MIRROR_SOURCE = (s: PoseSource): PoseSource =>
  (s.startsWith("left") ? `right${s.slice(4)}` : s.startsWith("right") ? `left${s.slice(5)}` : s) as PoseSource;

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Turn a tracked clip into keys for `mapping`'s bones. Pure: returns the ops, which the caller applies in one
 * transaction (editor `transaction`, MCP `store.transaction`).
 */
export function poseToKeys(doc: OpenBoneDocument, track: PoseTrack, o: PoseToKeysOptions): PoseToKeysResult {
  if (!track.frames.length) throw new Error("The pose track has no frames");
  const warnings: string[] = [];
  const byName = new Map<string, BoneData>();
  for (const b of doc.skeleton.bones) byName.set(b.id, b), byName.has(b.name) || byName.set(b.name, b);
  const mapping: Record<Id, PoseSource> = {};
  for (const [key, src] of Object.entries(o.mapping ?? guessPoseMapping(doc))) {
    const b = byName.get(key);
    if (!b) throw new Error(`Bone "${key}" not found`);
    if (!POSE_SOURCES.includes(src)) throw new Error(`Unknown body part "${src}" for bone "${b.name}"`);
    mapping[b.id] = o.mirror ? MIRROR_SOURCE(src) : src;
  }
  if (!Object.keys(mapping).length) throw new Error("No bones are mapped to the body: pass a mapping");

  const tr = smoothTrack(track, { minVisibility: o.minVisibility, smoothing: o.smoothing });
  const frames = tr.frames;
  const W = track.width || 1;
  const H = track.height || 1;
  const fps = o.fps ?? doc.fps ?? 30;
  const first = frames[0].time;
  const last = frames[frames.length - 1].time;
  const start = Math.max(first, Math.min(last, o.start ?? first));
  const end = Math.max(start, Math.min(last, o.end ?? last));
  const samples = Math.max(1, Math.floor((end - start) * fps + 1e-6) + 1);
  const at = o.at ?? 0;
  const tol = o.tolerance ?? 1;
  const mode = o.mode ?? "direction";
  const rootMotion = o.rootMotion ?? "full";

  // A joint at time t in skeleton-like pixels: y up, x flipped when mirrored. Linear between frames.
  let fi = 0;
  const frameAt = (t: number): [PoseFrame, PoseFrame, number] => {
    while (fi > 0 && frames[fi].time > t) fi--;
    while (fi < frames.length - 1 && frames[fi + 1].time <= t) fi++;
    const a = frames[fi];
    const b = frames[Math.min(frames.length - 1, fi + 1)];
    const f = b.time > a.time ? Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time))) : 0;
    return [a, b, f];
  };
  const raw = (fr: PoseFrame, j: Joint): V2 | null => {
    const parts = JOINT_PARTS[j];
    if (parts) {
      const p = raw(fr, parts[0]);
      const q = raw(fr, parts[1]);
      return p && q ? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] : (p ?? q);
    }
    const pt = fr.points[POSE_LANDMARKS[j as keyof typeof POSE_LANDMARKS]];
    if (!pt) return null;
    return [(o.mirror ? 1 - pt[0] : pt[0]) * W, -pt[1] * H];
  };
  const joint = (t: number, j: Joint): V2 | null => {
    const [a, b, f] = frameAt(t);
    const p = raw(a, j);
    const q = raw(b, j);
    if (!p || !q) return p ?? q;
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };
  const segAngle = (t: number, s: PoseSegment): number | null => {
    const [ja, jb] = POSE_SEGMENTS[s];
    const p = joint(t, ja);
    const q = joint(t, jb);
    if (!p || !q || (p[0] === q[0] && p[1] === q[1])) return null;
    return Math.atan2(q[1] - p[1], q[0] - p[0]) * RAD;
  };

  // Hidden-joint warnings.
  const minVis = o.minVisibility ?? 0.5;
  const usedJoints = new Set<Joint>();
  for (const src of Object.values(mapping)) {
    const js: Joint[] = isPosePoint(src) ? [POSE_POINTS[src]] : [...POSE_SEGMENTS[src]];
    for (const j of js) for (const k of JOINT_PARTS[j] ?? [j]) usedJoints.add(k);
  }
  for (const j of usedJoints) {
    const idx = POSE_LANDMARKS[j as keyof typeof POSE_LANDMARKS];
    const hidden = track.frames.filter((f) => !f.points[idx] || f.points[idx]![2] < minVis).length / track.frames.length;
    if (hidden >= 0.3) warnings.push(`${j.replace(/([A-Z])/g, " $1").toLowerCase()} was hidden in ${Math.round(hidden * 100)}% of frames: its keys hold the last place it was seen`);
  }

  // Video pixels → skeleton units, anchored at the hips at the first frame.
  const setup = setupWorld(doc);
  const bonesBySource = (...s: PoseSource[]) => doc.skeleton.bones.filter((b) => s.includes(mapping[b.id]));
  const origin = (b: BoneData): V2 => {
    const m = setup.get(b.id)!;
    return [m.x, m.y];
  };
  const avg = (ps: V2[]): V2 | null => (ps.length ? [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length] : null);
  const hipBone = bonesBySource("hips")[0];
  const rigHips = (hipBone ? origin(hipBone) : null) ?? avg(bonesBySource("leftThigh", "rightThigh").map(origin)) ?? avg(bonesBySource("spine").map(origin));
  const rigShoulders = avg(bonesBySource("leftUpperArm", "rightUpperArm").map(origin));
  const videoTorso = median(
    frames.map((f) => {
      const p = raw(f, "hipCentre");
      const q = raw(f, "shoulderCentre");
      return p && q ? Math.hypot(q[0] - p[0], q[1] - p[1]) : NaN;
    }).filter((v) => v > 0),
  );
  let rigTorso = rigHips && rigShoulders ? Math.hypot(rigShoulders[0] - rigHips[0], rigShoulders[1] - rigHips[1]) : 0;
  if (!(rigTorso > 1)) rigTorso = bonesBySource("spine").reduce((s, b) => s + b.length, 0);
  if (!(rigTorso > 1)) rigTorso = doc.height * 0.25;
  const scale = videoTorso > 0 ? rigTorso / videoTorso : 1;
  const anchor: V2 = rigHips ?? [0, 0];
  const hips0 = joint(start, "hipCentre") ?? [0, 0];
  const toSkeleton = (p: V2, t: number): V2 => {
    let dx = p[0] - hips0[0];
    let dy = p[1] - hips0[1];
    if (rootMotion !== "full") {
      const h = joint(t, "hipCentre") ?? hips0;
      dx -= h[0] - hips0[0];
      if (rootMotion === "off") dy -= h[1] - hips0[1];
    }
    return [anchor[0] + dx * scale, anchor[1] + dy * scale];
  };

  // Sample every mapped bone, parent first, so each bone's rotation is solved under its parent's new pose.
  const bones = doc.skeleton.bones;
  const series = new Map<string, { bone: BoneData; property: "rotation" | "x" | "y"; values: number[] }>();
  const add = (b: BoneData, property: "rotation" | "x" | "y") => {
    const key = `${b.id}:${property}`;
    if (!series.has(key)) series.set(key, { bone: b, property, values: [] });
    return series.get(key)!;
  };
  const ref = new Map<Id, number>();
  for (const b of bones) {
    const src = mapping[b.id];
    if (src && !isPosePoint(src)) {
      const a = segAngle(start, src);
      if (a !== null) ref.set(b.id, a);
    }
  }
  const missing = new Set<Id>();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = start + i / fps;
    times.push(at + i / fps);
    const world = new Map<Id, Affine>();
    for (const b of bones) {
      const parent = b.parent ? (world.get(b.parent) ?? null) : null;
      const local = { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY };
      const src = mapping[b.id];
      if (src && isPosePoint(src)) {
        if (src === "hips" && rootMotion === "off") {
          // Hips stay at their setup place.
        } else {
          const p = joint(t, POSE_POINTS[src]);
          if (!p) missing.add(b.id);
          else {
            const s = toSkeleton(p, t);
            const [lx, ly] = parent ? apply(invert(parent), s[0], s[1]) : s;
            local.x = lx;
            local.y = ly;
            add(b, "x").values.push(lx);
            add(b, "y").values.push(ly);
          }
        }
      } else if (src) {
        const a = segAngle(t, src);
        if (a === null || !ref.has(b.id)) missing.add(b.id);
        else {
          const setupAngle = Math.atan2(setup.get(b.id)!.c, setup.get(b.id)!.a) * RAD;
          const want = mode === "relative" ? setupAngle + wrapDeg(a - ref.get(b.id)!) : a;
          // The direction in the parent's space (exact under a scaled or sheared parent).
          let phi = want;
          if (parent && (b.inherit === "normal" || b.inherit === "noScale")) {
            const inv = invert({ ...parent, x: 0, y: 0 });
            const [dx, dy] = apply(inv, Math.cos(want / RAD), Math.sin(want / RAD));
            phi = Math.atan2(dy, dx) * RAD;
          }
          const s = add(b, "rotation");
          const prev = s.values.length ? s.values[s.values.length - 1] : b.rotation;
          const v = prev + wrapDeg(phi - b.shearX - prev);
          s.values.push(v);
          local.rotation = v;
        }
      }
      world.set(b.id, boneWorld(parent, local, b.inherit));
    }
  }
  for (const id of missing) {
    const b = bones.find((x) => x.id === id)!;
    if (!series.has(`${id}:rotation`) && !series.has(`${id}:x`)) warnings.push(`bone "${b.name}" got no keys: ${mapping[id]} was never seen in the video`);
  }
  for (const b of bones) {
    const src = mapping[b.id];
    if (src && !isPosePoint(src) && doc.skeleton.ik.some((c) => c.mix > 0 && c.bones.includes(b.id)))
      warnings.push(`bone "${b.name}" is in an IK chain, which overrides its rotation keys: map the IK target to a point instead`);
  }

  // Ops.
  const ops: PoseToKeysResult["ops"] = [];
  const existing = doc.animations.find((a) => a.id === o.animation || a.name === o.animation);
  const animRef = existing?.id ?? o.animation;
  if (!existing) ops.push({ op: "createAnimation", args: { name: o.animation } });
  const duration = (samples - 1) / fps;
  let keys = 0;
  const picks: { target: "bone"; id: Id; property: string; times: number[] }[] = [];
  for (const s of series.values()) {
    if (s.values.length !== samples) continue; // a bone seen only part of the time keeps what it had
    if (existing) {
      const tl = existing.timelines.find((x) => x.target === "bone" && x.id === s.bone.id && x.property === s.property);
      const old = tl ? (tl.keys as { time: number }[]).map((k) => k.time).filter((t) => t >= at - 1e-6 && t <= at + duration + 1e-6) : [];
      if (old.length) picks.push({ target: "bone", id: s.bone.id, property: s.property, times: old });
    }
  }
  if (picks.length) ops.push({ op: "deleteKeys", args: { animation: animRef, keys: picks } });
  // A fixed-length animation grows to fit the clip (0 = until the last key, which grows by itself).
  if (existing && existing.duration > 0 && existing.duration < at + duration - 1e-6)
    ops.push({ op: "updateAnimation", args: { animation: animRef, duration: Math.round((at + duration) * 1e4) / 1e4 } });
  for (const s of series.values()) {
    if (s.values.length !== samples) continue;
    const keep = simplifyKeys(times, s.values, tol);
    keys += keep.length;
    ops.push({
      op: "setKeys",
      args: {
        animation: animRef,
        target: "bone",
        id: s.bone.id,
        property: s.property,
        keys: keep.map((i) => ({ time: Math.round(times[i] * 1e4) / 1e4, value: Math.round(s.values[i] * 1e3) / 1e3, curve: "linear" })),
      },
    });
  }
  return { ops, mapping, keys, duration, samples, scale, warnings };
}
