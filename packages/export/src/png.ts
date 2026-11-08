import { ByteWriter, type Frame, crc32, zlibDeflate } from "./bytes.ts";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(w: ByteWriter, type: string, data: Uint8Array) {
  w.u32(data.length);
  const body = new ByteWriter().ascii(type).bytes(data).result();
  w.bytes(body).u32(crc32(body));
}

/** Filter type 0 (none) scanlines: [0, r,g,b,a, ...] per row. */
function scanlines(f: Frame): Uint8Array {
  const stride = f.width * 4;
  const out = new Uint8Array((stride + 1) * f.height);
  for (let y = 0; y < f.height; y++) {
    out[y * (stride + 1)] = 0;
    out.set(f.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return out;
}

function ihdr(width: number, height: number): Uint8Array {
  // 8-bit RGBA, deflate, adaptive filtering, no interlace.
  return new ByteWriter().u32(width).u32(height).u8(8).u8(6).u8(0).u8(0).u8(0).result();
}

/** Encode one RGBA frame as PNG. */
export async function encodePng(f: Frame): Promise<Uint8Array> {
  const w = new ByteWriter().bytes(SIGNATURE);
  chunk(w, "IHDR", ihdr(f.width, f.height));
  chunk(w, "IDAT", await zlibDeflate(scanlines(f)));
  chunk(w, "IEND", new Uint8Array());
  return w.result();
}

/**
 * Animated PNG: every frame is full size, replaces the previous one (dispose none, blend source).
 * `loops` 0 = forever. Browsers, macOS and most viewers play it; others show the first frame.
 */
export async function encodeApng(frames: Frame[], opts: { delayMs: number; loops?: number }): Promise<Uint8Array> {
  if (!frames.length) throw new Error("APNG needs at least one frame");
  const { width, height } = frames[0];
  const w = new ByteWriter().bytes(SIGNATURE);
  chunk(w, "IHDR", ihdr(width, height));
  chunk(w, "acTL", new ByteWriter().u32(frames.length).u32(opts.loops ?? 0).result());
  // Delay as a fraction: delayMs / 1000.
  const num = Math.max(1, Math.round(opts.delayMs));
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.width !== width || f.height !== height) throw new Error("All APNG frames must be the same size");
    chunk(w, "fcTL", new ByteWriter().u32(seq++).u32(width).u32(height).u32(0).u32(0).u16(num).u16(1000).u8(0).u8(0).result());
    const data = await zlibDeflate(scanlines(f));
    if (i === 0) chunk(w, "IDAT", data);
    else chunk(w, "fdAT", new ByteWriter().u32(seq++).bytes(data).result());
  }
  chunk(w, "IEND", new Uint8Array());
  return w.result();
}
