import {
  type Attachment,
  DocumentStore,
  type OpenBoneDocument,
  createDocument,
  deserialize,
  getAttachment,
  serialize,
} from "@openbone/core";
import { createSignal } from "solid-js";

export const store = new DocumentStore(createDocument("Untitled", { background: "#eef2f7" }));

const [rev, setRev] = createSignal(0);
store.subscribe(() => setRev((r) => r + 1));
/** Reactive accessor: re-runs dependents after every change. */
export const doc = (): OpenBoneDocument => {
  rev();
  return store.doc;
};
export { rev };

// ---------- toasts ----------
const [toasts, setToasts] = createSignal<{ id: number; text: string; kind: "error" | "info" }[]>([]);
export { toasts };
let toastId = 0;
export function toast(text: string, kind: "error" | "info" = "info") {
  const id = ++toastId;
  setToasts((t) => [...t, { id, text, kind }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 5000 : 2500);
}

/** Apply an op, surfacing errors as toasts. Routed through the live bridge when connected. */
export function apply(op: string, args: Record<string, unknown> = {}): unknown {
  try {
    return store.apply(op, args);
  } catch (e) {
    toast((e as Error).message, "error");
    return undefined;
  }
}

export function transaction(label: string, fn: () => void) {
  try {
    store.transaction(label, fn);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---------- editor UI state ----------
export type Mode = "setup" | "animate";
export type Tool = "select" | "rotate" | "translate" | "scale" | "bone";
export type Selection =
  | { kind: "bone"; id: string }
  | { kind: "slot"; id: string; attachment?: string }
  | { kind: "ik"; id: string }
  | { kind: "transform"; id: string }
  | { kind: "path"; id: string }
  | { kind: "physics"; id: string }
  | { kind: "image"; id: string }
  | null;

export const [mode, setMode] = createSignal<Mode>("setup");
export const [tool, setTool] = createSignal<Tool>("select");
export const [selection, setSelection] = createSignal<Selection>(null);
export const [animationId, setAnimationId] = createSignal<string | null>(null);
export const [time, setTime] = createSignal(0);
export const [playing, setPlaying] = createSignal(false);
export const [autoKey, setAutoKey] = createSignal(true);
export const [showBones, setShowBones] = createSignal(true);
export const [showMesh, setShowMesh] = createSignal(false);
export const [bottomTab, setBottomTab] = createSignal<"timeline" | "statemachine" | "scripts">("timeline");
export const [stateMachineId, setStateMachineId] = createSignal<string | null>(null);
/** When true the viewport runs the selected state machine live. */
export const [running, setRunning] = createSignal(false);
export const [baseUrl, setBaseUrl] = createSignal<string>("");
export const [fileName, setFileName] = createSignal<string>("untitled.obone");

export const selectedBoneId = () => {
  const s = selection();
  if (!s) return null;
  if (s.kind === "bone") return s.id;
  if (s.kind === "slot") return doc().skeleton.slots.find((x) => x.id === s.id)?.bone ?? null;
  return null;
};

export const currentAnimation = () => {
  const id = animationId();
  return id ? (doc().animations.find((a) => a.id === id) ?? null) : null;
};

export const currentStateMachine = () => {
  const d = doc();
  const id = stateMachineId();
  return (id ? d.stateMachines.find((s) => s.id === id) : d.stateMachines[0]) ?? null;
};

export function selectedAttachment(): { slotId: string; att: Attachment } | null {
  const s = selection();
  if (s?.kind !== "slot") return null;
  const slot = doc().skeleton.slots.find((x) => x.id === s.id);
  if (!slot) return null;
  const name = s.attachment ?? slot.attachment;
  const att = getAttachment(doc(), slot.id, name);
  return att ? { slotId: slot.id, att } : null;
}

// ---------- load / save ----------
export function loadDocument(d: OpenBoneDocument, name = `${d.name}.obone`, base = "") {
  setBaseUrl(base);
  store.load(d);
  setFileName(name);
  setSelection(null);
  setAnimationId(d.animations[0]?.id ?? null);
  setStateMachineId(d.stateMachines[0]?.id ?? null);
  setTime(0);
  setRunning(false);
}

export async function openExample(name: string) {
  const res = await fetch(`/examples/${name}.obone`);
  if (!res.ok) return toast(`Example ${name} not found`, "error");
  loadDocument(deserialize(await res.text()), `${name}.obone`, "/examples/");
}

export function exportJson(): string {
  return serialize(store.doc);
}
