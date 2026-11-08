import { BINDING_PROPERTIES, type BindingTarget, type InputBinding, type OpenBoneDocument, type StateMachineData } from "@openbone/core";
import { For, Show } from "solid-js";
import { askForm } from "../dialogs.tsx";
import { apply, doc, toast } from "../state.ts";

/** Everything an input binding can drive: bones, slots and constraints. */
function bindables(d: OpenBoneDocument): { target: BindingTarget; id: string; label: string }[] {
  const sk = d.skeleton;
  return [
    ...sk.bones.map((b) => ({ target: "bone" as const, id: b.id, label: `bone ${b.name}` })),
    ...sk.slots.map((s) => ({ target: "slot" as const, id: s.id, label: `slot ${s.name}` })),
    ...(["ik", "transform", "path", "physics"] as const).flatMap((k) => sk[k].map((c) => ({ target: k, id: c.id, label: `${k} ${c.name}` }))),
  ];
}

const objectName = (d: OpenBoneDocument, b: Pick<InputBinding, "target" | "object">) => {
  const sk = d.skeleton;
  const list: { id: string; name: string }[] = b.target === "bone" ? sk.bones : b.target === "slot" ? sk.slots : sk[b.target];
  return list.find((x) => x.id === b.object)?.name ?? "?";
};

const drivable = (sm: StateMachineData) => sm.inputs.filter((i) => i.type === "number" || i.type === "bool");
const isNum = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? "Enter a number" : null);
const isHex = (v: string) => (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? null : "Use a hex colour like #ff8800");

/** Ask for a new binding. `target`/`object` preset the driven object (Inspector); otherwise it is asked for. */
export async function newBinding(o: { sm?: StateMachineData; target?: BindingTarget; object?: string }) {
  const d = doc();
  let sm = o.sm;
  if (!sm) {
    if (!d.stateMachines.length) return toast("Create a state machine with a number input first", "error");
    if (d.stateMachines.length === 1) sm = d.stateMachines[0];
    else {
      const r = await askForm({
        title: "Bind to input",
        fields: [{ key: "sm", type: "choice", label: "State machine", options: d.stateMachines.map((s) => ({ value: s.id, label: s.name })) }],
      });
      if (!r) return;
      sm = d.stateMachines.find((s) => s.id === r.sm)!;
    }
  }
  const inputs = drivable(sm);
  if (!inputs.length) return toast(`State machine "${sm.name}" has no number or bool input to bind`, "error");
  const first = await askForm({
    title: "Bind to input",
    message: "The input drives the property every frame, after animations.",
    confirmLabel: "Next",
    fields: [
      { key: "input", type: "choice", label: "Input", options: inputs.map((i) => ({ value: i.id, label: i.name, description: i.type })) },
      ...(o.target && o.object
        ? []
        : [{ key: "object", type: "choice" as const, label: "Drives", options: bindables(d).map((b) => ({ value: `${b.target}:${b.id}`, label: b.label })) }]),
    ],
  });
  if (!first) return;
  const [target, object] = o.target && o.object ? [o.target, o.object] : (first.object.split(/:(.*)/s) as [BindingTarget, string]);
  const props = BINDING_PROPERTIES[target];
  const second = await askForm({
    title: `Bind ${objectName(d, { target, object })}`,
    message: "Input values from In min to In max map linearly (clamped) to Out min to Out max. Colour bindings take hex colours.",
    confirmLabel: "Add binding",
    fields: [
      { key: "property", type: "choice", label: "Property", options: props.map((p) => ({ value: p, label: p })) },
      { key: "inMin", type: "text", label: "In min", value: "0", validate: isNum },
      { key: "inMax", type: "text", label: "In max", value: "1", validate: isNum },
      { key: "outMin", type: "text", label: "Out min", value: "0", placeholder: "number, or #rrggbb for color" },
      { key: "outMax", type: "text", label: "Out max", value: "100", placeholder: "number, or #rrggbb for color" },
    ],
  });
  if (!second) return;
  const color = second.property === "color";
  const out = (v: string, fallback: string) => (color ? (isHex(v) ? fallback : v) : Number(v) || 0);
  apply("addBinding", {
    stateMachine: sm.id,
    input: first.input,
    target,
    object,
    property: second.property,
    inMin: Number(second.inMin),
    inMax: Number(second.inMax),
    outMin: out(second.outMin, "#ffffff"),
    outMax: out(second.outMax, "#ff0000"),
  });
}

