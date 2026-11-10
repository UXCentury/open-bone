import type { Affine, RGBA, TextAlign } from "@openbone/core";

/** A text attachment ready to draw: content already filled in from its template. */
export interface TextDraw {
  content: string;
  font: string;
  size: number;
  weight: number;
  align: TextAlign;
  /** Box size (alignment frame), centred on the origin of `matrix`. */
  width: number;
  height: number;
  /** Attachment colours (the draw item's `color` is the slot tint on top). */
  fill: RGBA;
  outline: RGBA | null;
  outlineWidth: number;
  /** Box centre to world (skeleton space, y-up). */
  matrix: Affine;
}

/** The parts of a 2D canvas context drawTextBox uses (browser, OffscreenCanvas or @napi-rs/canvas). */
export interface TextContext {
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
}

export const cssColor = (c: RGBA) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

/** CSS font shorthand for a text item. */
export const cssFont = (t: Pick<TextDraw, "weight" | "size" | "font">) => `${t.weight} ${t.size}px ${t.font}`;

type Measurer = { font: string; measureText(text: string): { width: number } };
let measurer: Measurer | null | undefined;
const measured = new Map<string, number>();

/**
 * How far (skeleton units) the widest line of a text item runs past its box, measured with the real font. Renderers
 * that rasterise text into a box-sized texture grow the texture by this, so text wider than its stored box (an
 * estimate, or a font that renders wider than expected) is not cut off. 0 when no canvas is available to measure.
 */
export function textOverflow(t: Pick<TextDraw, "content" | "font" | "size" | "weight" | "width">): number {
  const font = cssFont(t);
  const key = `${font}|${t.content}`;
  let w = measured.get(key);
  if (w === undefined) {
    if (measurer === undefined) {
      try {
        const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
        measurer = (c?.getContext("2d") as unknown as Measurer | null) ?? null;
      } catch {
        measurer = null;
      }
    }
    if (!measurer) return 0;
    measurer.font = font;
    w = Math.max(0, ...t.content.split("\n").map((l) => Number(measurer!.measureText(l)?.width) || 0));
    if (measured.size > 2000) measured.clear();
    measured.set(key, w);
  }
  return Math.max(0, w - t.width);
}

/**
 * Draw a text item in its own box frame: origin at the box centre, y down, one unit per skeleton unit.
 * Lines are centred vertically in the box; `tint` multiplies the fill and outline colours.
 */
export function drawTextBox(ctx: TextContext, t: TextDraw, tint: RGBA = [1, 1, 1, 1]) {
  const mul = (c: RGBA): RGBA => [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], c[3] * tint[3]];
  ctx.font = cssFont(t);
  ctx.textAlign = t.align;
  ctx.textBaseline = "middle";
  const x = t.align === "left" ? -t.width / 2 : t.align === "right" ? t.width / 2 : 0;
  const lines = t.content.split("\n");
  const lh = t.size * 1.2;
  const y0 = (-(lines.length - 1) * lh) / 2;
  if (t.outline && t.outlineWidth > 0) {
    ctx.lineJoin = "round";
    ctx.lineWidth = t.outlineWidth * 2;
    ctx.strokeStyle = cssColor(mul(t.outline));
    lines.forEach((l, i) => ctx.strokeText(l, x, y0 + i * lh));
  }
  ctx.fillStyle = cssColor(mul(t.fill));
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
}
