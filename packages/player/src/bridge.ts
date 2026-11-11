/**
 * Host bridge for embedding the player in a native WebView (Flutter, Android, iOS) or an iframe.
 *
 * Host → page: call `OpenBone.receive(json)` (or `OpenBone.setInput(...)` etc. directly) with a {@link BridgeCommand}.
 * Page → host: JSON strings of {@link BridgeMessage}, posted to whichever channel exists:
 *   - `window.OpenBoneHost.postMessage(str)`  Flutter `JavaScriptChannel` / Android `addJavascriptInterface`
 *   - `window.webkit.messageHandlers.openbone.postMessage(str)`  iOS WKWebView
 *   - `window.parent.postMessage(obj, "*")`  iframes (object, not string), when embedded
 *   - a `openbone-message` DOM event on `window` (detail = object), always
 */

export const BRIDGE_VERSION = 1;

export type BridgeCommand =
  | { type: "setInput"; name: string; value: boolean | number | string }
  | { type: "fire"; name: string }
  | { type: "play"; animation?: string; loop?: boolean }
  | { type: "pause" }
  | { type: "setSkin"; name: string | null }
  | { type: "useStateMachine"; name?: string }
  | { type: "getInputs" }
  | { type: "setMuted"; muted: boolean }
  | { type: "setBusMuted"; bus: string | null; muted: boolean | "toggle" };

export interface BridgeInputInfo {
  name: string;
  type: "bool" | "number" | "trigger" | "string";
  value: boolean | number | string | null;
}

export type BridgeMessage =
  | {
      type: "ready";
      animations: string[];
      stateMachines: string[];
      inputs: BridgeInputInfo[];
      skins: string[];
      width: number;
      height: number;
    }
  | { type: "event"; name: string; int?: number; float?: number; string?: string; time?: number }
  | { type: "stateChange"; layer: string; from: string | null; to: string }
  | { type: "inputs"; inputs: BridgeInputInfo[] }
  | { type: "error"; message: string };

/** Wire format of a page → host message: the message plus a source tag and protocol version. */
export type BridgeEnvelope = BridgeMessage & { source: "openbone"; v: number };

export function encodeMessage(m: BridgeMessage): string {
  return JSON.stringify({ source: "openbone", v: BRIDGE_VERSION, ...m });
}

/** Parse a host message string (for hosts written in JS, and tests). Returns null for anything that is not ours. */
export function decodeMessage(s: string): BridgeEnvelope | null {
  try {
    const m = JSON.parse(s) as BridgeEnvelope;
    return m && m.source === "openbone" && typeof m.type === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Validate a command from the host (a JSON string or an object). Throws with a readable message when it is wrong. */
export function parseCommand(input: string | unknown): BridgeCommand {
  const c = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || typeof c.type !== "string") throw new Error("OpenBone bridge: a command needs a string `type`");
  const str = (k: string) => {
    if (typeof c[k] !== "string" || !c[k]) throw new Error(`OpenBone bridge: "${c.type}" needs a string \`${k}\``);
    return c[k] as string;
  };
  switch (c.type) {
    case "setInput": {
      const v = c.value;
      if (typeof v !== "boolean" && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v)))
        throw new Error('OpenBone bridge: "setInput" needs a boolean, number or string `value`');
      return { type: "setInput", name: str("name"), value: v };
    }
    case "fire":
      return { type: "fire", name: str("name") };
    case "play":
      return {
        type: "play",
        ...(typeof c.animation === "string" ? { animation: c.animation } : {}),
        ...(typeof c.loop === "boolean" ? { loop: c.loop } : {}),
      };
    case "pause":
    case "getInputs":
      return { type: c.type };
    case "setSkin":
      return { type: "setSkin", name: typeof c.name === "string" && c.name ? c.name : null };
    case "useStateMachine":
      return { type: "useStateMachine", ...(typeof c.name === "string" ? { name: c.name } : {}) };
    case "setMuted":
      if (typeof c.muted !== "boolean") throw new Error('OpenBone bridge: "setMuted" needs a boolean `muted`');
      return { type: "setMuted", muted: c.muted };
    case "setBusMuted": {
      const m = c.muted ?? true;
      if (typeof m !== "boolean" && m !== "toggle") throw new Error('OpenBone bridge: "setBusMuted" needs `muted`: true, false or "toggle"');
      if (c.bus !== null && c.bus !== undefined && typeof c.bus !== "string") throw new Error('OpenBone bridge: "setBusMuted" needs a string `bus` (or null for the master)');
      return { type: "setBusMuted", bus: (c.bus as string | null | undefined) ?? null, muted: m };
    }
    default:
      throw new Error(`OpenBone bridge: unknown command "${String(c.type)}"`);
  }
}

/** What the bridge needs from a player (structural, so tests can pass a fake). */
export interface BridgePlayer {
  setInput(name: string, value: boolean | number | string): void;
  fire(name: string): void;
  play(): void;
  pause(): void;
  playAnimation(name: string, loop?: boolean): void;
  setSkin(name: string | null): void;
  useStateMachine?(name?: string): void;
  setMuted?(muted: boolean): void;
  setBusMuted?(bus: string | null, muted: boolean | "toggle"): unknown;
  inputs(): BridgeInputInfo[];
}

/** Run a validated command against a player. Returns a reply message for queries. */
export function applyCommand(p: BridgePlayer, c: BridgeCommand): BridgeMessage | null {
  switch (c.type) {
    case "setInput":
      p.setInput(c.name, c.value);
      return null;
    case "fire":
      p.fire(c.name);
      return null;
    case "play":
      if (c.animation) p.playAnimation(c.animation, c.loop ?? true);
      p.play();
      return null;
    case "pause":
      p.pause();
      return null;
    case "setSkin":
      p.setSkin(c.name);
      return null;
    case "useStateMachine":
      p.useStateMachine?.(c.name);
      return null;
    case "getInputs":
      return { type: "inputs", inputs: p.inputs() };
    case "setMuted":
      p.setMuted?.(c.muted);
      return null;
    case "setBusMuted":
      p.setBusMuted?.(c.bus, c.muted);
      return null;
  }
}

type PostTarget = { postMessage(s: string): void };
interface HostWindow {
  OpenBoneHost?: PostTarget;
  webkit?: { messageHandlers?: { openbone?: PostTarget } };
  parent?: { postMessage(m: unknown, origin: string): void } | null;
  dispatchEvent?(e: Event): boolean;
}

/** Send a message to every host channel present on `w` (see the module comment). */
export function postToHost(m: BridgeMessage, w: HostWindow = globalThis as unknown as HostWindow): string {
  const s = encodeMessage(m);
  try {
    w.OpenBoneHost?.postMessage(s);
  } catch {
    /* host channel gone */
  }
  try {
    w.webkit?.messageHandlers?.openbone?.postMessage(s);
  } catch {
    /* host channel gone */
  }
  if (w.parent && w.parent !== (w as unknown)) w.parent.postMessage(JSON.parse(s), "*");
  if (w.dispatchEvent && typeof CustomEvent !== "undefined") w.dispatchEvent(new CustomEvent("openbone-message", { detail: JSON.parse(s) }));
  return s;
}
