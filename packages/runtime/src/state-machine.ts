import {
  ANY_STATE,
  type AnimationData,
  type Condition,
  type InputData,
  type LayerData,
  type ListenerAction,
  type ListenerData,
  type OpenBoneDocument,
  type PointerEventType,
  type StateData,
  type StateMachineData,
  type TransitionData,
  animationDuration,
  parseHex,
} from "@openbone/core";
import { type FiredEvent, applyAnimation, eventsBetween, localTime } from "./animation.ts";
import { Emitter } from "./emitter.ts";
import type { ScriptApi, ScriptHandle, ScriptHost } from "./scripting.ts";
import type { Skeleton } from "./skeleton.ts";

class StateInstance {
  time = 0;
  prevTime = -1e-6;
  scripts: ScriptHandle[] = [];
  constructor(public data: StateData) {}
}

class LayerInstance {
  current: StateInstance | null = null;
  from: StateInstance | null = null;
  mixTime = 0;
  mixDuration = 0;
  exited = false;
  constructor(public data: LayerData) {}
}

type BoneOverride = Partial<Record<"x" | "y" | "rotation" | "scaleX" | "scaleY" | "shearX" | "shearY", number>>;

export type SMEvents = {
  /** An event reported by an animation key, listener or script. */
  event: [FiredEvent];
  stateChange: [{ layer: string; from: string | null; to: string }];
  inputChange: [{ name: string; value: boolean | number }];
  log: [unknown[]];
  error: [Error];
};

export interface StateMachineOptions {
  scriptHost?: ScriptHost;
  /** Max ms a single script call may take before it is aborted (QuickJS host). */
  scriptTimeoutMs?: number;
}

/**
 * Runs a Rive-style state machine over a skeleton: inputs, layered states with cross-fades,
 * pointer listeners, events and scripts.
 */
export class StateMachineInstance extends Emitter<SMEvents> {
  readonly doc: OpenBoneDocument;
  inputs = new Map<string, boolean | number>();
  private fired = new Set<string>();
  private layers: LayerInstance[];
  private pending: { type: PointerEventType; x: number; y: number }[] = [];
  private hovered = new Set<string>();
  private pressed = new Set<string>();
  private pointerState = { x: 0, y: 0, down: false };
  private scripts: ScriptHandle[] = [];
  private boneOverrides = new Map<string, BoneOverride>();
  private slotOverrides = new Map<string, { color?: string; attachment?: string | null }>();
  private pendingEvents: FiredEvent[] = [];
  private elapsed = 0;
  private started = false;

  constructor(
    public skeleton: Skeleton,
    public data: StateMachineData,
    private opts: StateMachineOptions = {},
  ) {
    super();
    this.doc = skeleton.doc;
    for (const i of data.inputs) this.inputs.set(i.id, i.type === "trigger" ? false : i.default);
    this.layers = data.layers.map((l) => new LayerInstance(l));
  }

  // ---------------- Inputs ----------------
  private input(ref: string): InputData | undefined {
    return this.data.inputs.find((i) => i.id === ref || i.name === ref);
  }
  getInput(name: string): boolean | number | undefined {
    const i = this.input(name);
    return i ? this.inputs.get(i.id) : undefined;
  }
  setInput(name: string, value: boolean | number) {
    const i = this.input(name);
    if (!i) throw new Error(`Input "${name}" not found`);
    if (i.type === "trigger") return this.fire(name);
    const v = i.type === "bool" ? Boolean(value) : Number(value);
    if (this.inputs.get(i.id) === v) return;
    this.inputs.set(i.id, v);
    this.emit("inputChange", { name: i.name, value: v });
  }
  setBool(name: string, v: boolean) {
    this.setInput(name, v);
  }
  setNumber(name: string, v: number) {
    this.setInput(name, v);
  }
  fire(name: string) {
    const i = this.input(name);
    if (!i) throw new Error(`Input "${name}" not found`);
    this.fired.add(i.id);
    this.emit("inputChange", { name: i.name, value: true });
  }

