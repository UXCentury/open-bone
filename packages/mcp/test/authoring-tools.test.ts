import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { audioDuration } from "../src/audio-meta.ts";
import { createServer } from "../src/index.ts";

/** What the MCP used to need outside help for: key replacement, audio lengths, re-tracing, weights by area, art prep. */

async function connect() {
  const { server } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    if (r.isError) throw new Error(r.content[0].text);
    const t = r.content[0].text;
    if (!t) return {};
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      return { text: t };
    }
  };
  const doc = async () => JSON.parse(((await client.callTool({ name: "get_document", arguments: {} })) as { content: { text: string }[] }).content[0].text);
  return { call, doc };
}

/** A PNG on disk: `draw` paints on a w×h canvas. */
function png(file: string, w: number, h: number, draw: (g: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void) {
  const c = createCanvas(w, h);
  draw(c.getContext("2d"));
  writeFileSync(file, c.toBuffer("image/png"));
  return file;
}

async function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "ob-auth-"));
  const t = await connect();
  await t.call("new_project", { name: "T", path: path.join(dir, "t.obone"), width: 400, height: 400, originX: 200, originY: 380 });
  return { dir, ...t };
}

describe("set_keys replace", () => {
  it("merges by default and replaces the whole timeline when asked", async () => {
    const { call, doc } = await project();
    await call("add_bone", { name: "b" });
    await call("create_animation", { name: "a" });
    await call("set_keys", { animation: "a", target: "bone", id: "b", property: "y", keys: [{ time: 0, value: 0 }, { time: 1, value: 10 }, { time: 2, value: 0 }] });
    const merged = await call("set_keys", { animation: "a", target: "bone", id: "b", property: "y", keys: [{ time: 0.5, value: 5 }] });
    expect(merged.keys).toBe(4);
    const replaced = await call("set_keys", { animation: "a", target: "bone", id: "b", property: "y", replace: true, keys: [{ time: 0, value: 1 }, { time: 3, value: 2 }] });
    expect(replaced.keys).toBe(2);
    const tl = (await doc()).animations[0].timelines[0];
    expect(tl.keys.map((k: { time: number }) => k.time)).toEqual([0, 3]);
  });
});

describe("audio durations", () => {
  it("reads WAV, MP3 (counted frames and Xing), OGG and FLAC lengths", () => {
    // WAV: 1.5 s of 16-bit mono at 8 kHz.
    const n = 12000;
    const wav = Buffer.alloc(44 + n * 2);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(36 + n * 2, 4);
    wav.write("WAVEfmt ", 8, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(n * 2, 40);
    expect(audioDuration(wav)).toBe(1.5);

    // MP3: 100 MPEG-1 layer III frames, 128 kbps, 44.1 kHz, after an ID3v2 tag (1152 samples per frame).
    const frame = (pad: number) => {
      const f = Buffer.alloc(417 + pad);
      f[0] = 0xff;
      f[1] = 0xfb;
      f[2] = 0x90 | (pad << 1);
      f[3] = 0x44;
      return f;
    };
    const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]);
    const frames = Array.from({ length: 100 }, (_, i) => frame(i % 3 === 0 ? 1 : 0));
    expect(audioDuration(Buffer.concat([id3, ...frames]))).toBeCloseTo((100 * 1152) / 44100, 2);
    // Same stream with an "Info" header saying 250 frames wins over counting.
    const info = frame(0);
    info.write("Info", 4 + 32, "ascii");
    info.writeUInt32BE(1, 4 + 32 + 4);
    info.writeUInt32BE(250, 4 + 32 + 8);
    expect(audioDuration(Buffer.concat([info, ...frames]))).toBeCloseTo((250 * 1152) / 44100, 2);

    // OGG Vorbis: identification header (48 kHz) and a last page at granule 96000 → 2 s.
    const page = (granule: number, body: Buffer) => {
      const h = Buffer.alloc(27 + 1);
      h.write("OggS", 0, "ascii");
      h.writeBigUInt64LE(BigInt(granule), 6);
      h[26] = 1;
      h[27] = body.length;
      return Buffer.concat([h, body]);
    };
    const ident = Buffer.alloc(30);
    ident[0] = 1;
    ident.write("vorbis", 1, "ascii");
    ident.writeUInt32LE(48000, 12);
    expect(audioDuration(Buffer.concat([page(0, ident), page(96000, Buffer.alloc(4))]))).toBe(2);

    // FLAC: STREAMINFO with 44.1 kHz and 88200 samples → 2 s.
    const flac = Buffer.alloc(8 + 34);
    flac.write("fLaC", 0, "ascii");
    flac[4] = 0x80;
    flac[7] = 34;
    const rate = 44100;
    flac[8 + 10] = (rate >> 12) & 0xff;
    flac[8 + 11] = (rate >> 4) & 0xff;
    flac[8 + 12] = (rate & 0x0f) << 4;
    flac.writeUInt32BE(88200, 8 + 14);
    expect(audioDuration(flac)).toBe(2);
    expect(audioDuration(Buffer.from("not audio"))).toBe(0);
  });
});

