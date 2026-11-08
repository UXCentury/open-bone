import { describe, expect, it } from "vitest";
import {
  DocumentStore,
  createDocument,
  deserializeBinary,
  formatNumber,
  formatTemplate,
  serializeBinary,
  templateInputs,
  validate,
} from "../src/index.ts";

describe("number formatting", () => {
  it.each([
    [2.349, "0.00", "2.35"],
    [2, "0.00", "2.00"],
    [2.3, "0.0#", "2.3"],
    [2.345, "0.0#", "2.35"],
    [2, "0.##", "2"],
    [1234567.891, "#,##0.00", "1,234,567.89"],
    [999, "#,##0", "999"],
    [-1234.5, "#,##0.0", "-1,234.5"],
    [5, "+0", "+5"],
    [-5, "+0", "-5"],
    [0.256, "0%", "26%"],
    [0.5, "#.00", ".50"],
    [7, "000", "007"],
    [1234.5, "$#,##0.00", "$1,234.50"],
    [2.35, "0.00x", "2.35x"],
    [-0.001, "0.00", "0.00"],
    [3.14159, "", "3.14159"],
  ])("%s with %j → %j", (v, pattern, want) => {
    expect(formatNumber(v, pattern)).toBe(want);
  });
});

describe("text templates", () => {
  const values: Record<string, number | string | boolean> = { multiplier: 2.349, name: "Ada", on: true, big: 12345.6 };
  const fill = (t: string) => formatTemplate(t, (n) => values[n]);

  it("fills inputs with optional number patterns", () => {
    expect(fill("{multiplier:0.00}x")).toBe("2.35x");
    expect(fill("Hi {name}!")).toBe("Hi Ada!");
    expect(fill("{on}")).toBe("true");
    expect(fill("{big:#,##0} pts")).toBe("12,346 pts");
    expect(fill("{multiplier}")).toBe("2.349");
  });

  it("keeps unknown names and escaped braces", () => {
    expect(fill("{missing:0.00}")).toBe("{missing:0.00}");
    expect(fill("{{multiplier}} = {multiplier:0.0}")).toBe("{multiplier} = 2.3");
    expect(fill("no template")).toBe("no template");
  });

  it("lists the inputs a template uses", () => {
    expect(templateInputs("{a:0.00} {b} {a} {{c}}")).toEqual(["a", "b"]);
  });
});

function crashDoc() {
  const s = new DocumentStore(createDocument("crash"));
  s.apply("addBone", { name: "rocket", length: 40 });
  s.apply("addSlot", { bone: "rocket", name: "label" });
  s.apply("createStateMachine", { name: "game" });
  s.apply("addInput", { stateMachine: "game", name: "multiplier", type: "number", default: 1 });
  return s;
}

