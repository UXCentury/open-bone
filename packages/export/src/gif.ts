// @ts-expect-error gifenc ships without types (MIT, CommonJS + ESM builds)
import * as gifencModule from "gifenc";
import type { Frame } from "./bytes.ts";

type Palette = number[][];
const { GIFEncoder, applyPalette, quantize } = // ESM build: named exports (its default is GIFEncoder); CommonJS interop: everything under default.
  ("GIFEncoder" in gifencModule ? gifencModule : (gifencModule as { default: unknown }).default) as {
  GIFEncoder: () => { writeFrame(i: Uint8Array, w: number, h: number, o: object): void; finish(): void; bytes(): Uint8Array };
  quantize: (d: Uint8Array | Uint8ClampedArray, n: number, o?: object) => Palette;
  applyPalette: (d: Uint8Array | Uint8ClampedArray, p: Palette, format?: string) => Uint8Array;
};

/**
 * Animated GIF (256 colours per frame). With `transparent`, pixels under 50% alpha become fully transparent
 * (GIF has 1-bit transparency); otherwise frames are expected to be opaque. `loops` 0 = forever.
 */
export function encodeGif(frames: Frame[], opts: { delayMs: number; loops?: number; transparent?: boolean }): Uint8Array {
  if (!frames.length) throw new Error("GIF needs at least one frame");
  const gif = GIFEncoder();
  const { width, height } = frames[0];
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) throw new Error("All GIF frames must be the same size");
    // gifenc reads pixels through a Uint32Array over the whole buffer: give it a tightly packed copy.
    const data = new Uint8Array(f.data);
    const palette = opts.transparent ? quantize(data, 256, { format: "rgba4444", oneBitAlpha: true }) : quantize(data, 256);
    const index = applyPalette(data, palette, opts.transparent ? "rgba4444" : "rgb565");
    const transparentIndex = opts.transparent ? palette.findIndex((c) => c[3] === 0) : -1;
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.max(10, Math.round(opts.delayMs / 10) * 10),
      ...(i === 0 ? { repeat: opts.loops ?? 0 } : {}),
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex, dispose: 2 } : {}),
    });
  });
  gif.finish();
  return gif.bytes();
}
