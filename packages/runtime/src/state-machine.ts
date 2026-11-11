import {
  ANY_STATE,
  type AnimationData,
  type Condition,
  type Id,
  type InputBinding,
  type InputData,
  type InputValue,
  type LayerData,
  type ListenerAction,
  type ListenerData,
  type OpenBoneDocument,
  type PointerEventType,
  type StateData,
  type StateMachineData,
  type TransitionData,
  animationDuration,
  bindingT,
  parseHex,
} from "@openbone/core";
import { type FiredEvent, applyAnimation, eventsBetween, localTime } from "./animation.ts";
import { type AudioCommand, AudioDirector, playAudioKeys } from "./audio.ts";
import { Emitter } from "./emitter.ts";
import type { ScriptApi, ScriptHandle, ScriptHost } from "./scripting.ts";
import type { Skeleton } from "./skeleton.ts";

let stateCounter = 0;
/** Cross-fade seconds for an onComplete hand-over. */
const ON_COMPLETE_MIX = 0.1;

class StateInstance {
  /** Owner id for the sounds this state starts. */
  readonly uid = `state_${++stateCounter}`;
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
  inputChange: [{ name: string; value: InputValue }];
  log: [unknown[]];
  error: [Error];
  /** Sound commands (play/stop/fade) for an audio backend. */
  audio: [AudioCommand];
};

export interface StateMachineOptions {
  /**
   * Runs the document's scripts (e.g. `createQuickJsHost()` from @openbone/scripting). Without one, scripts don't run
   * and a warning is printed once; pass `null` to run without scripts on purpose, with no warning.
   */
  scriptHost?: ScriptHost | null;
  /** @deprecated Ignored. Set the limit on the script host instead, e.g. `createQuickJsHost({ timeoutMs })`. */
  scriptTimeoutMs?: number;
}

/** Documents already warned about, so a warning shows once per document, not once per state machine instance. */
const warnedNoHost = new WeakSet<object>();

/**
 * Runs a Rive-style state machine over a skeleton: inputs, layered states with cross-fades,
 * pointer listeners, events and scripts.
 */
export class StateMachineInstance extends Emitter<SMEvents> {
  readonly doc: OpenBoneDocument;
  inputs = new Map<string, InputValue>();
  private fired = new Set<string>();
  private layers: LayerInstance[];
  private pending: { type: PointerEventType; x: number; y: number }[] = [];
  private hovered = new Set<string>();
  private pressed = new Set<string>();
  private pointerState = { x: 0, y: 0, down: false };
  private scripts: ScriptHandle[] = [];
  private boneOverrides = new Map<string, BoneOverride>();
  private slotOverrides = new Map<string, { color?: string; attachment?: string | null }>();
  /** Emitter on/off set by listeners and states (slot id → emitting), re-applied every frame. */
  private emitterOverrides = new Map<string, boolean>();
  private pendingEvents: FiredEvent[] = [];
  private elapsed = 0;
  private started = false;
  /** Sounds started by states, audio keys, event audio and listeners. */
  readonly audio: AudioDirector;

  constructor(
    public skeleton: Skeleton,
    public data: StateMachineData,
    private opts: StateMachineOptions = {},
  ) {
    super();
    this.doc = skeleton.doc;
    this.audio = new AudioDirector(this.doc, (c) => this.emit("audio", c));
    for (const i of data.inputs) this.inputs.set(i.id, i.type === "trigger" ? false : i.default);
    this.layers = data.layers.map((l) => new LayerInstance(l));
    // Text templates read this machine's inputs by name.
    skeleton.textValues = (name) => this.getInput(name);
    if (opts.scriptHost === undefined && this.doc.scripts.length && !warnedNoHost.has(this.doc)) {
      warnedNoHost.add(this.doc);
      console.warn(
        `OpenBone: "${this.doc.name}" has ${this.doc.scripts.length} script(s), but no scriptHost was given, so they won't run. ` +
          "Pass one (e.g. createQuickJsHost() from @openbone/scripting), or scriptHost: null to run without scripts on purpose.",
      );
    }
  }

