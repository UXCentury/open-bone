import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDocument, exportDocument, DocumentStore, parseDocument, pickDocumentFont, readFontMeta, serializeBinary, splitFontFamilies, validate } from "../src/index.ts";

/** A minimal font file: a `name` table (family, full name) and an `OS/2` table (weight, italic bit). */
function fakeFont(family: string, weight: number, italic = false): Uint8Array {
  const utf16 = (s: string) => {
    const out: number[] = [];
    for (const ch of s) out.push(ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255);
    return out;
  };
  const strings = [utf16(family), utf16(`${family} Regular`)];
  const name: number[] = [];
  const u16 = (arr: number[], v: number) => arr.push((v >> 8) & 255, v & 255);
  u16(name, 0);
  u16(name, 2);
  u16(name, 6 + 12 * 2);
  let off = 0;
  [1, 4].forEach((id, i) => {
    u16(name, 3); // Windows
    u16(name, 1); // Unicode BMP
    u16(name, 0x409); // English
    u16(name, id);
    u16(name, strings[i].length);
    u16(name, off);
    off += strings[i].length;
  });
  for (const s of strings) name.push(...s);
  const os2 = new Array(96).fill(0);
  os2[4] = weight >> 8;
  os2[5] = weight & 255;
  os2[63] = italic ? 1 : 0;
  const tables: [string, number[]][] = [
    ["OS/2", os2],
    ["name", name],
  ];
  const out: number[] = [];
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  u32(0x00010000);
  out.push(0, tables.length, 0, 32, 0, 1, 0, 0);
  let pos = 12 + 16 * tables.length;
  for (const [tag, data] of tables) {
    for (const c of tag) out.push(c.charCodeAt(0));
    u32(0);
    u32(pos);
    u32(data.length);
    pos += data.length;
  }
  for (const [, data] of tables) out.push(...data);
  return new Uint8Array(out);
}

function docWithText(font: string) {
  const s = new DocumentStore(createDocument("F"));
  s.apply("addSlot", { name: "label", bone: "root" });
  s.apply("addText", { slot: "label", name: "t", text: "Hi", font });
  return s;
}

describe("embedded fonts", () => {
  it("splits CSS family lists", () => {
    expect(splitFontFamilies(`Noto Serif JP, 'Georgia' , "serif"`)).toEqual(["Noto Serif JP", "Georgia", "serif"]);
  });

  it("picks the first listed family the document has, nearest in weight", () => {
    const s = docWithText("Missing, Body Serif, serif");
    s.apply("addFont", { name: "BodySerif-Regular", family: "Body Serif", src: "fonts/r.otf", weight: 400 });
    s.apply("addFont", { name: "BodySerif-Bold", family: "Body Serif", src: "fonts/b.otf", weight: 700 });
    s.apply("addFont", { name: "Other", family: "Other", src: "fonts/o.otf" });
    expect(pickDocumentFont(s.doc, "Missing, body serif, serif", 400)?.name).toBe("BodySerif-Regular");
    expect(pickDocumentFont(s.doc, "Missing, Body Serif", 650)?.name).toBe("BodySerif-Bold");
    expect(pickDocumentFont(s.doc, "Georgia, serif", 400)).toBeNull();
  });

  it("reads family, weight and style from a font file", () => {
    expect(readFontMeta(fakeFont("Body Serif", 700, true))).toEqual({ family: "Body Serif", fullName: "Body Serif Regular", weight: 700, style: "italic" });
    expect(readFontMeta(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]))).toBeNull(); // WOFF2: compressed tables
  });

  it("keeps fonts through .obonb, prunes unused ones on export, warns about unused ones", () => {
    const s = docWithText("Body Serif, serif");
    const data = `data:font/otf;base64,${Buffer.from(fakeFont("Body Serif", 400)).toString("base64")}`;
    s.apply("addFont", { name: "BodySerif", family: "Body Serif", src: data });
    s.apply("addFont", { name: "Unused", family: "Unused", src: "fonts/u.otf" });
    const back = parseDocument(serializeBinary(s.doc));
    expect(back.fonts?.map((f) => [f.family, f.src.slice(0, 15)])).toEqual([
      ["Body Serif", "data:font/otf;b"],
      ["Unused", "fonts/u.otf"],
    ]);
    expect(validate(s.doc).filter((i) => i.path.startsWith("fonts"))).toEqual([{ level: "warning", path: "fonts[1]", message: '"Unused": no text uses family "Unused"' }]);
    const out = exportDocument(s.doc);
    expect(out.doc.fonts?.map((f) => f.name)).toEqual(["BodySerif"]);
    expect(out.stats.fonts).toBe(1);
  });

  it("updates and deletes fonts", () => {
    const s = docWithText("A");
    s.apply("addFont", { name: "a", family: "A", src: "a.otf" });
    s.apply("updateFont", { font: "a", weight: 700, family: "A Bold" });
    expect(s.doc.fonts?.[0]).toMatchObject({ family: "A Bold", weight: 700 });
    s.apply("deleteFont", { font: "a" });
    expect(s.doc.fonts).toBeUndefined();
  });
});

describe("trigger sound check", () => {
  const windswept = () => parseDocument(readFileSync(new URL("../../../examples/windswept.obone", import.meta.url)));
  const triggerWarnings = (doc: ReturnType<typeof windswept>) => validate(doc).filter((i) => i.message.includes("only makes a sound"));

  it("passes Windswept, whose trigger sounds play from their states", () => {
    expect(triggerWarnings(windswept())).toEqual([]);
  });

  it("warns when a trigger's sound lives only on the button that fires it (the old Windswept)", () => {
    const doc = windswept();
    const sm = doc.stateMachines[0];
    const gusting = sm.layers.flatMap((l) => l.states).find((s) => s.name === "gusting")!;
    const gust = gusting.sounds![0].sound;
    delete gusting.sounds;
    const button = sm.listeners.find((l) => l.name === "gust click")!;
    button.actions.unshift({ type: "playSound", sound: gust, volume: 0.9 });
    const w = triggerWarnings(doc);
    expect(w).toHaveLength(1);
    expect(w[0].path).toBe("scene listener gust click");
    expect(w[0].message).toContain('trigger "gust"');
    expect(w[0].message).toContain('"gusting"');
  });

  it("ignores listeners that fire no trigger", () => {
    const doc = windswept();
    for (const l of doc.stateMachines[0].listeners) l.actions = l.actions.filter((a) => a.type !== "fireTrigger");
    expect(triggerWarnings(doc)).toEqual([]);
  });
});
