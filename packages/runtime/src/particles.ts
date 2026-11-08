import { type Affine, DEG, type ParticlesAttachment, type RGBA, type Range, gradientColor, lerp } from "@openbone/core";

/** Fixed simulation step (seconds). Every emitter advances in whole steps, so results only depend on the step count. */
export const PARTICLE_STEP = 1 / 60;
/** Most steps taken in one realtime frame; longer frames drop the excess (avoids a spiral after a stall). */
export const MAX_PARTICLE_STEPS = 30;
/** Prewarm simulates at most this many steps. */
const MAX_PREWARM_STEPS = 600;
const EPS = 1e-9;

/** Small, fast, seedable PRNG (mulberry32). Same seed → same sequence on every platform. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(r: Range): number {
    return r[0] === r[1] ? r[0] : r[0] + (r[1] - r[0]) * this.next();
  }
  between(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** FNV-1a hash of a string, mixed into an emitter's seed so equal seeds on different slots still differ. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** One live particle. Position/velocity are in world space or in slot-bone space (local emitters). */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size0: number;
  size1: number;
  rot0: number;
  rot1: number;
  spin: number;
}

/** Live keyable values; undefined fields fall back to the attachment's setup values. */
export interface EmitterValues {
  emitting?: boolean;
  rate?: number;
}

/** Geometry of one emitter's particles: quads TL, TR, BR, BL with unit uvs and per-vertex colours. */
export interface ParticleGeometry {
  count: number;
  vertices: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
}

/**
 * Simulation state of one particles attachment on one slot. Advance with `step(h, boneWorld, values)` at
 * PARTICLE_STEP; the result depends only on the seed and the sequence of (bone transform, values) per step.
 */
export class ParticleEmitter {
  particles: Particle[] = [];
  /** Seconds into the current emitter cycle. */
  cycle = 0;
  /** Steps simulated since the emitter was created. */
  steps = 0;
  /** Particles requested by emitParticles(), spawned on the next step. */
  pending = 0;
  private acc = 0;
  private wasEmitting = false;
  private rng: Rng;
  /** Bone translation at the previous step: rate-emitted particles are spread along the path in between. */
  private lastX = NaN;
  private lastY = NaN;

  constructor(
    public data: ParticlesAttachment,
    /** Extra seed mixed in (e.g. a hash of the slot name). */
    salt = 0,
  ) {
    this.rng = new Rng((data.seed ^ salt) >>> 0);
  }

  get alive() {
    return this.particles.length;
  }

  /** Restart the emitter cycle (bursts at time 0 fire again on the next step). Live particles stay. */
  restart() {
    this.cycle = 0;
    this.acc = 0;
    this.wasEmitting = false;
  }

  step(h: number, m: Affine, values: EmitterValues = {}) {
    const d = this.data;
    const emitting = values.emitting ?? d.emitting;
    if (this.steps === 0 && emitting && d.prewarm && d.loop) {
      // Run one cycle in place so the effect looks settled at the first frame.
      const n = Math.min(MAX_PREWARM_STEPS, Math.ceil(d.duration / h - 1e-6));
      this.lastX = m.x;
      this.lastY = m.y;
      for (let i = 0; i < n; i++) this.advance(h, m, true, values.rate ?? d.rate);
    }
    this.advance(h, m, emitting, values.rate ?? d.rate);
    this.steps++;
  }

  private advance(h: number, m: Affine, emitting: boolean, rate: number) {
    const d = this.data;
    // Integrate (keeps array order so older particles draw first).
    const damp = d.drag > 0 ? Math.exp(-d.drag * h) : 1;
    const g = d.gravity * h;
    let w = 0;
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.age += h;
      if (p.age >= p.life) continue;
      p.vy -= g;
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * h;
      p.y += p.vy * h;
      ps[w++] = p;
    }
    ps.length = w;

