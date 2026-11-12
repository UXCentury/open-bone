import { z } from "zod";
import { defaultSkin, deserialize, newId, normalizeDocument } from "../document.ts";
import { splitFontFamilies } from "../fonts.ts";
import type {
  AnimationData,
  Attachment,
  AudioData,
  BoneData,
  Id,
  OpenBoneDocument,
  SkinData,
  SlotData,
  Timeline,
} from "../types.ts";
import { defineOp } from "./registry.ts";

/**
 * Import data (like Spine's "Import data"): copy animations and skins from another project, matching bones,
 * slots, constraints and events by name, or bring in its whole skeleton under a new root bone. Images and sounds the
 * copied data uses come along (matched by name, copied when this project lacks them).
 */

export type ImportConflict = "rename" | "replace" | "skip";

export interface ImportReport {
  animations: { from: string; name: string; id: Id; replaced: boolean }[];
  skins: { from: string; name: string; id: Id; attachments: number }[];
  bones: number;
  slots: number;
  constraints: number;
  images: string[];
  sounds: string[];
  fonts: string[];
  events: string[];
  /** Human-readable notes about what could not be brought over (missing bones or slots, name conflicts). */
  skipped: string[];
}

/** What importing `names` from `source` would collide with in `target`, for a pick list. */
export function importConflicts(target: OpenBoneDocument, source: OpenBoneDocument) {
  const anims = new Set(target.animations.map((a) => a.name));
  const skins = new Set(target.skeleton.skins.map((s) => s.name));
  const bones = new Set(target.skeleton.bones.map((b) => b.name));
  const slots = new Set(target.skeleton.slots.map((s) => s.name));
  const sourceDefault = source.skeleton.skins[0]?.id;
  return {
    animations: source.animations.map((a) => ({ id: a.id, name: a.name, folder: a.folder, conflict: anims.has(a.name) })),
    skins: source.skeleton.skins.map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.folder,
      // The default skin always merges into this project's default skin.
      conflict: s.id !== sourceDefault && skins.has(s.name),
      isDefault: s.id === sourceDefault,
    })),
    /** Source bones / slots with no namesake here (their keys and attachments are skipped unless the skeleton is imported). */
    missingBones: source.skeleton.bones.filter((b) => !bones.has(b.name)).map((b) => b.name),
    missingSlots: source.skeleton.slots.filter((s) => !slots.has(s.name)).map((s) => s.name),
  };
}

function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

const byRef = <T extends { id: string; name: string }>(list: T[], r: string) => list.find((x) => x.id === r) ?? list.find((x) => x.name === r);

type ConstraintKind = "ik" | "transform" | "path" | "physics";
const CONSTRAINT_KINDS: ConstraintKind[] = ["ik", "transform", "path", "physics"];

class Importer {
  bone = new Map<Id, Id>();
  slot = new Map<Id, Id>();
  constraint: Record<ConstraintKind, Map<Id, Id>> = { ik: new Map(), transform: new Map(), path: new Map(), physics: new Map() };
  skin = new Map<Id, Id>();
  private image = new Map<Id, Id | null>();
  private sound = new Map<Id, Id | null>();
  private asset = new Map<Id, Id | null>();
  private bus = new Map<Id, Id | null>();
  private event = new Map<Id, Id>();
  report: ImportReport = { animations: [], skins: [], bones: 0, slots: 0, constraints: 0, images: [], sounds: [], fonts: [], events: [], skipped: [] };
  private notes = new Set<string>();

  constructor(
    private doc: OpenBoneDocument,
    private src: OpenBoneDocument,
  ) {
    this.skin.set(defaultSkin(src).id, defaultSkin(doc).id);
  }

  note(text: string) {
    if (this.notes.has(text)) return;
    this.notes.add(text);
    this.report.skipped.push(text);
  }

  srcName(kind: "bone" | "slot", id: Id) {
    const list: { id: string; name: string }[] = kind === "bone" ? this.src.skeleton.bones : this.src.skeleton.slots;
    return list.find((x) => x.id === id)?.name ?? id;
  }

  // ---------- name matching ----------