describe("meshes and weights", () => {
  async function rig() {
    const t = await project();
    const file = png(path.join(t.dir, "body.png"), 60, 200, (g) => {
      g.fillStyle = "#c33";
      g.fillRect(10, 0, 40, 200);
    });
    await t.call("import_image", { path: file, name: "body" });
    await t.call("add_bone", { name: "legs", rotation: 90, length: 100 });
    await t.call("add_bone", { name: "torso", y: 100, rotation: 90, length: 100 });
    await t.call("add_slot", { bone: "root", name: "body" });
    await t.call("add_region", { slot: "body", name: "body", image: "body", y: 100, width: 60, height: 200 });
    await t.call("trace_mesh", { slot: "body", maxHull: 16, interior: 4 });
    await t.call("auto_weights", { slot: "body", attachment: "body", bones: ["legs", "torso"], maxInfluences: 2 });
    return t;
  }

  it("re-traces a weighted mesh and binds it to the same bones", async () => {
    const { call, doc } = await rig();
    const r = await call("trace_mesh", { slot: "body", attachment: "body", maxHull: 40, interior: 6, tolerance: 1 });
    expect(r.retraced).toBe(true);
    expect([...(r.boundTo as string[])].sort()).toEqual(["legs", "torso"]);
    const d = await doc();
    const slotId = d.skeleton.slots.find((s: { name: string }) => s.name === "body").id;
    const mesh = d.skeleton.skins[0].attachments[slotId].body;
    expect(mesh.type).toBe("mesh");
    expect(mesh.weights).toHaveLength(mesh.vertices.length / 2);
    // Still where the image was: x within the 60 px region around 0, y from 0 to 200.
    const ys = mesh.vertices.filter((_: number, i: number) => i % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(5);
    expect(Math.max(...ys)).toBeGreaterThan(195);
  });

  it("set_weights_in_area pins everything below a line to one bone, with a soft edge", async () => {
    const { call, doc } = await rig();
    const r = await call("set_weights_in_area", { slot: "body", attachment: "body", area: { yMax: 60 }, influences: [{ bone: "legs", weight: 1 }], blend: 30 });
    expect(r.vertices).toBeGreaterThan(0);
    const d = await doc();
    const legs = d.skeleton.bones.find((b: { name: string }) => b.name === "legs").id;
    const slotId = d.skeleton.slots.find((s: { name: string }) => s.name === "body").id;
    const mesh = d.skeleton.skins[0].attachments[slotId].body;
    const inst = await import("@openbone/runtime").then(({ OpenBoneInstance }) => new OpenBoneInstance(d));
    inst.skeleton.updateWorldTransform();
    const worldY = (v: number) =>
      mesh.weights[v].reduce((s: number, i: { bone: string; x: number; y: number; weight: number }) => {
        const m = inst.skeleton.bones.find((b) => b.data.id === i.bone)!.world;
        return s + (m.c * i.x + m.d * i.y + m.y) * i.weight;
      }, 0);
    for (let v = 0; v < mesh.weights.length; v++) {
      const y = worldY(v);
      const share = mesh.weights[v].find((i: { bone: string }) => i.bone === legs)?.weight ?? 0;
      if (y < 59) expect(share).toBeCloseTo(1, 3);
    }
    await expect(call("set_weights_in_area", { slot: "body", attachment: "body", area: {}, influences: [{ bone: "legs", weight: 1 }] })).rejects.toThrow(/at least one/);
  });
});

describe("single-frame export with a state machine", () => {
  it("runs the steps up to the frame (a trigger before the time takes effect)", async () => {
    const { ProjectSession } = await import("../src/session.ts");
    const { exportFile } = await import("../src/export.ts");
    const { inflateSync } = await import("node:zlib");
    const s = new ProjectSession();
    s.autosave = false;
    await s.open(path.resolve(__dirname, "../../../conformance/fixtures/interactive.obone"));
    const { createQuickJsHost } = await import("@openbone/scripting");
    const quickjs = await createQuickJsHost({ timeoutMs: 50 });
    const host = async () => quickjs;
    const run = (fire: boolean) => [{ advance: 0.2 }, { ...(fire ? { fire: ["pressed"] } : {}), advance: 1 }];
    const opts = { stateMachine: "main", fps: 10, scale: 0.5 } as const;
    const pixels = async (bytes: Uint8Array) => {
      const img = await loadImage(Buffer.from(bytes));
      const c = createCanvas(img.width, img.height);
      c.getContext("2d").drawImage(img, 0, 0);
      return Buffer.from(c.getContext("2d").getImageData(0, 0, img.width, img.height).data);
    };
    const single = await pixels((await exportFile(s, { format: "png", ...opts, steps: run(true), time: 0.6 }, host)).bytes);
    const quiet = await pixels((await exportFile(s, { format: "png", ...opts, steps: run(false), time: 0.6 }, host)).bytes);
    expect(single.equals(quiet)).toBe(false); // the trigger at 0.2 s changed the pose at 0.6 s
    // Same as frame 7 (t = 0.6 s) of a sequence with the same steps.
    const zip = Buffer.from((await exportFile(s, { format: "png", ...opts, steps: run(true), sequence: true, duration: 0.7 }, host)).bytes);
    const name = "interactive_0007.png";
    let p = 0;
    let frame: Buffer | null = null;
    while (zip.readUInt32LE(p) === 0x04034b50) {
      const method = zip.readUInt16LE(p + 8);
      const size = zip.readUInt32LE(p + 18);
      const n = zip.readUInt16LE(p + 26);
      const extra = zip.readUInt16LE(p + 28);
      const data = zip.subarray(p + 30 + n + extra, p + 30 + n + extra + size);
      if (zip.toString("utf8", p + 30, p + 30 + n) === name) frame = method === 8 ? inflateSync(data, { finishFlush: 2 }) : data;
      p += 30 + n + extra + size;
    }
    expect(frame).not.toBeNull();
    expect((await pixels(frame!)).equals(single)).toBe(true);
  }, 60_000);
});

describe("export_file embed", () => {
  it("writes a self-contained .obone with every image and sound inside", async () => {
    const { call, dir } = await project();
    await call("import_image", { path: png(path.join(dir, "a.png"), 8, 8, (g) => g.fillRect(0, 0, 8, 8)), name: "a" });
    const out = path.join(dir, "copy", "t.obone");
    mkdirSync(path.dirname(out));
    const r = await call("export_file", { format: "obone", embed: true, out });
    expect(r.text).toMatch(/images and audio embedded/);
    const saved = JSON.parse(readFileSync(out, "utf8"));
    expect(saved.images[0].src).toMatch(/^data:image\/png;base64,/);
  });
});

describe("PNG metadata", () => {
  it("imports and traces PNGs that carry large metadata chunks (C2PA content credentials)", async () => {
    const { call, dir } = await project();
    const plain = readFileSync(png(path.join(dir, "p.png"), 40, 40, (g) => {
      g.fillStyle = "#123456";
      g.fillRect(5, 5, 30, 30);
    }));
    // Insert a 300 KB "caBX" chunk right after IHDR, as generated art from content-credential tools has.
    const ihdrEnd = 8 + 12 + plain.readUInt32BE(8);
    const body = Buffer.alloc(300_000, 7);
    const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from("caBX", "latin1"), body, Buffer.alloc(4)]);
    chunk.writeUInt32BE(body.length, 0);
    const file = path.join(dir, "c2pa.png");
    writeFileSync(file, Buffer.concat([plain.subarray(0, ihdrEnd), chunk, plain.subarray(ihdrEnd)]));
    expect(await call("import_image", { path: file, name: "c2pa" })).toMatchObject({ width: 40, height: 40 });
    await call("add_slot", { bone: "root", name: "s" });
    await call("add_region", { slot: "s", name: "r", image: "c2pa" });
    expect((await call("trace_mesh", { slot: "s", attachment: "r", interior: 0 })).outline).toBeGreaterThanOrEqual(4);
    const r = await call("process_image", { input: file, out: "c2pa-trim.png", ops: [{ op: "trim" }] });
    expect(r).toMatchObject({ width: 30, height: 30 });
  });
});

