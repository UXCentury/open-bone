import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { type Frame, crc32, createZip, encodeApng, encodeAviMjpeg, encodeGif, encodeMovMjpeg, encodePng, encodePsd } from "../src/index.ts";

const W = 64;
const H = 48;

/** Frame i: a red square moving right on transparent (or white) background. */
function frame(i: number, opaque = false): Frame {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  if (opaque) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(4 + i * 8, 12, 16, 16);
  return { width: W, height: H, data: new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer.slice(0)) };
}
const frames = (n: number, opaque = false) => Array.from({ length: n }, (_, i) => frame(i, opaque));
const jpeg = (f: Frame) => {
  const c = createCanvas(f.width, f.height);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(f.width, f.height);
  img.data.set(f.data);
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(c.toBuffer("image/jpeg"));
};

/** PNG-style chunks: [type, data] after the 8-byte signature, verifying each CRC. */
function pngChunks(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset);
  const out: { type: string; data: Uint8Array }[] = [];
  for (let p = 8; p < b.length; ) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    expect(v.getUint32(p + 8 + len), `${type} CRC`).toBe(crc32(b.subarray(p + 4, p + 8 + len)));
    out.push({ type, data: b.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

const hasFfprobe = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
/** ffprobe the first video stream of a file (counting decoded frames). */
function probe(bytes: Uint8Array, ext: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ob-")), `t.${ext}`);
  fs.writeFileSync(file, bytes);
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames,r_frame_rate", "-of", "json", file]).toString();
  return JSON.parse(out).streams[0] as { codec_name: string; width: number; height: number; nb_read_frames: string; r_frame_rate: string };
}

describe("PNG / APNG", () => {
  it("PNG decodes to the same pixels", async () => {
    const f = frame(1);
    const img = await loadImage(Buffer.from(await encodePng(f)));
    const c = createCanvas(W, H);
    c.getContext("2d").drawImage(img, 0, 0);
    const px = c.getContext("2d").getImageData(0, 0, W, H).data;
    expect(Array.from(px)).toEqual(Array.from(f.data));
  });

  it("APNG has one fcTL per frame, valid CRCs and sequence numbers", async () => {
    const b = await encodeApng(frames(4), { delayMs: 100, loops: 0 });
    const chunks = pngChunks(b);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
    expect(new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset).getUint32(0)).toBe(4);
    const seqs = chunks.filter((c) => c.type === "fcTL" || c.type === "fdAT").map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    if (hasFfprobe) expect(probe(b, "apng")).toMatchObject({ codec_name: "apng", width: W, height: H, nb_read_frames: "4" });
  });
});

describe("GIF", () => {
  it("decodes, keeps transparency and frame count", async () => {
    const b = encodeGif(frames(3), { delayMs: 100, transparent: true });
    expect(String.fromCharCode(...b.subarray(0, 6))).toBe("GIF89a");
    const img = await loadImage(Buffer.from(b));
    const c = createCanvas(W, H);
    c.getContext("2d").drawImage(img, 0, 0);
    const px = c.getContext("2d").getImageData(0, 0, W, H).data;
    expect(px[(20 * W + 10) * 4 + 3]).toBe(255); // inside the square
    expect(px[3]).toBe(0); // transparent corner
    if (hasFfprobe) expect(probe(b, "gif")).toMatchObject({ codec_name: "gif", width: W, height: H, nb_read_frames: "3" });
  });
});

describe("PSD", () => {
  it("has a valid header, one layer per frame and a flattened image ffmpeg can read", () => {
    const b = encodePsd(frames(3).map((frame, i) => ({ name: `frame ${i + 1}`, frame })));
    const v = new DataView(b.buffer, b.byteOffset);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe("8BPS");
    expect([v.getUint16(4), v.getUint16(12), v.getUint32(14), v.getUint32(18), v.getUint16(22), v.getUint16(24)]).toEqual([1, 4, H, W, 8, 3]);
    // Layer count lives right after the section lengths (header 26 + 4 + 4 + 4 + 4).
    expect(v.getInt16(26 + 4 + 4 + 4 + 4)).toBe(-3);
    if (hasFfprobe) expect(probe(b, "psd")).toMatchObject({ codec_name: "psd", width: W, height: H });
  });
});

describe("AVI / MOV (Motion-JPEG)", () => {
  const jpegs = frames(5, true).map(jpeg);
  it("AVI is a valid RIFF with an index", () => {
    const b = encodeAviMjpeg(jpegs, { width: W, height: H, fps: 25 });
    const v = new DataView(b.buffer, b.byteOffset);
    expect(String.fromCharCode(...b.subarray(0, 4), ...b.subarray(8, 12))).toBe("RIFFAVI ");
    expect(v.getUint32(4, true)).toBe(b.length - 8);
    if (hasFfprobe) expect(probe(b, "avi")).toMatchObject({ codec_name: "mjpeg", width: W, height: H, nb_read_frames: "5", r_frame_rate: "25/1" });
  });

  it("MOV is readable with the right frame count and rate", () => {
    const b = encodeMovMjpeg(jpegs, { width: W, height: H, fps: 30 });
    expect(String.fromCharCode(...b.subarray(4, 8))).toBe("ftyp");
    if (hasFfprobe) expect(probe(b, "mov")).toMatchObject({ codec_name: "mjpeg", width: W, height: H, nb_read_frames: "5", r_frame_rate: "30/1" });
  });
});

describe("ZIP", () => {
  it("stores entries with correct CRCs and a central directory", () => {
    const files = [
      { name: "frame_0001.png", data: new Uint8Array([1, 2, 3]) },
      { name: "frame_0002.png", data: new Uint8Array([4, 5]) },
    ];
    const b = createZip(files);
    const v = new DataView(b.buffer, b.byteOffset);
    const eocd = b.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    expect(v.getUint32(14, true)).toBe(crc32(files[0].data));
    if (hasFfprobe) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-"));
      fs.writeFileSync(path.join(dir, "t.zip"), b);
      const listing = execFileSync("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), z.namelist())", path.join(dir, "t.zip")]).toString();
      expect(listing).toContain("None ['frame_0001.png', 'frame_0002.png']");
    }
  });
});
