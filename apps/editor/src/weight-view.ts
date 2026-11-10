import { createSignal } from "solid-js";

/**
 * Weights tool display (like Spine's Pies / Overlay / Selected): each bone gets its own colour; the mesh can be tinted
 * by every bone's colour blended by the weights (a smooth gradient), and each vertex can show a pie of its influences.
 */

const KEY = "openbone.weightView";
interface WeightView {
  /** A pie of every bone's share on each vertex. */
  pies: boolean;
  /** All bones' colours blended over the mesh; off: the painted bone's weights as a heat map. */
  overlay: boolean;
  /** Pies only on the selected vertices. */
  selectedOnly: boolean;
}
const read = (): WeightView => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<WeightView> | null;
    return { pies: v?.pies ?? true, overlay: v?.overlay ?? true, selectedOnly: v?.selectedOnly ?? false };
  } catch {
    return { pies: true, overlay: true, selectedOnly: false };
  }
};
const [weightView, setWeightViewSignal] = createSignal<WeightView>(read());
export { weightView };
export function setWeightView(patch: Partial<WeightView>) {
  setWeightViewSignal((v) => ({ ...v, ...patch }));
  try {
    localStorage.setItem(KEY, JSON.stringify(weightView()));
  } catch {
    /* private mode */
  }
}

export type RGB = [number, number, number];

/** Distinct colours for bones by their place in the skeleton (stable as long as the bone order is). */
export function boneColor(index: number): RGB {
  // Golden-angle hues keep neighbouring bones far apart; two lightness steps double the useful range.
  const h = (index * 137.508) % 360;
  const l = index % 2 ? 0.58 : 0.5;
  return hslToRgb(h, 0.85, l);
}

export const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

/** A vertex's colour: its bones' colours blended by their weights. */
export function blendColor(weights: Map<string, number>, colorOf: (bone: string) => RGB): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const [bone, w] of weights) {
    if (w <= 0) continue;
    const c = colorOf(bone);
    r += c[0] * w;
    g += c[1] * w;
    b += c[2] * w;
    total += w;
  }
  return total > 0 ? [r / total, g / total, b / total] : [128, 128, 128];
}

/** Heat colour for one bone's weight (blue 0 → red 1), as RGB. */
export function heatRgb(w: number): RGB {
  return hslToRgb((1 - Math.min(1, Math.max(0, w))) * 240, 0.9, 0.52);
}

/**
 * Fill a triangle with colours interpolated between its corners: it is cut into n² small triangles, each filled with
 * the colour at its centre (Canvas 2D can't blend vertex colours itself). `n` around 4–6 looks smooth at editor zoom.
 */
export function fillGradientTriangle(ctx: CanvasRenderingContext2D, p: [number, number][], c: RGB[], alpha: number, n = 5) {
  const at = (i: number, j: number): [number, number] => {
    const a = (n - i - j) / n;
    const b = i / n;
    const g = j / n;
    return [p[0][0] * a + p[1][0] * b + p[2][0] * g, p[0][1] * a + p[1][1] * b + p[2][1] * g];
  };
  const colorAt = (a: number, b: number, g: number): string =>
    css([c[0][0] * a + c[1][0] * b + c[2][0] * g, c[0][1] * a + c[1][1] * b + c[2][1] * g, c[0][2] * a + c[1][2] * b + c[2][2] * g], alpha);
  const tri = (q: [number, number][], col: string) => {
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    ctx.lineTo(q[1][0], q[1][1]);
    ctx.lineTo(q[2][0], q[2][1]);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    // A hairline in the same colour hides the seams between the small triangles.
    ctx.strokeStyle = col;
    ctx.stroke();
  };
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n - i; j++) {
      // Upward small triangle (i, j), (i+1, j), (i, j+1); its centre in barycentric terms.
      tri([at(i, j), at(i + 1, j), at(i, j + 1)], colorAt((n - i - j - 2 / 3) / n, (i + 1 / 3) / n, (j + 1 / 3) / n));
      if (i + j < n - 1) tri([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], colorAt((n - i - j - 4 / 3) / n, (i + 2 / 3) / n, (j + 2 / 3) / n));
    }
}

/** A vertex pie: one slice per bone, sized by its weight, in the bone's colour. */
export function drawPie(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, weights: Map<string, number>, colorOf: (bone: string) => RGB, outline: number) {
  const list = [...weights].filter(([, w]) => w > 0.001);
  const total = list.reduce((s, [, w]) => s + w, 0) || 1;
  let a = -Math.PI / 2;
  for (const [bone, w] of list) {
    const sweep = (w / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, a, a + sweep);
    ctx.closePath();
    ctx.fillStyle = css(colorOf(bone));
    ctx.fill();
    a += sweep;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#000000cc";
  ctx.lineWidth = outline;
  ctx.stroke();
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
