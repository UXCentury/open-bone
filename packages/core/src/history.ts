import { cloneDocument } from "./document.ts";
import type { DocumentStore, HistoryEntry } from "./store.ts";
import type { OpenBoneDocument } from "./types.ts";

/**
 * Undo/redo history in a form that can be saved (IndexedDB, a file) and restored after a reload.
 * Each step is stored as a small JSON patch from its neighbour instead of a full snapshot, so a 200-step history of
 * a document with embedded images costs little more than the changes themselves.
 */

/** A JSON patch: replace a value, patch an object's keys (and delete some), or patch an array's items. */
export type JsonPatch =
  | { s: unknown }
  | { o: Record<string, JsonPatch>; d?: string[] }
  | { a: Record<string, JsonPatch>; n: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Patch that turns `a` into `b`, or null when they are equal. Shared (===) subtrees are skipped without a walk. */
export function jsonDiff(a: unknown, b: unknown): JsonPatch | null {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    const items: Record<string, JsonPatch> = {};
    let any = a.length !== b.length;
    for (let i = 0; i < b.length; i++) {
      const p = i < a.length ? jsonDiff(a[i], b[i]) : { s: b[i] };
      if (p) {
        items[i] = p;
        any = true;
      }
    }
    return any ? { a: items, n: b.length } : null;
  }
  if (isObj(a) && isObj(b)) {
    const keys: Record<string, JsonPatch> = {};
    const del: string[] = [];
    let any = false;
    for (const k in b) {
      if (b[k] === undefined) continue;
      const p = a[k] === undefined ? { s: b[k] } : jsonDiff(a[k], b[k]);
      if (p) {
        keys[k] = p;
        any = true;
      }
    }
    for (const k in a) if (a[k] !== undefined && b[k] === undefined) del.push(k);
    if (!any && !del.length) return null;
    return del.length ? { o: keys, d: del } : { o: keys };
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return null;
  return { s: b };
}

/** Apply a patch without changing `a`: unchanged subtrees are shared with it. */
export function jsonPatch(a: unknown, p: JsonPatch | null): unknown {
  if (!p) return a;
  if ("s" in p) return p.s;
  if ("a" in p) {
    const src = Array.isArray(a) ? a : [];
    const out = src.slice(0, p.n);
    while (out.length < p.n) out.push(undefined);
    for (const k in p.a) out[+k] = jsonPatch(src[+k], p.a[k]);
    return out;
  }
  const out: Record<string, unknown> = { ...(isObj(a) ? a : {}) };
  for (const k of p.d ?? []) delete out[k];
  for (const k in p.o) out[k] = jsonPatch(out[k], p.o[k]);
  return out;
}

export interface SavedHistoryStep {
  label: string;
  patch: JsonPatch | null;
}

/** History saved next to a document: `past` oldest first, `future` with the next redo last (like the store). */
export interface SavedHistory {
  version: 1;
  past: SavedHistoryStep[];
  future: SavedHistoryStep[];
}

/**
 * Patches between history snapshots never change (the store never mutates a snapshot), so they are cached:
 * saving after every edit only diffs the newest step.
 */
const cache = new WeakMap<object, WeakMap<object, JsonPatch | null>>();
function cachedDiff(from: OpenBoneDocument, to: OpenBoneDocument, current: OpenBoneDocument): JsonPatch | null {
  if (from === current || to === current) return jsonDiff(from, to);
  let m = cache.get(from);
  if (!m) cache.set(from, (m = new WeakMap()));
  if (m.has(to)) return m.get(to)!;
  const p = jsonDiff(from, to);
  m.set(to, p);
  return p;
}

/** The store's undo/redo history as patches relative to its current document. */
export function encodeHistory(store: DocumentStore): SavedHistory {
  const { past, future } = store.history();
  const cur = store.doc;
  // past[i] is reached from past[i + 1] (or the current document for the newest).
  const encPast = past.map((e, i) => ({ label: e.label, patch: cachedDiff(i + 1 < past.length ? past[i + 1].doc : cur, e.doc, cur) }));
  // future[last] is the next redo, reached from the current document.
  const encFuture = future.map((e, i) => ({ label: e.label, patch: cachedDiff(i + 1 < future.length ? future[i + 1].doc : cur, e.doc, cur) }));
  return { version: 1, past: encPast, future: encFuture };
}

/** Rebuild the snapshots of a saved history on top of the store's current document (which it must have been saved with). */
export function restoreHistory(store: DocumentStore, saved: SavedHistory | null | undefined): boolean {
  if (!saved || saved.version !== 1 || !Array.isArray(saved.past) || !Array.isArray(saved.future)) return false;
  const rebuild = (steps: SavedHistoryStep[]): HistoryEntry[] => {
    const out: HistoryEntry[] = new Array(steps.length);
    let from: OpenBoneDocument = store.doc;
    for (let i = steps.length - 1; i >= 0; i--) {
      // A full clone so the snapshot shares nothing mutable with the current document (images/audio are immutable).
      const doc = cloneDocument(jsonPatch(from, steps[i].patch) as OpenBoneDocument);
      out[i] = { doc, label: steps[i].label };
      from = doc;
    }
    return out;
  };
  try {
    store.setHistory(rebuild(saved.past), rebuild(saved.future));
    return true;
  } catch {
    return false;
  }
}
