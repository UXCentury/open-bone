import { For, type JSX, Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import {
  DEFAULT_SIZE,
  type DockId,
  type GroupId,
  MIN_SIZE,
  PANELS,
  type PanelId,
  draggingPanel,
  layout,
  movePanel,
  setActive,
  setDockSize,
  setDraggingPanel,
  setSplitRatio,
} from "../layout.ts";
import { Hierarchy } from "./Hierarchy.tsx";
import { Inspector } from "./Inspector.tsx";
import { ScriptsPanel } from "./ScriptsPanel.tsx";
import { StateMachinePanel } from "./StateMachinePanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { OutlinePanel, PreviewPanel } from "./Preview.tsx";

function PanelContent(p: { id: PanelId }) {
  return (
    <Switch>
      <Match when={p.id === "hierarchy"}>
        <Hierarchy />
      </Match>
      <Match when={p.id === "inspector"}>
        <Inspector />
      </Match>
      <Match when={p.id === "timeline"}>
        <Timeline />
      </Match>
      <Match when={p.id === "statemachine"}>
        <StateMachinePanel />
      </Match>
      <Match when={p.id === "scripts"}>
        <ScriptsPanel />
      </Match>
      <Match when={p.id === "preview"}>
        <PreviewPanel />
      </Match>
      <Match when={p.id === "outline"}>
        <OutlinePanel />
      </Match>
    </Switch>
  );
}

// ---------------- drag & drop ----------------

type Drop = { dock: DockId; index?: number; group?: GroupId | "newSplit"; rect: DOMRect };
const [ghost, setGhost] = createSignal<{ x: number; y: number; title: string } | null>(null);
const [drop, setDrop] = createSignal<Drop | null>(null);

const EDGE = 90;

/** Where a panel dropped at (x, y) would go: onto a tab strip (at a position), into a dock, or onto an empty edge. */
function dropTarget(x: number, y: number): Drop | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const tabs = el?.closest<HTMLElement>(".dock-tabs[data-dock]");
  if (tabs) {
    const dock = tabs.dataset.dock as DockId;
    const group = (tabs.dataset.group ?? "main") as GroupId;
    const items = [...tabs.querySelectorAll<HTMLElement>(".dock-tab")];
    let index = items.findIndex((t) => {
      const r = t.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    if (index < 0) index = items.length;
    return { dock, index, group, rect: tabs.closest<HTMLElement>(".dock-group")!.getBoundingClientRect() };
  }
  const groupEl = el?.closest<HTMLElement>(".dock-group[data-dock]");
  if (groupEl) {
    const dock = groupEl.dataset.dock as DockId;
    const group = (groupEl.dataset.group ?? "main") as GroupId;
    const r = groupEl.getBoundingClientRect();
    // The far part of an unsplit dock (bottom of a side dock, right of the bottom dock) splits it.
    if (group === "main" && !layout()[dock].split) {
      const side = dock !== "bottom";
      const t = side ? (y - r.top) / r.height : (x - r.left) / r.width;
      if (t > 0.6) return { dock, group: "newSplit", rect: side ? new DOMRect(r.left, r.top + r.height * 0.5, r.width, r.height * 0.5) : new DOMRect(r.left + r.width * 0.5, r.top, r.width * 0.5, r.height) };
    }
    return { dock, group, rect: r };
  }
  const dockEl = el?.closest<HTMLElement>(".dock[data-dock]");
  if (dockEl) return { dock: dockEl.dataset.dock as DockId, rect: dockEl.getBoundingClientRect() };
  const main = document.querySelector<HTMLElement>(".main")?.getBoundingClientRect();
  if (!main || x < main.left || x > main.right || y < main.top || y > main.bottom) return null;
  const strip = (l: number, t: number, w: number, h: number) => new DOMRect(l, t, w, h);
  const docked = (d: DockId) => document.querySelector<HTMLElement>(`.dock[data-dock="${d}"]`)?.getBoundingClientRect();
  if (x < main.left + EDGE) return { dock: "left", rect: docked("left") ?? strip(main.left, main.top, DEFAULT_SIZE.left, main.height) };
  if (x > main.right - EDGE) return { dock: "right", rect: docked("right") ?? strip(main.right - DEFAULT_SIZE.right, main.top, DEFAULT_SIZE.right, main.height) };
  if (y > main.bottom - EDGE) {
    const center = document.querySelector<HTMLElement>(".center")!.getBoundingClientRect();
    return { dock: "bottom", rect: docked("bottom") ?? strip(center.left, main.bottom - DEFAULT_SIZE.bottom, center.width, DEFAULT_SIZE.bottom) };
  }
  return null;
}

/** Tab pointer-down: a click activates the tab, a drag (> 5px) moves the panel to another dock or position. */
function startTabDrag(e: PointerEvent, dock: DockId, panel: PanelId) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (m: PointerEvent) => {
    if (!dragging && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return;
    if (!dragging) {
      dragging = true;
      setDraggingPanel(panel);
      document.body.classList.add("dragging-panel");
    }
    setGhost({ x: m.clientX, y: m.clientY, title: PANELS[panel].title });
    setDrop(dropTarget(m.clientX, m.clientY));
  };
  const end = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging-panel");
    const d = drop();
    setGhost(null);
    setDrop(null);
    setDraggingPanel(null);
    if (!dragging) {
      if (commit) setActive(dock, panel);
      return;
    }
    if (commit && d) movePanel(panel, d.dock, d.index, d.group === "newSplit" ? "newSplit" : (d.group ?? "main"));
  };
  const up = () => end(true);
  const key = (k: KeyboardEvent) => {
    if (k.key === "Escape") {
      k.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}

/** Floating tab label and drop preview while a panel is being dragged. */
export function DragOverlay() {
  return (
    <>
      <Show when={drop()}>
        {(d) => (
          <div
            class="drop-preview"
            style={{ left: `${d().rect.left}px`, top: `${d().rect.top}px`, width: `${d().rect.width}px`, height: `${d().rect.height}px` }}
          >
            <span>{d().group === "newSplit" ? "Split" : d().index !== undefined ? "Add as tab" : `Dock ${d().dock}`}</span>
          </div>
        )}
      </Show>
      <Show when={ghost()}>{(g) => <div class="drag-ghost" style={{ left: `${g().x + 12}px`, top: `${g().y + 8}px` }}>{g().title}</div>}</Show>
    </>
  );
}

// ---------------- docks ----------------

/** One tab group: a tab strip and the active panel. */
function TabGroup(p: { dock: DockId; group: GroupId; panels: PanelId[]; active: PanelId | null; style?: JSX.CSSProperties }) {
  return (
    <div class="dock-group" data-dock={p.dock} data-group={p.group} style={p.style}>
      <div class="dock-tabs" data-dock={p.dock} data-group={p.group} role="tablist" aria-label={`${p.dock} dock${p.group === "split" ? " (split)" : ""}`}>
        <For each={p.panels}>
          {(panel) => (
            <button
              class="dock-tab"
              role="tab"
              aria-selected={p.active === panel}
              classList={{ active: p.active === panel, dragged: draggingPanel() === panel }}
              title="Drag to move this panel: onto a tab strip to group it, to another side, or to the lower part of a dock to split it"
              onPointerDown={(e) => startTabDrag(e, p.dock, panel)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(p.dock, panel)}
            >
              {PANELS[panel].title}
            </button>
          )}
        </For>
      </div>
      <div class="dock-body" role="tabpanel">
        <Show when={p.active} keyed>
          {(id) => <PanelContent id={id} />}
        </Show>
      </div>
    </div>
  );
}

/** Divider between the two groups of a split dock. Double-click evens them out. */
function GroupSplitter(p: { dock: DockId }) {
  const side = p.dock !== "bottom";
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const box = el.parentElement!.getBoundingClientRect();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    document.body.classList.add(side ? "resizing-y" : "resizing-x");
    const ratio = (m: PointerEvent) => (side ? (m.clientY - box.top) / box.height : (m.clientX - box.left) / box.width);
    const move = (m: PointerEvent) => setSplitRatio(p.dock, ratio(m), false);
    const up = (m: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      setSplitRatio(p.dock, ratio(m), true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div
      class={`group-splitter ${side ? "splitter-y" : "splitter-x"}`}
      role="separator"
      aria-orientation={side ? "horizontal" : "vertical"}
      title="Drag to resize the two groups · double-click to even them"
      onPointerDown={down}
      onDblClick={() => setSplitRatio(p.dock, 0.5)}
    />
  );
}

export function Dock(p: { id: DockId }) {
  const state = () => layout()[p.id];
  const style = (): JSX.CSSProperties =>
    p.id === "bottom" ? { height: `min(${state().size}px, calc(100% - 140px))` } : { width: `min(${state().size}px, 45vw)` };
  const share = (r: number): JSX.CSSProperties => ({ flex: `${r} 1 0` });
  return (
    <Show when={state().panels.length}>
      <section class={`dock dock-${p.id}`} classList={{ "dock-split": !!state().split }} data-dock={p.id} style={style()}>
        <TabGroup dock={p.id} group="main" panels={state().panels} active={state().active} style={state().split ? share(state().split!.ratio) : { flex: "1 1 0" }} />
        <Show when={state().split}>
          {(sp) => (
            <>
              <GroupSplitter dock={p.id} />
              <TabGroup dock={p.id} group="split" panels={sp().panels} active={sp().active} style={share(1 - sp().ratio)} />
            </>
          )}
        </Show>
      </section>
    </Show>
  );
}

/** Drag handle that resizes a dock. Double-click resets; arrow keys nudge when focused. */
export function Splitter(p: { dock: DockId }) {
  const vertical = p.dock !== "bottom";
  let cleanup: (() => void) | null = null;
  onCleanup(() => cleanup?.());
  const sizeAt = (x: number, y: number) => {
    const main = document.querySelector<HTMLElement>(".main")!.getBoundingClientRect();
    const center = document.querySelector<HTMLElement>(".center")!.getBoundingClientRect();
    if (p.dock === "left") return Math.min(x - main.left, main.width * 0.45);
    if (p.dock === "right") return Math.min(main.right - x, main.width * 0.45);
    return Math.min(center.bottom - y, center.height - 140);
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(vertical ? "resizing-x" : "resizing-y");
    const move = (m: PointerEvent) => setDockSize(p.dock, sizeAt(m.clientX, m.clientY), false);
    const up = () => {
      cleanup?.();
      setDockSize(p.dock, layout()[p.dock].size, true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    cleanup = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      cleanup = null;
    };
  };
  const key = (e: KeyboardEvent) => {
    const grow = p.dock === "right" ? ["ArrowLeft"] : p.dock === "left" ? ["ArrowRight"] : ["ArrowUp"];
    const shrink = p.dock === "right" ? ["ArrowRight"] : p.dock === "left" ? ["ArrowLeft"] : ["ArrowDown"];
    const step = e.shiftKey ? 64 : 16;
    if (grow.includes(e.key)) setDockSize(p.dock, layout()[p.dock].size + step);
    else if (shrink.includes(e.key)) setDockSize(p.dock, layout()[p.dock].size - step);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <Show when={layout()[p.dock].panels.length}>
      <div
        class={`splitter ${vertical ? "splitter-x" : "splitter-y"}`}
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-valuemin={MIN_SIZE[p.dock]}
        aria-valuenow={layout()[p.dock].size}
        aria-label={`Resize ${p.dock} panel`}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={down}
        onDblClick={() => setDockSize(p.dock, DEFAULT_SIZE[p.dock])}
        onKeyDown={key}
      />
    </Show>
  );
}
