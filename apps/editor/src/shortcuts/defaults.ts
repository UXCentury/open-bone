import type { ShortcutDef } from "./keymap.ts";

/**
 * Every editor shortcut with its default keys. Actions are attached at runtime (see `./index.ts`), so this list
 * stays pure data for tests and the reference dialog.
 *
 * Defaults avoid keys browsers and desktop shells keep for themselves (Ctrl/⌘+W/T/N/Q/R/L/P/H/M, Ctrl/⌘+digits,
 * Alt+digits which switch tabs in Chrome on Linux) so they behave the same in a browser tab and in the Tauri app.
 * `Mod` = ⌘ on macOS, Ctrl on Windows/Linux.
 */
export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  // ---- File
  { id: "file.save", label: "Save", group: "File", keys: ["Mod+S"], scope: "global", inInputs: true },
  { id: "file.saveAs", label: "Save as…", group: "File", keys: ["Mod+Shift+S"], scope: "global", inInputs: true },
  { id: "file.open", label: "Open…", group: "File", keys: ["Mod+O"], scope: "editor" },
  { id: "file.export", label: "Export…", group: "File", keys: ["Mod+E"], scope: "editor", inInputs: true },

  // ---- Edit
  { id: "edit.undo", label: "Undo", group: "Edit", keys: ["Mod+Z"], scope: "editor" },
  { id: "edit.redo", label: "Redo", group: "Edit", keys: ["Mod+Shift+Z", "Mod+Y"], scope: "editor" },
  { id: "edit.delete", label: "Delete selection / vertices", group: "Edit", keys: ["Delete", "Backspace"], scope: "editor" },
  { id: "edit.duplicate", label: "Duplicate bone or slot", group: "Edit", keys: ["Mod+D"], scope: "editor" },
  { id: "edit.deselect", label: "Deselect", group: "Edit", keys: ["Escape"], scope: "editor" },
  { id: "edit.selectAllVertices", label: "Select all vertices (Mesh tool)", group: "Edit", keys: ["Mod+A"], scope: "editor" },
  { id: "edit.nudgeLeft", label: "Nudge vertices left (Shift: ×10)", group: "Edit", keys: ["ArrowLeft", "Shift+ArrowLeft"], scope: "editor", repeat: true },
  { id: "edit.nudgeRight", label: "Nudge vertices right (Shift: ×10)", group: "Edit", keys: ["ArrowRight", "Shift+ArrowRight"], scope: "editor", repeat: true },
  { id: "edit.nudgeUp", label: "Nudge vertices up (Shift: ×10)", group: "Edit", keys: ["ArrowUp", "Shift+ArrowUp"], scope: "editor", repeat: true },
  { id: "edit.nudgeDown", label: "Nudge vertices down (Shift: ×10)", group: "Edit", keys: ["ArrowDown", "Shift+ArrowDown"], scope: "editor", repeat: true },

  // ---- Tools
  { id: "tool.select", label: "Select / rotate tool", group: "Tools", keys: ["V", "R"], scope: "editor" },
  { id: "tool.translate", label: "Translate tool", group: "Tools", keys: ["T"], scope: "editor" },
  { id: "tool.scale", label: "Scale tool", group: "Tools", keys: ["S"], scope: "editor" },
  { id: "tool.bone", label: "Create bone tool", group: "Tools", keys: ["B"], scope: "editor" },
  { id: "tool.mesh", label: "Mesh edit tool", group: "Tools", keys: ["M"], scope: "editor" },
  { id: "tool.weights", label: "Weight paint tool", group: "Tools", keys: ["W"], scope: "editor" },

  // ---- View
  { id: "view.fit", label: "Fit artboard", group: "View", keys: ["F", "Shift+1"], scope: "editor" },
  { id: "view.focus", label: "Focus selection", group: "View", keys: ["Shift+2"], scope: "editor" },
  { id: "view.zoomIn", label: "Zoom in", group: "View", keys: ["=", "Plus"], scope: "editor", repeat: true },
  { id: "view.zoomOut", label: "Zoom out", group: "View", keys: ["-"], scope: "editor", repeat: true },
  { id: "view.zoom100", label: "Zoom to 100%", group: "View", keys: ["Shift+0"], scope: "editor" },
  { id: "view.grid", label: "Toggle grid", group: "View", keys: ["G"], scope: "editor" },
  { id: "view.rulers", label: "Toggle rulers and guides", group: "View", keys: ["Shift+R"], scope: "editor" },
  { id: "view.bones", label: "Toggle bones", group: "View", keys: ["Shift+B"], scope: "editor" },
  { id: "view.mesh", label: "Toggle mesh wireframe", group: "View", keys: ["Shift+M"], scope: "editor" },
  { id: "view.onion", label: "Toggle onion skin", group: "View", keys: ["O"], scope: "editor" },
  { id: "view.pan", label: "Pan", group: "View", keys: [], scope: "editor", fixed: "Space / Alt + drag, right or middle drag" },
  { id: "view.wheel", label: "Zoom at cursor", group: "View", keys: [], scope: "editor", fixed: "Mouse wheel / trackpad pinch" },

  // ---- Animate
  { id: "anim.playPause", label: "Play / pause animation", group: "Animate", keys: ["Space"], scope: "editor" },
  { id: "anim.prevFrame", label: "Previous frame", group: "Animate", keys: [","], scope: "editor", repeat: true },
  { id: "anim.nextFrame", label: "Next frame", group: "Animate", keys: ["."], scope: "editor", repeat: true },
  { id: "anim.prevKey", label: "Previous key", group: "Animate", keys: ["Shift+,"], scope: "editor", repeat: true },
  { id: "anim.nextKey", label: "Next key", group: "Animate", keys: ["Shift+."], scope: "editor", repeat: true },
  { id: "anim.first", label: "First frame", group: "Animate", keys: ["Home"], scope: "editor" },
  { id: "anim.last", label: "Last frame", group: "Animate", keys: ["End"], scope: "editor" },
  { id: "anim.setKey", label: "Key selected bone or slot", group: "Animate", keys: ["K"], scope: "editor" },
  { id: "mode.toggle", label: "Switch Setup / Animate", group: "Animate", keys: ["`"], scope: "editor" },

  // ---- Panels
  { id: "panel.hierarchy", label: "Show Skeleton panel", group: "Panels", keys: ["1"], scope: "editor" },
  { id: "panel.inspector", label: "Show Inspector", group: "Panels", keys: ["2"], scope: "editor" },
  { id: "panel.timeline", label: "Show Timeline", group: "Panels", keys: ["3"], scope: "editor" },
  { id: "panel.statemachine", label: "Show State Machine", group: "Panels", keys: ["4"], scope: "editor" },
  { id: "panel.scripts", label: "Show Scripts", group: "Panels", keys: ["5"], scope: "editor" },

  // ---- Play mode
  { id: "play.toggle", label: "Play / stop (Play mode)", group: "Play mode", keys: ["P", "Mod+Enter"], scope: "global" },
  { id: "play.stop", label: "Stop playing", group: "Play mode", keys: ["Escape"], scope: "play" },
  { id: "play.restart", label: "Restart", group: "Play mode", keys: ["R"], scope: "play" },
  { id: "play.pause", label: "Pause / resume", group: "Play mode", keys: ["Space"], scope: "play" },
  { id: "play.slower", label: "Slower", group: "Play mode", keys: ["["], scope: "play" },
  { id: "play.faster", label: "Faster", group: "Play mode", keys: ["]"], scope: "play" },
  { id: "play.fit", label: "Fit to view", group: "Play mode", keys: ["F"], scope: "play" },
  { id: "play.actual", label: "Actual size (1:1)", group: "Play mode", keys: ["1"], scope: "play" },
  { id: "play.fullWindow", label: "Full window", group: "Play mode", keys: ["Shift+F"], scope: "play" },

  // ---- Help
  { id: "help.shortcuts", label: "Keyboard shortcuts", group: "Help", keys: ["?"], scope: "global" },
];
