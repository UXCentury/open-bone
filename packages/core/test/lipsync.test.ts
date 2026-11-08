import { describe, expect, it } from "vitest";
import { type MouthShape, guessMouthMapping, lipSync } from "../src/index.ts";

const SR = 16000;
/** Build a signal from segments: [seconds, generator(t) → sample]. */
function signal(parts: [number, (t: number, i: number) => number][]) {
  const total = parts.reduce((s, [d]) => s + d, 0);
  const out = new Float32Array(Math.round(total * SR));
  let i = 0;
  for (const [d, gen] of parts) {
    const n = Math.round(d * SR);
    for (let k = 0; k < n; k++, i++) out[i] = gen(k / SR, k);
  }
  return out;
}
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const silent = () => 0;
/** Vowel-like: a 140 Hz voice with harmonics shaped by two formants. */
const vowel = (amp: number, f1: number, f2: number) => (t: number) => {
  let s = 0;
  for (let h = 1; h <= 30; h++) {
    const f = 140 * h;
    const g = Math.exp(-(((f - f1) / 120) ** 2)) + 0.7 * Math.exp(-(((f - f2) / 160) ** 2)) + 0.02;
    s += g * Math.sin(2 * Math.PI * f * t);
  }
  return amp * s * 0.15;
};
const shapeAt = (keys: { time: number; shape: MouthShape }[], t: number) => {
  let s: MouthShape = "rest";
  for (const k of keys) if (k.time <= t + 1e-9) s = k.shape;
  return s;
};

describe("lip sync", () => {
  it("silence rests; a loud open vowel opens wide; a quiet one barely opens", () => {
    const keys = lipSync(signal([[0.4, silent], [0.5, vowel(1, 750, 1200)], [0.4, silent], [0.5, vowel(0.18, 750, 1200)], [0.4, silent]]), SR, { fps: 30 });
    expect(shapeAt(keys, 0.2)).toBe("rest");
    expect(shapeAt(keys, 0.65)).toBe("wide");
    expect(shapeAt(keys, 1.1)).toBe("rest");
    expect(["small", "open"]).toContain(shapeAt(keys, 1.55));
    expect(keys[keys.length - 1].shape).toBe("rest");
  });

  it("a rounded vowel (energy low, weak mids) is round; hiss is small", () => {
    const keys = lipSync(signal([[0.3, silent], [0.5, vowel(0.8, 320, 700)], [0.3, silent], [0.4, () => 0.25 * noise() * (Math.random() > 0 ? 1 : 1)], [0.3, silent]]), SR);
    expect(shapeAt(keys, 0.55)).toBe("round");
    // White noise: mostly high frequencies at modest loudness.
    expect(shapeAt(keys, 1.3)).toBe("small");
  });

  it("a short gap inside speech is a closed mouth (m/b/p), a long one rests", () => {
    const v = vowel(1, 700, 1100);
    const keys = lipSync(signal([[0.3, silent], [0.4, v], [0.08, silent], [0.4, v], [0.6, silent], [0.4, v], [0.3, silent]]), SR);
    expect(shapeAt(keys, 0.74)).toBe("closed");
    expect(shapeAt(keys, 1.5)).toBe("rest");
  });

  it("keys snap to the frame rate, never repeat a shape, and start and end at rest", () => {
    const keys = lipSync(signal([[0.2, silent], [0.6, vowel(0.9, 700, 1100)], [0.2, silent]]), SR, { fps: 24 });
    expect(keys[0]).toEqual({ time: 0, shape: "rest" });
    for (const k of keys) expect(Math.abs(k.time * 24 - Math.round(k.time * 24))).toBeLessThan(1e-6);
    for (let i = 1; i < keys.length; i++) expect(keys[i].shape).not.toBe(keys[i - 1].shape);
    expect(lipSync(new Float32Array(SR), SR)).toEqual([{ time: 0, shape: "rest" }]);
  });

  it("guesses a mouth set from common names", () => {
    const m = guessMouthMapping(["mouth-rest", "mouth-mbp", "mouth-open", "mouth-wide", "mouth-o", "mouth-etc"]);
    expect(m).toMatchObject({ rest: "mouth-rest", closed: "mouth-mbp", open: "mouth-open", wide: "mouth-wide", round: "mouth-o", small: "mouth-etc" });
    const few = guessMouthMapping(["closed", "open"]);
    expect(few.rest).toBe("closed");
    expect(few.wide).toBe("open");
  });
});
