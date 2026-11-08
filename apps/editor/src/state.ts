import { EXAMPLES_BASE, fetchExample } from "./examples.ts";
import {
  type Attachment,
  DocumentStore,
  type OpenBoneDocument,
  type SkinData,
  attachmentOwner,
  createDocument,
  deserialize,
  getAttachment,
  serialize,
} from "@openbone/core";
import { createSignal } from "solid-js";

export const store = new DocumentStore(createDocument("Untitled"));

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
export type Tool = "select" | "rotate" | "translate" | "scale" | "bone" | "mesh" | "weights" | "pose";
/** Pose tool: how many bones bend when you drag one (the dragged bone and its parents); 99 = up to the root. */
export const [poseChain, setPoseChain] = createSignal(3);
export type Selection =
  | { kind: "bone"; id: string }
  | { kind: "slot"; id: string; attachment?: string }
  | { kind: "ik"; id: string }
  | { kind: "transform"; id: string }
  | { kind: "path"; id: string }
  | { kind: "physics"; id: string }
  | { kind: "slider"; id: string }
  | { kind: "image"; id: string }
  | { kind: "sound"; id: string }
  /** id "master" selects the master mix. */
  | { kind: "bus"; id: string }
  | { kind: "audio"; id: string }
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
/** Mesh tool: indices of the selected vertices of the selected mesh attachment. */
export const [meshSel, setMeshSel] = createSignal<number[]>([]);
/** Weights tool: bone being painted, brush settings. */
export const [weightBone, setWeightBone] = createSignal<string | null>(null);
export const [brushRadius, setBrushRadius] = createSignal(30);
export const [brushStrength, setBrushStrength] = createSignal(0.5);
export const [brushMode, setBrushMode] = createSignal<"add" | "subtract">("add");
/** Bones selected together (box select / shift-click), besides the primary `selection`. Empty = just the primary. */
export const [multiBones, setMultiBones] = createSignal<string[]>([]);
/** Mesh tool soft selection: dragging vertices also pulls unselected ones within `softRadius` screen px, with falloff. */
export const [softSelect, setSoftSelect] = createSignal(false);
export const [softRadius, setSoftRadius] = createSignal(60);
/** Weights tool: paint with the brush, or select vertices and set their weights directly. */
export const [weightMode, setWeightMode] = createSignal<"brush" | "direct">("brush");
/** Onion skin: ghost poses at ±step·i frames for i = 1..count (Animate mode). */
export const [onionSkin, setOnionSkin] = createSignal(false);
export const [onionCount, setOnionCount] = createSignal(2);
export const [onionStep, setOnionStep] = createSignal(2);
export const [stateMachineId, setStateMachineId] = createSignal<string | null>(null);
/** When true the viewport runs the selected state machine live. */
export const [running, setRunning] = createSignal(false);
export const [baseUrl, setBaseUrl] = createSignal<string>("");
export const [fileName, setFileName] = createSignal<string>("untitled.obone");
export const [exportOpen, setExportOpen] = createSignal(false);

/** Skin shown in the viewport and receiving new attachments. null = default skin only. */
export const [activeSkinId, setActiveSkinId] = createSignal<string | null>(null);

/** The active non-default skin, or null when only the default skin is shown (or the skin was deleted). */
export const activeSkin = (): SkinData | null => {
  const id = activeSkinId();
  const skins = doc().skeleton.skins;
  return (id && skins.slice(1).find((s) => s.id === id)) || null;
};

/** `{ skin }` op argument for the active skin, so new attachments land in it. Empty for the default skin. */
export const skinArg = (): { skin?: string } => {
  const s = activeSkin();
  return s ? { skin: s.id } : {};
};

/** `{ skin }` op argument for the skin that owns the attachment a slot shows under the active skin. */
export function ownerSkinArg(slotId: string, name: string): { skin?: string } {
  const owner = attachmentOwner(store.doc, slotId, name, activeSkin()?.id);
  return owner && owner !== store.doc.skeleton.skins[0] ? { skin: owner.id } : {};
}

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
  const att = getAttachment(doc(), slot.id, name, activeSkin()?.id);
  return att ? { slotId: slot.id, att } : null;
}

// ---------- load / save ----------
export function loadDocument(d: OpenBoneDocument, name = `${d.name}.obone`, base = "") {
  setBaseUrl(base);
  store.load(d);
  setFileName(name);
  setSelection(null);
  setActiveSkinId(null);
  setAnimationId(d.animations[0]?.id ?? null);
  setStateMachineId(d.stateMachines[0]?.id ?? null);
  setTime(0);
  setRunning(false);
}

export async function openExample(name: string) {
  try {
    loadDocument(await fetchExample(name), `${name}.obone`, EXAMPLES_BASE);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export function exportJson(): string {
  return serialize(store.doc);
}
