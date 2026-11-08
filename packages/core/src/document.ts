import type {
  AnimationData,
  Attachment,
  BoneData,
  EventData,
  Id,
  ImageAsset,
  InputData,
  LayerData,
  OpenBoneDocument,
  ScriptData,
  SkinData,
  SlotData,
  StateData,
  StateMachineData,
} from "./types.ts";
import { FORMAT_VERSION } from "./types.ts";

let counter = 0;
/** Short unique id with a type prefix, e.g. "bone_k3x9a1". */
export function newId(prefix: string): Id {
  counter = (counter + 1) % 1296;
  const rand = Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0");
  return `${prefix}_${rand}${counter.toString(36).padStart(2, "0")}`;
}

export function createDocument(name = "Untitled", opts: Partial<OpenBoneDocument> = {}): OpenBoneDocument {
  const rootId = newId("bone");
  return {
    format: "openbone",
    version: FORMAT_VERSION,
    name,
    width: 800,
    height: 600,
    originX: 400,
    originY: 450,
    background: null,
    fps: 30,
    images: [],
    skeleton: {
      bones: [
        {
          id: rootId,
          name: "root",
          parent: null,
          length: 0,
          x: 0,
          y: 0,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          shearX: 0,
          shearY: 0,
          inherit: "normal",
        },
      ],
      slots: [],
      skins: [{ id: "skin_default", name: "default", attachments: {} }],
      ik: [],
      transform: [],
    },
    events: [],
    animations: [],
    stateMachines: [],
    scripts: [],
    ...opts,
  };
}

/** Find by id first, then by name. */
function byRef<T extends { id: Id; name: string }>(list: T[], ref: string): T | undefined {
  return list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref);
}

export class RefError extends Error {}

function need<T>(v: T | undefined, kind: string, ref: string, list: { name: string }[]): T {
  if (v === undefined) {
    const names = list.map((x) => x.name).slice(0, 30).join(", ");
    throw new RefError(`${kind} "${ref}" not found. Available: ${names || "(none)"}`);
  }
  return v;
}

export const find = {
  bone: (d: OpenBoneDocument, ref: string) => byRef(d.skeleton.bones, ref),
  slot: (d: OpenBoneDocument, ref: string) => byRef(d.skeleton.slots, ref),
  image: (d: OpenBoneDocument, ref: string) => byRef(d.images, ref),
  skin: (d: OpenBoneDocument, ref: string) => byRef(d.skeleton.skins, ref),
  animation: (d: OpenBoneDocument, ref: string) => byRef(d.animations, ref),
  event: (d: OpenBoneDocument, ref: string) => byRef(d.events, ref),
  script: (d: OpenBoneDocument, ref: string) => byRef(d.scripts, ref),
  stateMachine: (d: OpenBoneDocument, ref: string) => byRef(d.stateMachines, ref),
  ik: (d: OpenBoneDocument, ref: string) => byRef(d.skeleton.ik, ref),
  transform: (d: OpenBoneDocument, ref: string) => byRef(d.skeleton.transform, ref),
};

export const get = {
  bone: (d: OpenBoneDocument, ref: string): BoneData => need(find.bone(d, ref), "Bone", ref, d.skeleton.bones),
  slot: (d: OpenBoneDocument, ref: string): SlotData => need(find.slot(d, ref), "Slot", ref, d.skeleton.slots),
  image: (d: OpenBoneDocument, ref: string): ImageAsset => need(find.image(d, ref), "Image", ref, d.images),
  skin: (d: OpenBoneDocument, ref: string): SkinData => need(find.skin(d, ref), "Skin", ref, d.skeleton.skins),
  animation: (d: OpenBoneDocument, ref: string): AnimationData =>
    need(find.animation(d, ref), "Animation", ref, d.animations),
  event: (d: OpenBoneDocument, ref: string): EventData => need(find.event(d, ref), "Event", ref, d.events),
  script: (d: OpenBoneDocument, ref: string): ScriptData => need(find.script(d, ref), "Script", ref, d.scripts),
  stateMachine: (d: OpenBoneDocument, ref: string): StateMachineData =>
    need(find.stateMachine(d, ref), "State machine", ref, d.stateMachines),
  layer: (sm: StateMachineData, ref?: string | null): LayerData =>
    ref == null ? need(sm.layers[0], "Layer", "(first)", sm.layers) : need(byRef(sm.layers, ref), "Layer", ref, sm.layers),
  state: (layer: LayerData, ref: string): StateData => need(byRef(layer.states, ref), "State", ref, layer.states),
  input: (sm: StateMachineData, ref: string): InputData => need(byRef(sm.inputs, ref), "Input", ref, sm.inputs),
};

export const defaultSkin = (d: OpenBoneDocument): SkinData => d.skeleton.skins[0];

/** Resolve the attachment a slot shows: active skin first, then default skin. */
export function getAttachment(d: OpenBoneDocument, slotId: Id, name: string | null, skinId?: Id): Attachment | null {
  if (name == null) return null;
  if (skinId) {
    const s = d.skeleton.skins.find((k) => k.id === skinId);
    const a = s?.attachments[slotId]?.[name];
    if (a) return a;
  }
  return defaultSkin(d).attachments[slotId]?.[name] ?? null;
}

export function childrenOf(d: OpenBoneDocument, boneId: Id): BoneData[] {
  return d.skeleton.bones.filter((b) => b.parent === boneId);
}

export function descendantIds(d: OpenBoneDocument, boneId: Id): Set<Id> {
  const out = new Set<Id>([boneId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of d.skeleton.bones) {
      if (b.parent && out.has(b.parent) && !out.has(b.id)) {
        out.add(b.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Reorder bones so every parent precedes its children (stable). */
export function sortBones(d: OpenBoneDocument): void {
  const bones = d.skeleton.bones;
  const placed = new Set<Id>();
  const out: BoneData[] = [];
  let guard = 0;
  while (out.length < bones.length && guard++ < bones.length + 1) {
    for (const b of bones) {
      if (!placed.has(b.id) && (b.parent === null || placed.has(b.parent))) {
        out.push(b);
        placed.add(b.id);
      }
    }
  }
  if (out.length === bones.length) d.skeleton.bones = out;
}

/** Last key time of any timeline/event, or the explicit duration. */
export function animationDuration(a: AnimationData): number {
  if (a.duration > 0) return a.duration;
  let t = 0;
  for (const tl of a.timelines) for (const k of tl.keys) t = Math.max(t, k.time);
  for (const e of a.events) t = Math.max(t, e.time);
  return t;
}

export function cloneDocument(d: OpenBoneDocument): OpenBoneDocument {
  // Images are treated as immutable and shared; everything else is deep-cloned.
  const { images, ...rest } = d;
  return { ...(structuredClone(rest) as Omit<OpenBoneDocument, "images">), images: images.slice() };
}

export function serialize(d: OpenBoneDocument, pretty = true): string {
  return JSON.stringify(d, null, pretty ? 2 : undefined);
}

export function deserialize(json: string): OpenBoneDocument {
  const d = JSON.parse(json) as OpenBoneDocument;
  if (d.format !== "openbone") throw new Error("Not an OpenBone document (missing format: \"openbone\")");
  if (d.version > FORMAT_VERSION) throw new Error(`Document version ${d.version} is newer than supported ${FORMAT_VERSION}`);
  d.scripts ??= [];
  d.stateMachines ??= [];
  d.events ??= [];
  return d;
}
