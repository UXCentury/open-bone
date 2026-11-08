import { createDocument } from "@openbone/core";
import { createSignal } from "solid-js";
import { bridgeStatus } from "./bridge.ts";
import { askConfirm } from "./dialogs.tsx";
import { toggleViewAid, viewAids } from "./guides.ts";
import { PANELS, type PanelId, movePanel, resetLayout, showPanel, swapSides, whereIs } from "./layout.ts";
import type { MenuItem } from "./menu.tsx";
import { cycleVisTo, visOf } from "./visibility.ts";
import { playActive } from "./play.ts";
import { setShortcutsOpen } from "./shortcuts/actions.ts";
import { loadDocument, mode, onionSkin, selection, setSelection, showBones, showMesh, store, apply, tool, setTool, type Tool } from "./state.ts";

/** Examples gallery visibility. */
export const [examplesOpen, setExamplesOpen] = createSignal(false);

export async function newProject() {
  const ok = await askConfirm({
    title: "Start a new project?",
    message: "Unsaved changes to the current project will be lost. Save first if you want to keep them.",
    confirmLabel: "Discard and start new",
    danger: true,
  });
  if (ok) loadDocument(createDocument("Untitled"), "untitled.obone");
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

/** The toolbar's Menu button. */
export function mainMenu(): MenuItem[] {
  const locked = playActive();
  return [
    { label: "New project", action: newProject, disabled: locked },
    { label: "Open…", shortcut: "file.open", disabled: locked },
    { label: "Save", shortcut: "file.save" },
    { label: "Save as…", shortcut: "file.saveAs" },
    { label: "Export…", shortcut: "file.export", disabled: locked },
    "sep",
    { label: "Examples…", action: () => setExamplesOpen(true), disabled: locked },
    "sep",
    { label: "Layout", submenu: layoutItems(), disabled: locked },
    { label: "Show panel", submenu: panelItems(), disabled: locked },
    "sep",
    { label: "Keyboard shortcuts", shortcut: "help.shortcuts", action: () => setShortcutsOpen(true) },
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
      { label: visOf(slot.id) === "hidden" ? "Show" : "Hide", action: () => cycleVisTo(slot.id, visOf(slot.id) === "hidden" ? "shown" : "hidden") },
      { label: visOf(slot.id) === "dim" ? "Undim" : "Dim", action: () => cycleVisTo(slot.id, visOf(slot.id) === "dim" ? "shown" : "dim") },
      "sep",
      { label: "Duplicate", shortcut: "edit.duplicate" },
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
      { label: "Grid", checked: viewAids().grid, action: () => toggleViewAid("grid") },
      { label: "Rulers and guides", checked: viewAids().rulers, action: () => toggleViewAid("rulers") },
      { label: "Onion skin", shortcut: "view.onion", checked: onionSkin() },
    ];
  }
  if (row) return [...selectionItems(), "sep", ...editItems()];
  return [...editItems(), "sep", { label: "Save", shortcut: "file.save" }, { label: "Export…", shortcut: "file.export" }, { label: "Examples…", action: () => setExamplesOpen(true) }, "sep", { label: "Layout", submenu: layoutItems() }];
}