describe("process_image", () => {
  it("keys out a flat background, trims, feathers and imports with the box it came from", async () => {
    const { call, dir, doc } = await project();
    const src = png(path.join(dir, "art.png"), 100, 80, (g) => {
      g.fillStyle = "#b6b5b5";
      g.fillRect(0, 0, 100, 80);
      g.fillStyle = "#2a8f3c";
      g.fillRect(30, 20, 40, 30);
    });
    const r = await call("process_image", { input: src, out: "art-cut.png", ops: [{ op: "keyColor" }, { op: "trim" }, { op: "featherEdges", left: 4, right: 4 }], importAs: "art" });
    expect(r.width).toBe(40);
    expect(r.height).toBe(30);
    expect(r.box).toEqual({ x: 30, y: 20, width: 40, height: 30 });
    const img = await loadImage(readFileSync(path.join(dir, "art-cut.png")));
    const c = createCanvas(img.width, img.height);
    c.getContext("2d").drawImage(img, 0, 0);
    const px = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
    expect(px[(15 * 40 + 20) * 4 + 3]).toBe(255); // middle: opaque green
    expect(px[(15 * 40 + 0) * 4 + 3]).toBe(0); // feathered left edge
    expect((await doc()).images.find((i: { name: string }) => i.name === "art")).toMatchObject({ width: 40, height: 30 });
  });

  it("cuts an object out by comparing with a painted-out copy, and replaces an image in place", async () => {
    const { call, dir, doc } = await project();
    const scene = (withTree: boolean) => (g: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => {
      g.fillStyle = "#6fa0d8";
      g.fillRect(0, 0, 120, 90);
      if (withTree) {
        g.fillStyle = "#2f5d2a";
        g.fillRect(70, 10, 30, 50);
      }
    };
    const full = png(path.join(dir, "full.png"), 120, 90, scene(true));
    png(path.join(dir, "plate.png"), 120, 90, scene(false));
    await call("import_image", { path: png(path.join(dir, "old.png"), 10, 10, () => {}), name: "tree" });
    const r = await call("process_image", { input: full, out: "tree.png", ops: [{ op: "differenceMatte", other: "plate.png" }, { op: "trim" }], replace: "tree" });
    // The cleanup filters grow the cut by a couple of pixels (background over the matching plate: invisible).
    const box = r.box as { x: number; y: number; width: number; height: number };
    expect(Math.abs(box.x - 70)).toBeLessThanOrEqual(3);
    expect(Math.abs(box.y - 10)).toBeLessThanOrEqual(3);
    expect(Math.abs(box.width - 30)).toBeLessThanOrEqual(6);
    expect(Math.abs(box.height - 50)).toBeLessThanOrEqual(6);
    const img = (await doc()).images.find((i: { name: string }) => i.name === "tree");
    expect(img.src).toBe("tree.png");
    expect(img.width).toBe(r.width);
  });
});