  matchByName() {
    const sk = this.doc.skeleton;
    for (const b of this.src.skeleton.bones) {
      const t = sk.bones.find((x) => x.name === b.name);
      if (t) this.bone.set(b.id, t.id);
    }
    for (const s of this.src.skeleton.slots) {
      const t = sk.slots.find((x) => x.name === s.name);
      if (t) this.slot.set(s.id, t.id);
    }
    for (const k of CONSTRAINT_KINDS)
      for (const c of this.src.skeleton[k]) {
        const t = (sk[k] as { id: string; name: string }[]).find((x) => x.name === c.name);
        if (t) this.constraint[k].set(c.id, t.id);
      }
  }

  // ---------- whole skeleton ----------

  copySkeleton() {
    const sk = this.doc.skeleton;
    const src = this.src.skeleton;
    const parent = sk.bones.find((b) => b.parent === null)!;
    const rootId = newId("bone");
    const rootName = uniqueName(
      sk.bones.map((b) => b.name),
      this.src.name?.trim() || "imported",
    );
    sk.bones.push({ id: rootId, name: rootName, parent: parent.id, length: 0, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: "normal" });
    // Parents come before children in a valid document, so one pass maps every parent first.
    const ordered = [...src.bones].sort((a, b) => depth(src.bones, a) - depth(src.bones, b));
    for (const b of ordered) {
      const id = newId("bone");
      this.bone.set(b.id, id);
      const copy: BoneData = { ...structuredClone(b), id, name: uniqueName(sk.bones.map((x) => x.name), b.name), parent: b.parent ? this.bone.get(b.parent)! : rootId };
      sk.bones.push(copy);
    }
    this.report.bones = src.bones.length + 1;
    for (const s of src.slots) {
      const id = newId("slot");
      this.slot.set(s.id, id);
      const copy: SlotData = { ...structuredClone(s), id, name: uniqueName(sk.slots.map((x) => x.name), s.name), bone: this.bone.get(s.bone)! };
      sk.slots.push(copy);
    }
    this.report.slots = src.slots.length;
    const allNames = () => CONSTRAINT_KINDS.flatMap((k) => (sk[k] as { name: string }[]).map((c) => c.name));
    const mapBones = (ids: Id[]) => ids.map((b) => this.bone.get(b)!);
    for (const c of src.ik) this.pushConstraint("ik", { ...structuredClone(c), bones: mapBones(c.bones), target: this.bone.get(c.target)! }, allNames());
    for (const c of src.transform) this.pushConstraint("transform", { ...structuredClone(c), bones: mapBones(c.bones), target: this.bone.get(c.target)! }, allNames());
    for (const c of src.path) this.pushConstraint("path", { ...structuredClone(c), bones: mapBones(c.bones), target: this.slot.get(c.target)! }, allNames());
    for (const c of src.physics) this.pushConstraint("physics", { ...structuredClone(c), bone: this.bone.get(c.bone)! }, allNames());
    if (src.sliders?.length) this.note(`${src.sliders.length} slider(s) not imported: add them again for the imported animations`);
  }

  private pushConstraint<T extends { id: Id; name: string }>(k: ConstraintKind, c: T, names: string[]) {
    const old = c.id;
    c.id = newId(k);
    c.name = uniqueName(names, c.name);
    this.constraint[k].set(old, c.id);
    (this.doc.skeleton[k] as unknown as T[]).push(c);
    this.report.constraints++;
  }

  // ---------- assets ----------

  mapImage(id: Id): Id | null {
    if (this.image.has(id)) return this.image.get(id)!;
    const img = this.src.images.find((i) => i.id === id);
    let out: Id | null = null;
    if (!img) this.note(`Image "${id}" is missing from the source project`);
    else {
      const same = this.doc.images.find((i) => i.name === img.name);
      if (same) out = same.id;
      else if (!img.src) this.note(`Image "${img.name}" exists only in the source's texture atlas; attachments using it were skipped`);
      else {
        out = this.doc.images.some((i) => i.id === img.id) ? newId("img") : img.id;
        // Image assets are shared with undo snapshots: push a new object, never mutate one.
        this.doc.images.push({ ...img, id: out });
        this.report.images.push(img.name);
      }
    }
    this.image.set(id, out);
    return out;
  }

