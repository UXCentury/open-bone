import { PARTICLE_DOT_SIZE, particleDotAlpha } from "@openbone/runtime";
import type { RasterCanvas } from "./text.ts";

/**
 * Pixels of the built-in soft round particle sprite (PARTICLE_DOT_TEXTURE), RGBA, PARTICLE_DOT_SIZE square.
 * `premultiplied` (render-webgl's upload): every channel is the alpha; otherwise white with alpha (for engines
 * that premultiply on upload, like a canvas source).
 */
export function particleDotPixels(premultiplied = false): Uint8ClampedArray {
  const n = PARTICLE_DOT_SIZE;
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const a = Math.round(particleDotAlpha(r) * 255);
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = premultiplied ? a : 255;
      px[o + 3] = a;
    }
  return px;
}

/** The particle sprite drawn into a canvas (null where no canvas can be made). */
export function particleDotCanvas(
  createCanvas: (w: number, h: number) => RasterCanvas | null = (w, h) =>
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : typeof document !== "undefined"
        ? Object.assign(document.createElement("canvas"), { width: w, height: h })
        : null,
): RasterCanvas | null {
  const n = PARTICLE_DOT_SIZE;
  const c = createCanvas(n, n);
  const ctx = c?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!c || !ctx) return null;
  const data = ctx.createImageData(n, n);
  data.data.set(particleDotPixels(false));
  ctx.putImageData(data, 0, 0);
  return c;
}
