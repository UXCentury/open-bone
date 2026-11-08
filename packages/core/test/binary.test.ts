import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, deserialize, deserializeBinary, isBinaryDocument, serializeBinary, validate } from "../src/index.ts";

const example = (n: string) => deserialize(fs.readFileSync(path.resolve(__dirname, `../../../examples/${n}.obone`), "utf8"));

/** Deep comparison that allows float32 rounding on non-integers. */
function close(a: unknown, b: unknown, at = "$"): void {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isInteger(a)) expect(b, at).toBe(a);
    else expect(Math.abs(a - b), at).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(a) * 1e-6));
    return;
  }
  if (Array.isArray(a)) {
    expect(Array.isArray(b), at).toBe(true);
    expect((b as unknown[]).length, at).toBe(a.length);
    a.forEach((x, i) => close(x, (b as unknown[])[i], `${at}[${i}]`));
    return;
  }
  if (a && typeof a === "object") {
    expect(Object.keys(b as object).sort(), at).toEqual(Object.keys(a).sort());
    for (const k of Object.keys(a)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    return;
  }
  expect(b, at).toEqual(a);
}

describe("binary documents (.obonb)", () => {
  it("round-trips both examples and is smaller than compact JSON", () => {
    for (const name of ["walker", "button"]) {
      const d = example(name);
      const bin = serializeBinary(d);
      expect(isBinaryDocument(bin)).toBe(true);
      const back = deserializeBinary(bin);
      close(d, back);
      expect(validate(back).filter((i) => i.level === "error")).toEqual([]);
      expect(bin.length).toBeLessThan(JSON.stringify(d).length);
    }
  });

  it("is lossless with float64 precision", () => {
    const d = example("walker");
    expect(deserializeBinary(serializeBinary(d, { precision: "float64" }))).toEqual(d);
  });

  it("keeps short decimals exact, negative and large integers, unicode and data URLs", () => {
    const s = new DocumentStore(createDocument("Ünïcødé 🦴"));
    s.apply("addBone", { name: "arm", x: -12, y: 0.42, rotation: 33.3, length: 1234567 });
    s.apply("addImage", { name: "px", src: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 });
    const back = deserializeBinary(serializeBinary(s.doc));
    expect(back).toEqual(s.doc);
  });

  it("rejects non-binary and truncated input", () => {
    expect(() => deserializeBinary(new TextEncoder().encode("{}"))).toThrow(/OBNB/);
    const bin = serializeBinary(example("button"));
    expect(() => deserializeBinary(bin.subarray(0, bin.length - 10))).toThrow(/Corrupt/);
  });
});
