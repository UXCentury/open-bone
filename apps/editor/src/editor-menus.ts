import { createDocument } from "@openbone/core";
import { confirmDiscard } from "./destructive.ts";
import { createSignal } from "solid-js";
import { bridgeStatus } from "./bridge.ts";
import { saveProjectToFolder } from "./storage.ts";
import { toggleWatching, watchFolder, watchedFolders, watching } from "./watch.ts";
import { toggleViewAid, viewAids } from "./guides.ts";
import { PANELS, type PanelId, movePanel, resetLayout, showPanel, swapSides, whereIs } from "./layout.ts";
import type { MenuItem } from "./menu.tsx";
import { cycleVisTo, showImages, visOf } from "./visibility.ts";
import { view3d, zView } from "./zview.ts";
import { type AttTransform, type BoneTransform, attTransformsFor, transformAttachment, transformBone } from "./transform-actions.ts";
import { getAttachment } from "@openbone/core";
import { activeSkin, compensate } from "./state.ts";
import { importFromProject } from "./panels/ImportDialog.tsx";
import { moveToFolder } from "./panels/Folders.tsx";
import { penMenuItems } from "./tools/pen.ts";

const ATT_LABELS: Record<AttTransform, string> = {
  flipX: "Flip horizontally",
  flipY: "Flip vertically",
  rot90: "Rotate 90° clockwise",
  "rot-90": "Rotate 90° counter-clockwise",
  rot180: "Rotate 180°",
  "skewX+": "Skew X +15°",
  "skewX-": "Skew X −15°",
  "skewY+": "Skew Y +15°",
  "skewY-": "Skew Y −15°",
  reset: "Reset rotation, scale and skew",
};
/** Transform submenu for a bone: mirror (children follow), rotate, skew, reset. */
const boneTransformMenu = (boneId: string): MenuItem => {
  const it = (label: string, op: BoneTransform): MenuItem => ({ label, action: () => transformBone(boneId, op) });
  const hasChildren = store.doc.skeleton.bones.some((x) => x.parent === boneId);
  return {
    // Say what happens to the child bones (Compensate decides), so flipping an upper arm doesn't surprise anyone.
    label: !hasChildren ? "Transform bone" : compensate() ? "Transform bone (children stay)" : "Transform bone (children follow)",
    submenu: [
      it("Flip horizontally (mirror)", "flipX"),
      it("Flip vertically", "flipY"),
      "sep",
      it("Rotate 90° clockwise", "rot90"),
      it("Rotate 90° counter-clockwise", "rot-90"),
      it("Rotate 180°", "rot180"),
      "sep",
      it("Skew X +15°", "skewX+"),
      it("Skew X −15°", "skewX-"),
      it("Skew Y +15°", "skewY+"),
      it("Skew Y −15°", "skewY-"),
      "sep",
      it("Reset rotation and scale", "resetRS"),
      it("Reset skew", "resetSkew"),
    ],
  };
};
/** Transform submenu for one attachment (flip, rotate, skew, reset the image itself; the bone is untouched). */
function partTransformMenu(slotId: string, attName: string | null | undefined): MenuItem[] {
  const att = attName ? getAttachment(store.doc, slotId, attName, activeSkin()?.id) : null;
  const ops = attTransformsFor(att);
  if (!att || !attName || !ops.length) return [];
  return [
    {
      label: `Transform “${attName}”`,
      submenu: ops.flatMap((op, i) => [
        ...((op === "rot90" || op === "skewX+") && i > 0 ? (["sep"] as MenuItem[]) : op === "reset" ? (["sep"] as MenuItem[]) : []),
        { label: ATT_LABELS[op], action: () => transformAttachment(slotId, attName, op) } as MenuItem,
      ]),
    },
  ];
}
import { playActive } from "./play.ts";
import { setShortcutsOpen } from "./shortcuts/actions.ts";
import { toast, loadDocument, mode, onionSkin, selection, setSelection, showBones, showMesh, store, apply, tool, setTool, type Tool } from "./state.ts";