    // Emission.
    if (emitting && !this.wasEmitting) {
      this.cycle = 0;
      this.acc = 0;
    }
    this.wasEmitting = emitting;
    const active = emitting && (d.loop || this.cycle < d.duration);
    let streamed = 0;
    let burst = this.pending;
    this.pending = 0;
    if (active) {
      this.acc += Math.max(0, rate) * h;
      streamed = Math.floor(this.acc);
      this.acc -= streamed;
      // Bursts inside [cycle, cycle + h); a looping cycle that wraps also covers the start of the next one.
      const start = this.cycle;
      const end = start + h;
      const wraps = end >= d.duration - EPS;
      const rest = end - d.duration;
      for (const b of d.bursts) {
        if (b.time > d.duration + EPS) continue;
        if (b.time >= start - EPS && b.time < end - EPS) burst += b.count;
        else if (wraps && d.loop && b.time < rest - EPS) burst += b.count;
      }
      this.cycle = wraps ? (d.loop ? Math.max(0, rest) : d.duration) : end;
    }
    const room = Math.max(0, d.maxParticles - ps.length);
    const nb = Math.min(burst, room);
    const ns = Math.min(streamed, room - nb);
    const lx = Number.isNaN(this.lastX) ? m.x : this.lastX;
    const ly = Number.isNaN(this.lastY) ? m.y : this.lastY;
    for (let i = 0; i < nb; i++) this.spawn(m, 0, m.x, m.y);
    for (let i = 0; i < ns; i++) {
      // Spread streamed particles over the step: born at fraction k, they have already lived (1 - k) of it.
      const k = (i + 1) / ns;
      this.spawn(m, (1 - k) * h, lerp(lx, m.x, k), lerp(ly, m.y, k));
    }
    this.lastX = m.x;
    this.lastY = m.y;

  }

  private spawn(m: Affine, preAge: number, ox: number, oy: number) {
    const d = this.data;
    const r = this.rng;
    const rot = d.rotation * DEG;
    const half = (d.angle / 2) * DEG;
    let f = 0; // along the direction
    let s = 0; // across it
    let dir = rot + r.between(-half, half);
    switch (d.shape) {
      case "circle": {
        const a = r.next() * Math.PI * 2;
        const rad = Math.sqrt(r.next()) * d.radius;
        f = Math.cos(a) * rad;
        s = Math.sin(a) * rad;
        dir = rot + a;
        break;
      }
      case "box":
        s = r.between(-d.width / 2, d.width / 2);
        f = r.between(-d.height / 2, d.height / 2);
        break;
      case "cone":
        s = r.between(-d.radius, d.radius);
        // Particles near the rim lean outwards, like a nozzle.
        if (d.radius > 0) dir = rot + (s / d.radius) * half;
        break;
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    let x = d.x + f * cos - s * sin;
    let y = d.y + f * sin + s * cos;
    const speed = r.range(d.speed);
    let vx = Math.cos(dir) * speed;
    let vy = Math.sin(dir) * speed;
    if (d.space === "world") {
      // Bone space → world; position relative to the (interpolated) emitter origin.
      const wx = m.a * x + m.b * y + ox;
      const wy = m.c * x + m.d * y + oy;
      x = wx;
      y = wy;
      const tx = m.a * vx + m.b * vy;
      const ty = m.c * vx + m.d * vy;
      const len = Math.hypot(tx, ty);
      vx = len > 1e-9 ? (tx / len) * speed : 0;
      vy = len > 1e-9 ? (ty / len) * speed : 0;
    }
    const p: Particle = {
      x,
      y,
      vx,
      vy,
      age: 0,
      life: Math.max(1e-3, r.range(d.lifetime)),
      size0: r.range(d.startSize),
      size1: r.range(d.endSize),
      rot0: r.range(d.startRotation),
      rot1: r.range(d.endRotation),
      spin: r.range(d.angularVelocity),
    };
    if (preAge > 0) {
      p.age = preAge;
      p.vy -= d.gravity * preAge;
      p.x += p.vx * preAge;
      p.y += p.vy * preAge;
    }
    if (p.age < p.life) this.particles.push(p);
  }

  /**
   * Quads for drawing, `frac` seconds after the last step (extrapolated for smooth motion between steps).
   * `m` is the slot bone's current world matrix (used by local-space emitters), `tint` the slot colour.
   */
  geometry(frac: number, m: Affine, tint: RGBA): ParticleGeometry {
    const d = this.data;
    const ps = this.particles;
    const n = Math.min(ps.length, 16383);
    const vertices = new Float32Array(n * 8);
    const colors = new Float32Array(n * 16);
    const uvs = new Float32Array(n * 8);
    const indices = new Uint16Array(n * 6);
    const local = d.space === "local";
    const sizeScale = local ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const age = Math.min(p.age + frac, p.life);
      const t = age / p.life;
      let x = p.x + p.vx * frac;
      let y = p.y + p.vy * frac;
      let vx = p.vx;
      let vy = p.vy;
      if (local) {
        const wx = m.a * x + m.b * y + m.x;
        const wy = m.c * x + m.d * y + m.y;
        x = wx;
        y = wy;
        const tx = m.a * vx + m.b * vy;
        vy = m.c * vx + m.d * vy;
        vx = tx;
      }
      const size = Math.max(0, lerp(p.size0, p.size1, t)) * sizeScale;
      const c = gradientColor(d.colors, t);
      const a = c[3] * tint[3];
      if (size <= 0 || a <= 0) continue;
      let ux: number; // half extent along the quad's u axis
      let uy: number;
      let hw: number; // half width across it
      if (d.look === "spark") {
        const sp = Math.hypot(vx, vy);
        const len = size / 2 + (sp * d.stretch) / 2;
        const ang = sp > 1e-6 ? Math.atan2(vy, vx) : (lerp(p.rot0, p.rot1, t) + p.spin * age) * DEG;
        ux = Math.cos(ang) * len;
        uy = Math.sin(ang) * len;
        hw = size / 2;
      } else {
        const ang = (lerp(p.rot0, p.rot1, t) + p.spin * age) * DEG;
        ux = (Math.cos(ang) * size) / 2;
        uy = (Math.sin(ang) * size) / 2;
        hw = size / 2;
      }
      const ul = Math.hypot(ux, uy) || 1;
      // v axis: perpendicular (counter-clockwise), pointing "up" in y-up space; TL = -u + v.
      const vx2 = (-uy / ul) * hw;
      const vy2 = (ux / ul) * hw;
      const o = k * 8;
      vertices[o] = x - ux + vx2;
      vertices[o + 1] = y - uy + vy2;
      vertices[o + 2] = x + ux + vx2;
      vertices[o + 3] = y + uy + vy2;
      vertices[o + 4] = x + ux - vx2;
      vertices[o + 5] = y + uy - vy2;
      vertices[o + 6] = x - ux - vx2;
      vertices[o + 7] = y - uy - vy2;
      uvs.set(UNIT_UVS, o);
      const r = c[0] * tint[0];
      const g = c[1] * tint[1];
      const b = c[2] * tint[2];
      for (let j = 0; j < 4; j++) {
        const q = k * 16 + j * 4;
        colors[q] = r;
        colors[q + 1] = g;
        colors[q + 2] = b;
        colors[q + 3] = a;
      }
      const ii = k * 6;
      const base = k * 4;
      indices[ii] = base;
      indices[ii + 1] = base + 1;
      indices[ii + 2] = base + 2;
      indices[ii + 3] = base;
      indices[ii + 4] = base + 2;
      indices[ii + 5] = base + 3;
      k++;
    }
    return {
      count: k,
      vertices: vertices.subarray(0, k * 8),
      uvs: uvs.subarray(0, k * 8),
      colors: colors.subarray(0, k * 16),
      indices: indices.subarray(0, k * 6),
    };
  }
}

const UNIT_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
