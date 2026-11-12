import { ANY_STATE, type Condition, type ConditionOp, type InputData, type InputValue, type LayerData, type StateData, type TransitionData, validate } from "@openbone/core";
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { apply, currentStateMachine, doc, running, setRunning, setStateMachineId, toast } from "../state.ts";
import { eventLog, smInstance } from "./Viewport.tsx";
import { askForm, askText, confirmDelete, uniqueName } from "../dialogs.tsx";
import { StateSounds } from "./AudioPanel.tsx";
import { emitterSlots } from "./ParticlesInspector.tsx";
import { BindingList } from "./Bindings.tsx";

const W = 130;
const H = 40;

type GraphView = { x: number; y: number; z: number };
/** Pan/zoom per state machine + layer, kept across panel remounts (fit only the first time a graph is shown). */
const graphViews = new Map<string, GraphView>();

type Sel = { kind: "state"; id: string } | { kind: "transition"; id: string } | null;

export function StateMachinePanel() {
  const sm = currentStateMachine;
  const [layerId, setLayerId] = createSignal<string | null>(null);
  const layer = (): LayerData | null => {
    const s = sm();
    if (!s) return null;
    return s.layers.find((l) => l.id === layerId()) ?? s.layers[0] ?? null;
  };
  const [sel, setSel] = createSignal<Sel>(null);
  const [active, setActive] = createSignal<Record<string, string | null>>({});
  const [liveInputs, setLiveInputs] = createSignal<Record<string, InputValue>>({});
  const timer = setInterval(() => {
    const inst = smInstance();
    if (!inst) return;
    setActive(inst.activeStates);
    const vals: Record<string, InputValue> = {};
    for (const i of inst.data.inputs) vals[i.id] = inst.inputs.get(i.id) ?? false;
    setLiveInputs(vals);
  }, 80);
  onCleanup(() => clearInterval(timer));

  const smArgs = () => ({ stateMachine: sm()!.id, layer: layer()!.id });

  /** Slider range for a number input: 0..1, widened to cover its default and the ranges of bindings it drives. */
  const rangeOf = (id: string): [number, number] => {
    const s = sm()!;
    const i = s.inputs.find((x) => x.id === id);
    const vals = [0, 1, Number(i?.default ?? 0), ...(s.bindings ?? []).filter((b) => b.input === id).flatMap((b) => [b.inMin, b.inMax])];
    return [Math.min(...vals), Math.max(...vals)];
  };

  const editInput = async (i: InputData) => {
    const r = await askForm({
      title: `Input “${i.name}”`,
      confirmLabel: "Save",
      fields: [
        { key: "name", type: "text", label: "Name", value: i.name, validate: uniqueName(sm()!.inputs.map((x) => x.name), i.name) },
        ...(i.type === "trigger" ? [] : [{ key: "default", type: "text" as const, label: "Default", value: String(i.default), required: i.type !== "string" }]),
        ...(i.type === "bool" && doc().audio
          ? [
              {
                key: "mutes",
                type: "choice" as const,
                label: "Mutes sound",
                compact: true,
                value: i.mutes === undefined ? "" : i.mutes === null ? "master" : i.mutes,
                options: [
                  { value: "", label: "Nothing" },
                  { value: "master", label: "All sound (master)", description: "While true, every sound is muted" },
                  ...doc().audio!.buses.map((b) => ({ value: b.id, label: `${b.name} bus`, description: `While true, the ${b.name} bus is muted` })),
                ],
              },
            ]
          : []),
      ],
    });
    if (r)
      apply("updateInput", {
        stateMachine: sm()!.id,
        input: i.id,
        name: r.name,
        ...(i.type === "trigger" ? {} : { default: parseDefault(i.type, r.default ?? "") }),
        ...(i.type === "bool" && r.mutes !== undefined ? { mutes: r.mutes } : {}),
      });
  };

  // ---------- graph interaction ----------
  let svg!: SVGSVGElement;
  const [dragPos, setDragPos] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [linking, setLinking] = createSignal<{ from: string; x: number; y: number } | null>(null);
  const pos = (s: StateData) => (dragPos()?.id === s.id ? dragPos()! : { x: s.x, y: s.y });
  // ---- graph view: pan (drag empty space), zoom (wheel, buttons), fit ----
  const viewKey = () => `${sm()?.id}/${layer()?.id}`;
  const [view, setViewRaw] = createSignal<GraphView>(graphViews.get(viewKey()) ?? { x: 0, y: 0, z: 1 });
  const setView = (v: GraphView | ((v: GraphView) => GraphView)) => {
    const next = typeof v === "function" ? v(view()) : v;
    setViewRaw(next);
    graphViews.set(viewKey(), next);
  };
  /** Show the saved view of the current graph, or fit it if it has none yet. */
  const showView = () => {
    const saved = graphViews.get(viewKey());
    if (saved) {
      fitted = true;
      setViewRaw(saved);
    } else fit();
  };
  const ZMIN = 0.2;
  const ZMAX = 2.5;
  const clampZ = (z: number) => Math.min(ZMAX, Math.max(ZMIN, z));
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.getBoundingClientRect();
    const v = view();
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  };
  /** Zoom by `f` keeping the graph point under (sx, sy) (svg pixels) in place; default: the view centre. */
  const zoomBy = (f: number, sx?: number, sy?: number) => {
    const r = svg.getBoundingClientRect();
    const cx = sx ?? r.width / 2;
    const cy = sy ?? r.height / 2;
    const v = view();
    const z = clampZ(v.z * f);
    setView({ z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z });
  };
  let fitted = graphViews.has(viewKey());
  // The panel may be in a hidden tab at first: fit the first time the graph gets a real size.
  const ro = new ResizeObserver(() => {
    if (!fitted) showView();
  });
  onCleanup(() => ro.disconnect());
  const fit = () => {
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const sts = layer()?.states ?? [];
    let x0 = 40, y0 = 20, x1 = 100, y1 = 50; // the Any node
    for (const st of sts) {
      x0 = Math.min(x0, st.x);
      y0 = Math.min(y0, st.y - 14); // ENTRY tag
      x1 = Math.max(x1, st.x + W);
      y1 = Math.max(y1, st.y + H);
    }
    fitted = true;
    const pad = 32;
    const z = clampZ(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0), 1.25));
    setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    // Pinch / ctrl-wheel and mouse wheels zoom at the cursor; a plain two-finger trackpad scroll pans.
    const trackpadPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0;
    if (trackpadPan) setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    else zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  };
  const bgDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const start = { x: e.clientX, y: e.clientY };
    const v0 = view();
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      setPanning(true);
      setView({ ...v0, x: v0.x + dx, y: v0.y + dy });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanning(false);
      if (!moved) setSel(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [panning, setPanning] = createSignal(false);
  const graphKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "f" || e.key === "F" || e.key === "0") fit();
    else if (e.key === "+" || e.key === "=") zoomBy(1.2);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Fit when the graph appears, and whenever another state machine or layer is shown.
  onMount(() => setTimeout(showView));
  createEffect(
    on(
      () => `${sm()?.id}/${layer()?.id}`,
      () => {
        fitted = false; // if the graph is hidden now, the ResizeObserver fits it once it is shown
        setTimeout(showView);
      },
      { defer: true },
    ),
  );

  const nodeDown = (e: PointerEvent, s: StateData | "any") => {
    e.stopPropagation();
    const id = s === "any" ? ANY_STATE : s.id;
    if (s !== "any") setSel({ kind: "state", id: s.id });
    if (e.shiftKey || s === "any") {
      const p = local(e);
      setLinking({ from: id, ...p });
      const move = (m: PointerEvent) => setLinking({ from: id, ...local(m) });
      const up = (u: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setLinking(null);
        const p2 = local(u);
        const target = layer()!.states.find((st) => p2.x >= st.x && p2.x <= st.x + W && p2.y >= st.y && p2.y <= st.y + H);
        if (target && target.id !== id) {
          const r = apply("addTransition", { ...smArgs(), from: id, to: target.id }) as { id: string } | undefined;
          if (r) setSel({ kind: "transition", id: r.id });
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    const st = s as StateData;
    const start = local(e);
    const move = (m: PointerEvent) => {
      const p = local(m);
      setDragPos({ id: st.id, x: st.x + p.x - start.x, y: st.y + p.y - start.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = dragPos();
      setDragPos(null);
      if (d && (d.x !== st.x || d.y !== st.y)) apply("updateState", { ...smArgs(), state: st.id, x: Math.round(d.x), y: Math.round(d.y) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const center = (id: string) => {
    if (id === ANY_STATE) return { x: 40 + 30, y: 20 + 15 };
    const s = layer()!.states.find((x) => x.id === id);
    if (!s) return { x: 0, y: 0 };
    const p = pos(s);
    return { x: p.x + W / 2, y: p.y + H / 2 };
  };

  const edge = (t: TransitionData) => {
    const a = center(t.from);
    const b = center(t.to);
    // offset bidirectional pairs
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const o = 7;
    const shrink = (len - 34) / len;
    const sx = a.x + nx * o + dx * (1 - shrink) * 0.5;
    const sy = a.y + ny * o + dy * (1 - shrink) * 0.5;
    const ex = a.x + nx * o + dx * (0.5 + shrink * 0.5);
    const ey = a.y + ny * o + dy * (0.5 + shrink * 0.5);
    return { sx, sy, ex, ey, mx: (sx + ex) / 2, my: (sy + ey) / 2 };
  };

  const inputName = (id: string) => sm()?.inputs.find((i) => i.id === id)?.name ?? "?";
  const condText = (c: Condition) => {
    const i = sm()?.inputs.find((x) => x.id === c.input);
    return i?.type === "trigger" ? `⚡${i.name}` : `${inputName(c.input)} ${c.op} ${i?.type === "string" ? JSON.stringify(c.value) : c.value}`;
  };

  const addState = () => {
    const anim = doc().animations[0];
    const r = apply("addState", { ...smArgs(), ...(anim ? { animation: anim.id, name: uniqueStateName(anim.name) } : { name: uniqueStateName("state") }) }) as { id: string } | undefined;
    if (r) setSel({ kind: "state", id: r.id });
  };
  const uniqueStateName = (base: string) => {
    const names = new Set(layer()?.states.map((s) => s.name));
    let n = base;
    let i = 2;
    while (names.has(n)) n = `${base}${i++}`;
    return n;
  };

  return (
    <Show
      when={sm()}
      fallback={
        <div class="empty">
          No state machine yet.{" "}
          <button
            onClick={() => {
              const r = apply("createStateMachine", { name: "State Machine 1" }) as { id: string } | undefined;
              if (r) setStateMachineId(r.id);
            }}
          >
            Create state machine
          </button>
        </div>
      }
    >
      <div class="sm-panel">
        <div class="sm-inputs">
          <div class="col-title">
            Inputs
            <button
              onClick={async () => {
                const r = await askForm({
                  title: "New input",
                  confirmLabel: "Add input",
                  fields: [
                    { key: "name", type: "text", label: "Name", placeholder: "e.g. hover", validate: uniqueName(sm()!.inputs.map((i) => i.name)) },
                    {
                      key: "type",
                      type: "choice",
                      label: "Type",
                      value: "bool",
                      options: [
                        { value: "bool", label: "Boolean", description: "On / off, e.g. hover" },
                        { value: "number", label: "Number", description: "A value, e.g. speed" },
                        { value: "trigger", label: "Trigger", description: "Fires once, e.g. jump" },
                        { value: "string", label: "Text", description: "A string, e.g. a player name shown by a text attachment" },
                      ],
                    },
                    { key: "default", type: "text", label: "Default", required: false, placeholder: "optional (number, true/false or text)" },
                  ],
                });
                if (r) apply("addInput", { stateMachine: sm()!.id, name: r.name, type: r.type, ...(r.default.trim() && r.type !== "trigger" ? { default: parseDefault(r.type, r.default) } : {}) });
              }}
            >
              +
            </button>
          </div>
          <For each={sm()!.inputs} fallback={<div class="muted pad">Inputs are what your app (or listeners) control.</div>}>
            {(i) => (
              <div class="input-row">
                <span class={`badge ${i.type}`}>{i.type === "trigger" ? "⚡" : i.type === "bool" ? "◐" : i.type === "string" ? "T" : "#"}</span>
                <span class="grow input-name" title={running() ? i.name : "Click to rename or change the default"} onClick={() => !running() && editInput(i)}>
                  {i.name}
                  <Show when={i.type !== "trigger" && !running()}>
                    <span class="muted"> = {JSON.stringify(i.default)}</span>
                  </Show>
                  <Show when={i.mutes !== undefined}>
                    <span class="muted" title="While true, this input mutes the bus: set it from your app, a page button, a listener or a script">
                      {" "}🔇 {i.mutes === null ? "all" : (doc().audio?.buses.find((b) => b.id === i.mutes)?.name ?? "?")}
                    </span>
                  </Show>
                </span>
                <Show
                  when={running()}
                  fallback={
                    <button class="row-del" title="Delete input" onClick={() => void confirmDelete(`input “${i.name}”`, "Conditions and listener actions that use it are removed too.", () => apply("deleteInput", { stateMachine: sm()!.id, input: i.id }))}>
                      ×
                    </button>
                  }
                >
                  <Switch>
                    <Match when={i.type === "bool"}>
                      <input type="checkbox" checked={Boolean(liveInputs()[i.id])} onChange={(e) => smInstance()?.setBool(i.id, e.currentTarget.checked)} />
                    </Match>
                    <Match when={i.type === "number"}>
                      <input
                        type="range"
                        min={rangeOf(i.id)[0]}
                        max={rangeOf(i.id)[1]}
                        step={(rangeOf(i.id)[1] - rangeOf(i.id)[0]) / 200}
                        value={Number(liveInputs()[i.id] ?? 0)}
                        onInput={(e) => smInstance()?.setNumber(i.id, Number(e.currentTarget.value))}
                      />
                      <input class="tiny" type="number" step="0.1" value={Number(liveInputs()[i.id] ?? 0)} onChange={(e) => smInstance()?.setNumber(i.id, Number(e.currentTarget.value))} />
                    </Match>
                    <Match when={i.type === "trigger"}>
                      <button onClick={() => smInstance()?.fire(i.id)}>Fire</button>
                    </Match>
                    <Match when={i.type === "string"}>
                      <input class="small" type="text" value={String(liveInputs()[i.id] ?? "")} onInput={(e) => smInstance()?.setString(i.id, e.currentTarget.value)} />
                    </Match>
                  </Switch>
                </Show>
              </div>
            )}
          </For>
          <div class="col-title" style={{ "margin-top": "10px" }}>
            Bindings
          </div>
          <BindingList sm={sm()!} />
          <div class="col-title" style={{ "margin-top": "10px" }}>
            Listeners
          </div>
          <ListenerList />
          <Show when={running()}>
            <div class="col-title">Event log</div>
            <div class="event-log">
              <For each={eventLog()}>{(l) => <div>{l}</div>}</For>
            </div>
          </Show>
        </div>

        <div class="sm-graph-wrap">
          <div class="sm-bar">
            <select value={sm()!.id} onChange={(e) => setStateMachineId(e.currentTarget.value)}>
              <For each={doc().stateMachines}>{(s) => <option value={s.id} selected={s.id === (sm()!.id)}>{s.name}</option>}</For>
            </select>
            <select value={layer()?.id} onChange={(e) => setLayerId(e.currentTarget.value)}>
              <For each={sm()!.layers}>{(l) => <option value={l.id} selected={l.id === (layer()?.id)}>{l.name}</option>}</For>
            </select>
            <button
              onClick={async () => {
                const name = await askText({
                  title: "New layer",
                  message: "Layers run in parallel, e.g. one for the body and one for the face.",
                  value: `Layer ${sm()!.layers.length + 1}`,
                  confirmLabel: "Create",
                  validate: uniqueName(sm()!.layers.map((l) => l.name)),
                });
                if (name) {
                  const r = apply("addLayer", { stateMachine: sm()!.id, name }) as { id: string } | undefined;
                  if (r) setLayerId(r.id);
                }
              }}
            >
              + Layer
            </button>
            <button onClick={addState}>+ State</button>
            <span class="muted">Shift-drag between states (or drag from Any) to add a transition · drag empty space to pan, wheel to zoom</span>
            <span class="spacer" />
            <button class={running() ? "live" : "primary"} onClick={() => setRunning(!running())}>
              {running() ? "■ Stop" : "▶ Run"}
            </button>
          </div>
          <div
            class="sm-graph"
            classList={{ panning: panning() }}
            tabIndex={0}
            onKeyDown={graphKey}
            style={{ "background-position": `${view().x}px ${view().y}px`, "background-size": `${18 * view().z}px ${18 * view().z}px, auto` }}
          >
            <svg
              ref={(el) => {
                if (svg) ro.unobserve(svg);
                svg = el;
                ro.observe(el);
              }}
              onPointerDown={bgDown} onWheel={onWheel} onDblClick={(e) => e.target === svg && fit()}>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a93a6" />
                </marker>
                <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffcc00" />
                </marker>
              </defs>
              <g transform={`translate(${view().x} ${view().y}) scale(${view().z})`}>
              <Show when={layer()}>
                <g class="any-node" onPointerDown={(e) => nodeDown(e, "any")}>
                  <rect x={40} y={20} width={60} height={30} rx={15} />
                  <text x={70} y={39}>
                    Any
                  </text>
                </g>
                <For each={layer()!.transitions}>
                  {(t) => {
                    const g = () => edge(t);
                    const selected = () => sel()?.kind === "transition" && sel()!.id === t.id;
                    return (
                      <g
                        class="edge"
                        classList={{ selected: selected() }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSel({ kind: "transition", id: t.id });
                        }}
                      >
                        <line x1={g().sx} y1={g().sy} x2={g().ex} y2={g().ey} class="hit" />
                        <line x1={g().sx} y1={g().sy} x2={g().ex} y2={g().ey} marker-end={selected() ? "url(#arrow-sel)" : "url(#arrow)"} />
                        <text x={g().mx} y={g().my - 6}>
                          {t.conditions.map(condText).join(" & ") || (t.exitTime != null ? `exit ${t.exitTime}` : "on end")}
                        </text>
                      </g>
                    );
                  }}
                </For>
                <For each={layer()!.states.filter((s) => s.onComplete && layer()!.states.some((x) => x.id === s.onComplete))}>
                  {(s) => {
                    const g = () => edge({ id: "", from: s.id, to: s.onComplete!, conditions: [], duration: 0, exitTime: null });
                    return (
                      <g class="edge on-complete" onPointerDown={(e) => { e.stopPropagation(); setSel({ kind: "state", id: s.id }); }}>
                        <line x1={g().sx} y1={g().sy} x2={g().ex} y2={g().ey} class="hit" />
                        <line x1={g().sx} y1={g().sy} x2={g().ex} y2={g().ey} stroke-dasharray="5 4" marker-end="url(#arrow)" />
                        <text x={g().mx} y={g().my - 6}>on complete</text>
                      </g>
                    );
                  }}
                </For>
                <For each={layer()!.states}>
                  {(s) => {
                    const p = () => pos(s);
                    const isActive = () => running() && active()[layer()!.name] === s.name;
                    return (
                      <g
                        class="state-node"
                        classList={{ selected: sel()?.kind === "state" && sel()!.id === s.id, active: isActive(), entry: layer()!.entry === s.id, exit: s.type === "exit" }}
                        onPointerDown={(e) => nodeDown(e, s)}
                      >
                        <rect x={p().x} y={p().y} width={W} height={H} rx={8} />
                        <text x={p().x + W / 2} y={p().y + 17}>
                          {s.name}
                        </text>
                        <text class="sub" x={p().x + W / 2} y={p().y + 31}>
                          {s.type === "blend1d" ? `blend · ${inputName(s.blendInput ?? "")}` : s.type === "exit" ? "exit" : (doc().animations.find((a) => a.id === s.animation)?.name ?? "no animation") + (s.loop ? " ⟳" : "")}
                        </text>
                        <Show when={layer()!.entry === s.id}>
                          <text class="entry-tag" x={p().x + 4} y={p().y - 4} text-anchor="start">
                            ENTRY
                          </text>
                        </Show>
                      </g>
                    );
                  }}
                </For>
                <Show when={linking()}>
                  {(l) => {
                    const a = center(l().from);
                    return <line class="linking" x1={a.x} y1={a.y} x2={l().x} y2={l().y} marker-end="url(#arrow-sel)" />;
                  }}
                </Show>
              </Show>
              </g>
            </svg>
            <div class="sm-zoom" onPointerDown={(e) => e.stopPropagation()}>
              <button title="Zoom out (-)" onClick={() => zoomBy(1 / 1.2)}>−</button>
              <button class="sm-zoom-pct" title="Reset to 100%" onClick={() => zoomBy(1 / view().z)}>
                {Math.round(view().z * 100)}%
              </button>
              <button title="Zoom in (+)" onClick={() => zoomBy(1.2)}>+</button>
              <button title="Fit to view (F, or double-click empty space)" onClick={fit}>⛶</button>
            </div>
          </div>
        </div>

        <div class="sm-props">
          <Switch fallback={<div class="muted pad">Select a state or transition.</div>}>
            <Match when={sel()?.kind === "state" && layer()?.states.find((s) => s.id === sel()!.id)}>
              {(s) => <StateProps state={s()} layer={layer()!} onDeleted={() => setSel(null)} />}
            </Match>
            <Match when={sel()?.kind === "transition" && layer()?.transitions.find((t) => t.id === sel()!.id)}>
              {(t) => <TransitionProps t={t()} layer={layer()!} onDeleted={() => setSel(null)} />}
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}

function StateProps(p: { state: StateData; layer: LayerData; onDeleted: () => void }) {
  const sm = () => currentStateMachine()!;
  const args = () => ({ stateMachine: sm().id, layer: p.layer.id, state: p.state.id });
  return (
    <div class="props">
      <div class="col-title">State</div>
      <label class="field">
        <span>Name</span>
        <input value={p.state.name} onChange={(e) => apply("updateState", { ...args(), name: e.currentTarget.value })} />
      </label>
      <Show when={p.state.type === "animation"}>
        <label class="field">
          <span>Animation</span>
          <select value={p.state.animation ?? ""} onChange={(e) => apply("updateState", { ...args(), animation: e.currentTarget.value || null })}>
            <option value="" selected={!(p.state.animation ?? "")}>—</option>
            <For each={doc().animations}>{(a) => <option value={a.id} selected={a.id === (p.state.animation ?? "")}>{a.name}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={p.state.type === "blend1d"}>
        <label class="field">
          <span>Blend input</span>
          <select value={p.state.blendInput ?? ""} onChange={(e) => apply("updateState", { ...args(), blendInput: e.currentTarget.value })}>
            <For each={sm().inputs.filter((i) => i.type === "number")}>{(i) => <option value={i.id} selected={i.id === (p.state.blendInput ?? "")}>{i.name}</option>}</For>
          </select>
        </label>
        <For each={p.state.blend ?? []}>
          {(b, i) => (
            <div class="field">
              <select
                value={b.animation}
                onChange={(e) => apply("updateState", { ...args(), blend: (p.state.blend ?? []).map((x, j) => (j === i() ? { ...x, animation: e.currentTarget.value } : x)) })}
              >
                <For each={doc().animations}>{(a) => <option value={a.id} selected={a.id === (b.animation)}>{a.name}</option>}</For>
              </select>
              <input
                class="tiny"
                type="number"
                step="0.1"
                value={b.value}
                onChange={(e) => apply("updateState", { ...args(), blend: (p.state.blend ?? []).map((x, j) => (j === i() ? { ...x, value: Number(e.currentTarget.value) } : x)) })}
              />
            </div>
          )}
        </For>
        <button
          disabled={!doc().animations.length}
          onClick={() => apply("updateState", { ...args(), blend: [...(p.state.blend ?? []), { animation: doc().animations[0].id, value: (p.state.blend?.length ?? 0) }] })}
        >
          + Blend entry
        </button>
      </Show>
      <label class="field">
        <span>Loop</span>
        <input type="checkbox" checked={p.state.loop} onChange={(e) => apply("updateState", { ...args(), loop: e.currentTarget.checked })} />
      </label>
      <label class="field">
        <span>Speed</span>
        <input type="number" step="0.1" value={p.state.speed} onChange={(e) => apply("updateState", { ...args(), speed: Number(e.currentTarget.value) })} />
      </label>
      <Show when={p.state.type !== "exit"}>
        <StateSounds state={p.state} layer={p.layer} />
      </Show>
      <Show when={p.state.type !== "exit" && emitterSlots().length}>
        <div class="col-title">Particle emitters on enter</div>
        <For each={emitterSlots()}>
          {(slot) => {
            const cur = () => p.state.emitters?.find((e) => e.slot === slot.id);
            return (
              <label class="field">
                <span>{slot.name}</span>
                <select
                  value={cur() ? (cur()!.emitting ? "on" : "off") : ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    apply("setStateEmitter", { ...args(), slot: slot.id, emitting: v === "" ? null : v === "on" });
                  }}
                >
                  <option value="" selected={!cur()}>unchanged</option>
                  <option value="on" selected={cur()?.emitting === true}>start</option>
                  <option value="off" selected={cur()?.emitting === false}>stop</option>
                </select>
              </label>
            );
          }}
        </For>
      </Show>
      <Show when={p.state.type !== "exit" && sm().inputs.some((i) => i.type !== "trigger")}>
        <div class="col-title" title="Values applied every time this state is entered, e.g. reset a round's multiplier when going back to idle.">Set inputs on enter</div>
        <For each={sm().inputs.filter((i) => i.type !== "trigger")}>
          {(input) => {
            const cur = () => p.state.inputs?.find((x) => x.input === input.id);
            const set = (value: boolean | number | string | null) => apply("setStateInput", { ...args(), input: input.id, value });
            return (
              <div class="field">
                <span>{input.name}</span>
                <span class="state-input">
                  <input type="checkbox" title="Set this input on enter" checked={!!cur()} onChange={(e) => set(e.currentTarget.checked ? input.default : null)} />
                  <Show when={cur()}>
                    {input.type === "bool" ? (
                      <input type="checkbox" title="Value" checked={cur()!.value === true} onChange={(e) => set(e.currentTarget.checked)} />
                    ) : (
                      <input
                        type={input.type === "number" ? "number" : "text"}
                        step="any"
                        value={String(cur()!.value)}
                        onChange={(e) => set(input.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value)}
                      />
                    )}
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </Show>
      <Show when={p.state.type !== "exit"}>
        <label class="field" title="Play the animation once (the first cycle when looping), then go to this state. The state's own transitions still win, so a trigger can interrupt it.">
          <span>On complete</span>
          <select value={p.state.onComplete ?? ""} onChange={(e) => apply("updateState", { ...args(), onComplete: e.currentTarget.value || null })}>
            <option value="" selected={!p.state.onComplete}>stay</option>
            <For each={p.layer.states.filter((x) => x.id !== p.state.id)}>{(x) => <option value={x.id} selected={x.id === p.state.onComplete}>→ {x.name}</option>}</For>
          </select>
        </label>
      </Show>
      <div class="btn-row">
        <button disabled={p.layer.entry === p.state.id} onClick={() => apply("updateState", { ...args(), entry: true })}>
          Set as entry
        </button>
        <button
          class="danger"
          onClick={() =>
            void confirmDelete(`state “${p.state.name}”`, "Transitions to and from it are removed too.", () => {
              apply("deleteState", args());
              p.onDeleted();
            })
          }
        >
          Delete
        </button>
      </div>
      <div class="col-title">Add state</div>
      <div class="btn-row">
        <button onClick={() => apply("addState", { stateMachine: sm().id, layer: p.layer.id, name: `blend${p.layer.states.length + 1}`, type: "blend1d", blendInput: sm().inputs.find((i) => i.type === "number")?.id })} disabled={!sm().inputs.some((i) => i.type === "number")} title="Needs a number input">
          + Blend 1D
        </button>
        <button onClick={() => apply("addState", { stateMachine: sm().id, layer: p.layer.id, name: `exit${p.layer.states.length + 1}`, type: "exit" })}>+ Exit</button>
      </div>
    </div>
  );
}

const OPS: ConditionOp[] = ["==", "!=", ">", "<", ">=", "<="];

function TransitionProps(p: { t: TransitionData; layer: LayerData; onDeleted: () => void }) {
  const sm = () => currentStateMachine()!;
  const args = () => ({ stateMachine: sm().id, layer: p.layer.id, transition: p.t.id });
  const name = (id: string) => (id === ANY_STATE ? "Any" : (p.layer.states.find((s) => s.id === id)?.name ?? "?"));
  const setConds = (conds: Condition[]) => apply("updateTransition", { ...args(), conditions: conds.map((c) => ({ input: c.input, op: c.op, value: c.value })) });
  return (
    <div class="props">
      <div class="col-title">
        Transition {name(p.t.from)} → {name(p.t.to)}
      </div>
      <label class="field">
        <span>Fade (s)</span>
        <input type="number" step="0.05" min="0" value={p.t.duration} onChange={(e) => apply("updateTransition", { ...args(), duration: Number(e.currentTarget.value) })} />
      </label>
      <label class="field">
        <span>Exit time</span>
        <input type="checkbox" checked={p.t.exitTime != null} onChange={(e) => apply("updateTransition", { ...args(), exitTime: e.currentTarget.checked ? 1 : null })} />
        <Show when={p.t.exitTime != null}>
          <input class="tiny" type="number" step="0.1" min="0" value={p.t.exitTime!} onChange={(e) => apply("updateTransition", { ...args(), exitTime: Number(e.currentTarget.value) })} />
        </Show>
      </label>
      <div class="col-title">Conditions (all must pass)</div>
      <For each={p.t.conditions} fallback={<div class="muted pad">None: fires when the source animation ends.</div>}>
        {(c, i) => {
          const input = () => sm().inputs.find((x) => x.id === c.input);
          const update = (patch: Partial<Condition>) => setConds(p.t.conditions.map((x, j) => (j === i() ? { ...x, ...patch } : x)));
          return (
            <div class="field cond">
              <select
                value={c.input}
                onChange={(e) => {
                  // A different input type needs a value of its own type.
                  const next = sm().inputs.find((x) => x.id === e.currentTarget.value);
                  update({ input: e.currentTarget.value, op: "==", value: emptyValue(next?.type) });
                }}
              >
                <For each={sm().inputs}>{(x) => <option value={x.id} selected={x.id === (c.input)}>{x.name}</option>}</For>
              </select>
              <Switch>
                <Match when={input()?.type === "trigger"}>
                  <span class="muted">fired</span>
                </Match>
                <Match when={input()?.type === "bool"}>
                  <select value={String(c.value)} onChange={(e) => update({ op: "==", value: e.currentTarget.value === "true" })}>
                    <option value="true">is true</option>
                    <option value="false">is false</option>
                  </select>
                </Match>
                <Match when={input()?.type === "string"}>
                  <select value={c.op} onChange={(e) => update({ op: e.currentTarget.value as ConditionOp })}>
                    <For each={["==", "!="] as ConditionOp[]}>{(o) => <option selected={o === c.op}>{o}</option>}</For>
                  </select>
                  <input class="small" type="text" value={String(c.value)} onChange={(e) => update({ value: e.currentTarget.value })} />
                </Match>
                <Match when={input()?.type === "number"}>
                  <select value={c.op} onChange={(e) => update({ op: e.currentTarget.value as ConditionOp })}>
                    <For each={OPS}>{(o) => <option selected={o === (c.op)}>{o}</option>}</For>
                  </select>
                  <input class="tiny" type="number" step="0.1" value={Number(c.value)} onChange={(e) => update({ value: Number(e.currentTarget.value) })} />
                </Match>
              </Switch>
              <button class="row-del" onClick={() => setConds(p.t.conditions.filter((_, j) => j !== i()))}>
                ×
              </button>
            </div>
          );
        }}
      </For>
      <button
        disabled={!sm().inputs.length}
        onClick={() => {
          const first = sm().inputs[0];
          setConds([...p.t.conditions, { input: first.id, op: "==", value: emptyValue(first.type) }]);
        }}
      >
        + Condition
      </button>
      <button
        class="danger"
        onClick={() =>
          void confirmDelete("this transition", null, () => {
            apply("deleteTransition", args());
            p.onDeleted();
          })
        }
      >
        Delete transition
      </button>
    </div>
  );
}

function ListenerList() {
  const sm = () => currentStateMachine()!;
  const [slot, setSlot] = createSignal("");
  const [event, setEvent] = createSignal("click");
  const [action, setAction] = createSignal("fireTrigger");
  const [target, setTarget] = createSignal("");
  const describe = (a: { type: string; input?: string; event?: string; value?: unknown; script?: string; sound?: string; slot?: string; emitting?: boolean; count?: number; bus?: string | null; muted?: boolean | "toggle" }) => {
    const soundName = () => doc().audio?.sounds.find((s) => s.id === a.sound)?.name;
    if (a.type === "setMute") {
      const bus = a.bus ? (doc().audio?.buses.find((b) => b.id === a.bus)?.name ?? "?") : "all sound";
      return `${a.muted === "toggle" ? "toggle mute" : a.muted ? "mute" : "unmute"} ${bus}`;
    }
    if (a.type === "playSound") return `play ♪ ${soundName()}`;
    if (a.type === "stopSound") return `stop ♪ ${soundName()}`;
    const iname = sm().inputs.find((i) => i.id === a.input)?.name;
    const sname = doc().skeleton.slots.find((s) => s.id === a.slot)?.name;
    if (a.type === "setEmitter") return `${a.emitting ? "start" : "stop"} ${sname} particles`;
    if (a.type === "emitParticles") return `burst ${a.count} ${sname}`;
    if (a.type === "setInput") return `${iname} = ${a.value}`;
    if (a.type === "toggleInput") return `toggle ${iname}`;
    if (a.type === "fireTrigger") return `fire ${iname}`;
    if (a.type === "reportEvent") return `event ${doc().events.find((e) => e.id === a.event)?.name}`;
    return `script ${doc().scripts.find((s) => s.id === a.script)?.name}`;
  };
  const add = () => {
    const t = target();
    if (!t) return toast("Choose an input / event / script / sound for the action", "error");
    const input = sm().inputs.find((i) => i.id === t);
    const act =
      action().startsWith("mute:")
        ? { type: "setMute", bus: t === "@master" ? null : t, muted: action() === "mute:toggle" ? "toggle" : action() === "mute:on" }
        : action() === "playSound" || action() === "stopSound"
        ? { type: action(), sound: t }
        : action() === "startEmitter" || action() === "stopEmitter"
          ? { type: "setEmitter", slot: t, emitting: action() === "startEmitter" }
          : action() === "emitParticles"
            ? { type: "emitParticles", slot: t, count: 20 }
            : action() === "reportEvent"
        ? { type: "reportEvent", event: t }
        : action() === "runScript"
          ? { type: "runScript", script: t, fn: "onAction" }
          : action() === "setInput"
            ? { type: "setInput", input: t, value: input?.type === "number" ? 1 : input?.type === "string" ? "" : true }
            : { type: action(), input: t };
    apply("addListener", { stateMachine: sm().id, slot: slot() || null, event: event(), actions: [act] });
  };
  // Validator warnings about each listener (e.g. a trigger whose sound only plays when this button is clicked).
  const warnings = () => {
    const prefix = `${sm().name} listener `;
    const out = new Map<string, string[]>();
    for (const i of validate(doc())) if (i.level === "warning" && i.path.startsWith(prefix)) out.set(i.path.slice(prefix.length), [...(out.get(i.path.slice(prefix.length)) ?? []), i.message]);
    return out;
  };
  return (
    <>
      <For each={sm().listeners} fallback={<div class="muted pad">Pointer events on hit boxes → actions.</div>}>
        {(l) => (
          <div class="input-row">
            <span class="grow">
              <b>{l.event}</b> on {doc().skeleton.slots.find((s) => s.id === l.slot)?.name ?? "artboard"} → {l.actions.map(describe).join(", ")}
            </span>
            <Show when={warnings().get(l.name)}>
              {(w) => (
                <span class="warn-badge" title={w().join("\n")} aria-label={`Warning: ${w().join(" ")}`}>
                  ⚠
                </span>
              )}
            </Show>
            <button class="row-del" title="Delete listener" onClick={() => void confirmDelete(`this ${l.event} listener`, null, () => apply("deleteListener", { stateMachine: sm().id, listener: l.id }))}>
              ×
            </button>
          </div>
        )}
      </For>
      <div class="listener-form">
        <select value={event()} onChange={(e) => setEvent(e.currentTarget.value)}>
          <For each={["click", "down", "up", "enter", "exit", "move"]}>{(x) => <option selected={x === (event())}>{x}</option>}</For>
        </select>
        <select value={slot()} onChange={(e) => setSlot(e.currentTarget.value)}>
          <option value="" selected={!(slot())}>artboard</option>
          <For each={doc().skeleton.slots}>{(s) => <option value={s.id} selected={s.id === (slot())}>{s.name}</option>}</For>
        </select>
        <select value={action()} onChange={(e) => { setAction(e.currentTarget.value); setTarget(""); }}>
          <option value="fireTrigger">fire trigger</option>
          <option value="setInput">set input</option>
          <option value="toggleInput">toggle bool</option>
          <option value="reportEvent">report event</option>
          <option value="runScript">run script</option>
          <option value="playSound">play sound</option>
          <option value="stopSound">stop sound</option>
          <option value="mute:toggle">toggle mute (bus)</option>
          <option value="mute:on">mute (bus)</option>
          <option value="mute:off">unmute (bus)</option>
          <Show when={emitterSlots().length}>
            <option value="startEmitter">start particles</option>
            <option value="stopEmitter">stop particles</option>
            <option value="emitParticles">burst 20 particles</option>
          </Show>
        </select>
        <select value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="" selected={!(target())}>…</option>
          <Switch>
            <Match when={action() === "reportEvent"}>
              <For each={doc().events}>{(x) => <option value={x.name} selected={x.name === (target())}>{x.name}</option>}</For>
            </Match>
            <Match when={action() === "runScript"}>
              <For each={doc().scripts}>{(x) => <option value={x.id} selected={x.id === (target())}>{x.name}</option>}</For>
            </Match>
            <Match when={action().startsWith("mute:")}>
              <option value="@master" selected={target() === "@master"}>all sound (master)</option>
              <For each={doc().audio?.buses ?? []}>{(x) => <option value={x.id} selected={x.id === (target())}>{x.name}</option>}</For>
            </Match>
            <Match when={action() === "playSound" || action() === "stopSound"}>
              <For each={doc().audio?.sounds ?? []}>{(x) => <option value={x.id} selected={x.id === (target())}>{x.name}</option>}</For>
            </Match>
            <Match when={action() === "startEmitter" || action() === "stopEmitter" || action() === "emitParticles"}>
              <For each={emitterSlots()}>{(x) => <option value={x.id} selected={x.id === (target())}>{x.name}</option>}</For>
            </Match>
            <Match when={true}>
              <For each={sm().inputs}>{(x) => <option value={x.id} selected={x.id === (target())}>{x.name}</option>}</For>
            </Match>
          </Switch>
        </select>
        <button onClick={add}>+ Listener</button>
      </div>
    </>
  );
}

/** A neutral condition value for an input type. */
function emptyValue(type: InputData["type"] | undefined): InputValue {
  return type === "number" ? 0 : type === "string" ? "" : true;
}

/** Parse a default typed into a dialog for an input of the given type. */
function parseDefault(type: InputData["type"] | string, v: string): InputValue {
  if (type === "number") return Number(v) || 0;
  if (type === "bool") return /^(true|1|yes|on)$/i.test(v.trim());
  return v;
}