/** Examples gallery visibility. */
export const [examplesOpen, setExamplesOpen] = createSignal(false);
/** About dialog visibility. */
export const [aboutOpen, setAboutOpen] = createSignal(false);

export async function newProject() {
  if (await confirmDiscard("Starting a new project")) loadDocument(createDocument("Untitled"), "untitled.obone");
}

const layoutItems = (): MenuItem[] => [
  { label: "Swap left and right panels", action: swapSides },
  {
    label: "Preview under the Inspector (split)",
    action: () => {
      if (whereIs("inspector").dock !== "right") movePanel("inspector", "right", 0);
      movePanel("preview", "right", undefined, "newSplit");
    },
  },
  "sep",
  { label: "Reset to default layout", action: resetLayout },
];

const panelItems = (): MenuItem[] => (Object.keys(PANELS) as PanelId[]).map((id) => ({ label: PANELS[id].title, action: () => showPanel(id) }));

/** Folder names (last path part), shortened for a menu label. */
const shortList = (paths: string[]) => {
  const s = paths.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p).join(", ");
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/** The toolbar's Menu button. */
export function mainMenu(): MenuItem[] {
  const locked = playActive();
  return [
    { label: "New project", action: newProject, disabled: locked },
    { label: "Open…", shortcut: "file.open", disabled: locked },
    { label: "Save", shortcut: "file.save" },
    { label: "Save as…", shortcut: "file.saveAs" },
    { label: "Save to folder…", action: () => void saveProjectToFolder().catch((e) => toast((e as Error).message, "error")) },
    { label: "Export…", shortcut: "file.export", disabled: locked },
    { label: "Import from project…", action: () => void importFromProject(), disabled: locked },
    "sep",
    { label: watching() ? `Watch art for changes (${shortList(watchedFolders())})` : "Watch art for changes", checked: watching(), action: () => void toggleWatching().catch((e) => toast((e as Error).message, "error")) },
    { label: "Watch folder…", action: () => void watchFolder().catch((e) => toast((e as Error).message, "error")) },
    "sep",
    { label: "Examples…", action: () => setExamplesOpen(true), disabled: locked },
    "sep",
    { label: "Layout", submenu: layoutItems(), disabled: locked },
    { label: "Show panel", submenu: panelItems(), disabled: locked },
    "sep",
    { label: "Keyboard shortcuts", shortcut: "help.shortcuts", action: () => setShortcutsOpen(true) },
    { label: "About OpenBone", action: () => setAboutOpen(true) },
  ];
}

const TOOLS: [Tool, string, string][] = [
  ["select", "Select / rotate", "tool.select"],
  ["translate", "Translate", "tool.translate"],
  ["scale", "Scale", "tool.scale"],
  ["pose", "Pose (IK)", "tool.pose"],
  ["bone", "Create bone", "tool.bone"],
  ["mesh", "Edit mesh", "tool.mesh"],
  ["weights", "Paint weights", "tool.weights"],
  ["pen", "Pen (paths, bounding boxes)", "tool.pen"],
];

