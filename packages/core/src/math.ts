/** 2D affine world transform: [a b; c d] plus translation. Maps local (x,y) -> (a*x + b*y + x, c*x + d*y + y). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const identity = (): Affine => ({ a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 });

export function multiply(p: Affine, l: Affine): Affine {
  return {
    a: p.a * l.a + p.b * l.c,
    b: p.a * l.b + p.b * l.d,
    c: p.c * l.a + p.d * l.c,
    d: p.c * l.b + p.d * l.d,
    x: p.a * l.x + p.b * l.y + p.x,
    y: p.c * l.x + p.d * l.y + p.y,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c || 1e-9;
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  return { a: ia, b: ib, c: ic, d: id, x: -(ia * m.x + ib * m.y), y: -(ic * m.x + id * m.y) };
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];
}

export interface LocalTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

/** Local matrix from TRS + shear (degrees). */
export function localMatrix(t: LocalTransform): Affine {
  const rx = (t.rotation + t.shearX) * DEG;
  const ry = (t.rotation + 90 + t.shearY) * DEG;
  return {
    a: Math.cos(rx) * t.scaleX,
    b: Math.cos(ry) * t.scaleY,
    c: Math.sin(rx) * t.scaleX,
    d: Math.sin(ry) * t.scaleY,
    x: t.x,
    y: t.y,
  };
}

export type Inherit = "normal" | "onlyTranslation" | "noRotation" | "noScale";

/** Compose a bone's world matrix from its parent world matrix according to its inherit mode. */
export function boneWorld(parent: Affine | null, local: LocalTransform, inherit: Inherit): Affine {
  const l = localMatrix(local);
  if (!parent) return l;
  const [wx, wy] = apply(parent, local.x, local.y);
  switch (inherit) {
    case "normal":
      return multiply(parent, l);
    case "onlyTranslation":
      return { ...l, x: wx, y: wy };
    case "noRotation": {
      // keep parent scale magnitude, drop its rotation
      const sx = Math.hypot(parent.a, parent.c);
      const sy = Math.hypot(parent.b, parent.d);
      return { a: l.a * sx, b: l.b * sy, c: l.c * sx, d: l.d * sy, x: wx, y: wy };
    }
    case "noScale": {
      const sx = Math.hypot(parent.a, parent.c) || 1;
      const sy = Math.hypot(parent.b, parent.d) || 1;
      const p = { a: parent.a / sx, b: parent.b / sy, c: parent.c / sx, d: parent.d / sy, x: 0, y: 0 };
      const m = multiply(p, l);
      return { ...m, x: wx, y: wy };
    }
  }
}

export const worldRotation = (m: Affine) => Math.atan2(m.c, m.a) * RAD;
export const worldScaleX = (m: Affine) => Math.hypot(m.a, m.c);
export const worldScaleY = (m: Affine) => Math.hypot(m.b, m.d);

/** Wrap degrees into (-180, 180]. */
export function wrapDeg(d: number): number {
  d %= 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpAngle = (a: number, b: number, t: number) => a + wrapDeg(b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Evaluate an eased fraction for a key curve. t in 0..1. */
export function evalCurve(curve: "linear" | "stepped" | [number, number, number, number], t: number): number {
  if (curve === "linear") return t;
  if (curve === "stepped") return 0;
  const [x1, y1, x2, y2] = curve;
  // Solve bezier x(s) = t for s with Newton + bisection fallback, then return y(s).
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let lo = 0;
  let hi = 1;
  let s = t;
  for (let i = 0; i < 24; i++) {
    const x = bx(s) - t;
    if (Math.abs(x) < 1e-6) break;
    if (x > 0) hi = s;
    else lo = s;
    s = (lo + hi) / 2;
  }
  return by(s);
}

// ---------- Colors ----------
export type RGBA = [number, number, number, number];

export function parseHex(hex: string): RGBA {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 1];
}

export function toHex(c: RGBA): string {
  const b = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${b(c[0])}${b(c[1])}${b(c[2])}${c[3] >= 1 ? "" : b(c[3])}`;
}

export const lerpColor = (a: RGBA, b: RGBA, t: number): RGBA => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
  lerp(a[3], b[3], t),
];

export function pointInPolygon(px: number, py: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
