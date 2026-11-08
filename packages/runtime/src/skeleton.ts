import {
  type Affine,
  type Attachment,
  type AtlasPage,
  type UvMap,
  type BoneData,
  CONSTRAINT_PROPERTIES,
  type ConstraintTarget,
  type Id,
  type IkConstraintData,
  type ImageAsset,
  type InputValue,
  type LocalTransform,
  type OpenBoneDocument,
  type ParticleLook,
  type ParticlesAttachment,
  type PathConstraintData,
  type PhysicsConstraintData,
  type RGBA,
  type SequenceAttachment,
  type SkinData,
  type SlotData,
  type TransformConstraintData,
  DEG,
  RAD,
  apply,
  atlasUvMap,
  boneWorld,
  buildSpline,
  defaultSkin,
  formatTemplate,
  identity,
  invert,
  isTrimmed,
  multiply,
  parseHex,
  pointInPolygon,
  remapUvs,
  sequenceCounter,
  sequenceFrameIndex,
  sequenceFrameLayout,
  setupWorld,
  shapeOutline,
  triangulate,
  worldRotation,
  worldScaleX,
  worldScaleY,
} from "@openbone/core";
import { type EmitterValues, MAX_PARTICLE_STEPS, PARTICLE_STEP, ParticleEmitter, hashString } from "./particles.ts";
import type { TextDraw } from "./text.ts";

export class Bone {
  parent: Bone | null = null;
  children: Bone[] = [];
  /** Local pose written by animations and scripts. */
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  shearX = 0;
  shearY = 0;
  /**
   * Local values actually used for the world transform this frame: a copy of the pose above
   * that local-space constraints (IK, local transform constraints) may change.
   */
  applied: LocalTransform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  world: Affine = identity();
  constructor(public data: BoneData) {
    this.setToSetupPose();
    this.resetApplied();
  }
  get name() {
    return this.data.name;
  }
  setToSetupPose() {
    const d = this.data;
    this.x = d.x;
    this.y = d.y;
    this.rotation = d.rotation;
    this.scaleX = d.scaleX;
    this.scaleY = d.scaleY;
    this.shearX = d.shearX;
    this.shearY = d.shearY;
  }
  resetApplied() {
    const a = this.applied;
    a.x = this.x;
    a.y = this.y;
    a.rotation = this.rotation;
    a.scaleX = this.scaleX;
    a.scaleY = this.scaleY;
    a.shearX = this.shearX;
    a.shearY = this.shearY;
  }
  updateWorld(root: Affine) {
    this.world = boneWorld(this.parent ? this.parent.world : root, this.applied, this.parent ? this.data.inherit : "normal");
  }
  updateSubtree(root: Affine, includeSelf = true) {
    if (includeSelf) this.updateWorld(root);
    for (const c of this.children) c.updateSubtree(root);
  }
  get worldX() {
    return this.world.x;
  }
  get worldY() {
    return this.world.y;
  }
  get worldRotation() {
    return worldRotation(this.world);
  }
  /** World -> this bone's local space. */
  worldToLocal(x: number, y: number): [number, number] {
    return apply(invert(this.world), x, y);
  }
}

export class Slot {
  color: RGBA = [1, 1, 1, 1];
  attachmentName: string | null = null;
  /** Mesh/path deform offsets by attachment name. */
  deform = new Map<string, number[]>();
  /** Keyed sequence frame counters by attachment name (written by `sequence` timelines). */
  sequenceFrames = new Map<string, number>();
  constructor(
    public data: SlotData,
    public bone: Bone,
  ) {
    this.setToSetupPose();
  }
  get name() {
    return this.data.name;
  }
  setToSetupPose() {
    this.color = parseHex(this.data.color);
    this.attachmentName = this.data.attachment;
    this.deform.clear();
    this.sequenceFrames.clear();
  }
}

/** The texture a draw item samples: an image asset or an atlas page (both resolved by id). */
export interface TextureRef {
  id: Id;
  width: number;
  height: number;
}

export interface DrawItem {
  slot: Slot;
  attachment: Attachment;
  /** The image asset drawn; null = solid colour fill. */
  image: ImageAsset | null;
  /**
   * Texture to bind: the image itself, or its atlas page when packed. Solid shapes in a packed document point at
   * the page's white block (uvs inside it), so renderers can batch them with images; otherwise null.
   */
  texture: TextureRef | null;
  /** For packed images: the image's rect inside `texture` (page pixels, y-down). Nothing outside it belongs to the image. */
  textureRect?: { x: number; y: number; width: number; height: number };
  vertices: Float32Array; // world x,y pairs
  /** In `texture` space (0..1, v down). */
  uvs: Float32Array;
  indices: Uint16Array;
  color: RGBA;
  blend: SlotData["blend"];
  stroke?: { color: RGBA; width: number; outline: Float32Array };
  /** Clipping mask this item is drawn inside (shared object for consecutive items under the same mask). */
  clip?: ClipRegion;
  /** Per-vertex RGBA (4 floats per vertex, slot tint included); when set it replaces `color`. */
  colors?: Float32Array;
  /**
   * Set on particle batches: `count` quads (4 vertices each: TL, TR, BR, BL). `look` circle/spark sample a soft
   * round sprite (texture id PARTICLE_DOT_TEXTURE), square a solid quad, image the item's texture.
   */
  particles?: { look: ParticleLook; count: number };
  /** Text attachments: what to draw in the box (`vertices` is the box quad, `color` the slot tint). */
  text?: TextDraw;
}

/** Texture id of the built-in soft round particle sprite; renderers generate it (see `particleDotAlpha`). */
export const PARTICLE_DOT_TEXTURE = "@openbone/particle-dot";
export const PARTICLE_DOT_SIZE = 64;

/** Alpha of the soft round particle sprite at distance `r` from its centre (0 = centre, 1 = edge). */
export const particleDotAlpha = (r: number) => (r >= 1 ? 0 : r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65) ** 1.6;

/** A clipping mask in world space: outline polygon plus its triangulation (for stencil-based renderers). */
export interface ClipRegion {
  slot: Slot;
  polygon: Float32Array;
  indices: Uint16Array;
}

/** One simulated point of a physics constraint. */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Position before the last step, for interpolating between steps. */
  px: number;
  py: number;
}

