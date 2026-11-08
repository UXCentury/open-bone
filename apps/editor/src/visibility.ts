import { createSignal } from "solid-js";
import { apply, doc, store, toast } from "./state.ts";

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
export const showAll = () => setVis({});

const DIM = 0.25;
/** Opacity the viewport draws a slot at: its own state times its bone chain's (hidden = 0, dimmed = 0.25). */
export function slotOpacity(slotId: string): number {
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
