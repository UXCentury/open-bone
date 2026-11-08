import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, createZip, readZip } from "../src/index.ts";

/** Minimal ZIP writer with deflated entries and a folder entry (createZip only stores). */
function deflatedZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = e.name.endsWith("/") ? Buffer.alloc(0) : deflateRawSync(e.data);
    const method = e.name.endsWith("/") ? 0 : 8;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc32(e.data), 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(e.data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    parts.push(h, name, comp);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

describe("readZip", () => {
  it("reads stored archives written by createZip", async () => {
    const files = [
      { name: "fire_0001.png", data: new Uint8Array([1, 2, 3]) },
      { name: "fire_0002.png", data: new Uint8Array([4, 5]) },
    ];
    expect(await readZip(createZip(files))).toEqual(files);
  });
  it("inflates deflated entries and skips folders", async () => {
    const big = new Uint8Array(5000).map((_, i) => i % 7);
    const out = await readZip(deflatedZip([{ name: "frames/", data: new Uint8Array() }, { name: "frames/a_1.png", data: big }]));
    expect(out.map((e) => e.name)).toEqual(["frames/a_1.png"]);
    expect(out[0].data).toEqual(big);
  });
  it("rejects non-archives", async () => {
    await expect(readZip(new Uint8Array(40))).rejects.toThrow(/Not a ZIP/);
  });
});
