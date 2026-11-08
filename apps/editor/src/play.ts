import { createSignal } from "solid-js";
import {
  type Mode,
  type Selection,
  type Tool,
  activeSkinId,
  animationId,
  currentStateMachine,
  doc,
  meshSel,
  mode,
  playing,
  running,
  selection,
  setMeshSel,
  setMode,
  setPlaying,
  setRunning,
  setSelection,
  setTime,
  setTool,
  time,
  tool,
} from "./state.ts";

/**
 * Play mode: runs the document as shipped (state machine with scripts and pointer listeners, or an animation)
 * through the same `Player` the web runtime uses, over the viewport. Editing is locked while it runs; Stop puts the
 * editor back exactly as it was.
 */

export type PlayTarget = { kind: "sm" | "anim"; id: string } | null;

export const [playActive, setPlayActive] = createSignal(false);
export const [playTarget, setPlayTarget] = createSignal<PlayTarget>(null);
/** Skin id for Play mode; null = default skin. */
export const [playSkin, setPlaySkin] = createSignal<string | null>(null);
export const [playSpeed, setPlaySpeed] = createSignal(1);
export const [playPaused, setPlayPaused] = createSignal(false);
export const [playFit, setPlayFit] = createSignal<"contain" | "none">("contain");
export const [playFullWindow, setPlayFullWindow] = createSignal(false);
/** Bumped to restart the player from the beginning. */
export const [playEpoch, setPlayEpoch] = createSignal(0);

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];

interface Snapshot {
  mode: Mode;
  tool: Tool;
  selection: Selection;
  meshSel: number[];
  playing: boolean;
  running: boolean;
  time: number;
  focus: HTMLElement | null;
}
let snapshot: Snapshot | null = null;

/** What Play runs by default: the editor's state machine, else the current (or first) animation. */
export function defaultPlayTarget(): PlayTarget {
  const d = doc();
  const sm = currentStateMachine();
  if (sm) return { kind: "sm", id: sm.id };
  const anim = d.animations.find((a) => a.id === animationId()) ?? d.animations[0];
  return anim ? { kind: "anim", id: anim.id } : null;
}

export function startPlay() {
  if (playActive()) return;
  snapshot = {
    mode: mode(),
    tool: tool(),
    selection: selection(),
    meshSel: meshSel(),
    playing: playing(),
    running: running(),
    time: time(),
    focus: document.activeElement as HTMLElement | null,
  };
  // The editor's own preview loops stop while Play runs (the viewport keeps its view untouched underneath).
  setPlaying(false);
  setRunning(false);
  const t = playTarget();
  const d = doc();
  const valid = t && (t.kind === "sm" ? d.stateMachines.some((s) => s.id === t.id) : d.animations.some((a) => a.id === t.id));
  if (!valid) setPlayTarget(defaultPlayTarget());
  const skin = playSkin();
  if (!skin || !d.skeleton.skins.some((s) => s.id === skin)) setPlaySkin(activeSkinId());
  setPlayPaused(false);
  (document.activeElement as HTMLElement | null)?.blur?.();
  setPlayActive(true);
}

export function stopPlay() {
  if (!playActive()) return;
  setPlayActive(false);
  setPlayFullWindow(false);
  const s = snapshot;
  snapshot = null;
  if (!s) return;
  setMode(s.mode);
  setTool(s.tool);
  setSelection(s.selection);
  // Selection changes clear the vertex selection; restore it after.
  queueMicrotask(() => setMeshSel(s.meshSel));
  setTime(s.time);
  setPlaying(s.playing);
  setRunning(s.running);
  s.focus?.focus?.();
}

export const togglePlay = () => (playActive() ? stopPlay() : startPlay());
export const restartPlay = () => {
  setPlayPaused(false);
  setPlayEpoch((n) => n + 1);
};

export function stepSpeed(dir: 1 | -1) {
  const i = SPEEDS.indexOf(playSpeed());
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))];
  setPlaySpeed(next);
}
