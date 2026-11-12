import { resolveSound } from "./audio.ts";
import { descendantIds, getAttachment } from "./document.ts";
import { usedFonts } from "./fonts.ts";
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
  (d.skeleton.sliders ?? []).forEach((sl, i) => {
    const where = `skeleton.sliders[${i}]`;
    if (!d.animations.some((a) => a.id === sl.animation)) err(where, `animation ${sl.animation} missing`);
    if (sl.bone && !d.skeleton.bones.some((b) => b.id === sl.bone)) err(where, `bone ${sl.bone} missing`);
    if (sl.input && !d.stateMachines.some((m) => m.inputs.some((x) => x.id === sl.input))) err(where, `input ${sl.input} missing`);
    if (!sl.bone && !sl.input) err(where, "no driver (bone or input)");
  });
  if (d.atlas) {
    const pages = new Map(d.atlas.pages.map((p) => [p.id, p]));
    const packed = new Set<string>();
    d.atlas.regions.forEach((r, i) => {
      const p = pages.get(r.page);
      if (!imageIds.has(r.image)) err(`atlas.regions[${i}]`, `image ${r.image} missing`);
      if (packed.has(r.image)) err(`atlas.regions[${i}]`, `image ${r.image} has two regions`);
      packed.add(r.image);
      if (!p) err(`atlas.regions[${i}]`, `page ${r.page} missing`);
      else {
        // A rotated region covers height × width on its page.
        const fw = r.rotated ? r.height : r.width;
        const fh = r.rotated ? r.width : r.height;
        if (r.x < 0 || r.y < 0 || r.x + fw > p.width || r.y + fh > p.height) err(`atlas.regions[${i}]`, "rect outside its page");
      }
    });
    if (d.atlas.white && !pages.has(d.atlas.white.page)) err("atlas.white", `page ${d.atlas.white.page} missing`);
    d.images.forEach((img, i) => !img.src && !packed.has(img.id) && err(`images[${i}]`, `"${img.name}" has no src and no atlas region`));
  } else d.images.forEach((img, i) => !img.src && err(`images[${i}]`, `"${img.name}" has no src`));
  sk.slots.forEach((s, i) => {
    if (!boneIds.has(s.bone)) err(`slots[${i}]`, `bone ${s.bone} missing`);
    if (s.attachment && !sk.skins.some((k) => k.attachments[s.id]?.[s.attachment!]))
      warn(`slots[${i}]`, `attachment "${s.attachment}" not in any skin`);
  });
  for (const skin of sk.skins)
    for (const [slotId, atts] of Object.entries(skin.attachments)) {
      if (!slotIds.has(slotId)) err(`skins.${skin.name}`, `unknown slot ${slotId}`);
      for (const a of Object.values(atts)) {
        if ((a.type === "region" || a.type === "mesh") && !imageIds.has(a.image))
          err(`skins.${skin.name}.${a.name}`, `image ${a.image} missing`);
        if (a.type === "sequence") {
          if (!a.frames.length) warn(`sequence ${a.name}`, "has no frames");
          a.frames.forEach((f, i) => !imageIds.has(f.image) && err(`sequence ${a.name}`, `frame ${i}: image ${f.image} missing`));
          if (!(a.fps > 0)) err(`sequence ${a.name}`, "fps must be positive");
          if (a.input && !d.stateMachines.some((sm) => sm.inputs.some((x) => x.id === a.input)))
            warn(`sequence ${a.name}`, `input ${a.input} missing`);
        }
        if (a.type === "particles") {
          if (a.look === "image" && (!a.image || !imageIds.has(a.image))) err(`particles ${a.name}`, `image ${a.image ?? "(none)"} missing`);
          if (!a.colors?.length) err(`particles ${a.name}`, "needs at least one colour stop");
        }
        if (a.type === "clipping") {
          if (a.vertices.length < 6 || a.vertices.length % 2) err(`clipping ${a.name}`, "needs at least 3 points");
          if (a.end && !slotIds.has(a.end)) err(`clipping ${a.name}`, `end slot ${a.end} missing`);
        }
        if (a.type === "boundingBox") {
          if (a.vertices.length < 6 || a.vertices.length % 2) warn(`bounding box ${a.name}`, "needs at least 3 points");
          if (a.weights && a.weights.length !== a.vertices.length / 2) err(`bounding box ${a.name}`, "weights length mismatch");
          a.weights?.forEach((w) => w.forEach((x) => !boneIds.has(x.bone) && err(`bounding box ${a.name}`, `weight bone ${x.bone} missing`)));
        }
        if (a.type === "path") {
          if (a.vertices.length < 12 || a.vertices.length % 6) err(`path ${a.name}`, "needs 6 numbers per knot and at least 2 knots");
          if (a.weights && a.weights.length !== a.vertices.length / 2) err(`path ${a.name}`, "weights length mismatch");
          a.weights?.forEach((w) => w.forEach((x) => !boneIds.has(x.bone) && err(`path ${a.name}`, `weight bone ${x.bone} missing`)));
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
  const boneIndex = new Map(sk.bones.map((b, i) => [b.id, i]));
  for (const c of sk.path ?? []) {
    const path = `path constraint ${c.name}`;
    const slot = sk.slots.find((s) => s.id === c.target);
    for (const b of c.bones) if (!boneIds.has(b)) err(path, `bone ${b} missing`);
    if (!slot) {
      err(path, `target slot ${c.target} missing`);
      continue;
    }
    for (let i = 1; i < c.bones.length; i++)
      if ((boneIndex.get(c.bones[i]) ?? 0) < (boneIndex.get(c.bones[i - 1]) ?? 0)) err(path, "bones must be listed parent before child");
    const att = getAttachment(d, slot.id, slot.attachment);
    if (!att || att.type !== "path") warn(path, `slot ${slot.name} does not show a path attachment in setup pose`);
    const chain = new Set<string>();
    for (const b of c.bones) if (boneIds.has(b)) for (const x of descendantIds(d, b)) chain.add(x);
    if (chain.has(slot.bone)) err(path, "the path's slot bone is moved by the constrained bones (cycle)");
    if (att?.type === "path" && att.weights?.some((w) => w.some((x) => chain.has(x.bone))))
      warn(path, "path is weighted to bones the constraint moves; the path will lag a frame behind");
  }
  for (const c of sk.physics ?? []) {
    const path = `physics constraint ${c.name}`;
    if (!boneIds.has(c.bone)) err(path, `bone ${c.bone} missing`);
    if (!(c.fps > 0)) err(path, "fps must be positive");
    if (!(c.mass > 0)) err(path, "mass must be positive");
  }
  const constraintIds = {
    ik: new Set(sk.ik.map((c) => c.id)),
    transform: new Set(sk.transform.map((c) => c.id)),
    path: new Set((sk.path ?? []).map((c) => c.id)),
    physics: new Set((sk.physics ?? []).map((c) => c.id)),
  };
  const allConstraintIds = new Set(Object.values(constraintIds).flatMap((x) => [...x]));
  for (const skin of sk.skins) {
    for (const b of skin.bones ?? []) if (!boneIds.has(b)) err(`skins.${skin.name}`, `skin bone ${b} missing`);
    for (const c of skin.constraints ?? []) if (!allConstraintIds.has(c)) err(`skins.${skin.name}`, `skin constraint ${c} missing`);
  }
  if (sk.referenceScale !== undefined && !(sk.referenceScale > 0)) err("skeleton", "referenceScale must be positive");
  const animIds = new Set(d.animations.map((a) => a.id));
  const eventIds = new Set(d.events.map((e) => e.id));
  for (const a of d.animations) {
    for (const t of a.timelines) {
      if (t.target === "bone" && !boneIds.has(t.id)) err(`animation ${a.name}`, `bone ${t.id} missing`);
      if ((t.target === "slot" || t.target === "deform" || t.target === "sequence") && !slotIds.has(t.id)) err(`animation ${a.name}`, `slot ${t.id} missing`);
      if (t.target in constraintIds && !constraintIds[t.target as keyof typeof constraintIds].has(t.id))
        err(`animation ${a.name}`, `${t.target} constraint ${t.id} missing`);
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
      for (const s of l.states) {
        if (s.onComplete && !stateIds.has(s.onComplete)) err(`${sm.name}/${s.name}`, "onComplete state missing");
      }
    }
    for (const li of sm.listeners) if (li.slot && !slotIds.has(li.slot)) err(`${sm.name} listener ${li.name}`, "slot missing");
    for (const b of sm.bindings ?? []) if (!inputIds.has(b.input)) err(`${sm.name} binding ${b.id}`, "input missing");
  }
  validateAudio(d, err, warn);
  validateTriggerSounds(d, warn);
  const used = usedFonts(d);
  (d.fonts ?? []).forEach((f, i) => {
    if (!f.src) err(`fonts[${i}]`, `"${f.name}" has no src`);
    if (!f.family) err(`fonts[${i}]`, `"${f.name}" has no family`);
    else if (!used.has(f)) warn(`fonts[${i}]`, `"${f.name}": no text uses family "${f.family}"`);
  });
  return issues;
}

/**
 * A button that plays a sound and fires a trigger, where nothing the trigger leads to makes a sound: firing that
 * trigger from code or from a page button (outside the artboard) is silent. The sound belongs on the state.
 */
function validateTriggerSounds(d: OpenBoneDocument, warn: (p: string, m: string) => void) {
  const animAudio = new Set(d.animations.filter((a) => a.audio?.length).map((a) => a.id));
  for (const sm of d.stateMachines) {
    for (const li of sm.listeners) {
      if (!li.actions.some((a) => a.type === "playSound")) continue;
      for (const act of li.actions) {
        if (act.type !== "fireTrigger") continue;
        const input = sm.inputs.find((i) => i.id === act.input);
        if (!input || input.type !== "trigger") continue;
        const targets = sm.layers.flatMap((l) =>
          l.transitions.filter((t) => t.conditions.some((c) => c.input === input.id)).map((t) => l.states.find((s) => s.id === t.to)).filter((s) => !!s),
        );
        if (!targets.length) continue;
        const sounding = targets.some(
          (s) => s!.sounds?.some((x) => x.action === "play") || (s!.animation && animAudio.has(s!.animation)) || s!.blend?.some((b) => animAudio.has(b.animation)),
        );
        if (!sounding)
          warn(
            `${sm.name} listener ${li.name}`,
            `trigger "${input.name}" only makes a sound when this button is clicked: firing it from code or a page button is silent. Add the sound to state ${targets.map((s) => `"${s!.name}"`).join(" / ")} (Sounds on enter) instead.`,
          );
      }
    }
  }
}

function validateAudio(d: OpenBoneDocument, err: (p: string, m: string) => void, warn: (p: string, m: string) => void) {
  const au = d.audio;
  const assetIds = new Set(au?.assets.map((a) => a.id));
  const busIds = new Set(au?.buses.map((b) => b.id));
  const soundIds = new Set(au?.sounds.map((s) => s.id));
  au?.assets.forEach((a, i) => !a.src && err(`audio.assets[${i}]`, `"${a.name}" has no src`));
  au?.sounds.forEach((s, i) => {
    if (!assetIds.has(s.asset)) err(`audio.sounds[${i}]`, `asset ${s.asset} missing`);
    if (s.bus && !busIds.has(s.bus)) err(`audio.sounds[${i}]`, `bus ${s.bus} missing`);
    if (!(s.rate > 0)) err(`audio.sounds[${i}]`, "rate must be positive");
  });
  d.events.forEach((e) => e.audio && !resolveSound(d, e.audio) && warn(`event ${e.name}`, `audio "${e.audio}" is not a sound or audio asset`));
  for (const a of d.animations) for (const k of a.audio ?? []) if (!soundIds.has(k.sound)) err(`animation ${a.name}`, `sound ${k.sound} missing`);
  for (const sm of d.stateMachines) {
    for (const l of sm.layers)
      for (const st of l.states) for (const x of st.sounds ?? []) if (!soundIds.has(x.sound)) err(`${sm.name}/${st.name}`, `sound ${x.sound} missing`);
    for (const li of sm.listeners)
      for (const x of li.actions)
        if ((x.type === "playSound" || x.type === "stopSound") && !soundIds.has(x.sound)) err(`${sm.name} listener ${li.name}`, `sound ${x.sound} missing`);
  }
}
