import { ANY_STATE, type Condition, type ConditionOp, type LayerData, type StateData, type TransitionData } from "@openbone/core";
import { For, Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import { apply, currentStateMachine, doc, running, setRunning, setStateMachineId, toast } from "../state.ts";
import { eventLog, smInstance } from "./Viewport.tsx";

const W = 130;
const H = 40;

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
  const [liveInputs, setLiveInputs] = createSignal<Record<string, boolean | number>>({});
  const timer = setInterval(() => {
    const inst = smInstance();
    if (!inst) return;
    setActive(inst.activeStates);
    const vals: Record<string, boolean | number> = {};
    for (const i of inst.data.inputs) vals[i.id] = inst.inputs.get(i.id) ?? false;
    setLiveInputs(vals);
  }, 80);
  onCleanup(() => clearInterval(timer));

  const smArgs = () => ({ stateMachine: sm()!.id, layer: layer()!.id });

  // ---------- graph interaction ----------
  let svg!: SVGSVGElement;
  const [dragPos, setDragPos] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [linking, setLinking] = createSignal<{ from: string; x: number; y: number } | null>(null);
  const pos = (s: StateData) => (dragPos()?.id === s.id ? dragPos()! : { x: s.x, y: s.y });
  const local = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left + svg.parentElement!.scrollLeft, y: e.clientY - r.top + svg.parentElement!.scrollTop };
  };

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
      setDragPos({ id: st.id, x: Math.max(0, st.x + p.x - start.x), y: Math.max(0, st.y + p.y - start.y) });
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
    return i?.type === "trigger" ? `⚡${i.name}` : `${inputName(c.input)} ${c.op} ${c.value}`;
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
              onClick={() => {
                const name = prompt("Input name");
                if (!name) return;
                const type = (prompt("Type: bool, number or trigger", "bool") ?? "bool") as "bool" | "number" | "trigger";
                if (!["bool", "number", "trigger"].includes(type)) return toast("Type must be bool, number or trigger", "error");
                apply("addInput", { stateMachine: sm()!.id, name, type });
              }}
            >
              +
            </button>
          </div>
          <For each={sm()!.inputs} fallback={<div class="muted pad">Inputs are what your app (or listeners) control.</div>}>
            {(i) => (
              <div class="input-row">
                <span class={`badge ${i.type}`}>{i.type === "trigger" ? "⚡" : i.type === "bool" ? "◐" : "#"}</span>
                <span class="grow">{i.name}</span>
                <Show
                  when={running()}
                  fallback={
                    <button class="row-del" title="Delete input" onClick={() => apply("deleteInput", { stateMachine: sm()!.id, input: i.id })}>
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
                        min="0"
                        max="1"
                        step="0.01"
                        value={Number(liveInputs()[i.id] ?? 0)}
                        onInput={(e) => smInstance()?.setNumber(i.id, Number(e.currentTarget.value))}
                      />
                      <input class="tiny" type="number" step="0.1" value={Number(liveInputs()[i.id] ?? 0)} onChange={(e) => smInstance()?.setNumber(i.id, Number(e.currentTarget.value))} />
                    </Match>
                    <Match when={i.type === "trigger"}>
                      <button onClick={() => smInstance()?.fire(i.id)}>Fire</button>
                    </Match>
                  </Switch>
                </Show>
              </div>
            )}
          </For>
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
              <For each={doc().stateMachines}>{(s) => <option value={s.id}>{s.name}</option>}</For>
            </select>
            <select value={layer()?.id} onChange={(e) => setLayerId(e.currentTarget.value)}>
              <For each={sm()!.layers}>{(l) => <option value={l.id}>{l.name}</option>}</For>
            </select>
            <button
              onClick={() => {
                const name = prompt("Layer name", `Layer ${sm()!.layers.length + 1}`);
                if (name) {
                  const r = apply("addLayer", { stateMachine: sm()!.id, name }) as { id: string } | undefined;
                  if (r) setLayerId(r.id);
                }
              }}
            >
              + Layer
            </button>
            <button onClick={addState}>+ State</button>
            <span class="muted">Shift-drag between states (or drag from Any) to add a transition</span>
            <span class="spacer" />
            <button class={running() ? "live" : "primary"} onClick={() => setRunning(!running())}>
              {running() ? "■ Stop" : "▶ Run"}
            </button>
          </div>
          <div class="sm-graph" onPointerDown={() => setSel(null)}>
            <svg ref={svg} width={Math.max(900, ...(layer()?.states.map((s) => s.x + W + 40) ?? [0]))} height={Math.max(260, ...(layer()?.states.map((s) => s.y + H + 40) ?? [0]))}>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a93a6" />
                </marker>
                <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffcc00" />
                </marker>
              </defs>
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
            </svg>
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
            <option value="">—</option>
            <For each={doc().animations}>{(a) => <option value={a.id}>{a.name}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={p.state.type === "blend1d"}>
        <label class="field">
          <span>Blend input</span>
          <select value={p.state.blendInput ?? ""} onChange={(e) => apply("updateState", { ...args(), blendInput: e.currentTarget.value })}>
            <For each={sm().inputs.filter((i) => i.type === "number")}>{(i) => <option value={i.id}>{i.name}</option>}</For>
          </select>
        </label>
        <For each={p.state.blend ?? []}>
          {(b, i) => (
            <div class="field">
              <select
                value={b.animation}
                onChange={(e) => apply("updateState", { ...args(), blend: (p.state.blend ?? []).map((x, j) => (j === i() ? { ...x, animation: e.currentTarget.value } : x)) })}
              >
                <For each={doc().animations}>{(a) => <option value={a.id}>{a.name}</option>}</For>
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
      <div class="btn-row">
        <button disabled={p.layer.entry === p.state.id} onClick={() => apply("updateState", { ...args(), entry: true })}>
          Set as entry
        </button>
        <button
          class="danger"
          onClick={() => {
            apply("deleteState", args());
            p.onDeleted();
          }}
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
              <select value={c.input} onChange={(e) => update({ input: e.currentTarget.value })}>
                <For each={sm().inputs}>{(x) => <option value={x.id}>{x.name}</option>}</For>
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
                <Match when={input()?.type === "number"}>
                  <select value={c.op} onChange={(e) => update({ op: e.currentTarget.value as ConditionOp })}>
                    <For each={OPS}>{(o) => <option>{o}</option>}</For>
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
          setConds([...p.t.conditions, { input: first.id, op: "==", value: first.type === "number" ? 0 : true }]);
        }}
      >
        + Condition
      </button>
      <button
        class="danger"
        onClick={() => {
          apply("deleteTransition", args());
          p.onDeleted();
        }}
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
  const describe = (a: { type: string; input?: string; event?: string; value?: unknown; script?: string }) => {
    const iname = sm().inputs.find((i) => i.id === a.input)?.name;
    if (a.type === "setInput") return `${iname} = ${a.value}`;
    if (a.type === "toggleInput") return `toggle ${iname}`;
    if (a.type === "fireTrigger") return `fire ${iname}`;
    if (a.type === "reportEvent") return `event ${doc().events.find((e) => e.id === a.event)?.name}`;
    return `script ${doc().scripts.find((s) => s.id === a.script)?.name}`;
  };
  const add = () => {
    const t = target();
    if (!t) return toast("Choose an input / event / script for the action", "error");
    const input = sm().inputs.find((i) => i.id === t);
    const act =
      action() === "reportEvent"
        ? { type: "reportEvent", event: t }
        : action() === "runScript"
          ? { type: "runScript", script: t, fn: "onAction" }
          : action() === "setInput"
            ? { type: "setInput", input: t, value: input?.type === "number" ? 1 : true }
            : { type: action(), input: t };
    apply("addListener", { stateMachine: sm().id, slot: slot() || null, event: event(), actions: [act] });
  };
  return (
    <>
      <For each={sm().listeners} fallback={<div class="muted pad">Pointer events on hit boxes → actions.</div>}>
        {(l) => (
          <div class="input-row">
            <span class="grow">
              <b>{l.event}</b> on {doc().skeleton.slots.find((s) => s.id === l.slot)?.name ?? "artboard"} → {l.actions.map(describe).join(", ")}
            </span>
            <button class="row-del" onClick={() => apply("deleteListener", { stateMachine: sm().id, listener: l.id })}>
              ×
            </button>
          </div>
        )}
      </For>
      <div class="listener-form">
        <select value={event()} onChange={(e) => setEvent(e.currentTarget.value)}>
          <For each={["click", "down", "up", "enter", "exit", "move"]}>{(x) => <option>{x}</option>}</For>
        </select>
        <select value={slot()} onChange={(e) => setSlot(e.currentTarget.value)}>
          <option value="">artboard</option>
          <For each={doc().skeleton.slots}>{(s) => <option value={s.id}>{s.name}</option>}</For>
        </select>
        <select value={action()} onChange={(e) => { setAction(e.currentTarget.value); setTarget(""); }}>
          <option value="fireTrigger">fire trigger</option>
          <option value="setInput">set input</option>
          <option value="toggleInput">toggle bool</option>
          <option value="reportEvent">report event</option>
          <option value="runScript">run script</option>
        </select>
        <select value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="">…</option>
          <Switch>
            <Match when={action() === "reportEvent"}>
              <For each={doc().events}>{(x) => <option value={x.name}>{x.name}</option>}</For>
            </Match>
            <Match when={action() === "runScript"}>
              <For each={doc().scripts}>{(x) => <option value={x.id}>{x.name}</option>}</For>
            </Match>
            <Match when={true}>
              <For each={sm().inputs}>{(x) => <option value={x.id}>{x.name}</option>}</For>
            </Match>
          </Switch>
        </select>
        <button onClick={add}>+ Listener</button>
      </div>
    </>
  );
}
