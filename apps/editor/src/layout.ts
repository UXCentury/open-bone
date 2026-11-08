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
  /**
   * A second tab group sharing the dock (split): below the first in the left/right docks, beside it in the bottom
   * dock. `ratio` is the share of the dock the first group takes.
   */
  split?: { panels: PanelId[]; active: PanelId | null; ratio: number };
}

/** Which tab group of a dock: the first, or the split one. */
export type GroupId = "main" | "split";

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
    const sp = s.split;
    if (sp && Array.isArray(sp.panels)) {
      const sPanels = sp.panels.filter((p): p is PanelId => p in PANELS && !seen.has(p));
      sPanels.forEach((p) => seen.add(p));
      const ratio = typeof sp.ratio === "number" && Number.isFinite(sp.ratio) ? Math.min(0.85, Math.max(0.15, sp.ratio)) : 0.6;
      const active = sp.active && sPanels.includes(sp.active) ? sp.active : (sPanels[0] ?? null);
      if (sPanels.length) {
        if (!panels.length) out[d] = { panels: sPanels, active, size };
        else out[d].split = { panels: sPanels, active, ratio };
      }
    }
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

const cloneDock = (d: DockState): DockState => ({ ...d, panels: [...d.panels], ...(d.split ? { split: { ...d.split, panels: [...d.split.panels] } } : {}) });
const clone = (l: Layout): Layout => ({ left: cloneDock(l.left), right: cloneDock(l.right), bottom: cloneDock(l.bottom) });

/** The tab group object of a dock (the dock itself for "main"). */
const groupOf = (d: DockState, g: GroupId): { panels: PanelId[]; active: PanelId | null } | undefined => (g === "main" ? d : d.split);

/** Where a panel is docked: its dock and tab group. */
export function whereIs(panel: PanelId): { dock: DockId; group: GroupId } {
  for (const d of DOCKS) {
    if (layout()[d].panels.includes(panel)) return { dock: d, group: "main" };
    if (layout()[d].split?.panels.includes(panel)) return { dock: d, group: "split" };
  }
  return { dock: "bottom", group: "main" };
}
export const dockOf = (panel: PanelId): DockId => whereIs(panel).dock;

/** After removing tabs: an emptied split disappears; an emptied first group is replaced by the split. */
function tidy(d: DockState) {
  if (d.split && !d.split.panels.length) delete d.split;
  if (!d.panels.length && d.split) {
    d.panels = d.split.panels;
    d.active = d.split.active;
    delete d.split;
  }
}

/**
 * Move a panel into a dock's tab group (at `index` among its tabs, default last) and make it active there.
 * group "newSplit" splits the dock: the panel opens in a second group below (side docks) or beside (bottom dock);
 * if the dock is already split it joins the split group.
 */
export function movePanel(panel: PanelId, to: DockId, index?: number, group: GroupId | "newSplit" = "main") {
  const l = clone(layout());
  const from = whereIs(panel);
  const src = groupOf(l[from.dock], from.group)!;
  const i = src.panels.indexOf(panel);
  if (i >= 0) {
    src.panels.splice(i, 1);
    if (from.dock === to && from.group === group && index !== undefined && index > i) index--;
    if (src.active === panel) src.active = src.panels[Math.max(0, i - 1)] ?? null;
  }
  const dock = l[to];
  // A split needs something left in the first group; otherwise it is just a move into the dock.
  if (group === "newSplit" && !dock.panels.length) group = "main";
  if (group === "newSplit") {
    dock.split ??= { panels: [], active: null, ratio: 0.6 };
    group = "split";
  }
  const target = groupOf(dock, group) ?? dock;
  const at = Math.max(0, Math.min(index ?? target.panels.length, target.panels.length));
  target.panels.splice(at, 0, panel);
  target.active = panel;
  for (const d of DOCKS) tidy(l[d]);
  setLayout(l);
}

export function setActive(dock: DockId, panel: PanelId) {
  const l = clone(layout());
  const g: GroupId = l[dock].split?.panels.includes(panel) ? "split" : "main";
  const target = groupOf(l[dock], g)!;
  if (target.active === panel) return;
  target.active = panel;
  setLayout(l);
}

/** Share of a split dock the first group takes (0.15 .. 0.85). */
export function setSplitRatio(dock: DockId, ratio: number, persist = true) {
  const l = clone(layout());
  if (!l[dock].split) return;
  l[dock].split!.ratio = Math.min(0.85, Math.max(0.15, ratio));
  if (persist) setLayout(l);
  else setLayoutRaw(l);
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

/** Every panel in a dock (both groups). */
export const dockPanels = (d: DockState): PanelId[] => [...d.panels, ...(d.split?.panels ?? [])];

export function swapSides() {
  const l = clone(layout());
  [l.left, l.right] = [l.right, l.left];
  setLayout(l);
}

/** Panel currently being dragged (for drop-zone highlighting). */
export const [draggingPanel, setDraggingPanel] = createSignal<PanelId | null>(null);
