import { z } from "zod";
import { get, getAttachment, newId } from "../document.ts";
import type { AnimationData, Curve, Key, OpenBoneDocument, Timeline } from "../types.ts";
import { BONE_PROPERTIES, CONSTRAINT_PROPERTIES } from "../types.ts";
import { EASINGS, curve as curveSchema, defineOp, hex, optId, ref } from "./registry.ts";

const curveIn = z
  .union([curveSchema, z.enum(["easeIn", "easeOut", "easeInOut", "backOut"])])
  .default("linear")
  .transform((c): Curve => (typeof c === "string" && c in EASINGS ? EASINGS[c] : (c as Curve)));

const target = z
  .enum(["bone", "slot", "ik", "transform", "path", "physics", "deform", "drawOrder"])
  .describe("What is animated: bone property, slot color/attachment, constraint (ik/transform/path/physics) values, mesh/path deform, draw order");

const keyValue = z.union([z.number(), z.string(), z.null(), z.array(z.number()), z.array(z.string())]);

const PROPS: Record<string, string[]> = {
  bone: BONE_PROPERTIES,
  slot: ["color", "attachment"],
  ik: CONSTRAINT_PROPERTIES.ik,
  transform: CONSTRAINT_PROPERTIES.transform,
  path: CONSTRAINT_PROPERTIES.path,
  physics: CONSTRAINT_PROPERTIES.physics,
  deform: ["offsets"],
  drawOrder: ["order"],
};

