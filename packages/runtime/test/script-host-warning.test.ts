import { readFileSync } from "node:fs";
import { deserialize } from "@openbone/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenBoneInstance } from "../src/index.ts";

const walker = () => deserialize(readFileSync(new URL("../../../examples/walker.obone", import.meta.url), "utf8"));

describe("documents with scripts and no script host", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns once per document when scripts would be skipped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = walker();
    expect(doc.scripts.length).toBeGreaterThan(0);
    const inst = new OpenBoneInstance(doc);
    inst.useStateMachine();
    inst.useStateMachine();
    new OpenBoneInstance(doc).useStateMachine();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/no scriptHost was given/);
  });

  it("stays quiet with scriptHost: null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new OpenBoneInstance(walker(), { scriptHost: null }).useStateMachine();
    expect(warn).not.toHaveBeenCalled();
  });
});