  private audio(): AudioData {
    return (this.doc.audio ??= { master: 1, muted: false, assets: [], buses: [], sounds: [] });
  }

  private mapAsset(id: Id): Id | null {
    if (this.asset.has(id)) return this.asset.get(id)!;
    const a = this.src.audio?.assets.find((x) => x.id === id);
    let out: Id | null = null;
    if (a) {
      const audio = this.audio();
      const same = audio.assets.find((x) => x.name === a.name);
      if (same) out = same.id;
      else {
        out = audio.assets.some((x) => x.id === a.id) ? newId("aud") : a.id;
        audio.assets.push({ ...a, id: out });
      }
    }
    this.asset.set(id, out);
    return out;
  }

  private mapBus(id: Id | null): Id | null {
    if (!id) return null;
    if (this.bus.has(id)) return this.bus.get(id)!;
    const b = this.src.audio?.buses.find((x) => x.id === id);
    let out: Id | null = null;
    if (b) {
      const audio = this.audio();
      const same = audio.buses.find((x) => x.name === b.name);
      if (same) out = same.id;
      else {
        out = audio.buses.some((x) => x.id === b.id) ? newId("bus") : b.id;
        audio.buses.push({ ...structuredClone(b), id: out });
      }
    }
    this.bus.set(id, out);
    return out;
  }

  mapSound(id: Id): Id | null {
    if (this.sound.has(id)) return this.sound.get(id)!;
    const s = this.src.audio?.sounds.find((x) => x.id === id) ?? this.src.audio?.sounds.find((x) => x.name === id);
    let out: Id | null = null;
    if (s) {
      const audio = this.audio();
      const same = audio.sounds.find((x) => x.name === s.name);
      if (same) out = same.id;
      else {
        const asset = this.mapAsset(s.asset);
        if (!asset) this.note(`Sound "${s.name}" has no audio file in the source project`);
        else {
          out = audio.sounds.some((x) => x.id === s.id) ? newId("snd") : s.id;
          audio.sounds.push({ ...structuredClone(s), id: out, asset, bus: this.mapBus(s.bus) });
          this.report.sounds.push(s.name);
        }
      }
    } else this.note(`Sound "${id}" is missing from the source project`);
    this.sound.set(id, out);
    return out;
  }

  mapEvent(id: Id): Id | null {
    if (this.event.has(id)) return this.event.get(id)!;
    const e = this.src.events.find((x) => x.id === id);
    if (!e) return null;
    const same = this.doc.events.find((x) => x.name === e.name);
    let out: Id;
    if (same) out = same.id;
    else {
      out = this.doc.events.some((x) => x.id === e.id) ? newId("evt") : e.id;
      const copy = { ...structuredClone(e), id: out };
      if (e.audio) {
        // An event's sound is a sound (id or name) or an audio file.
        const isSound = this.src.audio?.sounds.some((s) => s.id === e.audio || s.name === e.audio);
        const asset = !isSound ? this.src.audio?.assets.find((x) => x.id === e.audio || x.name === e.audio) : undefined;
        const mapped = isSound ? this.mapSound(e.audio) : asset ? this.mapAsset(asset.id) : null;
        if (mapped) copy.audio = mapped;
        else delete copy.audio;
      }
      this.doc.events.push(copy);
      this.report.events.push(e.name);
    }
    this.event.set(id, out);
    return out;
  }

  // ---------- attachments ----------

