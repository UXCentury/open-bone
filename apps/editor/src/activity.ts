import type { ChangeEvent, DocumentStore, OpCall } from "@openbone/core";
import { createSignal } from "solid-js";

/**
 * Activity log: what happened to the project and who did it (you, an MCP agent, the file watcher), plus MCP
 * connection changes and errors. Shown in the Activity panel.
 */

export type ActivitySource = "you" | "mcp" | "system";
export type ActivityLevel = "info" | "error";

export interface ActivityEntry {
  id: number;
  time: number;
  source: ActivitySource;
  level: ActivityLevel;
  text: string;
  /** Same action repeated in a row (dragging a bone, scrubbing a value) counts up instead of adding lines. */
  count: number;
  /** For merging repeats: op name + target. */
  key?: string;
}

const MAX = 500;
let nextId = 0;
const [entries, setEntries] = createSignal<ActivityEntry[]>([]);
export { entries as activityEntries };

/** Unread entries since the panel was last looked at (for a badge on its tab). */
const [unseen, setUnseen] = createSignal(0);
export { unseen as activityUnseen };
export const markActivitySeen = () => setUnseen(0);

export function logActivity(source: ActivitySource, text: string, level: ActivityLevel = "info", key?: string) {
  const now = Date.now();
  setEntries((list) => {
    const last = list[list.length - 1];
    if (key && last && last.key === key && last.source === source && now - last.time < 4000) {
      return [...list.slice(0, -1), { ...last, time: now, count: last.count + 1 }];
    }
    const next = [...list, { id: ++nextId, time: now, source, level, text, count: 1, key }];
    return next.length > MAX ? next.slice(next.length - MAX) : next;
  });
  setUnseen((n) => n + 1);
}

export const clearActivity = () => {
  setEntries([]);
  setUnseen(0);
};

/** "addBone" → "Add bone", "setIkConstraint" → "Set ik constraint". */
export function humanizeOp(op: string): string {
  const words = op.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The arguments that name what an op worked on, in order of preference. */
const TARGET_KEYS = ["name", "bone", "slot", "sound", "animation", "asset", "image", "event", "state", "stateMachine", "input", "skin", "bus", "constraint", "id", "target"];

/** One readable line for an op: "Add bone “arm”", "Set keys · walk". */
export function describeOp(o: OpCall): { text: string; key: string } {
  const args = (o.args ?? {}) as Record<string, unknown>;
  let target = "";
  for (const k of TARGET_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) {
      target = v;
      break;
    }
  }
  const extra = typeof args.animation === "string" && args.animation !== target ? ` · ${args.animation}` : "";
  const text = `${humanizeOp(o.op)}${target ? ` “${target}”` : ""}${extra}`;
  return { text, key: `${o.op}:${target}:${typeof args.property === "string" ? args.property : ""}` };
}

const sourceOf = (origin: string | undefined): ActivitySource => (origin === "bridge" ? "mcp" : origin === "watch" ? "system" : "you");

let unsubscribe: (() => void) | null = null;

/** Start logging the store's changes (once). */
export function watchStoreActivity(store: DocumentStore) {
  unsubscribe?.();
  unsubscribe = store.subscribe((_doc, e: ChangeEvent) => {
    // Quiet ops are redraw nudges and view state, not edits.
    if (e.quiet) return;
    const source = sourceOf(e.origin);
    if (e.kind === "op") {
      for (const o of e.ops) {
        const d = describeOp(o);
        logActivity(source, d.text, "info", d.key);
      }
    } else if (e.kind === "transaction") {
      const first = e.ops[0];
      if (!first) return;
      const d = describeOp(first);
      logActivity(source, e.ops.length > 1 ? `${d.text} (+${e.ops.length - 1} more)` : d.text, "info", `txn:${d.key}`);
    } else if (e.kind === "undo") logActivity(source, "Undo");
    else if (e.kind === "redo") logActivity(source, "Redo");
    else if (e.kind === "load") logActivity(source, source === "mcp" ? "Project loaded from the MCP server" : "Project loaded", "info", "load");
  });
}
