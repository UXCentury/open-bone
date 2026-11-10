import { z } from "zod";
import { findSound, findBus } from "../audio.ts";
import { get, newId } from "../document.ts";
import type { Condition, InputType, InputValue, ListenerAction, OpenBoneDocument, StateMachineData } from "../types.ts";
import { ANY_STATE } from "../types.ts";
import { defineOp, optId, ref } from "./registry.ts";

const smRef = ref("State machine");
const inputValue = z.union([z.boolean(), z.number(), z.string()]);

/** Convert a value to an input's type (the default for its type when missing). */
export function coerceInput(type: InputType, v: InputValue | undefined): InputValue {
  if (type === "number") {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "string") return v === undefined ? "" : String(v);
  if (typeof v === "string") return v === "true";
  return Boolean(v ?? false);
}
const layerRef = ref("Layer").optional().describe("Defaults to the first layer");

defineOp({
  name: "createStateMachine",
  group: "interactivity",
  description: "Create a state machine (Rive-style) with one empty layer.",
  schema: z.object({ id: optId, name: z.string(), layerName: z.string().default("Layer 1") }),
  apply(doc, a) {
    if (doc.stateMachines.some((s) => s.name === a.name)) throw new Error(`State machine "${a.name}" already exists`);
    const id = (a.id ??= newId("sm"));
    const layerId = `${id}_layer1`;
    doc.stateMachines.push({
      id,
      name: a.name,
      inputs: [],
      bindings: [],
      layers: [{ id: layerId, name: a.layerName, entry: null, states: [], transitions: [] }],
      listeners: [],
      scripts: [],
    });
    return { id, layer: layerId };
  },
});

defineOp({
  name: "deleteStateMachine",
  group: "interactivity",
  description: "Delete a state machine.",
  schema: z.object({ stateMachine: smRef }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    doc.stateMachines = doc.stateMachines.filter((s) => s !== sm);
    return {};
  },
});

defineOp({
  name: "addLayer",
  group: "interactivity",
  description: "Add a layer. Layers run in parallel; later layers override properties they key (e.g. body walk + face blink).",
  schema: z.object({ stateMachine: smRef, id: optId, name: z.string() }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const id = (a.id ??= newId("layer"));
    sm.layers.push({ id, name: a.name, entry: null, states: [], transitions: [] });
    return { id };
  },
});