  /** A copy of `att` (on source slot `slot`) using this project's ids, or null when it can't be brought over. */
  attachment(att: Attachment, where: string): Attachment | null {
    const a = structuredClone(att);
    if (a.type === "region" || a.type === "mesh") {
      const img = this.mapImage(a.image);
      if (!img) return null;
      a.image = img;
    }
    if (a.type === "particles" && a.image) {
      const img = this.mapImage(a.image);
      if (img) a.image = img;
      else {
        delete a.image;
        if (a.look === "image") a.look = "circle";
      }
    }
    if (a.type === "sequence") {
      for (const f of a.frames) {
        const img = this.mapImage(f.image);
        if (!img) return null;
        f.image = img;
      }
      // Inputs belong to state machines, which aren't imported.
      if (a.input) a.input = null;
    }
    if ((a.type === "mesh" || a.type === "path" || a.type === "boundingBox") && a.weights) {
      for (const v of a.weights)
        for (const inf of v) {
          const b = this.bone.get(inf.bone);
          if (!b) {
            this.note(`${where}: weighted to bone "${this.srcName("bone", inf.bone)}", which this project doesn't have`);
            return null;
          }
          inf.bone = b;
        }
    }
    if (a.type === "mesh" && a.linked) {
      if (a.linked.slot) {
        const s = this.slot.get(a.linked.slot);
        if (s) a.linked.slot = s;
        else delete a.linked;
      }
      if (a.linked?.skin) {
        const k = this.skin.get(a.linked.skin);
        if (k) a.linked.skin = k;
        else delete a.linked.skin;
      }
    }
    if (a.type === "clipping" && a.end) a.end = this.slot.get(a.end) ?? null;
    return a;
  }

  /** Copy a source skin's attachments into `target`. Existing attachments of the same name are replaced or kept. */
  fillSkin(srcSkin: SkinData, target: SkinData, replaceExisting: boolean): number {
    let n = 0;
    for (const [srcSlot, atts] of Object.entries(srcSkin.attachments)) {
      const slot = this.slot.get(srcSlot);
      const slotName = this.srcName("slot", srcSlot);
      if (!slot) {
        if (Object.keys(atts).length) this.note(`Skin "${srcSkin.name}": slot "${slotName}" not in this project (${Object.keys(atts).length} attachment(s) skipped)`);
        continue;
      }
      for (const [name, att] of Object.entries(atts)) {
        const exists = !!target.attachments[slot]?.[name];
        if (exists && !replaceExisting) {
          this.note(`Skin "${target.name}": kept the existing "${slotName}/${name}"`);
          continue;
        }
        const copy = this.attachment(att, `Skin "${srcSkin.name}", "${slotName}/${name}"`);
        if (!copy) continue;
        (target.attachments[slot] ??= {})[name] = copy;
        n++;
      }
    }
    // Skin bones and skin constraints come along, mapped to this project's bones and constraints.
    const bones = (srcSkin.bones ?? []).map((b) => this.bone.get(b)).filter((b): b is Id => !!b);
    if (bones.length) target.bones = [...new Set([...(target.bones ?? []), ...bones])];
    const cons = (srcSkin.constraints ?? [])
      .map((c) => Object.values(this.constraint).map((m) => m.get(c)).find(Boolean))
      .filter((c): c is Id => !!c);
    if (cons.length) target.constraints = [...new Set([...(target.constraints ?? []), ...cons])];
    return n;
  }

  // ---------- animations ----------

  timeline(tl: Timeline): Timeline | null {
    const t = structuredClone(tl);
    switch (t.target) {
      case "bone": {
        const id = this.bone.get(t.id);
        if (!id) return this.missing("bone", this.srcName("bone", t.id));
        t.id = id;
        return t;
      }
      case "slot":
      case "sequence":
      case "deform":
      case "particles": {
        const id = this.slot.get(t.id);
        if (!id) return this.missing("slot", this.srcName("slot", t.id));
        t.id = id;
        return t;
      }
      case "ik":
      case "transform":
      case "path":
      case "physics": {
        const id = this.constraint[t.target].get(t.id);
        if (!id) return this.missing(`${t.target} constraint`, (this.src.skeleton[t.target] as { id: string; name: string }[]).find((c) => c.id === t.id)?.name ?? t.id);
        t.id = id;
        return t;
      }
      case "drawOrder": {
        const setup = this.doc.skeleton.slots.map((s) => s.id);
        for (const k of t.keys) {
          // Mapped slots take the key's relative order; the others stay where the setup pose has them.
          const ordered = k.value.map((s) => this.slot.get(s)).filter((s): s is Id => !!s);
          const moved = new Set(ordered);
          let i = 0;
          k.value = setup.map((s) => (moved.has(s) ? ordered[i++] : s));
        }
        return t;
      }
    }
  }

