import { DocumentStore, createDocument } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";
import { describe, expect, it } from "vitest";
import { createQuickJsHost } from "../src/index.ts";

describe("QuickJS script host", () => {
  it("runs sandboxed scripts against the ob API", async () => {
    const s = new DocumentStore(createDocument());
    s.apply("addBone", { name: "head" });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "count", type: "number" });
    s.apply("addScript", {
      name: "counter",
      code: `function onUpdate(dt){ ob.setInput("count", ob.input("count") + 1); ob.setBone("head", {rotation: ob.input("count") * 10}); }
             function onEvent(e){ console.log("evt", e.name) }
             function poke(){ ob.emit("poked", {int: 7}) }
             const leak = typeof process === "undefined" && typeof window === "undefined" && typeof fetch === "undefined";
             ob.log("sandboxed", leak);`,
    });
    s.apply("attachScript", { stateMachine: "sm", script: "counter" });
    const host = await createQuickJsHost();
    const inst = new OpenBoneInstance(s.doc, { scriptHost: host });
    const sm = inst.useStateMachine();
    const logs: unknown[][] = [];
    sm.on("log", (a) => logs.push(a));
    sm.on("error", (e) => {
      throw e;
    });
    sm.advance(0.016);
    sm.advance(0.016);
    expect(sm.getInput("count")).toBe(2);
    expect(inst.skeleton.findBone("head")!.rotation).toBe(20);
    expect(logs[0]).toEqual(["sandboxed", true]);
  });

  it("aborts infinite loops and reports errors", async () => {
    const s = new DocumentStore(createDocument());
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addScript", { name: "bad", code: `function onUpdate(){ while(true){} }` });
    s.apply("attachScript", { stateMachine: "sm", script: "bad" });
    const inst = new OpenBoneInstance(s.doc, { scriptHost: await createQuickJsHost({ timeoutMs: 20 }) });
    const sm = inst.useStateMachine();
    const errors: Error[] = [];
    sm.on("error", (e) => errors.push(e));
    const t = Date.now();
    sm.advance(0.016);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(errors[0]?.message).toMatch(/interrupted/i);
  });
});
