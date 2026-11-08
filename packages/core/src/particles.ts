import { lerpColor, parseHex, type RGBA } from "./math.ts";
import type { ColorStop, ParticlesAttachment } from "./types.ts";

/** Editable fields of a particles attachment (everything but `type` and `name`). */
export type ParticleSettings = Omit<ParticlesAttachment, "type" | "name">;

/** Defaults for a new emitter: a gentle upward puff of white dots. */
export function defaultParticleSettings(): ParticleSettings {
  return {
    emitting: true,
    rate: 20,
    bursts: [],
    maxParticles: 200,
    duration: 1,
    loop: true,
    prewarm: false,
    shape: "point",
    x: 0,
    y: 0,
    rotation: 90,
    angle: 30,
    radius: 10,
    width: 40,
    height: 40,
    space: "world",
    lifetime: [0.8, 1.2],
    speed: [80, 120],
    gravity: 0,
    drag: 0,
    startSize: [10, 14],
    endSize: [2, 4],
    startRotation: [0, 0],
    endRotation: [0, 0],
    angularVelocity: [0, 0],
    colors: [
      { t: 0, color: "#ffffffff" },
      { t: 1, color: "#ffffff00" },
    ],
    blend: "normal",
    look: "circle",
    stretch: 0.05,
    seed: 1,
  };
}

export type ParticlePreset = "fire" | "smoke" | "sparks" | "confetti" | "exhaust" | "coins";

/** Starting points for common effects. Each overrides part of the defaults. */
export const PARTICLE_PRESETS: Record<ParticlePreset, Partial<ParticleSettings>> = {
  fire: {
    rate: 60,
    shape: "circle",
    radius: 12,
    rotation: 90,
    angle: 20,
    lifetime: [0.5, 0.9],
    speed: [60, 110],
    gravity: -60,
    drag: 0.5,
    startSize: [22, 30],
    endSize: [4, 8],
    colors: [
      { t: 0, color: "#fff3b0ff" },
      { t: 0.3, color: "#ffae2bee" },
      { t: 0.7, color: "#e8401ca0" },
      { t: 1, color: "#60100000" },
    ],
    blend: "additive",
    look: "circle",
  },
  smoke: {
    rate: 14,
    shape: "circle",
    radius: 10,
    rotation: 90,
    angle: 25,
    lifetime: [1.6, 2.6],
    speed: [30, 60],
    gravity: -20,
    drag: 0.8,
    startSize: [16, 22],
    endSize: [60, 80],
    startRotation: [0, 360],
    angularVelocity: [-40, 40],
    colors: [
      { t: 0, color: "#9a9ea880" },
      { t: 0.4, color: "#80848c60" },
      { t: 1, color: "#6a6e7600" },
    ],
    look: "circle",
    prewarm: true,
  },
  sparks: {
    rate: 0,
    bursts: [{ time: 0, count: 30 }],
    duration: 0.8,
    shape: "point",
    rotation: 90,
    angle: 160,
    lifetime: [0.35, 0.7],
    speed: [180, 360],
    gravity: 500,
    drag: 1,
    startSize: [3, 4],
    endSize: [1, 2],
    colors: [
      { t: 0, color: "#ffffd0ff" },
      { t: 0.5, color: "#ffb030ff" },
      { t: 1, color: "#ff400000" },
    ],
    blend: "additive",
    look: "spark",
    stretch: 0.04,
  },
  confetti: {
    rate: 0,
    bursts: [{ time: 0, count: 80 }],
    duration: 3,
    shape: "box",
    width: 60,
    height: 10,
    rotation: 90,
    angle: 70,
    lifetime: [2, 3],
    speed: [250, 450],
    gravity: 380,
    drag: 1.6,
    startSize: [8, 12],
    endSize: [8, 12],
    startRotation: [0, 360],
    angularVelocity: [-360, 360],
    colors: [
      { t: 0, color: "#ffffffff" },
      { t: 0.85, color: "#ffffffff" },
      { t: 1, color: "#ffffff00" },
    ],
    look: "square",
  },
  exhaust: {
    rate: 90,
    shape: "cone",
    radius: 6,
    rotation: -90,
    angle: 14,
    lifetime: [0.3, 0.55],
    speed: [220, 300],
    gravity: 0,
    drag: 1.2,
    startSize: [14, 18],
    endSize: [26, 34],
    colors: [
      { t: 0, color: "#ffffffff" },
      { t: 0.15, color: "#ffd25aff" },
      { t: 0.5, color: "#ff6a1ca0" },
      { t: 1, color: "#50505000" },
    ],
    blend: "additive",
    look: "circle",
    prewarm: true,
  },
  coins: {
    rate: 0,
    bursts: [{ time: 0, count: 12 }],
    duration: 1.5,
    shape: "point",
    rotation: 90,
    angle: 60,
    lifetime: [1, 1.4],
    speed: [220, 340],
    gravity: 700,
    startSize: [14, 16],
    endSize: [14, 16],
    angularVelocity: [-180, 180],
    colors: [
      { t: 0, color: "#ffd23fff" },
      { t: 0.8, color: "#ffc21fff" },
      { t: 1, color: "#ffc21f00" },
    ],
    look: "circle",
  },
};

/** Settings for a preset, filled from the defaults (fresh arrays, safe to mutate). */
export function particlePreset(preset: ParticlePreset): ParticleSettings {
  return structuredClone({ ...defaultParticleSettings(), ...PARTICLE_PRESETS[preset] });
}

/** Colour of the gradient at life fraction `t` (0..1). Stops need not be sorted. */
export function gradientColor(stops: ColorStop[], t: number): RGBA {
  if (!stops.length) return [1, 1, 1, 1];
  const sorted = stops.length > 1 && stops.some((s, i) => i > 0 && s.t < stops[i - 1].t) ? [...stops].sort((a, b) => a.t - b.t) : stops;
  if (t <= sorted[0].t) return parseHex(sorted[0].color);
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return parseHex(last.color);
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    if (t <= b.t) {
      const a = sorted[i - 1];
      return lerpColor(parseHex(a.color), parseHex(b.color), (t - a.t) / (b.t - a.t || 1));
    }
  }
  return parseHex(last.color);
}