function resolveTimeline(
  doc: OpenBoneDocument,
  anim: AnimationData,
  a: { target: string; id?: string; property?: string; attachment?: string },
  create: boolean,
): Timeline | undefined {
  let id = "skeleton";
  let attachment: string | undefined;
  const property = a.property ?? PROPS[a.target][0];
  if (!PROPS[a.target].includes(property))
    throw new Error(`Property "${property}" invalid for ${a.target}. Use one of: ${PROPS[a.target].join(", ")}`);
  switch (a.target) {
    case "bone":
      id = get.bone(doc, need(a.id, "id (bone)")).id;
      break;
    case "slot":
      id = get.slot(doc, need(a.id, "id (slot)")).id;
      break;
    case "ik":
    case "transform":
    case "path":
    case "physics":
      id = get[a.target](doc, need(a.id, `id (${a.target} constraint)`)).id;
      break;
    case "deform": {
      const slot = get.slot(doc, need(a.id, "id (slot)"));
      id = slot.id;
      attachment = need(a.attachment, "attachment");
      const name = attachment;
      const att = getAttachment(doc, id, name) ?? doc.skeleton.skins.map((k) => k.attachments[id]?.[name]).find(Boolean);
      if (!att || (att.type !== "mesh" && att.type !== "path")) throw new Error("Deform keys need a mesh or path attachment");
      break;
    }
  }
  let tl = anim.timelines.find(
    (t) =>
      t.target === a.target &&
      t.id === id &&
      t.property === property &&
      (t.target !== "deform" || t.attachment === attachment),
  );
  if (!tl && create) {
    tl = { target: a.target, id, property, keys: [], ...(attachment ? { attachment } : {}) } as Timeline;
    anim.timelines.push(tl);
  }
  return tl;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

function checkValue(tl: Timeline, value: unknown) {
  const ok =
    tl.target === "bone" || tl.target === "ik" || tl.target === "transform" || tl.target === "path" || tl.target === "physics"
      ? typeof value === "number"
      : tl.target === "slot" && tl.property === "color"
        ? typeof value === "string" && hex.safeParse(value).success
        : tl.target === "slot"
          ? typeof value === "string" || value === null
          : Array.isArray(value);
  if (!ok) throw new Error(`Invalid value ${JSON.stringify(value)} for ${tl.target}.${tl.property}`);
}

function upsertKey(tl: Timeline, key: Key<unknown>) {
  checkValue(tl, key.value);
  const keys = tl.keys as Key<unknown>[];
  const i = keys.findIndex((k) => Math.abs(k.time - key.time) < 1e-6);
  if (i >= 0) keys[i] = key;
  else {
    keys.push(key);
    keys.sort((p, q) => p.time - q.time);
  }
}

defineOp({
  name: "createAnimation",
  group: "animation",
  description: "Create an empty animation. Duration 0 means 'until the last key'.",
  schema: z.object({ id: optId, name: z.string(), duration: z.number().min(0).default(0) }),
  apply(doc, a) {
    if (doc.animations.some((x) => x.name === a.name)) throw new Error(`Animation "${a.name}" already exists`);
    const id = (a.id ??= newId("anim"));
    doc.animations.push({ id, name: a.name, duration: a.duration, timelines: [], events: [] });
    return { id };
  },
});

defineOp({
  name: "updateAnimation",
  group: "animation",
  description: "Rename an animation or change its duration.",
  schema: z.object({ animation: ref("Animation"), name: z.string().optional(), duration: z.number().min(0).optional() }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    if (a.name) anim.name = a.name;
    if (a.duration !== undefined) anim.duration = a.duration;
    return {};
  },
});

defineOp({
  name: "deleteAnimation",
  group: "animation",
  description: "Delete an animation (state machine states using it are cleared).",
  schema: z.object({ animation: ref("Animation") }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    doc.animations = doc.animations.filter((x) => x !== anim);
    for (const sm of doc.stateMachines)
      for (const l of sm.layers)
        for (const s of l.states) {
          if (s.animation === anim.id) s.animation = undefined;
          if (s.blend) s.blend = s.blend.filter((e) => e.animation !== anim.id);
        }
    return {};
  },
});

defineOp({
  name: "setKeys",
  group: "animation",
  description:
    "Set one or more keyframes on a timeline (absolute values). Examples: bone rotation {target:'bone', id:'arm', property:'rotation', keys:[{time:0,value:0},{time:0.5,value:45,curve:'easeInOut'}]}; path constraint {target:'path', id:'tail-path', property:'position', keys:[...]}; slot color value '#ff0000'; slot attachment value 'eyes-closed' or null; deform value = flat offsets per vertex; drawOrder value = slot ids/names back-to-front.",
  schema: z.object({
    animation: ref("Animation"),
    target,
    id: z.string().optional().describe("Bone/slot/constraint id or name (not needed for drawOrder)"),
    property: z
      .string()
      .optional()
      .describe(
        `bone: ${BONE_PROPERTIES.join("|")}; slot: color|attachment; ${Object.entries(CONSTRAINT_PROPERTIES)
          .map(([k, v]) => `${k}: ${v.join("|")}`)
          .join("; ")}`,
      ),
    attachment: z.string().optional().describe("Mesh attachment name (deform only)"),
    keys: z.array(z.object({ time: z.number().min(0), value: keyValue, curve: curveIn })).min(1),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const tl = resolveTimeline(doc, anim, a, true)!;
    for (const k of a.keys) {
      let value = k.value;
      if (tl.target === "drawOrder") value = (value as string[]).map((r) => get.slot(doc, r).id);
      upsertKey(tl, { time: k.time, value, curve: k.curve });
    }
    return { timeline: `${tl.target}:${tl.id}:${tl.property}`, keys: tl.keys.length };
  },
});

defineOp({
  name: "deleteKey",
  group: "animation",
  description: "Delete the keyframe at `time` from a timeline (removes the timeline when empty).",
  schema: z.object({
    animation: ref("Animation"),
    target,
    id: z.string().optional(),
    property: z.string().optional(),
    attachment: z.string().optional(),
    time: z.number(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const tl = resolveTimeline(doc, anim, a, false);
    if (!tl) throw new Error("Timeline not found");
    (tl as { keys: Key<unknown>[] }).keys = (tl.keys as Key<unknown>[]).filter((k) => Math.abs(k.time - a.time) > 1e-6);
    if (tl.keys.length === 0) anim.timelines = anim.timelines.filter((t) => t !== tl);
    return {};
  },
});

defineOp({
  name: "moveKey",
  group: "animation",
  description: "Move a keyframe to a new time (and optionally change its curve).",
  schema: z.object({
    animation: ref("Animation"),
    target,
    id: z.string().optional(),
    property: z.string().optional(),
    attachment: z.string().optional(),
    time: z.number(),
    newTime: z.number().min(0).optional(),
    curve: curveIn.optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const tl = resolveTimeline(doc, anim, a, false);
    const key = (tl?.keys as Key<unknown>[] | undefined)?.find((k) => Math.abs(k.time - a.time) < 1e-6);
    if (!tl || !key) throw new Error("Key not found");
    if (a.curve !== undefined) key.curve = a.curve;
    if (a.newTime !== undefined) {
      (tl as { keys: Key<unknown>[] }).keys = (tl.keys as Key<unknown>[]).filter((k) => k !== key || false);
      upsertKey(tl, { ...key, time: a.newTime });
    }
    return {};
  },
});

defineOp({
  name: "deleteTimeline",
  group: "animation",
  description: "Remove a whole timeline (all keys for that property) from an animation.",
  schema: z.object({
    animation: ref("Animation"),
    target,
    id: z.string().optional(),
    property: z.string().optional(),
    attachment: z.string().optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const tl = resolveTimeline(doc, anim, a, false);
    anim.timelines = anim.timelines.filter((t) => t !== tl);
    return {};
  },
});

// ---------------- Events ----------------

defineOp({
  name: "addEvent",
  group: "animation",
  description: "Define a named event (fired from animation keys or listeners, delivered to scripts and the host app).",
  schema: z.object({
    id: optId,
    name: z.string(),
    int: z.number().int().default(0),
    float: z.number().default(0),
    string: z.string().default(""),
    audio: z.string().optional(),
  }),
  apply(doc, a) {
    if (doc.events.some((e) => e.name === a.name)) throw new Error(`Event "${a.name}" already exists`);
    const id = (a.id ??= newId("evt"));
    doc.events.push({ id, name: a.name, int: a.int, float: a.float, string: a.string, ...(a.audio ? { audio: a.audio } : {}) });
    return { id };
  },
});

defineOp({
  name: "addEventKey",
  group: "animation",
  description: "Fire an event at a time in an animation (optionally overriding its payload). Creates the event if needed.",
  schema: z.object({
    animation: ref("Animation"),
    event: z.string(),
    time: z.number().min(0),
    int: z.number().int().optional(),
    float: z.number().optional(),
    string: z.string().optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    let ev = doc.events.find((e) => e.id === a.event || e.name === a.event);
    if (!ev) {
      ev = { id: newId("evt"), name: a.event, int: 0, float: 0, string: "" };
      doc.events.push(ev);
    }
    const key = { time: a.time, event: ev.id, ...(a.int !== undefined ? { int: a.int } : {}), ...(a.float !== undefined ? { float: a.float } : {}), ...(a.string !== undefined ? { string: a.string } : {}) };
    anim.events = anim.events.filter((k) => !(k.event === ev.id && Math.abs(k.time - a.time) < 1e-6));
    anim.events.push(key);
    anim.events.sort((p, q) => p.time - q.time);
    return { event: ev.id };
  },
});

defineOp({
  name: "deleteEventKey",
  group: "animation",
  description: "Remove an event key from an animation.",
  schema: z.object({ animation: ref("Animation"), event: ref("Event"), time: z.number() }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const ev = get.event(doc, a.event);
    anim.events = anim.events.filter((k) => !(k.event === ev.id && Math.abs(k.time - a.time) < 1e-6));
    return {};
  },
});