/** One binding with inline editors for its input, property and ranges. */
function BindingRow(p: { sm: StateMachineData; b: InputBinding; showObject: boolean }) {
  const set = (patch: Record<string, unknown>) => apply("updateBinding", { stateMachine: p.sm.id, binding: p.b.id, ...patch });
  const isColor = () => p.b.property === "color";
  const num = (key: "inMin" | "inMax" | "outMin" | "outMax") => (
    <input class="tiny" type="number" step="0.1" value={Number(p.b[key])} onChange={(e) => set({ [key]: Number(e.currentTarget.value) })} />
  );
  const col = (key: "outMin" | "outMax") => (
    <input type="color" value={String(p.b[key]).slice(0, 7)} onChange={(e) => set({ [key]: e.currentTarget.value })} />
  );
  return (
    <div class="binding">
      <div class="input-row">
        <select value={p.b.input} onChange={(e) => set({ input: e.currentTarget.value })} title="Input">
          <For each={drivable(p.sm)}>{(i) => <option value={i.id} selected={i.id === p.b.input}>{i.name}</option>}</For>
        </select>
        <span class="muted">→</span>
        <Show when={p.showObject}>
          <span title={p.b.target}>{objectName(doc(), p.b)}.</span>
        </Show>
        <select
          value={p.b.property}
          onChange={(e) => {
            const prop = e.currentTarget.value;
            // Switching between colour and number properties needs matching output values.
            if ((prop === "color") !== isColor()) set({ property: prop, ...(prop === "color" ? { outMin: "#ffffff", outMax: "#ff0000" } : { outMin: 0, outMax: 1 }) });
            else set({ property: prop });
          }}
          title="Property"
        >
          <For each={BINDING_PROPERTIES[p.b.target]}>{(x) => <option selected={x === p.b.property}>{x}</option>}</For>
        </select>
        <span class="grow" />
        <button class="row-del" title="Delete binding" onClick={() => apply("deleteBinding", { stateMachine: p.sm.id, binding: p.b.id })}>
          ×
        </button>
      </div>
      <div class="input-row binding-ranges">
        <span class="muted">in</span>
        {num("inMin")}
        {num("inMax")}
        <span class="muted">out</span>
        <Show when={isColor()} fallback={<>{num("outMin")}{num("outMax")}</>}>
          {col("outMin")}
          {col("outMax")}
        </Show>
      </div>
    </div>
  );
}

/**
 * Bindings list. With `object`, shows the bindings of every state machine that drive that bone/slot/constraint
 * (Inspector); with `sm`, all bindings of that state machine (State Machine panel).
 */
export function BindingList(p: { sm?: StateMachineData; target?: BindingTarget; object?: string }) {
  const rows = () => {
    // Ops edit bindings in place, so copy them: rows re-render whenever the document changes.
    const d = doc();
    const sms = p.sm ? d.stateMachines.filter((s) => s.id === p.sm!.id) : d.stateMachines;
    return sms.flatMap((sm) => (sm.bindings ?? []).filter((b) => !p.object || b.object === p.object).map((b) => ({ sm, b: { ...b } })));
  };
  return (
    <>
      <For each={rows()} fallback={<div class="muted pad">{p.object ? "No input drives this yet." : "Bindings drive bones, slots or constraints from number inputs."}</div>}>
        {(r) => <BindingRow sm={r.sm} b={r.b} showObject={!p.object} />}
      </For>
      <button onClick={() => newBinding({ sm: p.sm, target: p.target, object: p.object })}>+ Binding</button>
    </>
  );
}
