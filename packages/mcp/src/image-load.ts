import { type Image, loadImage } from "@napi-rs/canvas";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG chunks that affect how pixels decode; everything else (text, EXIF, C2PA content credentials…) is dropped. */
const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "acTL", "fcTL", "fdAT"]);

/**
 * A PNG without its metadata chunks. Generated art often carries large ones (C2PA "caBX" content credentials, XMP)
 * before the pixel data, and @napi-rs/canvas then fails to recognise the buffer ("Invalid SVG image"). Returns the
 * input unchanged when it is not a PNG or has nothing to drop.
 */
export function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8 || SIG.some((b, i) => buf[i] !== b)) return buf;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let dropped = false;
  for (let p = 8; p + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const end = p + 12 + len;
    if (end > buf.length) return buf; // truncated: leave it to the decoder
    if (KEEP.has(type)) parts.push(buf.subarray(p, end));
    else dropped = true;
    p = end;
    if (type === "IEND") break;
  }
  return dropped ? Buffer.concat(parts) : buf;
}

/** loadImage for image bytes, a data: URI, a URL or a path, robust to PNG metadata chunks. */
export async function decodeImage(src: Buffer | string): Promise<Image> {
  if (typeof src === "string") {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
    if (m?.[2]) return loadImage(stripPngMetadata(Buffer.from(m[3], "base64")));
    return loadImage(src);
  }
  return loadImage(stripPngMetadata(src));
}
