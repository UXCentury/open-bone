import { createSignal } from "solid-js";
import { apply, doc, selectedBoneIds, selectedSlotIds, store, toast } from "./state.ts";

/**
 * Editor-only visibility for the Skeleton tree's eye buttons: a bone or slot can be shown, dimmed or hidden while you
 * work. It changes only what the editor viewport draws (not the document, Play, the preview or exports). A hidden or
 * dimmed bone applies to every slot under it.
 */
export type Vis = "shown" | "dim" | "hidden";
const [vis, setVis] = createSignal<Record<string, Vis>>({});
export const visOf = (id: string): Vis => vis()[id] ?? "shown";
export function cycleVis(id: string, back = false) {
  const order: Vis[] = ["shown", "dim", "hidden"];
  const i = order.indexOf(visOf(id));
  const next = order[(i + (back ? 2 : 1)) % 3];
  setVis((v) => {
    const out = { ...v };
    if (next === "shown") delete out[id];
    else out[id] = next;
    return out;
  });
}
/** Set a node's visibility directly (context menu Show/Hide/Dim). */
export function cycleVisTo(id: string, to: Vis) {
  setVis((v) => {
    const out = { ...v };
    if (to === "shown") delete out[id];
    else out[id] = to;
    return out;
  });
}
export const anyHidden = () => Object.keys(vis()).length > 0;
export const showAll = () => {
  setVis({});
  setIsolated(null);
};

// ---- lock (editor only): locked bones and slots can't be clicked in the viewport; a bone locks everything under it ----
const [locks, setLocks] = createSignal<Record<string, true>>({});
export const isLocked = (id: string) => !!locks()[id];
export function setLocked(id: string, on: boolean) {
  setLocks((l) => {
    const out = { ...l };
    if (on) out[id] = true;
    else delete out[id];
    return out;
  });
}
export const toggleLock = (id: string) => setLocked(id, !isLocked(id));
export const unlockAll = () => setLocks({});
export const anyLocked = () => Object.keys(locks()).length > 0;
/** Whether a bone is locked, by itself or by a locked parent. */
export function boneLocked(boneId: string): boolean {
  const l = locks();
  if (!Object.keys(l).length) return false;
  const bones = doc().skeleton.bones;
  for (let b = bones.find((x) => x.id === boneId); b; b = b.parent ? bones.find((x) => x.id === b!.parent) : undefined) if (l[b.id]) return true;
  return false;
}
/** Whether a slot can't be clicked: locked itself, or its bone (or a parent of it) is locked. */
export function slotLocked(slotId: string): boolean {
  const l = locks();
  if (!Object.keys(l).length) return false;
  if (l[slotId]) return true;
  const slot = doc().skeleton.slots.find((s) => s.id === slotId);
  return !!slot && boneLocked(slot.bone);
}

// ---- isolate (editor only): show only the selected parts, then everything again as it was ----
const [isolated, setIsolated] = createSignal<Record<string, Vis> | null>(null);
export const isIsolated = () => isolated() !== null;
/**
 * Hide every slot that isn't kept: the given slots, plus every slot under the given bones (and their children).
 * The eye states from before are remembered and come back with `endIsolate`.
 */
export function isolate(slotIds: string[], boneIds: string[]) {
  const d = doc();
  const keepBones = new Set<string>();
  const addBone = (id: string) => {
    keepBones.add(id);
    for (const c of d.skeleton.bones) if (c.parent === id && !keepBones.has(c.id)) addBone(c.id);
  };
  boneIds.forEach(addBone);
  const keep = new Set([...slotIds, ...d.skeleton.slots.filter((s) => keepBones.has(s.bone)).map((s) => s.id)]);
  if (!keep.size) return toast("Select a part or a bone to show only that", "info");
  if (!isolated()) setIsolated(vis());
  const next: Record<string, Vis> = {};
  for (const s of d.skeleton.slots) if (!keep.has(s.id)) next[s.id] = "hidden";
  setVis(next);
}
export function endIsolate() {
  const before = isolated();
  setIsolated(null);
  setVis(before ?? {});
}

/**
 * View → Attachments (H): hide every attachment in the viewport so only the bones show, to see and work on the rig
 * itself. Hidden attachments can't be clicked either. Editor-only, like the eye buttons.
 */
export const [showImages, setShowImages] = createSignal(true);

const DIM = 0.25;
/** Opacity the viewport draws a slot at: its own state times its bone chain's (hidden = 0, dimmed = 0.25). */
export function slotOpacity(slotId: string): number {
  return showImages() ? eyeOpacity(slotId) : 0;
}

/** The eye buttons' part of slotOpacity, ignoring View → Attachments (the Z view shows parts even with images off). */
export function eyeOpacity(slotId: string): number {
  const v = vis();
  if (!Object.keys(v).length) return 1;
  const d = doc();
  const slot = d.skeleton.slots.find((s) => s.id === slotId);
  if (!slot) return 1;
  const f = (s: Vis | undefined) => (s === "hidden" ? 0 : s === "dim" ? DIM : 1);
  let a = f(v[slot.id]);
  let bone = d.skeleton.bones.find((b) => b.id === slot.bone);
  while (bone && a > 0) {
    a *= f(v[bone.id]);
    bone = bone.parent ? d.skeleton.bones.find((b) => b.id === bone!.parent) : undefined;
  }
  return a;
}

// ---- draw order (z): slots later in the list draw on top ----
export type Reorder = "front" | "forward" | "backward" | "back";
export function reorderSlot(slotId: string, where: Reorder) {
  const slots = store.doc.skeleton.slots;
  const i = slots.findIndex((s) => s.id === slotId);
  if (i < 0) return;
  const last = slots.length - 1;
  const to = where === "front" ? last : where === "back" ? 0 : where === "forward" ? Math.min(last, i + 1) : Math.max(0, i - 1);
  if (to === i) return toast(where === "front" || where === "forward" ? "Already in front of everything" : "Already behind everything");
  apply("updateSlot", { slot: slotId, index: to });
}

/** Shift+H, the Skeleton header button and the context menu: show only the selection, or everything again. */
export function toggleIsolateSelection() {
  if (isIsolated()) return endIsolate();
  isolate(selectedSlotIds(), selectedBoneIds());
}

/** L: lock or unlock the selected parts and bones. */
export function toggleLockSelection() {
  const ids = [...selectedSlotIds(), ...selectedBoneIds()];
  if (!ids.length) return toast("Select a part or a bone to lock it", "info");
  const lock = !ids.every((id) => isLocked(id));
  for (const id of ids) setLocked(id, lock);
  toast(lock ? `Locked ${ids.length === 1 ? "it" : `${ids.length} items`}: it can't be clicked in the viewport (unlock in the Skeleton tree or with L)` : "Unlocked", "info");
}