defineOp({
  name: "addInput",
  group: "interactivity",
  description:
    "Add an input the host app / listeners / scripts control: bool, number, string or trigger (one-shot). Text attachments show inputs with {name} templates; number inputs can drive properties through bindings (addBinding).",
  schema: z.object({
    stateMachine: smRef,
    id: optId,
    name: z.string().regex(/^[^{}:]+$/, "Input names cannot contain { } or :"),
    type: z.enum(["bool", "number", "trigger", "string"]),
    default: inputValue.optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    if (sm.inputs.some((i) => i.name === a.name)) throw new Error(`Input "${a.name}" already exists`);
    const id = (a.id ??= newId("in"));
    sm.inputs.push({ id, name: a.name, type: a.type, default: coerceInput(a.type, a.default) });
    return { id };
  },
});

defineOp({
  name: "updateInput",
  group: "interactivity",
  description: "Rename an input or change its default value.",
  schema: z.object({
    stateMachine: smRef,
    input: ref("Input"),
    name: z.string().regex(/^[^{}:]+$/, "Input names cannot contain { } or :").optional(),
    default: inputValue.optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const input = get.input(sm, a.input);
    if (a.name && a.name !== input.name) {
      if (sm.inputs.some((i) => i.name === a.name)) throw new Error(`Input "${a.name}" already exists`);
      input.name = a.name;
    }
    if (a.default !== undefined) input.default = coerceInput(input.type, a.default);
    return {};
  },
});

defineOp({
  name: "deleteInput",
  group: "interactivity",
  description: "Delete an input and every condition, action and binding using it.",
  schema: z.object({ stateMachine: smRef, input: ref("Input") }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const input = get.input(sm, a.input);
    sm.inputs = sm.inputs.filter((i) => i !== input);
    for (const l of sm.layers) {
      for (const t of l.transitions) t.conditions = t.conditions.filter((c) => c.input !== input.id);
      for (const s of l.states) {
        if (s.blendInput === input.id) s.blendInput = undefined;
        if (s.inputs) {
          s.inputs = s.inputs.filter((x) => x.input !== input.id);
          if (!s.inputs.length) delete s.inputs;
        }
      }
    }
    for (const li of sm.listeners) li.actions = li.actions.filter((x) => !("input" in x) || x.input !== input.id);
    sm.bindings = (sm.bindings ?? []).filter((b) => b.input !== input.id);
    if (doc.skeleton.sliders) {
      doc.skeleton.sliders = doc.skeleton.sliders.filter((s) => s.input !== input.id);
      if (!doc.skeleton.sliders.length) delete doc.skeleton.sliders;
    }
    return {};
  },
});

defineOp({
  name: "addState",
  group: "interactivity",
  description:
    "Add a state to a layer. 'animation' plays one animation; 'blend1d' blends animations by a number input; 'exit' stops the layer. The first state added becomes the entry state. onComplete names a state to go to once the animation has played through (play once, then continue).",
  schema: z.object({
    stateMachine: smRef,
    layer: layerRef,
    id: optId,
    name: z.string().optional(),
    type: z.enum(["animation", "blend1d", "exit"]).default("animation"),
    animation: ref("Animation").optional(),
    loop: z.boolean().default(true),
    speed: z.number().default(1),
    blendInput: ref("Number input").optional(),
    blend: z.array(z.object({ animation: ref("Animation"), value: z.number() })).optional(),
    entry: z.boolean().optional().describe("Make this the layer's entry state"),
    onComplete: ref("State").nullable().optional().describe("State to go to when the animation finishes (after the first cycle when looping)"),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const anim = a.animation ? get.animation(doc, a.animation) : undefined;
    const id = (a.id ??= newId("st"));
    const name = (a.name ??= anim?.name ?? a.type);
    if (layer.states.some((s) => s.name === name)) throw new Error(`State "${name}" already exists in layer`);
    const n = layer.states.length;
    layer.states.push({
      id,
      name,
      type: a.type,
      ...(anim ? { animation: anim.id } : {}),
      loop: a.loop,
      speed: a.speed,
      ...(a.blendInput ? { blendInput: get.input(sm, a.blendInput).id } : {}),
      ...(a.blend ? { blend: a.blend.map((e) => ({ animation: get.animation(doc, e.animation).id, value: e.value })) } : {}),
      ...(a.onComplete ? { onComplete: a.onComplete === name ? id : get.state(layer, a.onComplete).id } : {}),
      x: a.x ?? 160 + (n % 4) * 180,
      y: a.y ?? 80 + Math.floor(n / 4) * 120,
    });
    if (a.entry || layer.entry === null) layer.entry = id;
    return { id, name };
  },
});

defineOp({
  name: "updateState",
  group: "interactivity",
  description: "Change a state's name, animation, loop, speed, blend setup, onComplete target (null clears it), editor position, or make it the entry.",
  schema: z.object({
    stateMachine: smRef,
    layer: layerRef,
    state: ref("State"),
    name: z.string().optional(),
    animation: ref("Animation").nullable().optional(),
    loop: z.boolean().optional(),
    speed: z.number().optional(),
    blendInput: ref("Number input").optional(),
    blend: z.array(z.object({ animation: ref("Animation"), value: z.number() })).optional(),
    entry: z.boolean().optional(),
    onComplete: ref("State").nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const s = get.state(layer, a.state);
    if (a.onComplete !== undefined) {
      if (a.onComplete === null) delete s.onComplete;
      else s.onComplete = get.state(layer, a.onComplete).id;
    }
    if (a.name) s.name = a.name;
    if (a.animation !== undefined) s.animation = a.animation === null ? undefined : get.animation(doc, a.animation).id;
    if (a.loop !== undefined) s.loop = a.loop;
    if (a.speed !== undefined) s.speed = a.speed;
    if (a.blendInput) s.blendInput = get.input(sm, a.blendInput).id;
    if (a.blend) s.blend = a.blend.map((e) => ({ animation: get.animation(doc, e.animation).id, value: e.value }));
    if (a.x !== undefined) s.x = a.x;
    if (a.y !== undefined) s.y = a.y;
    if (a.entry) layer.entry = s.id;
    return {};
  },
});

defineOp({
  name: "deleteState",
  group: "interactivity",
  description: "Delete a state and its transitions.",
  schema: z.object({ stateMachine: smRef, layer: layerRef, state: ref("State") }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const s = get.state(layer, a.state);
    layer.states = layer.states.filter((x) => x !== s);
    layer.transitions = layer.transitions.filter((t) => t.from !== s.id && t.to !== s.id);
    for (const x of layer.states) if (x.onComplete === s.id) delete x.onComplete;
    if (layer.entry === s.id) layer.entry = layer.states[0]?.id ?? null;
    return {};
  },
});

const conditionSchema = z.object({
  input: ref("Input"),
  op: z.enum(["==", "!=", ">", "<", ">=", "<="]).default("=="),
  value: inputValue.default(true),
});

function resolveConditions(sm: StateMachineData, list: z.infer<typeof conditionSchema>[]): Condition[] {
  return list.map((c) => {
    const input = get.input(sm, c.input);
    if (input.type === "string" && !["==", "!="].includes(c.op)) throw new Error(`String input "${input.name}" only supports == and !=`);
    return { input: input.id, op: c.op, value: input.type === "trigger" ? true : coerceInput(input.type, c.value) };
  });
}

defineOp({
  name: "addTransition",
  group: "interactivity",
  description:
    "Add a transition between states. from may be '@any'. All conditions must pass (trigger inputs pass when fired). Optional cross-fade duration (s) and exitTime (fraction of the source animation that must have played).",
  schema: z.object({
    stateMachine: smRef,
    layer: layerRef,
    id: optId,
    from: z.string().describe(`State id/name or "${ANY_STATE}"`),
    to: ref("State"),
    conditions: z.array(conditionSchema).default([]),
    duration: z.number().min(0).default(0.15),
    exitTime: z.number().min(0).nullable().default(null),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const from = a.from === ANY_STATE ? ANY_STATE : get.state(layer, a.from).id;
    const to = get.state(layer, a.to).id;
    const id = (a.id ??= newId("tr"));
    layer.transitions.push({ id, from, to, conditions: resolveConditions(sm, a.conditions), duration: a.duration, exitTime: a.exitTime });
    return { id };
  },
});

defineOp({
  name: "updateTransition",
  group: "interactivity",
  description: "Replace a transition's conditions, duration or exitTime.",
  schema: z.object({
    stateMachine: smRef,
    layer: layerRef,
    transition: z.string(),
    conditions: z.array(conditionSchema).optional(),
    duration: z.number().min(0).optional(),
    exitTime: z.number().min(0).nullable().optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const t = layer.transitions.find((x) => x.id === a.transition);
    if (!t) throw new Error(`Transition "${a.transition}" not found`);
    if (a.conditions) t.conditions = resolveConditions(sm, a.conditions);
    if (a.duration !== undefined) t.duration = a.duration;
    if (a.exitTime !== undefined) t.exitTime = a.exitTime;
    return {};
  },
});

defineOp({
  name: "deleteTransition",
  group: "interactivity",
  description: "Delete a transition.",
  schema: z.object({ stateMachine: smRef, layer: layerRef, transition: z.string() }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    layer.transitions = layer.transitions.filter((t) => t.id !== a.transition);
    return {};
  },
});

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setInput"), input: ref("Input"), value: inputValue }),
  z.object({ type: z.literal("toggleInput"), input: ref("Bool input") }),
  z.object({ type: z.literal("fireTrigger"), input: ref("Trigger input") }),
  z.object({ type: z.literal("reportEvent"), event: z.string().describe("Event name (created if missing)") }),
  z.object({ type: z.literal("runScript"), script: ref("Script"), fn: z.string().default("onAction") }),
  z.object({ type: z.literal("playSound"), sound: ref("Sound"), volume: z.number().min(0).optional() }),
  z.object({ type: z.literal("stopSound"), sound: ref("Sound"), fade: z.number().min(0).optional().describe("Fade-out seconds (default: the sound's fadeOut)") }),
  z.object({ type: z.literal("setEmitter"), slot: ref("Slot with a particles attachment"), emitting: z.boolean() }),
  z.object({ type: z.literal("emitParticles"), slot: ref("Slot with a particles attachment"), count: z.number().int().min(1).max(10000) }),
  z.object({
    type: z.literal("setMute"),
    bus: ref("Bus").nullable().default(null).describe("Bus name or id (e.g. music, sfx); null mutes everything (the master)"),
    muted: z.union([z.boolean(), z.literal("toggle")]).default("toggle"),
  }),
]);

function soundId(doc: OpenBoneDocument, r: string): string {
  const s = findSound(doc, r);
  if (!s) throw new Error(`Sound "${r}" not found. Available: ${(doc.audio?.sounds ?? []).map((x) => x.name).join(", ") || "(none)"}`);
  return s.id;
}

function resolveAction(doc: OpenBoneDocument, sm: StateMachineData, x: z.infer<typeof actionSchema>): ListenerAction {
  switch (x.type) {
    case "setInput": {
      const input = get.input(sm, x.input);
      return { type: "setInput", input: input.id, value: coerceInput(input.type, x.value) };
    }
    case "toggleInput":
      return { type: "toggleInput", input: get.input(sm, x.input).id };
    case "fireTrigger":
      return { type: "fireTrigger", input: get.input(sm, x.input).id };
    case "reportEvent": {
      let ev = doc.events.find((e) => e.id === x.event || e.name === x.event);
      if (!ev) {
        ev = { id: newId("evt"), name: x.event, int: 0, float: 0, string: "" };
        doc.events.push(ev);
      }
      return { type: "reportEvent", event: ev.id };
    }
    case "runScript":
      return { type: "runScript", script: get.script(doc, x.script).id, fn: x.fn };
    case "playSound":
      return { type: "playSound", sound: soundId(doc, x.sound), ...(x.volume !== undefined ? { volume: x.volume } : {}) };
    case "stopSound":
      return { type: "stopSound", sound: soundId(doc, x.sound), ...(x.fade !== undefined ? { fade: x.fade } : {}) };
    case "setEmitter":
      return { type: "setEmitter", slot: get.slot(doc, x.slot).id, emitting: x.emitting };
    case "emitParticles":
      return { type: "emitParticles", slot: get.slot(doc, x.slot).id, count: x.count };
    case "setMute": {
      if (x.bus === null) return { type: "setMute", bus: null, muted: x.muted };
      const bus = findBus(doc, x.bus);
      if (!bus) throw new Error(`Bus "${x.bus}" not found. Available: ${(doc.audio?.buses ?? []).map((b) => b.name).join(", ") || "(none)"}`);
      return { type: "setMute", bus: bus.id, muted: x.muted };
    }
  }
}

defineOp({
  name: "addListener",
  group: "interactivity",
  description:
    "React to pointer input on a slot's bounding box (or the whole artboard when slot is null): down, up, click, enter, exit, move → actions (setInput, toggleInput, fireTrigger, reportEvent, runScript, playSound, stopSound, setEmitter {slot, emitting} to start/stop a particle emitter, emitParticles {slot, count} for a one-off burst).",
  schema: z.object({
    stateMachine: smRef,
    id: optId,
    name: z.string().optional(),
    slot: ref("Slot with a bounding box").nullable().default(null),
    event: z.enum(["down", "up", "click", "enter", "exit", "move"]),
    actions: z.array(actionSchema).min(1),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const slot = a.slot ? get.slot(doc, a.slot).id : null;
    const id = (a.id ??= newId("lis"));
    // Pre-create referenced events so replays generate identical ids.
    const actions = a.actions.map((x) => resolveAction(doc, sm, x));
    sm.listeners.push({ id, name: a.name ?? `${a.event}`, slot, event: a.event, actions });
    return { id };
  },
});

defineOp({
  name: "deleteListener",
  group: "interactivity",
  description: "Delete a listener.",
  schema: z.object({ stateMachine: smRef, listener: z.string() }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    sm.listeners = sm.listeners.filter((l) => l.id !== a.listener && l.name !== a.listener);
    return {};
  },
});

defineOp({
  name: "addScript",
  group: "interactivity",
  description:
    "Add a sandboxed JavaScript script. Define any of: onStart(), onUpdate(dt), onEvent(e), onPointer(p), or custom functions for runScript actions. API: ob.input(name) / ob.setInput(name, v) / ob.fire(name) / ob.emit(event, payload) / ob.bone(name) -> {x,y,rotation,scaleX,scaleY,worldX,worldY} / ob.setBone(name, {rotation,...}) / ob.slot(name, {color, attachment}) / ob.time / ob.log(...).",
  schema: z.object({ id: optId, name: z.string(), code: z.string() }),
  apply(doc, a) {
    if (doc.scripts.some((s) => s.name === a.name)) throw new Error(`Script "${a.name}" already exists`);
    const id = (a.id ??= newId("scr"));
    doc.scripts.push({ id, name: a.name, code: a.code });
    return { id };
  },
});

defineOp({
  name: "updateScript",
  group: "interactivity",
  description: "Replace a script's code or name.",
  schema: z.object({ script: ref("Script"), name: z.string().optional(), code: z.string().optional() }),
  apply(doc, a) {
    const s = get.script(doc, a.script);
    if (a.name) s.name = a.name;
    if (a.code !== undefined) s.code = a.code;
    return {};
  },
});

defineOp({
  name: "attachScript",
  group: "interactivity",
  description: "Run a script for the whole state machine, or only while a given state is active.",
  schema: z.object({ stateMachine: smRef, script: ref("Script"), layer: layerRef, state: ref("State").optional() }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const script = get.script(doc, a.script);
    if (a.state) {
      const s = get.state(get.layer(sm, a.layer), a.state);
      s.scripts = [...new Set([...(s.scripts ?? []), script.id])];
    } else sm.scripts = [...new Set([...sm.scripts, script.id])];
    return {};
  },
});

defineOp({
  name: "deleteScript",
  group: "interactivity",
  description: "Delete a script and detach it everywhere.",
  schema: z.object({ script: ref("Script") }),
  apply(doc, a) {
    const s = get.script(doc, a.script);
    doc.scripts = doc.scripts.filter((x) => x !== s);
    for (const sm of doc.stateMachines) {
      sm.scripts = sm.scripts.filter((x) => x !== s.id);
      for (const l of sm.layers) for (const st of l.states) if (st.scripts) st.scripts = st.scripts.filter((x) => x !== s.id);
      for (const li of sm.listeners) li.actions = li.actions.filter((x) => x.type !== "runScript" || x.script !== s.id);
    }
    return {};
  },
});

defineOp({
  name: "setStateInput",
  group: "interactivity",
  description:
    "Make a state set a bool/number/string input when it is entered (value null removes it). Use it to reset a round: e.g. the idle state sets multiplier back to 1 and status to 'Press START' after a crash or cash-out.",
  schema: z.object({
    stateMachine: smRef,
    layer: ref("Layer").optional(),
    state: ref("State"),
    input: ref("Input"),
    value: inputValue.nullable(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const st = get.state(get.layer(sm, a.layer), a.state);
    const input = get.input(sm, a.input);
    if (input.type === "trigger") throw new Error(`"${input.name}" is a trigger; states can only set bool, number and string inputs on enter`);
    const list = (st.inputs ?? []).filter((x) => x.input !== input.id);
    if (a.value !== null) list.push({ input: input.id, value: coerceInput(input.type, a.value) });
    if (list.length) st.inputs = list;
    else delete st.inputs;
    return {};
  },
});
