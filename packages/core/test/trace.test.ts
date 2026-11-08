import { describe, expect, it } from "vitest";
import { isSimple, pointInPolygon, traceMesh } from "../src/index.ts";

/** An alpha mask from a predicate. */
function mask(w: number, h: number, on: (x: number, y: number) => boolean) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = on(x, y) ? 255 : 0;
  return a;
}
const hullOf = (m: { vertices: number[]; hull: number }) => m.vertices.slice(0, m.hull * 2);
const area = (p: number[]) => {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(s / 2);
};

describe("traceMesh (automatic mesh outline)", () => {
  it("a circle traces to a round outline much smaller than its box", () => {
    const w = 100;
    const m = traceMesh(mask(w, w, (x, y) => (x - 50) ** 2 + (y - 50) ** 2 < 40 ** 2), w, w, { x: 0, y: 0, width: 100, height: 100 }, { padding: 0, interior: 0 })!;
    expect(m).not.toBeNull();
    expect(m.hull).toBeGreaterThan(8);
    expect(isSimple(hullOf(m))).toBe(true);
    // ~ circle area (π·40² ≈ 5027), well below the 100×100 quad.
    expect(area(hullOf(m))).toBeGreaterThan(4500);
    expect(area(hullOf(m))).toBeLessThan(5800);
    expect(m.triangles.length / 3).toBeGreaterThanOrEqual(m.hull - 2);
  });

  it("follows a concave L shape and keeps every visible pixel inside", () => {
    const w = 80;
    const on = (x: number, y: number) => (x < 30 && y < 80) || (y >= 50 && x < 80);
    const m = traceMesh(mask(w, w, on), w, w, { x: 40, y: -40, width: 80, height: 80 }, { padding: 1, interior: 0 })!;
    const hull = hullOf(m);
    expect(isSimple(hull)).toBe(true);
    // The empty top-right corner is outside the mesh; the L's pixels are inside (pixel centres → attachment space).
    const toLocal = (x: number, y: number): [number, number] => [x + 0.5, -(y + 0.5)];
    expect(pointInPolygon(...toLocal(60, 20), hull)).toBe(false);
    for (const [x, y] of [[5, 5], [25, 70], [75, 75], [15, 40]]) expect(pointInPolygon(...toLocal(x, y), hull)).toBe(true);
  });

  it("maps uvs to the image and positions like a region (centre, scale, rotation)", () => {
    const w = 40;
    const a = mask(w, 20, () => true);
    const m = traceMesh(a, w, 20, { x: 10, y: 5, width: 40, height: 20, rotation: 90 }, { padding: 0, interior: 0 })!;
    expect(m.hull).toBe(4);
    for (const u of m.uvs) expect(u).toBeGreaterThanOrEqual(0);
    for (const u of m.uvs) expect(u).toBeLessThanOrEqual(1);
    // Rotated 90°: the 40-wide image becomes 40 tall around (10, 5).
    const xs = m.vertices.filter((_, i) => i % 2 === 0);
    const ys = m.vertices.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 5);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(10, 5);
  });

  it("adds interior vertices for bending and returns null for an empty image", () => {
    const w = 120;
    const m = traceMesh(mask(w, w, (x, y) => x > 10 && x < 110 && y > 10 && y < 110), w, w, { x: 0, y: 0, width: 120, height: 120 }, { interior: 25 })!;
    expect(m.vertices.length / 2).toBeGreaterThan(m.hull + 4);
    expect(traceMesh(new Uint8Array(100), 10, 10, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });

  it("art in several big pieces falls back to one hull around everything", () => {
    const w = 100;
    const m = traceMesh(mask(w, w, (x, y) => (x < 30 && y < 30) || (x > 70 && y > 70)), w, w, { x: 50, y: -50, width: 100, height: 100 }, { padding: 0, interior: 0 })!;
    const hull = hullOf(m);
    expect(pointInPolygon(15, -15, hull)).toBe(true);
    expect(pointInPolygon(85, -85, hull)).toBe(true);
  });

  it("handles big images quickly (downsampled)", () => {
    const w = 2000;
    const t0 = performance.now();
    const m = traceMesh(mask(w, w, (x, y) => (x - 1000) ** 2 + (y - 1000) ** 2 < 900 ** 2), w, w, { x: 0, y: 0, width: 200, height: 200 })!;
    expect(m).not.toBeNull();
    expect(m.hull).toBeLessThanOrEqual(48);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
