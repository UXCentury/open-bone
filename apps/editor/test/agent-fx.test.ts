import { DocumentStore, createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { agentEffects, agentFlash, onStoreChange, opTargets } from "../src/agent-fx.ts";

function rig() {
  const store = new DocumentStore(createDocument("Rig"));
  const root = store.doc.skeleton.bones[0].id;
  store.apply("addBone", { name: "arm", parent: root, length: 40 });
  store.apply("addSlot", { name: "arm-slot", bone: "arm" });
  return store;
}

describe("agent effects", () => {
  it("finds the bones and slots an op names, by id or name, also inside nested arguments", () => {
    const store = rig();
    const arm = store.doc.skeleton.bones.find((b) => b.name === "arm")!;
    const slot = store.doc.skeleton.slots[0];
    expect(opTargets(store.doc, { bone: "arm", rotation: 30 })).toEqual([{ kind: "bone", id: arm.id }]);
    expect(opTargets(store.doc, { slot: slot.id })).toEqual([{ kind: "slot", id: slot.id }]);
    expect(opTargets(store.doc, { animation: "walk", keys: [{ target: { bone: arm.id } }] })).toEqual([{ kind: "bone", id: arm.id }]);
    expect(opTargets(store.doc, { name: "nothing here" })).toEqual([]);
  });

  it("lights up only what the agent changed, not your own edits", () => {
    const store = rig();
    const arm = store.doc.skeleton.bones.find((b) => b.name === "arm")!;
    const off = store.subscribe(onStoreChange);
    store.apply("updateBone", { bone: "arm", rotation: 10 });
    expect(agentEffects().some((f) => f.id === arm.id)).toBe(false);
    store.apply("updateBone", { bone: "arm", rotation: 20 }, "bridge");
    const fx = agentEffects().filter((f) => f.id === arm.id);
    expect(fx).toHaveLength(1);
    expect(fx[0].label).toMatch(/Update bone/);
    expect(agentFlash(arm.id)).toBe(true);
    off();
  });
});
