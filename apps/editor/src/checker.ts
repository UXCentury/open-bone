/** Checkerboard fills (cached per canvas context), used to show transparency. */
const cache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();

export function checkerPattern(ctx: CanvasRenderingContext2D, a: string, b: string, cell: number): CanvasPattern | string {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  const key = `${a}${b}${cell}`;
  let p = m.get(key);
  if (!p) {
    const c = document.createElement("canvas");
    c.width = c.height = Math.max(2, Math.round(cell * 2));
    const g = c.getContext("2d")!;
    g.fillStyle = a;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = b;
    g.fillRect(0, 0, c.width / 2, c.height / 2);
    g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
    const made = ctx.createPattern(c, "repeat");
    if (!made) return a;
    m.set(key, (p = made));
  }
  return p;
}

/** True when a #rrggbbaa colour is not fully opaque. */
export const isTranslucent = (hex: string) => hex.length >= 9 && parseInt(hex.slice(7, 9), 16) < 255;

/**
 * Fill an artboard rectangle: the light checkerboard where it is transparent (no background, or a translucent one),
 * then the background colour on top, so opacity reads as transparency rather than as a darker colour.
 */
export function fillArtboard(ctx: CanvasRenderingContext2D, background: string | null, x: number, y: number, w: number, h: number, cell = 10) {
  if (!background || isTranslucent(background)) {
    ctx.fillStyle = checkerPattern(ctx, "#d6d9df", "#eceef2", cell);
    ctx.fillRect(x, y, w, h);
  }
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, w, h);
  }
}
