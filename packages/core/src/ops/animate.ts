import { z } from "zod";
import { get, getAttachment, newId } from "../document.ts";
import type { AnimationData, Curve, Key, OpenBoneDocument, Timeline } from "../types.ts";
import { BONE_PROPERTIES, CONSTRAINT_PROPERTIES, PARTICLE_PROPERTIES } from "../types.ts";
import { EASINGS, curve as curveSchema, defineOp, hex, optId, ref } from "./registry.ts";

const curveIn = z
  .union([curveSchema, z.enum(["easeIn", "easeOut", "easeInOut", "backOut"])])
  .default("linear")
  .transform((c): Curve => (typeof c === "string" && c in EASINGS ? EASINGS[c] : (c as Curve)));

const target = z
  .enum(["bone", "slot", "ik", "transform", "path", "physics", "particles", "deform", "sequence", "drawOrder"])
  .describe("What is animated: bone property, slot color/attachment, constraint (ik/transform/path/physics) values, particle emitter (id = slot; emitting true/false, rate), mesh/path deform, sequence frame, draw order");

const keyValue = z.union([z.boolean(), z.number(), z.string(), z.null(), z.array(z.number()), z.array(z.string())]);

const PROPS: Record<string, string[]> = {
  bone: BONE_PROPERTIES,
  slot: ["color", "attachment", "dark"],
  ik: CONSTRAINT_PROPERTIES.ik,
  transform: CONSTRAINT_PROPERTIES.transform,
  path: CONSTRAINT_PROPERTIES.path,
  physics: CONSTRAINT_PROPERTIES.physics,
  particles: PARTICLE_PROPERTIES,
  deform: ["offsets"],
  sequence: ["frame"],
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
    case "particles":
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
    case "sequence": {
      const slot = get.slot(doc, need(a.id, "id (slot)"));
      id = slot.id;
      attachment = need(a.attachment, "attachment");
      const name = attachment;
      const att = getAttachment(doc, id, name) ?? doc.skeleton.skins.map((k) => k.attachments[id]?.[name]).find(Boolean);
      if (!att || att.type !== "sequence") throw new Error("Sequence frame keys need a sequence attachment");
      break;
    }
  }
  let tl = anim.timelines.find(
    (t) =>
      t.target === a.target &&
      t.id === id &&
      t.property === property &&
      ((t.target !== "deform" && t.target !== "sequence") || t.attachment === attachment),
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
    tl.target === "particles"
      ? tl.property === "emitting"
        ? typeof value === "boolean"
        : typeof value === "number"
      : tl.target === "bone" || tl.target === "sequence" || tl.target === "ik" || tl.target === "transform" || tl.target === "path" || tl.target === "physics"
      ? typeof value === "number"
      : tl.target === "slot" && (tl.property === "color" || tl.property === "dark")
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
  description:
    "Rename an animation, change its duration, mark whether it is exported (export: false keeps a helper animation out of exports unless picked), or give it a colour for the editor's lists (color: null removes it).",
  schema: z.object({
    animation: ref("Animation"),
    name: z.string().optional(),
    duration: z.number().min(0).optional(),
    export: z.boolean().optional(),
    color: z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).nullable().optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    if (a.name) {
      if (doc.animations.some((x) => x !== anim && x.name === a.name)) throw new Error(`Animation "${a.name}" already exists`);
      anim.name = a.name;
    }
    if (a.duration !== undefined) anim.duration = a.duration;
    if (a.export !== undefined) {
      if (a.export) delete anim.export;
      else anim.export = false;
    }
    if (a.color !== undefined) {
      if (a.color) anim.color = a.color;
      else delete anim.color;
    }
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
    if (doc.skeleton.sliders) {
      doc.skeleton.sliders = doc.skeleton.sliders.filter((s) => s.animation !== anim.id);
      if (!doc.skeleton.sliders.length) delete doc.skeleton.sliders;
    }
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
    "Set one or more keyframes on a timeline (absolute values). Examples: bone rotation {target:'bone', id:'arm', property:'rotation', keys:[{time:0,value:0},{time:0.5,value:45,curve:'easeInOut'}]}; path constraint {target:'path', id:'tail-path', property:'position', keys:[...]}; slot color value '#ff0000'; particle emitter {target:'particles', id:'exhaust', property:'emitting', keys:[{time:0,value:true},{time:1,value:false}]} or property 'rate' (numbers); slot attachment value 'eyes-closed' or null; deform value = flat offsets per vertex; sequence {target:'sequence', id:slot, attachment, property:'frame'} value = frame counter (use curve 'stepped' or linear to count through frames); drawOrder value = slot ids/names back-to-front.",
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
    attachment: z.string().optional().describe("Mesh/path attachment name (deform) or sequence attachment name (sequence)"),
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

// ---------------- Batch key editing (dopesheet selection: shift, scale, paste, delete) ----------------

/** Keys picked on one timeline: the timeline (as for setKeys) and the times of its keys. */
const keyPick = z.object({
  target,
  id: z.string().optional(),
  property: z.string().optional(),
  attachment: z.string().optional(),
  times: z.array(z.number()).min(1),
});
const eventPick = z.object({ event: z.string().describe("Event id or name"), time: z.number() });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

defineOp({
  name: "transformKeys",
  group: "animation",
  description:
    "Shift and/or scale picked keys in time (the dopesheet's move and scale): newTime = pivot + (time - pivot) * scale + offset, clamped at 0 and rounded to frames when `fps` is given. Moved keys replace keys already at their new time. Example: shift a walk's keys 0.25 s later {animation:'walk', keys:[{target:'bone', id:'leg', property:'rotation', times:[0,0.5]}], offset:0.25}; play twice as fast {…, scale:0.5, pivot:0}.",
  schema: z.object({
    animation: ref("Animation"),
    keys: z.array(keyPick).default([]),
    events: z.array(eventPick).default([]),
    offset: z.number().default(0),
    scale: z.number().positive().default(1),
    pivot: z.number().default(0),
    fps: z.number().positive().optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const map = (t: number) => {
      let n = Math.max(0, a.pivot + (t - a.pivot) * a.scale + a.offset);
      if (a.fps) n = Math.round(n * a.fps) / a.fps;
      return Math.round(n * 1e6) / 1e6;
    };
    let moved = 0;
    for (const pick of a.keys) {
      const tl = resolveTimeline(doc, anim, pick, false);
      if (!tl) throw new Error(`Timeline not found: ${pick.target} ${pick.id ?? ""} ${pick.property ?? ""}`);
      const keys = tl.keys as Key<unknown>[];
      const picked = keys.filter((k) => pick.times.some((t) => near(t, k.time)));
      const rest = keys.filter((k) => !picked.includes(k));
      (tl as { keys: Key<unknown>[] }).keys = rest;
      // In time order, so when two keys land on one frame the later one wins.
      for (const k of picked.sort((p, q) => p.time - q.time)) upsertKey(tl, { ...k, time: map(k.time) });
      moved += picked.length;
    }
    for (const e of a.events) {
      const ev = get.event(doc, e.event);
      const k = anim.events.find((x) => x.event === ev.id && near(x.time, e.time));
      if (!k) continue;
      const to = map(k.time);
      anim.events = anim.events.filter((x) => x === k || !(x.event === ev.id && near(x.time, to)));
      k.time = to;
      moved++;
    }
    anim.events.sort((p, q) => p.time - q.time);
    return { moved };
  },
});

defineOp({
  name: "pasteKeys",
  group: "animation",
  description:
    "Paste keys (e.g. copied from this or another animation) at time `at`: each key's time is relative to the start of the copy. Creates timelines as needed and replaces keys already at those times. Event keys paste the same way. Example: {animation:'run', at:0.5, keys:[{target:'bone', id:'head', property:'rotation', time:0, value:10}, {target:'bone', id:'head', property:'rotation', time:0.2, value:-5, curve:'easeInOut'}]}.",
  schema: z.object({
    animation: ref("Animation"),
    at: z.number().min(0).default(0),
    keys: z
      .array(
        z.object({
          target,
          id: z.string().optional(),
          property: z.string().optional(),
          attachment: z.string().optional(),
          time: z.number().min(0),
          value: keyValue,
          curve: curveIn,
        }),
      )
      .default([]),
    events: z.array(z.object({ event: z.string(), time: z.number().min(0), int: z.number().int().optional(), float: z.number().optional(), string: z.string().optional() })).default([]),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const at = (t: number) => Math.round((a.at + t) * 1e6) / 1e6;
    for (const k of a.keys) {
      const tl = resolveTimeline(doc, anim, k, true)!;
      let value = k.value;
      if (tl.target === "drawOrder") value = (value as string[]).map((r) => get.slot(doc, r).id);
      upsertKey(tl, { time: at(k.time), value, curve: k.curve });
    }
    for (const e of a.events) {
      const ev = get.event(doc, e.event);
      const time = at(e.time);
      anim.events = anim.events.filter((x) => !(x.event === ev.id && near(x.time, time)));
      anim.events.push({ time, event: ev.id, ...(e.int !== undefined ? { int: e.int } : {}), ...(e.float !== undefined ? { float: e.float } : {}), ...(e.string !== undefined ? { string: e.string } : {}) });
    }
    anim.events.sort((p, q) => p.time - q.time);
    return { keys: a.keys.length, events: a.events.length };
  },
});

defineOp({
  name: "deleteKeys",
  group: "animation",
  description: "Delete many picked keys at once (timelines left empty are removed). Same `keys` / `events` shape as transformKeys.",
  schema: z.object({ animation: ref("Animation"), keys: z.array(keyPick).default([]), events: z.array(eventPick).default([]) }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    let removed = 0;
    for (const pick of a.keys) {
      const tl = resolveTimeline(doc, anim, pick, false);
      if (!tl) continue;
      const before = tl.keys.length;
      (tl as { keys: Key<unknown>[] }).keys = (tl.keys as Key<unknown>[]).filter((k) => !pick.times.some((t) => near(t, k.time)));
      removed += before - tl.keys.length;
      if (!tl.keys.length) anim.timelines = anim.timelines.filter((t) => t !== tl);
    }
    for (const e of a.events) {
      const ev = get.event(doc, e.event);
      const before = anim.events.length;
      anim.events = anim.events.filter((k) => !(k.event === ev.id && near(k.time, e.time)));
      removed += before - anim.events.length;
    }
    return { removed };
  },
});
