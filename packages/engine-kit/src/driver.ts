import type { AudioAsset, OpenBoneDocument } from "@openbone/core";
import { WebAudioBackend } from "@openbone/player/audio";
import { type AudioCommand, type FiredEvent, OpenBoneInstance, type ScriptHost, type StateMachineInstance } from "@openbone/runtime";

export type InputValue = boolean | number | string;

export type DriverEvents = {
  event: [FiredEvent];
  stateChange: [{ layer: string; from: string | null; to: string }];
  audio: [AudioCommand];
};

export interface DriverOptions {
  /** State machine to run (name or id). Default: the first one, unless `animation` is given. */
  stateMachine?: string;
  /** Play this animation instead of a state machine. */
  animation?: string;
  /** Loop `animation` (default true). */
  loop?: boolean;
  /** Skin (outfit) to show, by name or id. */
  skin?: string;
  /** "quickjs" (sandboxed, default when the document has scripts), "none", or your own host. */
  scripts?: "quickjs" | "none" | ScriptHost;
  /** Play the document's sounds (default true). "muted" loads them but starts muted. */
  audio?: boolean | "muted";
  /** Share the engine's AudioContext (Phaser's sound manager, a Three.js AudioListener...). */
  audioContext?: AudioContext;
  /** Base URL for relative audio paths (default: the document's base URL). */
  audioBaseUrl?: string;
  resolveAudioUrl?: (asset: AudioAsset) => string;
  /** Where the first click or key press unlocks audio (default: window). */
  unlockTarget?: EventTarget;
  onEvent?: (e: FiredEvent) => void;
  onStateChange?: (e: { layer: string; from: string | null; to: string }) => void;
}

let scriptHostFactory: (() => Promise<ScriptHost | null>) | null = null;

/** Replace how documents with scripts get their sandbox (default: load `@openbone/scripting`, QuickJS). */
export function setEngineScriptHostFactory(factory: (() => Promise<ScriptHost | null>) | null) {
  scriptHostFactory = factory;
}

async function scriptHostFor(doc: OpenBoneDocument, scripts: DriverOptions["scripts"]): Promise<ScriptHost | undefined> {
  if (typeof scripts === "object") return scripts;
  if (scripts === "none" || !doc.scripts.length) return undefined;
  if (scriptHostFactory) return (await scriptHostFactory()) ?? undefined;
  const { createQuickJsHost } = await import("@openbone/scripting");
  return createQuickJsHost();
}

/**
 * Engine-independent playback of one document: an OpenBoneInstance (posing, animations, state machine, listeners,
 * events) plus Web Audio for its sounds. Every engine object owns one and calls `advance(dt)` from its update loop,
 * then draws `instance.drawList()`.
 */
export class OpenBoneDriver {
  audio: WebAudioBackend | null = null;
  private _speed = 1;
  /** True while the pointer is over the object (so leaving sends one "move" far outside, ending hovers). */
  private pointerInside = false;

  private constructor(
    public readonly doc: OpenBoneDocument,
    public readonly instance: OpenBoneInstance,
  ) {}

  /** Build a driver: loads the script sandbox when the document has scripts, starts audio and the first animation. */
  static async create(doc: OpenBoneDocument, baseUrl: string, o: DriverOptions = {}): Promise<OpenBoneDriver> {
    const scriptHost = await scriptHostFor(doc, o.scripts);
    return OpenBoneDriver.createSync(doc, baseUrl, { ...o, scripts: scriptHost ?? "none" });
  }

