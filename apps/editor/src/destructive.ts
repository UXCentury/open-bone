import { descendantIds } from "@openbone/core";
import { askConfirm, confirmDelete, count } from "./dialogs.tsx";
import { apply, fileName, modified, setSelection, store } from "./state.ts";

/**
 * Confirmed deletes for the rig items more than one place can delete (Inspector buttons, the Delete key, menus).
 * Each message says what else goes with the item, so a click on the wrong row doesn't silently take half a rig.
 */

const q = (name: string) => `“${name}”`;
const listNames = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));

/** Attachments (in every skin) on the given slots. */
function attachmentCount(slotIds: Set<string>) {
  let n = 0;
  for (const skin of store.doc.skeleton.skins) for (const id of slotIds) n += Object.keys(skin.attachments[id] ?? {}).length;
  return n;
}

export function deleteBoneAsk(id: string) {
  const d = store.doc;
  const bone = d.skeleton.bones.find((b) => b.id === id);
  if (!bone) return Promise.resolve(false);
  const ids = descendantIds(d, id);
  const children = d.skeleton.bones.filter((b) => b.id !== id && ids.has(b.id));
  const slots = d.skeleton.slots.filter((s) => ids.has(s.bone));
  const parts: string[] = [];
  if (children.length) parts.push(`its ${count(children.length, "child bone")} (${listNames(children.map((b) => b.name))})`);
  if (slots.length) parts.push(`${count(slots.length, "slot")} with ${count(attachmentCount(new Set(slots.map((s) => s.id))), "attachment")}`);
  const detail = parts.length ? `This also removes ${parts.join(" and ")}, and their keys and constraints.` : "Its keys and constraints are removed too.";
  return confirmDelete(`bone ${q(bone.name)}`, detail, () => apply("deleteBone", { bone: id }) !== undefined && setSelection(null));
}

export function deleteSlotAsk(id: string) {
  const slot = store.doc.skeleton.slots.find((s) => s.id === id);
  if (!slot) return Promise.resolve(false);
  const n = attachmentCount(new Set([id]));
  return confirmDelete(`slot ${q(slot.name)}`, `${n ? `Its ${count(n, "attachment")} and ` : "Its "}keys are removed too.`, () => apply("deleteSlot", { slot: id }) !== undefined && setSelection(null));
}

export function deleteAttachmentAsk(slot: string, attachment: string, skin: string, verb = "Delete") {
  const skinName = store.doc.skeleton.skins.find((k) => k.id === skin)?.name ?? "";
  const detail = verb === "Delete" ? "Keys that show it are removed too." : `The ${q(skinName)} skin shows the default skin's version again.`;
  return confirmDelete(verb === "Delete" ? `attachment ${q(attachment)}` : `${q(skinName)}'s version of ${q(attachment)}`, detail, () => apply("deleteAttachment", { slot, attachment, skin }), verb);
}

export function deleteConstraintAsk(id: string, kind: string) {
  const sk = store.doc.skeleton;
  const c = [...sk.ik, ...sk.transform, ...(sk.path ?? []), ...(sk.physics ?? [])].find((x) => x.id === id);
  return confirmDelete(`${kind} constraint ${q(c?.name ?? id)}`, "Its keys are removed too. The bones stay.", () => apply("deleteConstraint", { constraint: id }) !== undefined && setSelection(null));
}

/**
 * Before replacing the open project (new, open, example): ask when it has unsaved changes, since its undo
 * history goes with it. `what` completes "… replaces it", e.g. "Opening “walker”".
 */
export async function confirmDiscard(what: string): Promise<boolean> {
  if (!modified()) return true;
  return askConfirm({
    title: "Discard unsaved changes?",
    message: `“${fileName()}” has changes that aren't saved. ${what} replaces it, and its undo history can't bring it back. Save first to keep them.`,
    confirmLabel: "Discard changes",
    danger: true,
  });
}
