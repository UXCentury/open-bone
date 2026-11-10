import { z } from "zod";
import { get, newId } from "../document.ts";
import {
  BONE_PROPERTIES,
  CONSTRAINT_PROPERTIES,
  type BindingProperty,
  type BindingTarget,
  type InputBinding,
  type OpenBoneDocument,
  type StateMachineData,
} from "../types.ts";
import { defineOp, hex, optId, ref } from "./registry.ts";
import { attTarget, placement, putAttachment } from "./rig.ts";

// ---------------- Text attachments ----------------

/** Full-width characters (CJK ideographs and punctuation, kana, Hangul, full-width forms, emoji) take about 1 em. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** Rough line width in ems: about 0.62 em per Latin character, 1 em per full-width one. */
const lineEms = (line: string) => {
  let ems = 0;
  for (const ch of line) ems += WIDE.test(ch) ? 1 : 0.62;
  return ems;
};

/** Rough box for text (no font metrics available here); renderers that rasterise text grow past it when the real text is wider. */
export function estimateTextBox(text: string, size: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(0.62, ...lines.map(lineEms));
  return { width: Math.ceil(longest * size + size * 0.4), height: Math.ceil(lines.length * size * 1.25) };
}

defineOp({
  name: "addText",
  group: "attachment",
  description:
    "Attach text to a slot. `text` is a template: {input} or {input:0.00} shows a state machine input (number patterns: 0.00 decimals, #,##0 thousands, leading + sign, trailing %, any other characters kept, e.g. {multiplier:0.00x} → 2.35x). The width x height box (estimated when omitted) is the alignment frame and hit area.",
  schema: z.object({
    ...attTarget,
    text: z.string().default("Text"),
    ...placement,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    font: z.string().default("sans-serif").describe("CSS font family"),
    size: z.number().positive().default(32),
    weight: z.number().int().min(100).max(900).default(400),
    color: hex.default("#ffffff"),
    align: z.enum(["left", "center", "right"]).default("center"),
    outline: hex.optional(),
    outlineWidth: z.number().min(0).optional(),
  }),
  apply(doc, a) {
    const { slot, skin, activate, name, ...rest } = a;
    const box = estimateTextBox(a.text, a.size);
    a.width ??= box.width;
    a.height ??= box.height;
    return putAttachment(doc, slot, skin, { type: "text", name: name ?? "text", ...rest, width: a.width, height: a.height }, activate);
  },
});

// ---------------- Input bindings ----------------

const TARGET_PROPERTIES: Record<BindingTarget, readonly BindingProperty[]> = {
  bone: BONE_PROPERTIES,
  slot: ["color", "alpha"],
  ...CONSTRAINT_PROPERTIES,
};

/** Properties a binding may drive on each kind of object. */
export const BINDING_PROPERTIES = TARGET_PROPERTIES;

function resolveObject(doc: OpenBoneDocument, target: BindingTarget, object: string): string {
  switch (target) {
    case "bone":
      return get.bone(doc, object).id;
    case "slot":
      return get.slot(doc, object).id;
    default:
      return get[target](doc, object).id;
  }
}

const out = z.union([z.number(), hex]);

function checkBinding(sm: StateMachineData, b: InputBinding) {
  const input = sm.inputs.find((i) => i.id === b.input)!;
  if (input.type !== "number" && input.type !== "bool") throw new Error(`Input "${input.name}" must be a number or bool input to drive a binding`);
  if (!TARGET_PROPERTIES[b.target].includes(b.property))
    throw new Error(`"${b.property}" cannot be bound on a ${b.target}. Use one of: ${TARGET_PROPERTIES[b.target].join(", ")}`);
  const wantHex = b.property === "color";
  for (const v of [b.outMin, b.outMax])
    if ((typeof v === "string") !== wantHex) throw new Error(wantHex ? "color bindings need hex outMin/outMax" : "outMin/outMax must be numbers");
}

defineOp({
  name: "addBinding",
  group: "interactivity",
  description:
    "Drive a bone, slot or constraint property from a number (or bool) input, every frame after animations: input [inMin, inMax] maps linearly (clamped) to [outMin, outMax]. Bone: rotation/x/y/scaleX/scaleY/shearX/shearY; slot: color (hex outputs) or alpha (0..1); constraints: their keyable values (ik mix, path position, ...). Example: altitude 0..100 → rocket bone y 0..300.",
  schema: z.object({
    stateMachine: ref("State machine"),
    id: optId,
    input: ref("Number input"),
    target: z.enum(["bone", "slot", "ik", "transform", "path", "physics"]),
    object: ref("Bone, slot or constraint"),
    property: z.string(),
    inMin: z.number().default(0),
    inMax: z.number().default(1),
    outMin: out,
    outMax: out,
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    sm.bindings ??= [];
    const id = (a.id ??= newId("bind"));
    const b: InputBinding = {
      id,
      input: get.input(sm, a.input).id,
      target: a.target,
      object: resolveObject(doc, a.target, a.object),
      property: a.property as BindingProperty,
      inMin: a.inMin,
      inMax: a.inMax,
      outMin: a.outMin,
      outMax: a.outMax,
    };
    checkBinding(sm, b);
    sm.bindings.push(b);
    return { id };
  },
});

defineOp({
  name: "updateBinding",
  group: "interactivity",
  description: "Change an input binding's input, target object, property or ranges.",
  schema: z.object({
    stateMachine: ref("State machine"),
    binding: z.string(),
    input: ref("Number input").optional(),
    target: z.enum(["bone", "slot", "ik", "transform", "path", "physics"]).optional(),
    object: ref("Bone, slot or constraint").optional(),
    property: z.string().optional(),
    inMin: z.number().optional(),
    inMax: z.number().optional(),
    outMin: out.optional(),
    outMax: out.optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const b = sm.bindings?.find((x) => x.id === a.binding);
    if (!b) throw new Error(`Binding "${a.binding}" not found`);
    const next: InputBinding = { ...b };
    if (a.input) next.input = get.input(sm, a.input).id;
    if (a.target) next.target = a.target;
    if (a.object || a.target) next.object = resolveObject(doc, next.target, a.object ?? b.object);
    if (a.property) next.property = a.property as BindingProperty;
    for (const k of ["inMin", "inMax", "outMin", "outMax"] as const) if (a[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = a[k];
    checkBinding(sm, next);
    Object.assign(b, next);
    return {};
  },
});

defineOp({
  name: "deleteBinding",
  group: "interactivity",
  description: "Delete an input binding.",
  schema: z.object({ stateMachine: ref("State machine"), binding: z.string() }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const before = sm.bindings?.length ?? 0;
    sm.bindings = (sm.bindings ?? []).filter((b) => b.id !== a.binding);
    if (sm.bindings.length === before) throw new Error(`Binding "${a.binding}" not found`);
    return {};
  },
});