describe("data ops", () => {
  it("adds a text attachment with an estimated box", () => {
    const s = crashDoc();
    s.apply("addText", { slot: "label", text: "{multiplier:0.00}x", size: 40, weight: 700, outline: "#000000", outlineWidth: 3 });
    const att = s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id].text;
    expect(att).toMatchObject({ type: "text", text: "{multiplier:0.00}x", size: 40, weight: 700, align: "center", font: "sans-serif" });
    if (att.type !== "text") throw new Error();
    expect(att.width).toBeGreaterThan(200);
    expect(att.height).toBe(50);
    s.apply("updateAttachment", { slot: "label", attachment: "text", props: { text: "x{multiplier}", align: "left" } });
    expect(att).toMatchObject({ text: "x{multiplier}", align: "left" });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("string inputs: default, update, conditions", () => {
    const s = crashDoc();
    s.apply("addInput", { stateMachine: "game", name: "phase", type: "string", default: "idle" });
    s.apply("addInput", { stateMachine: "game", name: "label", type: "string" });
    const sm = s.doc.stateMachines[0];
    expect(sm.inputs.find((i) => i.name === "label")!.default).toBe("");
    s.apply("updateInput", { stateMachine: "game", input: "phase", default: 3, name: "stage" });
    expect(sm.inputs.find((i) => i.name === "stage")!.default).toBe("3");
    s.apply("createAnimation", { name: "a" });
    s.apply("addState", { stateMachine: "game", animation: "a", name: "one" });
    s.apply("addState", { stateMachine: "game", animation: "a", name: "two" });
    s.apply("addTransition", { stateMachine: "game", from: "one", to: "two", conditions: [{ input: "stage", op: "==", value: "go" }] });
    expect(sm.layers[0].transitions[0].conditions[0].value).toBe("go");
    expect(() => s.apply("addTransition", { stateMachine: "game", from: "one", to: "two", conditions: [{ input: "stage", op: ">", value: "a" }] })).toThrow(/only supports/);
    expect(() => s.apply("addInput", { stateMachine: "game", name: "bad{name}", type: "string" })).toThrow();
  });

  it("onComplete is set, cleared and follows state deletion", () => {
    const s = crashDoc();
    s.apply("createAnimation", { name: "a" });
    s.apply("addState", { stateMachine: "game", animation: "a", name: "intro", loop: false });
    s.apply("addState", { stateMachine: "game", animation: "a", name: "main" });
    s.apply("updateState", { stateMachine: "game", state: "intro", onComplete: "main" });
    const [intro, main] = s.doc.stateMachines[0].layers[0].states;
    expect(intro.onComplete).toBe(main.id);
    s.apply("updateState", { stateMachine: "game", state: "intro", onComplete: null });
    expect(intro.onComplete).toBeUndefined();
    s.apply("addState", { stateMachine: "game", animation: "a", name: "outro", onComplete: "intro" });
    s.apply("deleteState", { stateMachine: "game", state: "intro" });
    expect(s.doc.stateMachines[0].layers[0].states.find((x) => x.name === "outro")!.onComplete).toBeUndefined();
  });

  it("bindings are validated and dropped with their input or object", () => {
    const s = crashDoc();
    s.apply("addBone", { name: "aim", x: 100 });
    s.apply("addIkConstraint", { name: "ik", bones: ["rocket"], target: "aim" });
    // A failed op restores a snapshot, so always read through s.doc.
    const sm = () => s.doc.stateMachines[0];
    const { id } = s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "rocket", property: "y", inMin: 1, inMax: 10, outMin: 0, outMax: 300 }) as { id: string };
    expect(sm().bindings[0]).toMatchObject({ id, target: "bone", object: s.doc.skeleton.bones.find((b) => b.name === "rocket")!.id, property: "y", outMax: 300 });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "label", property: "color", outMin: "#ffffff", outMax: "#ff0000" });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "ik", object: "ik", property: "mix", outMin: 0, outMax: 1 });
    expect(() => s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "rocket", property: "color", outMin: 0, outMax: 1 })).toThrow(/cannot be bound/);
    expect(() => s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "label", property: "color", outMin: 0, outMax: 1 })).toThrow(/hex/);
    s.apply("addInput", { stateMachine: "game", name: "msg", type: "string" });
    expect(() => s.apply("addBinding", { stateMachine: "game", input: "msg", target: "bone", object: "rocket", property: "x", outMin: 0, outMax: 1 })).toThrow(/number or bool/);
    s.apply("updateBinding", { stateMachine: "game", binding: id, property: "rotation", outMax: 90 });
    expect(sm().bindings[0]).toMatchObject({ property: "rotation", outMax: 90, outMin: 0 });
    expect(sm().bindings).toHaveLength(3);

    s.apply("deleteConstraint", { constraint: "ik" });
    expect(sm().bindings.map((b) => b.target)).toEqual(["bone", "slot"]);
    s.apply("deleteSlot", { slot: "label" });
    expect(sm().bindings.map((b) => b.target)).toEqual(["bone"]);
    s.apply("deleteBinding", { stateMachine: "game", binding: id });
    expect(sm().bindings).toEqual([]);
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "rocket", property: "x", outMin: 0, outMax: 1 });
    s.apply("deleteInput", { stateMachine: "game", input: "multiplier" });
    expect(sm().bindings).toEqual([]);
  });

  it("survives the binary format", () => {
    const s = crashDoc();
    s.apply("addText", { slot: "label", text: "{multiplier:0.00}x" });
    s.apply("addInput", { stateMachine: "game", name: "who", type: "string", default: "me" });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "label", property: "color", outMin: "#ffffff", outMax: "#ff0000" });
    const back = deserializeBinary(serializeBinary(s.doc));
    expect(back.stateMachines[0].bindings).toEqual(s.doc.stateMachines[0].bindings);
    expect(back.stateMachines[0].inputs).toEqual(s.doc.stateMachines[0].inputs);
    expect(back.skeleton.skins).toEqual(s.doc.skeleton.skins);
  });

  it("older documents get an empty bindings list", () => {
    const s = crashDoc();
    const raw = JSON.parse(JSON.stringify(s.doc));
    delete raw.stateMachines[0].bindings;
    expect(new DocumentStore(raw).doc.stateMachines[0].bindings).toEqual([]);
  });
});