  /** Like `create`, without loading a script sandbox (pass one in `scripts`, or scripts do not run). */
  static createSync(doc: OpenBoneDocument, baseUrl: string, o: DriverOptions = {}): OpenBoneDriver {
    const instance = new OpenBoneInstance(doc, { scriptHost: typeof o.scripts === "object" ? o.scripts : undefined });
    const d = new OpenBoneDriver(doc, instance);
    const hasAudioApi = typeof AudioContext !== "undefined" || !!o.audioContext;
    if (o.audio !== false && doc.audio?.assets.length && hasAudioApi) {
      const audio = new WebAudioBackend(doc, { baseUrl: o.audioBaseUrl ?? baseUrl, context: o.audioContext, resolveUrl: o.resolveAudioUrl });
      audio.setMuted(o.audio === "muted");
      const target = o.unlockTarget ?? (typeof window !== "undefined" ? window : undefined);
      if (target) audio.unlock(target);
      void audio.preload();
      instance.on("audio", audio.handle);
      d.audio = audio;
    }
    if (o.skin) instance.skeleton.setSkin(o.skin);
    if (o.onEvent) instance.on("event", o.onEvent);
    if (o.onStateChange) instance.on("stateChange", o.onStateChange);
    if (o.animation) instance.play(o.animation, o.loop ?? true);
    else if (doc.stateMachines.length) instance.useStateMachine(o.stateMachine);
    else if (doc.animations.length) instance.play(doc.animations[0].name, o.loop ?? true);
    instance.advance(0);
    return d;
  }

  get skeleton() {
    return this.instance.skeleton;
  }
  get stateMachine(): StateMachineInstance | null {
    return this.instance.stateMachine;
  }

  /** Playback speed (1 = normal); sounds follow it. */
  get speed() {
    return this._speed;
  }
  set speed(v: number) {
    this._speed = v;
    this.audio?.setSpeed(v);
  }

  /** Step the animation or state machine by `dt` seconds (scaled by `speed`). */
  advance(dt: number) {
    this.instance.advance(dt * this._speed);
  }

  /** Re-pose without advancing time (after setSkin, setInput... while paused). */
  refresh() {
    this.instance.advance(0);
  }

  setInput(name: string, value: InputValue) {
    this.stateMachine?.setInput(name, value);
  }
  getInput(name: string): InputValue | undefined {
    return this.stateMachine?.getInput(name);
  }
  fire(name: string) {
    this.stateMachine?.fire(name);
  }
  /** Fixed text (or an `{input}` template) for a slot's text attachment; null restores it. */
  setText(slot: string, text: string | null) {
    this.instance.skeleton.setText(slot, text);
  }
  /** Show a skin by name or id; null shows the default skin only. */
  setSkin(name: string | null) {
    this.instance.skeleton.setSkin(name);
    this.refresh();
  }
  get skins(): string[] {
    return this.doc.skeleton.skins.map((s) => s.name);
  }
  get animations(): string[] {
    return this.doc.animations.map((a) => a.name);
  }
  /** Play an animation (stops the state machine). */
  play(animation: string, loop = true, track = 0) {
    return this.instance.play(animation, loop, track);
  }
  /** Switch to a state machine (name or id; default the first). */
  useStateMachine(name?: string) {
    return this.instance.useStateMachine(name);
  }

  /** Pointer at a point in skeleton space (y-up). */
  pointer(type: "down" | "up" | "move", x: number, y: number) {
    this.pointerInside = true;
    this.instance.pointer(type, x, y);
  }
  /** The pointer left the object or the canvas: ends hovers (listeners' exit actions run). */
  pointerLeave() {
    if (!this.pointerInside) return;
    this.pointerInside = false;
    this.instance.pointer("move", -1e9, -1e9);
  }

  /** Listen to the instance: "event" (fired events), "stateChange", "audio" (sound commands). Returns an unsubscribe function. */
  on<K extends keyof DriverEvents>(name: K, fn: (...args: DriverEvents[K]) => void): () => void {
    return this.instance.on(name, fn);
  }

  pause() {
    this.audio?.pauseAll();
  }
  resume() {
    this.audio?.resumeAll();
  }
  setMuted(muted: boolean) {
    this.audio?.setMuted(muted);
  }

  dispose() {
    this.instance.dispose();
    this.audio?.dispose();
    this.audio = null;
  }
}
