import { createSignal } from "solid-js";

/**
 * Editor workspace layout: three docks (left, right, bottom) around the viewport. Each dock holds panels as
 * tabs and has a size; panels can be dragged between docks. Saved per browser in localStorage.
 */

export type PanelId = "hierarchy" | "inspector" | "timeline" | "statemachine" | "scripts" | "preview" | "outline";
export type DockId = "left" | "right" | "bottom";

export interface DockState {
  panels: PanelId[];
  active: PanelId | null;
  /** Width (left/right) or height (bottom) in CSS px. */
  size: number;
}

export type Layout = Record<DockId, DockState>;

export const PANELS: Record<PanelId, { title: string }> = {
  hierarchy: { title: "Skeleton" },
  inspector: { title: "Inspector" },
  timeline: { title: "Timeline" },
  statemachine: { title: "State Machine" },
  scripts: { title: "Scripts" },
  preview: { title: "Preview" },
  outline: { title: "Outline" },
};
export const DOCKS: DockId[] = ["left", "right", "bottom"];
export const DEFAULT_SIZE: Record<DockId, number> = { left: 250, right: 280, bottom: 290 };
export const MIN_SIZE: Record<DockId, number> = { left: 170, right: 200, bottom: 120 };

const KEY = "openbone.layout.v1";

export function defaultLayout(): Layout {
  return {
    left: { panels: ["hierarchy"], active: "hierarchy", size: DEFAULT_SIZE.left },
    right: { panels: ["inspector", "preview", "outline"], active: "inspector", size: DEFAULT_SIZE.right },
    bottom: { panels: ["timeline", "statemachine", "scripts"], active: "timeline", size: DEFAULT_SIZE.bottom },
  };
}

/** A stored layout is used if it is well-formed; each panel appears once (missing new panels are added). */
function sanitize(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<DockId, Partial<DockState>>>;
  const seen = new Set<PanelId>();
  const out = {} as Layout;
  for (const d of DOCKS) {
    const s = r[d];
    if (!s || !Array.isArray(s.panels)) return null;
    const panels = s.panels.filter((p): p is PanelId => p in PANELS && !seen.has(p));
    panels.forEach((p) => seen.add(p));
    const size = typeof s.size === "number" && Number.isFinite(s.size) ? Math.max(MIN_SIZE[d], s.size) : DEFAULT_SIZE[d];
    out[d] = { panels, active: s.active && panels.includes(s.active) ? s.active : (panels[0] ?? null), size };
  }
  if (!seen.size) return null;
  // Panels added in a newer version join the right dock, so a saved layout survives upgrades.
  for (const p of Object.keys(PANELS) as PanelId[]) if (!seen.has(p)) out.right.panels.push(p);
  out.right.active ??= out.right.panels[0] ?? null;
  return out;
}

function load(): Layout {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "null")) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

const [layout, setLayoutRaw] = createSignal<Layout>(load());
export { layout };

function setLayout(next: Layout) {
  setLayoutRaw(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: layout still works for this session */
  }
}

const clone = (l: Layout): Layout => ({
  left: { ...l.left, panels: [...l.left.panels] },
  right: { ...l.right, panels: [...l.right.panels] },
  bottom: { ...l.bottom, panels: [...l.bottom.panels] },
});

export const dockOf = (panel: PanelId): DockId => DOCKS.find((d) => layout()[d].panels.includes(panel)) ?? "bottom";

/** Move a panel to a dock (at `index` among its tabs, default last) and make it the active tab there. */
export function movePanel(panel: PanelId, to: DockId, index?: number) {
  const l = clone(layout());
  const from = DOCKS.find((d) => l[d].panels.includes(panel));
  if (from) {
    const i = l[from].panels.indexOf(panel);
    l[from].panels.splice(i, 1);
    if (from === to && index !== undefined && index > i) index--;
    if (l[from].active === panel) l[from].active = l[from].panels[Math.max(0, i - 1)] ?? null;
  }
  const at = Math.max(0, Math.min(index ?? l[to].panels.length, l[to].panels.length));
  l[to].panels.splice(at, 0, panel);
  l[to].active = panel;
  setLayout(l);
}

export function setActive(dock: DockId, panel: PanelId) {
  if (layout()[dock].active === panel) return;
  const l = clone(layout());
  l[dock].active = panel;
  setLayout(l);
}

/** Bring a panel to the front wherever it is docked. */
export function showPanel(panel: PanelId) {
  setActive(dockOf(panel), panel);
}

export function setDockSize(dock: DockId, size: number, persist = true) {
  const l = clone(layout());
  l[dock].size = Math.round(Math.max(MIN_SIZE[dock], size));
  if (persist) setLayout(l);
  else setLayoutRaw(l);
}

export function resetLayout() {
  setLayout(defaultLayout());
}

export function swapSides() {
  const l = clone(layout());
  [l.left, l.right] = [l.right, l.left];
  setLayout(l);
}

/** Panel currently being dragged (for drop-zone highlighting). */
export const [draggingPanel, setDraggingPanel] = createSignal<PanelId | null>(null);
