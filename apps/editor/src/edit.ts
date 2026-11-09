import { BONE_PROPERTIES, type BoneProperty, getAttachment } from "@openbone/core";
import { activeSkin, animationId, apply, autoKey, mode, ownerSkinArg, setAnimationId, store, time, toast, transaction } from "./state.ts";

/** Make sure an animation is selected in animate mode (creates one if the doc has none). */
export function ensureAnimation(): string | null {
  const id = animationId();
  if (id && store.doc.animations.some((a) => a.id === id)) return id;
  const first = store.doc.animations[0];
  if (first) {
    setAnimationId(first.id);
    return first.id;
  }
  const res = apply("createAnimation", { name: "animation" }) as { id: string } | undefined;
  if (res) setAnimationId(res.id);
  return res?.id ?? null;
}

/**
 * Set keys like the `setKeys` op, and when a key lands past an animation's fixed length, extend the length to it
 * (recording past the end grows the animation, as in Spine). One undo step.
 */
function setKeysExtending(args: { animation: string; keys: { time: number; [k: string]: unknown }[]; [k: string]: unknown }) {
  transaction("key", () => {
    store.apply("setKeys", args);
    const a = store.doc.animations.find((x) => x.id === args.animation);
    const last = Math.max(...args.keys.map((k) => k.time));
    if (a && a.duration > 0 && last > a.duration + 1e-6) store.apply("updateAnimation", { animation: a.id, duration: last });
  });
}

/** Write bone values: setup pose in Setup mode, keyframes at the current time in Animate mode. */
export function commitBone(boneId: string, props: Record<string, number>) {
  if (mode() === "setup") {
    apply("updateBone", { bone: boneId, ...props });
    return;
  }
  if (!autoKey()) {
    toast("Auto-key is off: use the ◆ buttons in the inspector to key values", "info");
    return;
  }
  const anim = ensureAnimation();
  if (!anim) return;
  transaction("key bone", () => {
    for (const [property, value] of Object.entries(props))
      if (BONE_PROPERTIES.includes(property as BoneProperty))
        setKeysExtending({ animation: anim, target: "bone", id: boneId, property, keys: [{ time: round3(time()), value }] });
  });
}

export function keyBoneProperty(boneId: string, property: BoneProperty, value: number) {
  const anim = ensureAnimation();
  if (anim) setKeysExtending({ animation: anim, target: "bone", id: boneId, property, keys: [{ time: round3(time()), value }] });
}

export function keySlot(slotId: string, property: "color" | "attachment" | "dark", value: string | null) {
  const anim = ensureAnimation();
  if (anim) setKeysExtending({ animation: anim, target: "slot", id: slotId, property, keys: [{ time: round3(time()), value, curve: property === "attachment" ? "stepped" : "linear" }] });
}

/** Key a constraint value at the current time (Animate mode). */
export function keyConstraint(target: "ik" | "transform" | "path" | "physics", id: string, property: string, value: number) {
  const anim = ensureAnimation();
  // IK switches (bend, stretch, compress) change at keys instead of blending.
  const stepped = target === "ik" && (property === "bend" || property === "stretch" || property === "compress");
  if (anim) setKeysExtending({ animation: anim, target, id, property, keys: [{ time: round3(time()), value, ...(stepped ? { curve: "stepped" } : {}) }] });
}

export function commitAttachmentMove(slotId: string, name: string, x: number, y: number) {
  const att = getAttachment(store.doc, slotId, name, activeSkin()?.id);
  if (!att) return;
  apply("updateAttachment", { slot: slotId, attachment: name, ...ownerSkinArg(slotId, name), props: { x, y } });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