  // ---------------- Inputs ----------------
  private input(ref: string): InputData | undefined {
    return this.data.inputs.find((i) => i.id === ref || i.name === ref);
  }
  getInput(name: string): InputValue | undefined {
    const i = this.input(name);
    return i ? this.inputs.get(i.id) : undefined;
  }
  setInput(name: string, value: InputValue) {
    const i = this.input(name);
    if (!i) throw new Error(`Input "${name}" not found`);
    if (i.type === "trigger") return this.fire(name);
    let v: InputValue;
    if (i.type === "string") v = String(value);
    else if (i.type === "bool") v = typeof value === "string" ? value === "true" : Boolean(value);
    else {
      v = Number(value);
      if (!Number.isFinite(v)) return;
    }
    if (this.inputs.get(i.id) === v) return;
    this.inputs.set(i.id, v);
    if (i.type === "bool" && i.mutes !== undefined) this.audio.setMute(i.mutes, v as boolean);
    this.emit("inputChange", { name: i.name, value: v });
  }

  /**
   * Mute, unmute or toggle a bus (null = the master). When a bool input owns that bus's mute (`InputData.mutes`), it
   * goes through the input so both stay in step. Returns the new state.
   */
  setBusMute(bus: Id | null, muted: boolean | "toggle"): boolean {
    const next = muted === "toggle" ? !this.audio.isMuted(bus) : muted;
    const owner = this.data.inputs.find((i) => i.type === "bool" && i.mutes === bus);
    if (owner && this.inputs.get(owner.id) !== next) this.setInput(owner.id, next);
    else this.audio.setMute(bus, next);
    return next;
  }
  setBool(name: string, v: boolean) {
    this.setInput(name, v);
  }
  setNumber(name: string, v: number) {
    this.setInput(name, v);
  }
  setString(name: string, v: string) {
    this.setInput(name, v);
  }
  /** Show fixed text (or a template) in a slot's text attachment; null goes back to the attachment's own text. */
  setText(slot: string, text: string | null) {
    this.skeleton.setText(slot, text);
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
          if (ev) {
            if (ev.audio) this.audio.play(ev.audio, { volume: ev.volume, source: `event:${ev.name}` });
            this.pendingEvents.push({ name: ev.name, id: ev.id, time: this.elapsed, int: ev.int, float: ev.float, string: ev.string, animation: "" });
          }
          break;
        }
        case "playSound":
          this.audio.play(a.sound, { volume: a.volume, source: `listener:${_li.name}` });
          break;
        case "stopSound":
          this.audio.stopSound(a.sound, a.fade);
          break;
        case "runScript": {
          const script = this.doc.scripts.find((s) => s.id === a.script);
          const handle = script && this.scriptFor(script.id);
          if (handle) this.safeCall(handle, a.fn);
          break;
        }
        case "setEmitter":
          this.setEmitter(a.slot, a.emitting);
          break;
        case "setMute":
          this.setBusMute(a.bus, a.muted);
          break;
        case "emitParticles":
          this.skeleton.emitParticles(a.slot, a.count);
          break;
      }
    }
  }

  /** Switch a slot's particle emitter; switching it on restarts its cycle so bursts replay. */
  setEmitter(slotRef: string, emitting: boolean) {
    const slot = this.skeleton.findSlot(slotRef);
    if (!slot) return;
    this.emitterOverrides.set(slot.data.id, emitting);
    if (emitting) this.skeleton.restartEmitter(slot.data.id);
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
        if (ev?.audio) this.audio.play(ev.audio, { volume: ev.volume, source: `event:${ev.name}` });
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
    // Inputs that own a bus's mute: a true default mutes it; a bus already muted (the document's mix, or mutes the
    // host set before this machine) shows as true.
    for (const i of this.data.inputs) {
      if (i.type !== "bool" || i.mutes === undefined) continue;
      if (this.inputs.get(i.id)) this.audio.setMute(i.mutes, true);
      else if (this.audio.isMuted(i.mutes)) this.inputs.set(i.id, true);
    }
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

  /** Run a state's sound hooks for `on`; plays on enter are owned by the state instance. */
  private stateSounds(s: StateData, on: "enter" | "exit", owner?: string) {
    for (const x of s.sounds ?? []) {
      if (x.on !== on) continue;
      if (x.action === "stop") this.audio.stopSound(x.sound);
      else this.audio.play(x.sound, { volume: x.volume, owner, tag: owner && `hook:${x.sound}`, source: `state:${s.name}` });
    }
  }

  private enter(l: LayerInstance, state: StateData, mix: number) {
    const prev = l.current;
    if (prev) {
      for (const h of prev.scripts) this.disposeStateScript(h);
      // Looping sounds of the old state fade out over the cross-fade (at least their own fadeOut).
      this.audio.stopOwner(prev.uid, mix);
      this.stateSounds(prev.data, "exit");
    }
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
      this.stateSounds(state, "enter", inst.uid);
      for (const e of state.emitters ?? []) this.setEmitter(e.slot, e.emitting);
      for (const x of state.inputs ?? []) if (this.input(x.input)) this.setInput(x.input, x.value);
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
        if (input.type === "string") return String(v) === String(want);
        return v === want || (typeof v === "number" && typeof want === "number" && Math.abs(v - want) < 1e-9);
      case "!=":
        if (input.type === "string") return String(v) !== String(want);
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
    // A blend state's progress follows its stronger animation (the one its events come from).
    const pair = this.blendPair(s.data);
    const anim = pair ? (pair.t >= 0.5 ? pair.hi : pair.lo) : this.anim(s.data.animation);
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

  /** Take at most one transition (or the "on complete" step); returns the transition taken, if any. */
  private evaluate(l: LayerInstance): TransitionData | null {
    if (l.exited) return null;
    const cur = l.current;
    const candidates = l.data.transitions.filter((t) => t.from === ANY_STATE || t.from === cur?.data.id);
    // Specific transitions take priority over any-state ones.
    candidates.sort((a, b) => Number(a.from === ANY_STATE) - Number(b.from === ANY_STATE));
    for (const t of candidates) {
      if (!this.canTake(t, cur)) continue;
      // A transition to a deleted state is skipped (and keeps its triggers for others).
      const to = l.data.states.find((s) => s.id === t.to);
      if (!to) continue;
      this.enter(l, to, t.duration);
      return t;
    }
    // "On complete": play once, then continue to the next state.
    const next = cur?.data.onComplete;
    if (cur && next && this.progress(cur) >= 1) {
      const to = l.data.states.find((s) => s.id === next);
      if (to) this.enter(l, to, ON_COMPLETE_MIX);
    }
    return null;
  }

  /**
   * Evaluate a layer until it settles (a few hops at most). A transition consumes only the triggers in its own
   * conditions, so a trigger fired in the same frame as another change (stop walking + attack) is still seen by the
   * transition that needs it, instead of being dropped with the rest at the end of the frame.
   */
  private settle(l: LayerInstance) {
    for (let hop = 0; hop < 4; hop++) {
      const t = this.evaluate(l);
      if (!t) return;
      for (const c of t.conditions) if (this.fired.has(c.input)) this.fired.delete(c.input);
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

  /** The animations a state is playing now (a blend state's current pair). */
  private stateAnimations(s: StateInstance): AnimationData[] {
    const d = s.data;
    if (d.type === "animation") {
      const anim = this.anim(d.animation);
      return anim ? [anim] : [];
    }
    if (d.type === "blend1d") {
      const pair = this.blendPair(d);
      if (!pair) return [];
      return [pair.lo, pair.hi].filter((a): a is AnimationData => !!a);
    }
    return [];
  }

  /**
   * Pose a state at weight `alpha`. With `into` (the state being faded to) and its outgoing weight `outAlpha`, the
   * blending values none of `into` key are applied at `outAlpha` instead, so they fade towards the pose underneath.
   */
  private applyState(s: StateInstance, alpha: number, into?: AnimationData[], outAlpha = 0) {
    const d = s.data;
    if (d.type === "animation") {
      const anim = this.anim(d.animation);
      if (anim) applyAnimation(this.skeleton, anim, localTime(anim, s.time, d.loop), alpha, into && { into, alpha: outAlpha });
    } else if (d.type === "blend1d") {
      const pair = this.blendPair(d);
      if (!pair) return;
      const { lo, hi, t } = pair;
      if (lo) applyAnimation(this.skeleton, lo, localTime(lo, s.time, d.loop), alpha, into && { into, alpha: outAlpha });
      if (hi && hi !== lo && t > 0)
        applyAnimation(this.skeleton, hi, localTime(hi, s.time, d.loop), alpha * t, into && { into, alpha: outAlpha * t });
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
    if (!anim) return;
    playAudioKeys(this.audio, anim, s.prevTime, s.time, d.loop, s.uid);
    for (const ev of eventsBetween(this.doc, anim, s.prevTime, s.time, d.loop)) {
      if (ev.audio) this.audio.play(ev.audio, { volume: ev.volume, owner: s.uid, source: `event:${ev.name}` });
      this.pendingEvents.push(ev);
    }
  }

  /** Step the machine by `dt` seconds and pose the skeleton. */
  advance(dt: number) {
    if (!this.started) this.start();
    this.elapsed += dt;
    this.audio.update(dt);
    this.processPointer();
    for (const s of this.scripts) this.safeCall(s, "onUpdate", dt);
    for (const l of this.layers) for (const h of l.current?.scripts ?? []) this.safeCall(h, "onUpdate", dt);

    for (const l of this.layers) this.settle(l);
    this.fired.clear();

    for (const l of this.layers) {
      for (const s of [l.current, l.from]) {
        if (!s) continue;
        s.prevTime = s.time > 0 ? s.time : Math.min(s.prevTime, s.time); // keys at 0 fire on the first step
        s.time += dt * s.data.speed;
      }
      // No time passed: nothing was crossed (keys at 0 fire on the first real step, not twice).
      if (l.current && dt > 0) this.collectEvents(l.current);
      if (l.from) {
        l.mixTime += dt;
        if (l.mixTime >= l.mixDuration) l.from = null;
      }
    }

    const sk = this.skeleton;
    sk.setToSetupPose();
    for (const l of this.layers) {
      const mixA = l.mixDuration > 0 ? Math.min(1, l.mixTime / l.mixDuration) : 1;
      if (l.from) {
        // Fading to a state: what it doesn't key fades from the old state's value to the pose underneath.
        if (l.current) this.applyState(l.from, 1, this.stateAnimations(l.current), 1 - mixA);
        else this.applyState(l.from, l.exited ? 1 - mixA : 1);
      }
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
    for (const [id, emitting] of this.emitterOverrides) sk.particleValues.set(id, { ...sk.particleValues.get(id), emitting });
    this.applyBindings();
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

  /** Drive bound properties from their inputs (after animations and script overrides). */
  applyBindings() {
    const sk = this.skeleton;
    for (const b of this.data.bindings ?? []) {
      const raw = this.inputs.get(b.input);
      if (raw === undefined) continue;
      // Bindings read numbers; a bool counts as 0/1, and a text input that isn't a number is ignored (no NaN poses).
      const n = typeof raw === "boolean" ? Number(raw) : Number(raw);
      if (!Number.isFinite(n)) continue;
      const t = bindingT(n, b.inMin, b.inMax);
      if (b.target === "bone") {
        const bone = sk.boneById_(b.object);
        if (bone) (bone as unknown as Record<string, number>)[b.property] = lerpNum(b, t);
      } else if (b.target === "slot") {
        const slot = sk.slotById_(b.object);
        if (!slot) continue;
        if (b.property === "alpha") slot.color = [slot.color[0], slot.color[1], slot.color[2], lerpNum(b, t)];
        else if (b.property === "color") {
          const lo = parseHex(String(b.outMin));
          const hi = parseHex(String(b.outMax));
          slot.color = [0, 1, 2, 3].map((k) => lo[k] + (hi[k] - lo[k]) * t) as typeof slot.color;
        }
      } else {
        const v = sk.constraintValues.get(b.object);
        if (v) v[b.property] = lerpNum(b, t);
      }
    }
  }

  /** Clear persistent script overrides (scripts typically re-set them each frame). */
  clearOverrides() {
    this.boneOverrides.clear();
    this.slotOverrides.clear();
  }

  dispose() {
    this.audio.stopAll();
    for (const h of this.handles.values()) h.dispose();
    for (const l of this.layers) for (const h of l.current?.scripts ?? []) h.dispose();
    this.handles.clear();
  }
}

const lerpNum = (b: InputBinding, t: number) => Number(b.outMin) + (Number(b.outMax) - Number(b.outMin)) * t;