interface PhysicsState {
  origin: Particle;
  tip: Particle;
  /** Animated origin/tip seen last frame (for inertia). */
  lastO: [number, number];
  lastT: [number, number];
  /** Simulated time received, and whole steps taken (counting steps avoids float drift in the step boundary). */
  time: number;
  steps: number;
}

/** Setup values of a constraint's keyable fields (transform constraints also get `mix` = 1, a multiplier). */
function setupValues(kind: ConstraintTarget, c: object): Record<string, number> {
  const src = c as Record<string, unknown>;
  const out: Record<string, number> = kind === "transform" ? { mix: 1 } : {};
  for (const p of CONSTRAINT_PROPERTIES[kind]) {
    if (kind === "transform" && p === "mix") continue;
    out[p] = typeof src[p] === "number" ? (src[p] as number) : 0;
  }
  return out;
}

/** Most simulation steps taken in one frame; longer frames drop the excess time (avoids a spiral after a stall). */
const MAX_PHYSICS_STEPS = 8;

/** Rotate a world matrix's axes by `rad` (counter-clockwise). */
function rotateAxes(w: Affine, rad: number) {
  if (rad === 0) return;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { a, b, c, d } = w;
  w.a = cos * a - sin * c;
  w.b = cos * b - sin * d;
  w.c = sin * a + cos * c;
  w.d = sin * b + cos * d;
}

/** Shear angle in degrees between a matrix's axes (0 when they are perpendicular). */
const skewOf = (m: Affine) => wrap((Math.atan2(m.d, m.b) - Math.atan2(m.c, m.a)) * RAD - 90);

/** Set the Y axis so the matrix has the given shear, keeping the Y axis length. */
function setSkew(w: Affine, skewDeg: number) {
  const ly = Math.hypot(w.b, w.d);
  const ang = Math.atan2(w.c, w.a) + (90 + skewDeg) * DEG;
  w.b = Math.cos(ang) * ly;
  w.d = Math.sin(ang) * ly;
}

export class Skeleton {
  bones: Bone[] = [];
  slots: Slot[] = [];
  drawOrder: Slot[] = [];
  skin: SkinData | null = null;
  /**
   * Live (keyable) constraint values by constraint id, reset from the document in setToSetupPose and
   * written by animation timelines. Transform constraints also have `mix`, a multiplier on all their mixes.
   */
  constraintValues = new Map<Id, Record<string, number>>();
  /** Placement of the skeleton (applied to root bones). */
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  private boneById = new Map<Id, Bone>();
  private slotById = new Map<Id, Slot>();
  private images = new Map<Id, ImageAsset>();
  /** Packed images: their page, uv map and (for trimmed regions) the trimmed rect in 0..1 image space. */
  private packed = new Map<
    Id,
    { page: AtlasPage; rect: NonNullable<DrawItem["textureRect"]>; map: UvMap; regionUvs: Float32Array; trim: [number, number, number, number] | null }
  >();
  private white: { page: AtlasPage; u: number; v: number } | null = null;
  private physicsState = new Map<Id, PhysicsState>();
  /** Seconds passed to update(); drives sequences when no animation is applied. */
  clock = 0;
  /** Local time of the (dominant) animation applied this frame, or null; sequences follow it. Reset by setToSetupPose. */
  animationTime: number | null = null;
  /** Live number input values (by input id) that sequences bound to an input read. Set by the state machine. */
  inputValues = new Map<Id, number>();
  private inputDefaults = new Map<Id, number>();
  /** Time passed to update() and not yet consumed by the physics solver. */
  private pendingDt = 0;
  private setupCache: Map<Id, Affine> | null = null;
  /**
   * How particles advance. "realtime": by the time passed to update() (players, state machines).
   * "seek": only through seekParticles(), which replays from time 0 so any time gives the same particles
   * (editor timeline, image/video export).
   */
  particleClock: "realtime" | "seek" = "realtime";
  /** Keyable emitter values by slot id (reset in setToSetupPose; timelines and state machines write them). */
  particleValues = new Map<Id, EmitterValues>();
  private emitters = new Map<Id, ParticleEmitter>();
  private particlePending = 0;
  /** Time since the last particle step, drawn as extrapolated motion. */
  private particleFrac = 0;
  /** Steps simulated since the last particle reset (seek mode). */
  private particleSteps = 0;
  private pendingBursts = new Map<Id, number>();
  /** Values for text templates by input name; the state machine running this skeleton sets it. */
  textValues: (name: string) => InputValue | undefined = () => undefined;
  /** Text shown instead of an attachment's own template, by slot id (see setText). */
  textOverrides = new Map<Id, string>();

  constructor(public doc: OpenBoneDocument) {
    for (const bd of doc.skeleton.bones) {
      const b = new Bone(bd);
      if (bd.parent) {
        b.parent = this.boneById.get(bd.parent) ?? null;
        b.parent?.children.push(b);
      }
      this.bones.push(b);
      this.boneById.set(bd.id, b);
    }
    for (const sd of doc.skeleton.slots) {
      const bone = this.boneById.get(sd.bone);
      if (!bone) continue;
      const s = new Slot(sd, bone);
      this.slots.push(s);
      this.slotById.set(sd.id, s);
    }
    for (const img of doc.images) this.images.set(img.id, img);
    const pages = new Map(doc.atlas?.pages.map((p) => [p.id, p]));
    for (const r of doc.atlas?.regions ?? []) {
      const page = pages.get(r.page);
      if (!page || !this.images.has(r.image)) continue;
      const map = atlasUvMap(r, page);
      const trim: [number, number, number, number] | null = isTrimmed(r)
        ? [r.offsetX / r.originalWidth, r.offsetY / r.originalHeight, (r.offsetX + r.width) / r.originalWidth, (r.offsetY + r.height) / r.originalHeight]
        : null;
      const quad = trim ? new Float32Array([trim[0], trim[1], trim[2], trim[1], trim[2], trim[3], trim[0], trim[3]]) : REGION_UVS;
      const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      this.packed.set(r.image, { page, rect, map, regionUvs: remapUvs(quad, map), trim });
    }
    for (const sm of doc.stateMachines) for (const i of sm.inputs) if (typeof i.default === "number") this.inputDefaults.set(i.id, i.default);
    const w = doc.atlas?.white;
    const wp = w && pages.get(w.page);
    if (w && wp) this.white = { page: wp, u: (w.x + w.width / 2) / wp.width, v: (w.y + w.height / 2) / wp.height };
    this.setToSetupPose();
    this.updateWorldTransform();
  }