  /** Current state name per layer. */
  get activeStates(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const l of this.layers) out[l.data.name] = l.exited ? "exit" : (l.current?.data.name ?? null);
    return out;
  }

  // ---------------- Pointer ----------------
  /** Queue a pointer event in skeleton (world) coordinates; processed on the next advance(). */
  pointer(type: "down" | "up" | "move", x: number, y: number) {
    this.pending.push({ type, x, y });
  }

  private processPointer() {
    const evs = this.pending;
    this.pending = [];
    for (const p of evs) {
      this.pointerState = { x: p.x, y: p.y, down: p.type === "down" ? true : p.type === "up" ? false : this.pointerState.down };
      for (const s of this.scripts) this.safeCall(s, "onPointer", { type: p.type, x: p.x, y: p.y });
      for (const li of this.data.listeners) {
        const hit = li.slot ? this.hit(li.slot, p.x, p.y) : true;
        const key = li.id;
        let fire = false;
        if (li.event === "move") fire = hit && p.type === "move";
        else if (li.event === "down") fire = hit && p.type === "down";
        else if (li.event === "up") fire = hit && p.type === "up";
        else if (li.event === "click") {
          if (p.type === "down" && hit) this.pressed.add(key);
          if (p.type === "up") {
            fire = hit && this.pressed.has(key);
            this.pressed.delete(key);
          }
        } else if (li.event === "enter" || li.event === "exit") {
          const was = this.hovered.has(key);
          if (hit && !was) {
            this.hovered.add(key);
            fire = li.event === "enter";
          } else if (!hit && was) {
            this.hovered.delete(key);
            fire = li.event === "exit";
          }
        }
        if (fire) this.runActions(li, li.actions);
      }
    }
  }

  private hit(slotId: string, x: number, y: number) {
    const slot = this.skeleton.slotById_(slotId);
    return !!slot && this.skeleton.hitTest(slot, x, y);
  }

  private runActions(_li: ListenerData, actions: ListenerAction[]) {
    for (const a of actions) {
      switch (a.type) {
        case "setInput":
          this.setInput(a.input, a.value);
          break;
        case "toggleInput":
          this.setInput(a.input, !this.inputs.get(a.input));
          break;
        case "fireTrigger":
          this.fire(a.input);
          break;
        case "reportEvent": {
          const ev = this.doc.events.find((e) => e.id === a.event);
          if (ev) this.pendingEvents.push({ name: ev.name, id: ev.id, time: this.elapsed, int: ev.int, float: ev.float, string: ev.string, animation: "" });
          break;
        }
        case "runScript": {
          const script = this.doc.scripts.find((s) => s.id === a.script);
          const handle = script && this.scriptFor(script.id);
          if (handle) this.safeCall(handle, a.fn);
          break;
        }
      }
    }
  }

  // ---------------- Scripts ----------------
  private handles = new Map<string, ScriptHandle>();

  private api(): ScriptApi {
    return {
      time: () => this.elapsed,
      input: (n) => this.getInput(n),
      setInput: (n, v) => this.setInput(n, v),
      fire: (n) => this.fire(n),
      emit: (name, payload = {}) => {
        const ev = this.doc.events.find((e) => e.name === name || e.id === name);
        this.pendingEvents.push({
          name,
          id: ev?.id ?? name,
          time: this.elapsed,
          int: payload.int ?? ev?.int ?? 0,
          float: payload.float ?? ev?.float ?? 0,
          string: payload.string ?? ev?.string ?? "",
          animation: "",
        });
      },
      bone: (n) => {
        const b = this.skeleton.findBone(n);
        if (!b) return null;
        return { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, worldX: b.world.x, worldY: b.world.y, worldRotation: b.worldRotation };
      },
      setBone: (n, props) => {
        const b = this.skeleton.findBone(n);
        if (b) this.boneOverrides.set(b.data.id, { ...this.boneOverrides.get(b.data.id), ...props });
      },
      slot: (n, props) => {
        const s = this.skeleton.findSlot(n);
        if (s) this.slotOverrides.set(s.data.id, { ...this.slotOverrides.get(s.data.id), ...props });
      },
      pointer: () => ({ ...this.pointerState }),
      log: (...args) => this.emit("log", args),
    };
  }

  private scriptFor(id: string): ScriptHandle | null {
    if (!this.opts.scriptHost) return null;
    let h = this.handles.get(id);
    if (!h) {
      const s = this.doc.scripts.find((x) => x.id === id);
      if (!s) return null;
      try {
        h = this.opts.scriptHost.load(s, this.api());
      } catch (e) {
        this.emit("error", e as Error);
        return null;
      }
      this.handles.set(id, h);
    }
    return h;
  }

  private safeCall(h: ScriptHandle, fn: string, ...args: unknown[]) {
    try {
      if (h.has(fn)) h.call(fn, ...args);
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }
  }

  private start() {
    this.started = true;
    for (const id of this.data.scripts) {
      const h = this.scriptFor(id);
      if (h) {
        this.scripts.push(h);
        this.safeCall(h, "onStart");
      }
    }
    for (const l of this.layers) {
      const entry = l.data.states.find((s) => s.id === l.data.entry);
      if (entry) this.enter(l, entry, 0);
    }
  }

  private enter(l: LayerInstance, state: StateData, mix: number) {
    const prev = l.current;
    if (prev) for (const h of prev.scripts) this.disposeStateScript(h);
    if (state.type === "exit") {
      l.exited = true;
      l.from = prev;
      l.current = null;
      l.mixTime = 0;
      l.mixDuration = mix;
    } else {
      const inst = new StateInstance(state);
      l.from = mix > 0 ? prev : null;
      l.current = inst;
      l.mixTime = 0;
      l.mixDuration = mix;
      l.exited = false;
      for (const id of state.scripts ?? []) {
        const s = this.doc.scripts.find((x) => x.id === id);
        if (!s || !this.opts.scriptHost) continue;
        try {
          const h = this.opts.scriptHost.load(s, this.api());
          inst.scripts.push(h);
          this.safeCall(h, "onStart");
        } catch (e) {
          this.emit("error", e as Error);
        }
      }
    }
    this.emit("stateChange", { layer: l.data.name, from: prev?.data.name ?? null, to: state.name });
  }

  private disposeStateScript(h: ScriptHandle) {
    try {
      h.dispose();
    } catch {
      /* ignore */
    }
  }

  // ---------------- Transitions ----------------
  private conditionPasses(c: Condition): boolean {
    const input = this.data.inputs.find((i) => i.id === c.input);
    if (!input) return false;
    if (input.type === "trigger") return this.fired.has(input.id);
    const v = this.inputs.get(input.id);
    const want = c.value;
    switch (c.op) {
      case "==":
        return v === want || (typeof v === "number" && typeof want === "number" && Math.abs(v - want) < 1e-9);
      case "!=":
        return v !== want;
      case ">":
        return Number(v) > Number(want);
      case "<":
        return Number(v) < Number(want);
      case ">=":
        return Number(v) >= Number(want);
      case "<=":
        return Number(v) <= Number(want);
    }
  }

  private progress(s: StateInstance): number {
    const anim = this.anim(s.data.animation);
    const d = anim ? animationDuration(anim) : 0;
    return d > 0 ? s.time / d : 1;
  }

  private canTake(t: TransitionData, s: StateInstance | null): boolean {
    if (t.from !== ANY_STATE && t.to === s?.data.id && t.conditions.length === 0) return false;
    if (t.from === ANY_STATE && t.to === s?.data.id) return false; // don't restart self from any-state
    const exitTime = t.exitTime ?? (t.conditions.length === 0 ? 1 : null);
    if (exitTime != null && s && this.progress(s) < exitTime) return false;
    return t.conditions.every((c) => this.conditionPasses(c));
  }

  private evaluate(l: LayerInstance) {
    if (l.exited) return;
    const cur = l.current;
    const candidates = l.data.transitions.filter((t) => t.from === ANY_STATE || t.from === cur?.data.id);
    // Specific transitions take priority over any-state ones.
    candidates.sort((a, b) => Number(a.from === ANY_STATE) - Number(b.from === ANY_STATE));
    for (const t of candidates) {
      if (!this.canTake(t, cur)) continue;
      const to = l.data.states.find((s) => s.id === t.to);
      if (to) this.enter(l, to, t.duration);
      return;
    }
  }

  private anim(id: string | undefined): AnimationData | undefined {
    return id ? this.doc.animations.find((a) => a.id === id) : undefined;
  }

  // ---------------- Apply ----------------
  /** Blend1d: the two bracketing entries and the weight of the upper one. */
  private blendPair(d: StateData): { lo: AnimationData | undefined; hi: AnimationData | undefined; t: number } | null {
    if (d.type !== "blend1d" || !d.blend?.length) return null;
    const v = Number(this.inputs.get(d.blendInput ?? "") ?? 0);
    const entries = [...d.blend].sort((a, b) => a.value - b.value);
    let lo = entries[0];
    let hi = entries[0];
    let t = 0;
    if (v >= entries[entries.length - 1].value) lo = hi = entries[entries.length - 1];
    else
      for (let i = 0; i < entries.length - 1; i++)
        if (v >= entries[i].value && v <= entries[i + 1].value) {
          lo = entries[i];
          hi = entries[i + 1];
          t = (v - lo.value) / (hi.value - lo.value || 1);
          break;
        }
    return { lo: this.anim(lo.animation), hi: this.anim(hi.animation), t };
  }

  private applyState(s: StateInstance, alpha: number) {
    const d = s.data;
    if (d.type === "animation") {
      const anim = this.anim(d.animation);
      if (anim) applyAnimation(this.skeleton, anim, localTime(anim, s.time, d.loop), alpha);
    } else if (d.type === "blend1d") {
      const pair = this.blendPair(d);
      if (!pair) return;
      const { lo, hi, t } = pair;
      if (lo) applyAnimation(this.skeleton, lo, localTime(lo, s.time, d.loop), alpha);
      if (hi && hi !== lo && t > 0) applyAnimation(this.skeleton, hi, localTime(hi, s.time, d.loop), alpha * t);
    }
  }

  private collectEvents(s: StateInstance) {
    const d = s.data;
    let anim: AnimationData | undefined;
    if (d.type === "animation") anim = this.anim(d.animation);
    else if (d.type === "blend1d") {
      // Only the dominant animation of a blend reports events (avoids doubled footsteps).
      const pair = this.blendPair(d);
      anim = pair ? (pair.t >= 0.5 ? pair.hi : pair.lo) : undefined;
    }
    if (anim) this.pendingEvents.push(...eventsBetween(this.doc, anim, s.prevTime, s.time, d.loop));
  }

  /** Step the machine by `dt` seconds and pose the skeleton. */
  advance(dt: number) {
    if (!this.started) this.start();
    this.elapsed += dt;
    this.processPointer();
    for (const s of this.scripts) this.safeCall(s, "onUpdate", dt);
    for (const l of this.layers) for (const h of l.current?.scripts ?? []) this.safeCall(h, "onUpdate", dt);

    for (const l of this.layers) this.evaluate(l);
    this.fired.clear();

    for (const l of this.layers) {
      for (const s of [l.current, l.from]) {
        if (!s) continue;
        s.prevTime = s.time;
        s.time += dt * s.data.speed;
      }
      if (l.current) this.collectEvents(l.current);
      if (l.from) {
        l.mixTime += dt;
        if (l.mixTime >= l.mixDuration) l.from = null;
      }
    }

    const sk = this.skeleton;
    sk.setToSetupPose();
    for (const l of this.layers) {
      const mixA = l.mixDuration > 0 ? Math.min(1, l.mixTime / l.mixDuration) : 1;
      if (l.from) this.applyState(l.from, l.exited ? 1 - mixA : 1);
      if (l.current) this.applyState(l.current, l.from ? mixA : 1);
    }
    for (const [id, o] of this.boneOverrides) {
      const b = sk.boneById_(id);
      if (b) Object.assign(b, o);
    }
    for (const [id, o] of this.slotOverrides) {
      const s = sk.slotById_(id);
      if (!s) continue;
      if (o.color) s.color = parseHex(o.color);
      if (o.attachment !== undefined) s.attachmentName = o.attachment;
    }
    for (const [id, v] of this.inputs) if (typeof v === "number") sk.inputValues.set(id, v);
    sk.update(dt);
    sk.updateWorldTransform();

    const evs = this.pendingEvents;
    this.pendingEvents = [];
    for (const e of evs) {
      this.emit("event", e);
      for (const h of this.scripts) this.safeCall(h, "onEvent", e);
      for (const l of this.layers) for (const h of l.current?.scripts ?? []) this.safeCall(h, "onEvent", e);
    }
  }

  /** Clear persistent script overrides (scripts typically re-set them each frame). */
  clearOverrides() {
    this.boneOverrides.clear();
    this.slotOverrides.clear();
  }

  dispose() {
    for (const h of this.handles.values()) h.dispose();
    for (const l of this.layers) for (const h of l.current?.scripts ?? []) h.dispose();
    this.handles.clear();
  }
}
