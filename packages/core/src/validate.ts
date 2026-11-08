import { getAttachment } from "./document.ts";
import type { OpenBoneDocument } from "./types.ts";

export interface Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}

/** Structural + referential checks. Returns an empty list when the document is sound. */
export function validate(d: OpenBoneDocument): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });
  if (d.format !== "openbone") err("format", "must be 'openbone'");
  const sk = d.skeleton;
  const boneIds = new Set<string>();
  sk.bones.forEach((b, i) => {
    if (boneIds.has(b.id)) err(`bones[${i}]`, `duplicate id ${b.id}`);
    if (b.parent && !boneIds.has(b.parent)) err(`bones[${i}]`, `parent ${b.parent} missing or after child`);
    boneIds.add(b.id);
  });
  if (!sk.bones.length) err("bones", "skeleton needs at least one bone");
  const slotIds = new Set(sk.slots.map((s) => s.id));
  const imageIds = new Set(d.images.map((i) => i.id));
  if (d.atlas) {
    const pages = new Map(d.atlas.pages.map((p) => [p.id, p]));
    const packed = new Set<string>();
    d.atlas.regions.forEach((r, i) => {
      const p = pages.get(r.page);
      if (!imageIds.has(r.image)) err(`atlas.regions[${i}]`, `image ${r.image} missing`);
      if (packed.has(r.image)) err(`atlas.regions[${i}]`, `image ${r.image} has two regions`);
      packed.add(r.image);
      if (!p) err(`atlas.regions[${i}]`, `page ${r.page} missing`);
      else if (r.x < 0 || r.y < 0 || r.x + r.width > p.width || r.y + r.height > p.height) err(`atlas.regions[${i}]`, "rect outside its page");
    });
    if (d.atlas.white && !pages.has(d.atlas.white.page)) err("atlas.white", `page ${d.atlas.white.page} missing`);
    d.images.forEach((img, i) => !img.src && !packed.has(img.id) && err(`images[${i}]`, `"${img.name}" has no src and no atlas region`));
  } else d.images.forEach((img, i) => !img.src && err(`images[${i}]`, `"${img.name}" has no src`));
  sk.slots.forEach((s, i) => {
    if (!boneIds.has(s.bone)) err(`slots[${i}]`, `bone ${s.bone} missing`);
    if (s.attachment && !getAttachment(d, s.id, s.attachment)) warn(`slots[${i}]`, `attachment "${s.attachment}" not in default skin`);
  });
  for (const skin of sk.skins)
    for (const [slotId, atts] of Object.entries(skin.attachments)) {
      if (!slotIds.has(slotId)) err(`skins.${skin.name}`, `unknown slot ${slotId}`);
      for (const a of Object.values(atts)) {
        if ((a.type === "region" || a.type === "mesh") && !imageIds.has(a.image))
          err(`skins.${skin.name}.${a.name}`, `image ${a.image} missing`);
        if (a.type === "clipping") {
          if (a.vertices.length < 6 || a.vertices.length % 2) err(`clipping ${a.name}`, "needs at least 3 points");
          if (a.end && !slotIds.has(a.end)) err(`clipping ${a.name}`, `end slot ${a.end} missing`);
        }
        if (a.type === "mesh") {
          if (a.uvs.length !== a.vertices.length) err(`mesh ${a.name}`, "uvs/vertices length mismatch");
          const n = a.vertices.length / 2;
          if (a.triangles.some((t) => t >= n)) err(`mesh ${a.name}`, "triangle index out of range");
          if (a.weights && a.weights.length !== n) err(`mesh ${a.name}`, "weights length mismatch");
          a.weights?.forEach((w) => w.forEach((x) => !boneIds.has(x.bone) && err(`mesh ${a.name}`, `weight bone ${x.bone} missing`)));
        }
      }
    }
  for (const c of [...sk.ik, ...sk.transform]) {
    if (!boneIds.has(c.target)) err(`constraint ${c.name}`, "target missing");
    for (const b of c.bones) if (!boneIds.has(b)) err(`constraint ${c.name}`, `bone ${b} missing`);
  }
  const animIds = new Set(d.animations.map((a) => a.id));
  const eventIds = new Set(d.events.map((e) => e.id));
  for (const a of d.animations) {
    for (const t of a.timelines) {
      if (t.target === "bone" && !boneIds.has(t.id)) err(`animation ${a.name}`, `bone ${t.id} missing`);
      if ((t.target === "slot" || t.target === "deform") && !slotIds.has(t.id)) err(`animation ${a.name}`, `slot ${t.id} missing`);
      for (let i = 1; i < t.keys.length; i++)
        if (t.keys[i].time < t.keys[i - 1].time) err(`animation ${a.name}`, "keys not sorted");
    }
    for (const e of a.events) if (!eventIds.has(e.event)) err(`animation ${a.name}`, `event ${e.event} missing`);
  }
  const scriptIds = new Set(d.scripts.map((s) => s.id));
  for (const sm of d.stateMachines) {
    const inputIds = new Set(sm.inputs.map((i) => i.id));
    for (const l of sm.layers) {
      const stateIds = new Set(l.states.map((s) => s.id));
      if (l.states.length && (!l.entry || !stateIds.has(l.entry))) warn(`${sm.name}/${l.name}`, "no valid entry state");
      for (const s of l.states) {
        if (s.type === "animation" && (!s.animation || !animIds.has(s.animation))) warn(`${sm.name}/${s.name}`, "state has no animation");
        if (s.type === "blend1d" && (!s.blendInput || !inputIds.has(s.blendInput))) err(`${sm.name}/${s.name}`, "blend input missing");
        s.scripts?.forEach((x) => !scriptIds.has(x) && err(`${sm.name}/${s.name}`, `script ${x} missing`));
      }
      for (const t of l.transitions) {
        if (t.from !== "@any" && !stateIds.has(t.from)) err(`${sm.name}/${l.name}`, `transition from missing state`);
        if (!stateIds.has(t.to)) err(`${sm.name}/${l.name}`, `transition to missing state`);
        for (const c of t.conditions) if (!inputIds.has(c.input)) err(`${sm.name}/${l.name}`, `condition input missing`);
      }
    }
    for (const li of sm.listeners) if (li.slot && !slotIds.has(li.slot)) err(`${sm.name} listener ${li.name}`, "slot missing");
  }
  return issues;
}