  findBone(ref: string): Bone | undefined {
    return this.boneById.get(ref) ?? this.bones.find((b) => b.data.name === ref);
  }
  findSlot(ref: string): Slot | undefined {
    return this.slotById.get(ref) ?? this.slots.find((s) => s.data.name === ref);
  }
  boneById_(id: Id) {
    return this.boneById.get(id);
  }
  slotById_(id: Id) {
    return this.slotById.get(id);
  }

  setSkin(ref: string | null) {
    this.skin = ref ? (this.doc.skeleton.skins.find((s) => s.id === ref || s.name === ref) ?? null) : null;
  }

  setToSetupPose() {
    for (const b of this.bones) b.setToSetupPose();
    for (const s of this.slots) s.setToSetupPose();
    this.drawOrder = this.slots.slice();
    this.animationTime = null;
    this.constraintValues.clear();
    this.particleValues.clear();
    const sk = this.doc.skeleton;
    for (const kind of ["ik", "transform", "path", "physics"] as const)
      for (const c of sk[kind] ?? []) this.constraintValues.set(c.id, setupValues(kind, c));
  }

  private values(kind: ConstraintTarget, c: { id: Id }): Record<string, number> {
    let v = this.constraintValues.get(c.id);
    if (!v) this.constraintValues.set(c.id, (v = setupValues(kind, c)));
    return v;
  }

  /** Advance simulated time (physics). Call once per frame before updateWorldTransform. */
  update(dt: number) {
    if (dt > 0) {
      this.pendingDt += dt;
      this.clock += dt;
      this.particlePending += dt;
    }
  }

  // ---------------- Particles ----------------

  /** Forget every particle; emitters restart (and prewarm) on their next step. */
  resetParticles() {
    this.emitters.clear();
    this.pendingBursts.clear();
    this.particlePending = 0;
    this.particleFrac = 0;
    this.particleSteps = 0;
  }

  /** Simulated particle time (seek mode: steps × PARTICLE_STEP plus the drawn fraction). */
  get particleTime() {
    return this.particleSteps * PARTICLE_STEP + this.particleFrac;
  }

  /**
   * Deterministically bring particles to time `t`. `pose(time)` must pose the skeleton at that time
   * (setToSetupPose, apply animations, updateWorldTransform); it is called once per simulation step that is
   * still missing. Seeking backwards replays from 0. Pose the skeleton at `t` yourself afterwards to draw.
   */
  seekParticles(t: number, pose: (time: number) => void) {
    this.particleClock = "seek";
    this.particlePending = 0;
    const target = Math.max(0, Math.floor(t / PARTICLE_STEP + 1e-6));
    if (target < this.particleSteps) this.resetParticles();
    while (this.particleSteps < target) {
      pose(this.particleSteps * PARTICLE_STEP);
      this.stepParticles(PARTICLE_STEP);
      this.particleSteps++;
    }
    this.particleFrac = Math.max(0, Math.min(PARTICLE_STEP, t - target * PARTICLE_STEP));
  }

  /** Turn a slot's emitter on/off from outside the timeline (kept until the next setToSetupPose). */
  setEmitting(slotRef: string, emitting: boolean) {
    const slot = this.findSlot(slotRef);
    if (slot) this.particleValues.set(slot.data.id, { ...this.particleValues.get(slot.data.id), emitting });
  }

  /** Restart a slot's emitter cycle (its bursts fire again). */
  restartEmitter(slotRef: string) {
    const slot = this.findSlot(slotRef);
    if (slot) this.emitters.get(slot.data.id)?.restart();
  }

  /** Spawn `count` particles from a slot's emitter on the next step. */
  emitParticles(slotRef: string, count: number) {
    const slot = this.findSlot(slotRef);
    if (slot && count > 0) this.pendingBursts.set(slot.data.id, (this.pendingBursts.get(slot.data.id) ?? 0) + count);
  }

  /** The emitter simulating a slot's current particles attachment (null when it shows something else). */
  emitter(slotRef: string): ParticleEmitter | null {
    const slot = this.findSlot(slotRef);
    const em = slot ? this.emitters.get(slot.data.id) : undefined;
    return em && slot && em.data === this.getAttachment(slot) ? em : null;
  }

  private stepParticles(h: number) {
    for (const slot of this.slots) {
      const att = this.getAttachment(slot);
      const id = slot.data.id;
      if (!att || att.type !== "particles") {
        this.emitters.delete(id);
        continue;
      }
      let em = this.emitters.get(id);
      if (!em || em.data !== att) {
        em = new ParticleEmitter(att, hashString(slot.data.name));
        this.emitters.set(id, em);
      }
      const burst = this.pendingBursts.get(id);
      if (burst) em.pending += burst;
      em.step(h, slot.bone.world, this.particleValues.get(id));
    }
    this.pendingBursts.clear();
  }

  private advanceParticles(dt: number) {
    const acc = this.particleFrac + dt;
    const n = Math.floor(acc / PARTICLE_STEP + 1e-6);
    const steps = Math.min(n, MAX_PARTICLE_STEPS);
    for (let i = 0; i < steps; i++) this.stepParticles(PARTICLE_STEP);
    this.particleSteps += steps;
    this.particleFrac = Math.max(0, Math.min(PARTICLE_STEP, acc - n * PARTICLE_STEP));
  }

  /** Forget physics motion: the next frame starts at rest on the animated pose. */
  resetPhysics() {
    this.physicsState.clear();
    this.pendingDt = 0;
  }

  private get rootMatrix(): Affine {
    return { a: this.scaleX, b: 0, c: 0, d: this.scaleY, x: this.x, y: this.y };
  }