  private missingCount = new Map<string, number>();
  private missing(kind: string, name: string): null {
    const key = `${kind} "${name}"`;
    this.missingCount.set(key, (this.missingCount.get(key) ?? 0) + 1);
    return null;
  }

  animation(a: AnimationData): Omit<AnimationData, "id" | "name"> {
    this.missingCount.clear();
    const timelines = a.timelines.map((t) => this.timeline(t)).filter((t): t is Timeline => !!t);
    if (this.missingCount.size)
      this.note(`Animation "${a.name}": keys for ${[...this.missingCount.keys()].slice(0, 5).join(", ")}${this.missingCount.size > 5 ? "…" : ""} skipped (not in this project)`);
    const events = a.events.flatMap((k) => {
      const e = this.mapEvent(k.event);
      return e ? [{ ...structuredClone(k), event: e }] : [];
    });
    const audio = (a.audio ?? []).flatMap((k) => {
      const s = this.mapSound(k.sound);
      return s ? [{ ...structuredClone(k), sound: s }] : [];
    });
    const { id: _id, name: _name, timelines: _t, events: _e, audio: _a, ...rest } = structuredClone(a);
    return { ...rest, timelines, events, ...(audio.length ? { audio } : {}) };
  }
}

function depth(bones: BoneData[], b: BoneData): number {
  let d = 0;
  for (let p = b.parent; p && d < bones.length; d++) p = bones.find((x) => x.id === p)?.parent ?? null;
  return d;
}