function selectionItems(): MenuItem[] {
  const s = selection();
  if (!s) return [];
  const d = store.doc;
  if (s.kind === "bone") {
    const b = d.skeleton.bones.find((x) => x.id === s.id);
    if (!b) return [];
    return [
      {
        label: "Add child bone",
        action: () => {
          const res = apply("addBone", { parent: b.id, name: "bone", x: b.length || 40 }) as { id: string } | undefined;
          if (res) setSelection({ kind: "bone", id: res.id });
        },
      },
      // The bone's own parts, to flip or turn an image without touching the bone (or its children).
      ...d.skeleton.slots.filter((x) => x.bone === b.id).flatMap((x) => partTransformMenu(x.id, x.attachment)),
      boneTransformMenu(b.id),
      "sep",
      { label: "Duplicate", shortcut: "edit.duplicate", disabled: !b.parent },
      { label: "Focus in viewport", shortcut: "view.focus" },
      ...(mode() === "animate" ? [{ label: "Set key", shortcut: "anim.setKey" } as MenuItem] : []),
      "sep",
      { label: `Delete “${b.name}”`, shortcut: "edit.delete", danger: true, disabled: !b.parent },
    ];
  }
  if (s.kind === "slot") {
    const slot = d.skeleton.slots.find((x) => x.id === s.id);
    if (!slot) return [];
    const slots = d.skeleton.slots;
    const at = slots.indexOf(slot);
    return [
      {
        label: "Arrange",
        submenu: [
          { label: "Bring to front", shortcut: "edit.bringToFront", disabled: at === slots.length - 1 },
          { label: "Bring forward", shortcut: "edit.bringForward", disabled: at === slots.length - 1 },
          { label: "Send backward", shortcut: "edit.sendBackward", disabled: at === 0 },
          { label: "Send to back", shortcut: "edit.sendToBack", disabled: at === 0 },
        ],
      },
      ...partTransformMenu(slot.id, (s as { attachment?: string }).attachment ?? slot.attachment),
      boneTransformMenu(slot.bone),
      { label: visOf(slot.id) === "hidden" ? "Show" : "Hide", action: () => cycleVisTo(slot.id, visOf(slot.id) === "hidden" ? "shown" : "hidden") },
      { label: visOf(slot.id) === "dim" ? "Undim" : "Dim", action: () => cycleVisTo(slot.id, visOf(slot.id) === "dim" ? "shown" : "dim") },
      "sep",
      { label: "Duplicate", shortcut: "edit.duplicate" },
      { label: slot.folder ? `Move to folder… (now “${slot.folder}”)` : "Move to folder…", action: () => void moveToFolder("slot", slot.id, slot.folder) },
      { label: "Focus in viewport", shortcut: "view.focus" },
      ...(mode() === "animate" ? [{ label: "Set key", shortcut: "anim.setKey" } as MenuItem] : []),
      "sep",
      { label: `Delete “${slot.name}”`, shortcut: "edit.delete", danger: true },
    ];
  }
  return [];
}

const editItems = (): MenuItem[] => [
  { label: "Undo", shortcut: "edit.undo", disabled: bridgeStatus() !== "connected" && !store.canUndo },
  { label: "Redo", shortcut: "edit.redo", disabled: bridgeStatus() !== "connected" && !store.canRedo },
];

/** What a right-click shows, by where it happened. Null: no menu. */
export function contextItems(target: HTMLElement): MenuItem[] | null {
  if (playActive()) return null;
  // Tree rows select what they show first, like a left click.
  const row = target.closest<HTMLElement>(".tree-row");
  if (row) row.click();

  if (target.closest(".viewport")) {
    return [
      ...penMenuItems(),
      "sep",
      ...selectionItems(),
      "sep",
      ...editItems(),
      "sep",
      { label: "Tool", submenu: TOOLS.map(([id, label, sc]) => ({ label, shortcut: sc, checked: tool() === id, action: () => setTool(id) })) },
      "sep",
      { label: "Fit artboard", shortcut: "view.fit" },
      { label: "Zoom to 100%", shortcut: "view.zoom100" },
      "sep",
      { label: "Bones", shortcut: "view.bones", checked: showBones() },
      { label: "Mesh wireframe", shortcut: "view.mesh", checked: showMesh() },
      { label: "Attachments", shortcut: "view.attachments", checked: showImages() },
      { label: "Order view (draw order)", shortcut: "view.z", checked: zView() },
      { label: "3D view (layers in depth)", shortcut: "view.3d", checked: view3d() },
      { label: "Grid", checked: viewAids().grid, action: () => toggleViewAid("grid") },
      { label: "Rulers and guides", checked: viewAids().rulers, action: () => toggleViewAid("rulers") },
      { label: "Onion skin", shortcut: "view.onion", checked: onionSkin() },
    ];
  }
  if (row) return [...selectionItems(), "sep", ...editItems()];
  return [...editItems(), "sep", { label: "Save", shortcut: "file.save" }, { label: "Export…", shortcut: "file.export" }, { label: "Examples…", action: () => setExamplesOpen(true) }, "sep", { label: "Layout", submenu: layoutItems() }];
}