  /** Solve world transforms, then constraints in order: IK, transform, path, physics. */
  updateWorldTransform() {
    const root = this.rootMatrix;
    for (const b of this.bones) {
      b.resetApplied();
      b.updateWorld(root);
    }
    const sk = this.doc.skeleton;
    for (const c of sk.ik) this.applyIk(c, this.values("ik", c));
    for (const c of sk.transform) this.applyTransform(c, this.values("transform", c));
    for (const c of sk.path ?? []) this.applyPath(c, this.values("path", c));
    const dt = this.pendingDt;
    this.pendingDt = 0;
    for (const c of sk.physics ?? []) this.applyPhysics(c, this.values("physics", c), dt);
    const pdt = this.particlePending;
    this.particlePending = 0;
    if (this.particleClock === "realtime" && pdt > 0) this.advanceParticles(pdt);
  }

  // ---------------- IK ----------------

  private applyIk(c: IkConstraintData, v: Record<string, number>) {
    const mix = v.mix;
    if (mix <= 0) return;
    const target = this.boneById.get(c.target);
    const bones = c.bones.map((id) => this.boneById.get(id)).filter(Boolean) as Bone[];
    if (!target || bones.length === 0) return;
    const root = this.rootMatrix;
    const tx = target.world.x;
    const ty = target.world.y;
    if (bones.length === 1) {
      const b = bones[0];
      const pw = b.parent ? b.parent.world : root;
      const inv = invert(pw);
      const dx = tx - b.world.x;
      const dy = ty - b.world.y;
      const lx = inv.a * dx + inv.b * dy;
      const ly = inv.c * dx + inv.d * dy;
      const want = Math.atan2(ly, lx) * RAD - b.applied.shearX;
      b.applied.rotation += wrap(want - b.applied.rotation) * mix;
      b.updateWorld(root);
      const len = b.data.length * worldScaleX(b.world);
      if ((c.stretch || c.compress) && len > 1e-6) {
        const k = Math.hypot(dx, dy) / len;
        if ((k > 1 && c.stretch) || (k < 1 && c.compress)) {
          const s = 1 + (k - 1) * mix;
          b.world.a *= s;
          b.world.c *= s;
        }
      }
      b.updateSubtree(root, false);
      return;
    }
    const [p, ch] = bones;
    const det = (m: Affine) => Math.sign(m.a * m.d - m.b * m.c) || 1;
    const px = p.world.x;
    const py = p.world.y;
    const l1 = Math.hypot(ch.world.x - px, ch.world.y - py);
    const l2 = ch.data.length * worldScaleX(ch.world);
    const reach = l1 + l2;
    const dRaw = Math.hypot(tx - px, ty - py);
    // Soft IK: inside `softness` of full extension, the reached distance approaches full
    // extension exponentially instead of snapping straight.
    let dSoft = dRaw;
    const soft = Math.min(v.softness ?? 0, reach);
    if (soft > 1e-6 && dRaw > reach - soft) dSoft = reach - soft + soft * (1 - Math.exp(-(dRaw - (reach - soft)) / soft));
    const dEff = Math.min(Math.max(dSoft, Math.abs(l1 - l2) + 1e-4), reach - 1e-4);
    const ux = dRaw > 1e-9 ? (tx - px) / dRaw : 1;
    const uy = dRaw > 1e-9 ? (ty - py) / dRaw : 0;
    // The point actually aimed at (equal to the target when it is reachable and softness is off).
    const ax = px + ux * dEff;
    const ay = py + uy * dEff;
    const base = Math.atan2(uy, ux);
    const cosA = (l1 * l1 + dEff * dEff - l2 * l2) / (2 * l1 * dEff || 1);
    const a1 = base + (c.bendPositive ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, cosA)));
    // Rotate parent so its child origin points along a1.
    const curDir = Math.atan2(ch.world.y - py, ch.world.x - px);
    const sP = det(p.parent ? p.parent.world : root);
    const deltaP = wrap((a1 - curDir) * RAD) * sP;
    const pRot = p.applied.rotation;
    const cRot = ch.applied.rotation;
    p.applied.rotation = pRot + deltaP;
    p.updateSubtree(root);
    // Child aims from the elbow at the aim point.
    const want = Math.atan2(ay - ch.world.y, ax - ch.world.x) * RAD;
    const sC = det(p.world);
    const deltaC = wrap(want - ch.worldRotation) * sC;
    p.applied.rotation = pRot + deltaP * mix;
    ch.applied.rotation = cRot + deltaC * mix;
    p.updateWorld(root);
    ch.updateWorld(root);
    // Stretch: scale both bones along their length so the tip reaches the real target.
    if (c.stretch && dRaw > dEff + 1e-9) {
      const s = 1 + (dRaw / dEff - 1) * mix;
      const cw = ch.world;
      p.world.a *= s;
      p.world.c *= s;
      const [ox, oy] = apply(p.world, ch.applied.x, ch.applied.y);
      ch.world = { a: cw.a * s, b: cw.b, c: cw.c * s, d: cw.d, x: ox, y: oy };
    }
    ch.updateSubtree(root, false);
    for (const sib of p.children) if (sib !== ch) sib.updateSubtree(root);
  }

  // ---------------- Transform ----------------

  private setupWorldOf(id: Id): Affine {
    this.setupCache ??= setupWorld(this.doc);
    return multiply(this.rootMatrix, this.setupCache.get(id) ?? identity());
  }

  private applyTransform(c: TransformConstraintData, v: Record<string, number>) {
    const m = v.mix ?? 1;
    const mr = v.mixRotate * m;
    const mt = v.mixTranslate * m;
    const ms = v.mixScale * m;
    const mh = (v.mixShear ?? 0) * m;
    if (mr <= 0 && mt <= 0 && ms <= 0 && mh <= 0) return;
    const target = this.boneById.get(c.target);
    if (!target) return;
    const root = this.rootMatrix;
    const offScaleX = c.offsetScaleX ?? 0;
    const offScaleY = c.offsetScaleY ?? 0;
    const offShear = c.offsetShear ?? 0;
    for (const id of c.bones) {
      const b = this.boneById.get(id);
      if (!b || b === target) continue;
      if (c.local) {
        const p = b.applied;
        const t = target.applied;
        if (c.relative) {
          const s = target.data;
          p.rotation += (wrap(t.rotation - s.rotation) + c.offsetRotation) * mr;
          p.x += (t.x - s.x + c.offsetX) * mt;
          p.y += (t.y - s.y + c.offsetY) * mt;
          p.scaleX *= 1 + ((s.scaleX ? t.scaleX / s.scaleX : 1) - 1 + offScaleX) * ms;
          p.scaleY *= 1 + ((s.scaleY ? t.scaleY / s.scaleY : 1) - 1 + offScaleY) * ms;
          p.shearY += (t.shearY - s.shearY + offShear) * mh;
        } else {
          p.rotation += wrap(t.rotation + c.offsetRotation - p.rotation) * mr;
          p.x += (t.x + c.offsetX - p.x) * mt;
          p.y += (t.y + c.offsetY - p.y) * mt;
          p.scaleX += (t.scaleX + offScaleX - p.scaleX) * ms;
          p.scaleY += (t.scaleY + offScaleY - p.scaleY) * ms;
          p.shearY += (t.shearY + offShear - p.shearY) * mh;
        }
        b.updateSubtree(root);
        continue;
      }
      const w = b.world;
      const t = target.world;
      if (c.relative) {
        const s = this.setupWorldOf(target.data.id);
        if (mr > 0) rotateAxes(w, (wrap(worldRotation(t) - worldRotation(s)) + c.offsetRotation) * mr * DEG);
        if (mt > 0) {
          w.x += (t.x - s.x + c.offsetX) * mt;
          w.y += (t.y - s.y + c.offsetY) * mt;
        }
        if (ms > 0) {
          const kx = 1 + (worldScaleX(t) / (worldScaleX(s) || 1) - 1 + offScaleX) * ms;
          const ky = 1 + (worldScaleY(t) / (worldScaleY(s) || 1) - 1 + offScaleY) * ms;
          w.a *= kx;
          w.c *= kx;
          w.b *= ky;
          w.d *= ky;
        }
        if (mh > 0) setSkew(w, skewOf(w) + (wrap(skewOf(t) - skewOf(s)) + offShear) * mh);
      } else {
        if (mr > 0) rotateAxes(w, wrap(worldRotation(t) + c.offsetRotation - worldRotation(w)) * mr * DEG);
        if (mt > 0) {
          const [ox, oy] = apply(t, c.offsetX, c.offsetY);
          w.x += (ox - w.x) * mt;
          w.y += (oy - w.y) * mt;
        }
        if (ms > 0) {
          const sx = worldScaleX(w) || 1;
          const sy = worldScaleY(w) || 1;
          const kx = (sx + (worldScaleX(t) + offScaleX - sx) * ms) / sx;
          const ky = (sy + (worldScaleY(t) + offScaleY - sy) * ms) / sy;
          w.a *= kx;
          w.c *= kx;
          w.b *= ky;
          w.d *= ky;
        }
        if (mh > 0) {
          const sb = skewOf(w);
          setSkew(w, sb + wrap(skewOf(t) + offShear - sb) * mh);
        }
      }
      b.updateSubtree(root, false);
    }
  }

  // ---------------- Path ----------------

  private applyPath(c: PathConstraintData, v: Record<string, number>) {
    const { mixRotate, mixX, mixY } = v;
    if (mixRotate <= 0 && mixX <= 0 && mixY <= 0) return;
    const slot = this.slotById.get(c.target);
    if (!slot) return;
    const att = this.getAttachment(slot);
    if (!att || att.type !== "path") return;
    const spline = buildSpline(this.attachmentWorldVertices(slot, att), att.closed);
    const total = spline.length;
    if (total <= 1e-9) return;
    const bones = c.bones.map((id) => this.boneById.get(id)).filter(Boolean) as Bone[];
    const n = bones.length;
    if (!n) return;
    const lengths = bones.map((b) => b.data.length * worldScaleX(b.world));
    const sumLen = lengths.reduce((s, l) => s + l, 0);
    // Distance along the path of each bone origin, plus one past the last bone's tip.
    const dist = new Array<number>(n + 1);
    dist[0] = c.positionMode === "percent" ? v.position * total : v.position;
    for (let i = 0; i < n; i++) {
      let gap: number;
      switch (c.spacingMode) {
        case "fixed":
          gap = v.spacing;
          break;
        case "percent":
          gap = v.spacing * total;
          break;
        case "proportional":
          gap = v.spacing * total * (sumLen > 0 ? lengths[i] / sumLen : 1 / n);
          break;
        default:
          gap = lengths[i] + v.spacing;
      }
      dist[i + 1] = dist[i] + gap;
    }
    const pts = dist.map((d) => spline.sample(d));
    const root = this.rootMatrix;
    const off = c.offsetRotation * DEG;
    for (let i = 0; i < n; i++) {
      const b = bones[i];
      const w = b.world;
      const p = pts[i];
      w.x += (p.x - w.x) * mixX;
      w.y += (p.y - w.y) * mixY;
      if (mixRotate > 0) {
        let ang = p.angle;
        if (c.rotateMode !== "tangent") {
          // Aim from where the bone now is at the next placed point.
          const q = pts[i + 1];
          const dx = q.x - w.x;
          const dy = q.y - w.y;
          const d = Math.hypot(dx, dy);
          if (d > 1e-6) {
            ang = Math.atan2(dy, dx);
            if (c.rotateMode === "chainScale" && lengths[i] > 1e-6) {
              const k = 1 + (d / lengths[i] - 1) * mixRotate;
              w.a *= k;
              w.c *= k;
            }
          }
        }
        rotateAxes(w, wrap((ang + off) * RAD - worldRotation(w)) * mixRotate * DEG);
      }
      b.updateSubtree(root, false);
    }
  }

  // ---------------- Physics ----------------

  private applyPhysics(c: PhysicsConstraintData, v: Record<string, number>, dt: number) {
    const b = this.boneById.get(c.bone);
    if (!b) return;
    const w = b.world;
    const len = b.data.length > 1e-6 ? b.data.length : 1;
    const ox = w.x;
    const oy = w.y;
    const [tx, ty] = apply(w, len, 0);
    let st = this.physicsState.get(c.id);
    if (!st) {
      const at = (x: number, y: number): Particle => ({ x, y, vx: 0, vy: 0, px: x, py: y });
      st = { origin: at(ox, oy), tip: at(tx, ty), lastO: [ox, oy], lastT: [tx, ty], time: 0, steps: 0 };
      this.physicsState.set(c.id, st);
    }
    // Inertia: the part of the bone's movement not resisted is carried straight into the particles.
    const carry = 1 - Math.min(1, Math.max(0, v.inertia));
    const shift = (p: Particle, dx: number, dy: number) => {
      p.x += dx;
      p.y += dy;
      p.px += dx;
      p.py += dy;
    };
    shift(st.origin, (ox - st.lastO[0]) * carry, (oy - st.lastO[1]) * carry);
    shift(st.tip, (tx - st.lastT[0]) * carry, (ty - st.lastT[1]) * carry);
    st.lastO = [ox, oy];
    st.lastT = [tx, ty];

    const h = 1 / Math.max(1, c.fps || 60);
    st.time += dt;
    const due = Math.floor(st.time / h + 1e-6);
    if (due - st.steps > MAX_PHYSICS_STEPS) st.steps = due - MAX_PHYSICS_STEPS;
    // Spring constant per unit mass, capped so explicit integration stays stable.
    const k = Math.min(Math.max(0, v.strength) / Math.max(1e-6, v.mass), 1 / (h * h));
    const decay = Math.exp(-Math.max(0, v.damping) * h);
    const step = (p: Particle, gx: number, gy: number) => {
      p.px = p.x;
      p.py = p.y;
      p.vx = (p.vx + ((gx - p.x) * k + v.wind) * h) * decay;
      p.vy = (p.vy + ((gy - p.y) * k - v.gravity) * h) * decay;
      p.x += p.vx * h;
      p.y += p.vy * h;
    };
    for (; st.steps < due; st.steps++) {
      step(st.origin, ox, oy);
      step(st.tip, tx, ty);
    }
    const mix = Math.min(1, Math.max(0, v.mix));
    if (mix <= 0) return;
    // Draw between the last two steps so motion is smooth at any frame rate.
    const f = Math.min(1, Math.max(0, st.time / h - st.steps));
    const lerpP = (p: Particle): [number, number] => [p.px + (p.x - p.px) * f, p.py + (p.y - p.py) * f];
    const [sox, soy] = lerpP(st.origin);
    const [stx, sty] = lerpP(st.tip);
    w.x = ox + (sox - ox) * c.x * mix;
    w.y = oy + (soy - oy) * c.y * mix;
    if (c.rotate > 0 || c.scaleX > 0) {
      const dx = stx - w.x;
      const dy = sty - w.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        const base = Math.atan2(ty - oy, tx - ox);
        rotateAxes(w, wrap((Math.atan2(dy, dx) - base) * RAD) * c.rotate * mix * DEG);
        if (c.scaleX > 0 && b.data.length > 1e-6) {
          const s = 1 + (d / len - 1) * c.scaleX * mix;
          w.a *= s;
          w.c *= s;
        }
      }
    }
    b.updateSubtree(this.rootMatrix, false);
  }

  /**
   * Frame counter of a sequence on a slot: a keyed value, else the bound input's value, else
   * floor(time x fps), where time is the applied animation's time or the skeleton clock. Offset included.
   */
  sequenceCounter(slot: Slot, att: SequenceAttachment): number {
    const keyed = slot.sequenceFrames.get(att.name);
    if (keyed !== undefined) return Math.floor(keyed + 1e-6) + att.offset;
    if (att.input) {
      const v = this.inputValues.get(att.input) ?? this.inputDefaults.get(att.input);
      if (v !== undefined) return Math.floor(v + 1e-6) + att.offset;
    }
    return sequenceCounter(att.fps, att.offset, this.animationTime ?? this.clock);
  }

  /** Index of the sequence frame shown on a slot now (-1 = none). */
  sequenceFrame(slot: Slot, att: SequenceAttachment): number {
    return sequenceFrameIndex(att.frames.length, att.mode, this.sequenceCounter(slot, att));
  }

  /** Draw item for one frame of a sequence (null when hidden or the frame's image is missing). */
  private sequenceItem(slot: Slot, att: SequenceAttachment, index: number): DrawItem | null {
    const frame = att.frames[index];
    const image = frame && this.images.get(frame.image);
    if (!frame || !image) return null;
    const color = mulColor(slot.color, parseHex(att.color));
    if (color[3] <= 0) return null;
    const { uv, quad } = sequenceFrameLayout(frame, image.width, image.height);
    const packed = this.packed.get(frame.image);
    let [u0, v0, u1, v1] = uv;
    let [q0, p0, q1, p1] = quad;
    if (packed?.trim) {
      // The atlas holds only part of the image: draw the overlap of the frame and the packed part.
      const [a0, b0, a1, b1] = packed.trim;
      const nu0 = Math.max(u0, a0), nv0 = Math.max(v0, b0), nu1 = Math.min(u1, a1), nv1 = Math.min(v1, b1);
      if (nu0 >= nu1 || nv0 >= nv1) return null;
      const fx = (u: number) => q0 + ((u - u0) / (u1 - u0)) * (q1 - q0);
      const fy = (v: number) => p0 + ((v - v0) / (v1 - v0)) * (p1 - p0);
      [q0, p0, q1, p1] = [fx(nu0), fy(nv0), fx(nu1), fy(nv1)];
      [u0, v0, u1, v1] = [nu0, nv0, nu1, nv1];
    }
    let vertices = this.attachmentWorldVertices(slot, att);
    if (q0 !== 0 || p0 !== 0 || q1 !== 1 || p1 !== 1) vertices = trimQuad(vertices, [q0, p0, q1, p1]);
    const quadUvs = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]);
    const texture = packed ? packed.page : image;
    const uvs = packed ? remapUvs(quadUvs, packed.map) : quadUvs;
    // Only the frame's own pixels belong to it (sheet neighbours and atlas padding do not).
    const whole = !packed && u0 === 0 && v0 === 0 && u1 === 1 && v1 === 1;
    const textureRect = whole
      ? undefined
      : {
          x: uvs[0] * texture.width,
          y: uvs[1] * texture.height,
          width: (uvs[4] - uvs[0]) * texture.width,
          height: (uvs[5] - uvs[1]) * texture.height,
        };
    return {
      slot,
      attachment: att,
      image,
      texture,
      ...(textureRect ? { textureRect } : {}),
      vertices,
      uvs,
      indices: REGION_INDICES,
      color,
      blend: slot.data.blend,
    };
  }

  /** Show fixed text (or a template) in a slot's text attachment instead of its own; null restores it. */
  setText(slotRef: string, text: string | null) {
    const slot = this.findSlot(slotRef);
    if (!slot) throw new Error(`Slot "${slotRef}" not found`);
    if (text === null) this.textOverrides.delete(slot.data.id);
    else this.textOverrides.set(slot.data.id, text);
  }

  /** The text a slot's text attachment shows right now (template filled in). */
  textContent(slot: Slot, att: Extract<Attachment, { type: "text" }>): string {
    return formatTemplate(this.textOverrides.get(slot.data.id) ?? att.text, this.textValues);
  }

  /** Box centre → world matrix of a text attachment. */
  textMatrix(slot: Slot, att: Extract<Attachment, { type: "text" }>): Affine {
    const r = att.rotation * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return multiply(slot.bone.world, { a: c, b: -s, c: s, d: c, x: att.x, y: att.y });
  }

  getAttachment(slot: Slot, name: string | null = slot.attachmentName): Attachment | null {
    if (name == null) return null;
    const id = slot.data.id;
    return this.skin?.attachments[id]?.[name] ?? defaultSkin(this.doc).attachments[id]?.[name] ?? null;
  }

  /** World-space vertices of a slot's region/mesh/path/bbox/shape/point attachment. */
  attachmentWorldVertices(slot: Slot, att: Attachment): Float32Array {
    const m = slot.bone.world;
    if (att.type === "region" || att.type === "sequence" || att.type === "text") {
      const hw = (att.width / 2) * (att.type === "text" ? 1 : att.scaleX);
      const hh = (att.height / 2) * (att.type === "text" ? 1 : att.scaleY);
      const cos = Math.cos(att.rotation * DEG);
      const sin = Math.sin(att.rotation * DEG);
      // TL, TR, BR, BL (y-up)
      const corners = [-hw, hh, hw, hh, hw, -hh, -hw, -hh];
      const out = new Float32Array(8);
      for (let i = 0; i < 8; i += 2) {
        const lx = att.x + corners[i] * cos - corners[i + 1] * sin;
        const ly = att.y + corners[i] * sin + corners[i + 1] * cos;
        out[i] = m.a * lx + m.b * ly + m.x;
        out[i + 1] = m.c * lx + m.d * ly + m.y;
      }
      return out;
    }
    if (att.type === "mesh" || att.type === "path") {
      const n = att.vertices.length / 2;
      const deform = slot.deform.get(att.name);
      const out = new Float32Array(n * 2);
      if (att.weights) {
        for (let v = 0; v < n; v++) {
          let wx = 0;
          let wy = 0;
          const dx = deform ? deform[v * 2] : 0;
          const dy = deform ? deform[v * 2 + 1] : 0;
          for (const inf of att.weights[v]) {
            const bm = this.boneById.get(inf.bone)?.world ?? m;
            const lx = inf.x + dx;
            const ly = inf.y + dy;
            wx += (bm.a * lx + bm.b * ly + bm.x) * inf.weight;
            wy += (bm.c * lx + bm.d * ly + bm.y) * inf.weight;
          }
          out[v * 2] = wx;
          out[v * 2 + 1] = wy;
        }
      } else {
        for (let v = 0; v < n; v++) {
          const lx = att.vertices[v * 2] + (deform ? deform[v * 2] : 0);
          const ly = att.vertices[v * 2 + 1] + (deform ? deform[v * 2 + 1] : 0);
          out[v * 2] = m.a * lx + m.b * ly + m.x;
          out[v * 2 + 1] = m.c * lx + m.d * ly + m.y;
        }
      }
      return out;
    }
    const local = att.type === "shape" ? shapeOutline(att) : att.type === "boundingBox" || att.type === "clipping" ? att.vertices : [att.x, att.y];
    const out = new Float32Array(local.length);
    for (let i = 0; i < local.length; i += 2) {
      out[i] = m.a * local[i] + m.b * local[i + 1] + m.x;
      out[i + 1] = m.c * local[i] + m.d * local[i + 1] + m.y;
    }
    return out;
  }

  private shapeCache = new WeakMap<object, { key: string; indices: Uint16Array }>();

  /** Renderable geometry in draw order. */
  drawList(): DrawItem[] {
    const items: DrawItem[] = [];
    let clip: ClipRegion | null = null;
    let clipEnd: Id | null = null;
    for (const slot of this.drawOrder) {
      const att = this.getAttachment(slot);
      const first = items.length;
      draw: if (att) {
      if (att.type === "clipping") {
        // One mask at a time (as in Spine): a mask inside another mask's range is ignored.
        if (!clip && att.vertices.length >= 6) {
          const key = att.vertices.join(",");
          let cached = this.clipCache.get(att);
          if (!cached || cached.key !== key) {
            cached = { key, indices: new Uint16Array(triangulate(att.vertices)) };
            this.clipCache.set(att, cached);
          }
          clip = { slot, polygon: this.attachmentWorldVertices(slot, att), indices: cached.indices };
          clipEnd = att.end;
        }
        break draw;
      }
      if (att.type === "region" || att.type === "mesh") {
        const image = this.images.get(att.image) ?? null;
        const ac = parseHex(att.color);
        const color = mulColor(slot.color, ac);
        if (color[3] <= 0) break draw;
        let vertices = this.attachmentWorldVertices(slot, att);
        const packed = this.packed.get(att.image);
        let uvs: Float32Array;
        if (att.type === "region") {
          uvs = packed ? packed.regionUvs : REGION_UVS;
          if (packed?.trim) vertices = trimQuad(vertices, packed.trim);
        } else uvs = packed ? remapUvs(att.uvs, packed.map) : new Float32Array(att.uvs);
        const indices = att.type === "region" ? REGION_INDICES : new Uint16Array(att.triangles);
        const texture = packed ? packed.page : image;
        items.push({
          slot,
          attachment: att,
          image,
          texture,
          ...(packed ? { textureRect: packed.rect } : {}),
          vertices,
          uvs,
          indices,
          color,
          blend: slot.data.blend,
        });
      } else if (att.type === "sequence") {
        const item = this.sequenceItem(slot, att, this.sequenceFrame(slot, att));
        if (item) items.push(item);
      } else if (att.type === "particles") {
        const item = this.particleItem(slot, att);
        if (item) items.push(item);
      } else if (att.type === "text") {
        const color = slot.color;
        if (color[3] <= 0) break draw;
        items.push({
          slot,
          attachment: att,
          image: null,
          texture: null,
          vertices: this.attachmentWorldVertices(slot, att),
          uvs: REGION_UVS,
          indices: REGION_INDICES,
          color,
          blend: slot.data.blend,
          text: {
            content: this.textContent(slot, att),
            font: att.font,
            size: att.size,
            weight: att.weight,
            align: att.align,
            width: att.width,
            height: att.height,
            fill: parseHex(att.color),
            outline: att.outline && att.outlineWidth ? parseHex(att.outline) : null,
            outlineWidth: att.outlineWidth ?? 0,
            matrix: this.textMatrix(slot, att),
          },
        });
      } else if (att.type === "shape") {
        const outline = this.attachmentWorldVertices(slot, att);
        const key = `${att.shape}|${att.width}|${att.height}|${att.radius}|${att.points?.join(",")}`;
        let cached = this.shapeCache.get(att);
        if (!cached || cached.key !== key) {
          cached = { key, indices: new Uint16Array(triangulate(shapeOutline(att))) };
          this.shapeCache.set(att, cached);
        }
        const color = mulColor(slot.color, parseHex(att.fill));
        items.push({
          slot,
          attachment: att,
          image: null,
          texture: this.white?.page ?? null,
          vertices: outline,
          uvs: this.white ? fill2(outline.length, this.white.u, this.white.v) : new Float32Array(outline.length),
          indices: cached.indices,
          color,
          blend: slot.data.blend,
          ...(att.stroke && att.strokeWidth
            ? { stroke: { color: mulColor(slot.color, parseHex(att.stroke)), width: att.strokeWidth, outline } }
            : {}),
        });
      }
      }
      if (clip && clip.slot !== slot) for (let i = first; i < items.length; i++) items[i].clip = clip;
      if (clip && slot.data.id === clipEnd) {
        clip = null;
        clipEnd = null;
      }
    }
    return items;
  }

  private clipCache = new WeakMap<object, { key: string; indices: Uint16Array }>();

  private particleItem(slot: Slot, att: ParticlesAttachment): DrawItem | null {
    const em = this.emitters.get(slot.data.id);
    if (!em || em.data !== att || !em.alive) return null;
    const geo = em.geometry(this.particleFrac, slot.bone.world, slot.color);
    if (!geo.count) return null;
    let texture: TextureRef | null = null;
    let image: ImageAsset | null = null;
    let uvs = geo.uvs;
    let textureRect: DrawItem["textureRect"];
    if (att.look === "image") {
      image = (att.image && this.images.get(att.image)) || null;
      const packed = att.image ? this.packed.get(att.image) : undefined;
      if (packed) {
        texture = packed.page;
        textureRect = packed.rect;
        uvs = remapUvs(geo.uvs, packed.map);
      } else texture = image;
      if (!texture) return null;
    } else if (att.look === "square") {
      if (this.white) {
        texture = this.white.page;
        uvs = fill2(geo.uvs.length, this.white.u, this.white.v);
      }
    } else texture = { id: PARTICLE_DOT_TEXTURE, width: PARTICLE_DOT_SIZE, height: PARTICLE_DOT_SIZE };
    return {
      slot,
      attachment: att,
      image,
      texture,
      ...(textureRect ? { textureRect } : {}),
      vertices: geo.vertices,
      uvs,
      indices: geo.indices,
      color: slot.color,
      colors: geo.colors,
      blend: att.blend,
      particles: { look: att.look, count: geo.count },
    };
  }

  /** World polygon of the slot's bounding box: the active attachment if it is one, else the first bbox on the slot. */
  hitPolygon(slot: Slot): Float32Array | null {
    let att = this.getAttachment(slot);
    if (!att || att.type !== "boundingBox") {
      const all = { ...defaultSkin(this.doc).attachments[slot.data.id], ...(this.skin?.attachments[slot.data.id] ?? {}) };
      att = Object.values(all).find((a) => a.type === "boundingBox") ?? att;
    }
    if (!att) return null;
    if (att.type === "boundingBox" || att.type === "shape" || att.type === "clipping") return this.attachmentWorldVertices(slot, att);
    if (att.type === "region" || att.type === "sequence" || att.type === "text") return this.attachmentWorldVertices(slot, att);
    if (att.type === "mesh") {
      const v = this.attachmentWorldVertices(slot, att);
      return v.slice(0, att.hull * 2);
    }
    return null;
  }

  hitTest(slot: Slot, x: number, y: number): boolean {
    const poly = this.hitPolygon(slot);
    return !!poly && pointInPolygon(x, y, poly);
  }

  /** Axis-aligned bounds of everything drawn (world space). */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const it of this.drawList()) for (let i = 0; i < it.vertices.length; i += 2) add(it.vertices[i], it.vertices[i + 1]);
    for (const b of this.bones) {
      add(b.world.x, b.world.y);
      const [ex, ey] = apply(b.world, b.data.length, 0);
      add(ex, ey);
    }
    return { minX, minY, maxX, maxY };
  }
}

const REGION_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const REGION_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const fill2 = (n: number, a: number, b: number) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    out[i] = a;
    out[i + 1] = b;
  }
  return out;
};

/**
 * Shrink a region quad (TL, TR, BR, BL, i.e. uv (0,0) (1,0) (1,1) (0,1)) to the trimmed part [u0, v0, u1, v1]
 * of its image, so no transparent margin is drawn and nothing outside the packed rect is sampled.
 */
function trimQuad(q: Float32Array, [u0, v0, u1, v1]: [number, number, number, number]): Float32Array {
  const ux = q[2] - q[0], uy = q[3] - q[1]; // TL -> TR
  const vx = q[6] - q[0], vy = q[7] - q[1]; // TL -> BL
  const at = (u: number, v: number) => [q[0] + ux * u + vx * v, q[1] + uy * u + vy * v];
  return new Float32Array([...at(u0, v0), ...at(u1, v0), ...at(u1, v1), ...at(u0, v1)]);
}

const mulColor = (a: RGBA, b: RGBA): RGBA => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];

function wrap(d: number) {
  d %= 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}