defineOp({
  name: "importData",
  group: "project",
  description:
    'Import data from another OpenBone project (like Spine\'s "Import data"). Picked `animations` and `skins` (ids or names in the source) are copied, matching bones, slots, constraints and events by name; keys and attachments for bones or slots this project lacks are skipped and reported. The images and sounds they use come along (reused when a same-named one exists here). `skeleton: true` brings in the whole skeleton (bones, slots, constraints and every skin\'s attachments) under a new root bone named after the source project. `onConflict` decides what happens when a picked animation or skin name already exists: rename (default), replace (keeps this project\'s id, so state machines still play it), or skip. The source default skin always merges into this default skin.',
  schema: z.object({
    document: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("Source project: an OpenBone document object or its JSON text"),
    animations: z.array(z.string()).optional().describe("Source animation ids or names to copy"),
    skins: z.array(z.string()).optional().describe("Source skin ids or names to copy"),
    skeleton: z.boolean().default(false).describe("Bring in the whole skeleton under a new root bone"),
    onConflict: z.enum(["rename", "replace", "skip"]).default("rename"),
  }),
  apply(doc, a) {
    const raw = a.document as unknown as Partial<OpenBoneDocument>;
    if (typeof a.document !== "string" && (raw.format !== "openbone" || !raw.skeleton)) throw new Error('Not an OpenBone document (missing format: "openbone")');
    const src = typeof a.document === "string" ? deserialize(a.document) : normalizeDocument(structuredClone(raw) as OpenBoneDocument);
    const animRefs = a.animations ?? [];
    const skinRefs = a.skins ?? [];
    if (!a.skeleton && !animRefs.length && !skinRefs.length) throw new Error("Nothing to import: pick animations, skins or the skeleton");
    const anims = animRefs.map((r) => {
      const x = byRef(src.animations, r);
      if (!x) throw new Error(`Source animation "${r}" not found. Available: ${src.animations.map((y) => y.name).join(", ") || "(none)"}`);
      return x;
    });
    const skins = skinRefs.map((r) => {
      const x = byRef(src.skeleton.skins, r);
      if (!x) throw new Error(`Source skin "${r}" not found. Available: ${src.skeleton.skins.map((y) => y.name).join(", ")}`);
      return x;
    });
    const im = new Importer(doc, src);
    const sk = doc.skeleton;
    const srcDefault = defaultSkin(src);

    if (a.skeleton) {
      im.copySkeleton();
      // Every skin's attachments come with the skeleton (the slots are new, so nothing collides): named skins merge
      // into this project's skin of the same name.
      const pairs = src.skeleton.skins.map((s) => {
        if (s === srcDefault) return [s, defaultSkin(doc)] as const;
        let t = sk.skins.find((k) => k.name === s.name);
        if (!t) {
          t = { id: newId("skin"), name: s.name, attachments: {}, ...(s.folder ? { folder: s.folder } : {}) };
          sk.skins.push(t);
        }
        im.skin.set(s.id, t.id);
        return [s, t] as const;
      });
      for (const [s, t] of pairs) {
        const n = im.fillSkin(s, t, true);
        im.report.skins.push({ from: s.name, name: t.name, id: t.id, attachments: n });
      }
    } else im.matchByName();

    if (!a.skeleton) {
      // Decide every skin's target first, so linked meshes can point at skins imported in the same call.
      const plan: { s: SkinData; t: SkinData; replace: boolean }[] = [];
      for (const s of skins) {
        if (s === srcDefault) {
          plan.push({ s, t: defaultSkin(doc), replace: a.onConflict === "replace" });
          continue;
        }
        let t = sk.skins.find((k) => k.name === s.name);
        if (t && a.onConflict === "skip") {
          im.note(`Skin "${s.name}" already exists (skipped)`);
          continue;
        }
        if (t && t === defaultSkin(doc)) t = undefined; // never replace the default skin by name
        if (t && a.onConflict === "replace") t.attachments = {};
        else {
          t = {
            id: newId("skin"),
            name: uniqueName(
              sk.skins.map((k) => k.name),
              s.name,
            ),
            attachments: {},
            ...(s.folder ? { folder: s.folder } : {}),
          };
          sk.skins.push(t);
        }
        im.skin.set(s.id, t.id);
        plan.push({ s, t, replace: true });
      }
      for (const { s, t, replace } of plan) {
        const n = im.fillSkin(s, t, replace);
        im.report.skins.push({ from: s.name, name: t.name, id: t.id, attachments: n });
      }
    }

    for (const srcAnim of anims) {
      const body = im.animation(srcAnim);
      const existing = doc.animations.find((x) => x.name === srcAnim.name);
      if (existing && a.onConflict === "skip") {
        im.note(`Animation "${srcAnim.name}" already exists (skipped)`);
        continue;
      }
      if (existing && a.onConflict === "replace") {
        for (const k of Object.keys(existing)) if (k !== "id" && k !== "name") delete (existing as unknown as Record<string, unknown>)[k];
        Object.assign(existing, body);
        im.report.animations.push({ from: srcAnim.name, name: existing.name, id: existing.id, replaced: true });
        continue;
      }
      const id = doc.animations.some((x) => x.id === srcAnim.id) ? newId("anim") : srcAnim.id;
      const name = uniqueName(
        doc.animations.map((x) => x.name),
        srcAnim.name,
      );
      doc.animations.push({ id, name, ...body });
      im.report.animations.push({ from: srcAnim.name, name, id, replaced: false });
    }
    // Fonts the imported texts name come along (skipped when this project already has that family).
    if (src.fonts?.length) {
      const families = new Set<string>();
      for (const skin of doc.skeleton.skins)
        for (const atts of Object.values(skin.attachments))
          for (const att of Object.values(atts)) if (att.type === "text") for (const f of splitFontFamilies(att.font)) families.add(f.toLowerCase());
      const have = new Set((doc.fonts ?? []).map((f) => f.family.toLowerCase()));
      for (const f of src.fonts) {
        const fam = f.family.toLowerCase();
        if (!families.has(fam) || have.has(fam)) continue;
        doc.fonts ??= [];
        const id = doc.fonts.some((x) => x.id === f.id) ? newId("fnt") : f.id;
        const name = uniqueName(doc.fonts.map((x) => x.name), f.name);
        doc.fonts.push({ ...f, id, name });
        im.report.fonts.push(f.name);
      }
    }
    return im.report;
  },
});
