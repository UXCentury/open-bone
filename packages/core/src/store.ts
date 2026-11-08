import { cloneDocument, createDocument, normalizeDocument } from "./document.ts";
import { applyOp, type OpCall } from "./ops/registry.ts";
import type { OpenBoneDocument } from "./types.ts";

export interface ChangeEvent {
  kind: "op" | "undo" | "redo" | "load" | "transaction";
  ops: OpCall[];
  /** Origin tag, so a live bridge doesn't echo its own changes back. */
  origin?: string;
}

type Listener = (doc: OpenBoneDocument, e: ChangeEvent) => void;

/**
 * Holds the current document, applies ops and keeps undo/redo history (snapshot based).
 * Used by the editor, the MCP server and the live bridge.
 */
export class DocumentStore {
  doc: OpenBoneDocument;
  private past: { doc: OpenBoneDocument; label: string }[] = [];
  private future: { doc: OpenBoneDocument; label: string }[] = [];
  private listeners = new Set<Listener>();
  private txn: { before: OpenBoneDocument; ops: OpCall[]; label: string } | null = null;
  historyLimit = 200;

  constructor(doc: OpenBoneDocument = createDocument()) {
    this.doc = normalizeDocument(doc);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ChangeEvent) {
    for (const l of this.listeners) l(this.doc, e);
  }

  load(doc: OpenBoneDocument, origin?: string) {
    this.doc = normalizeDocument(doc);
    this.past = [];
    this.future = [];
    this.emit({ kind: "load", ops: [], origin });
  }

  /** Apply one op. Throws (and leaves the document untouched) if the op fails. */
  apply(op: string, args: unknown = {}, origin?: string): unknown {
    if (this.txn) {
      const r = applyOp(this.doc, op, args);
      this.txn.ops.push({ op, args: r.args });
      return r.result;
    }
    const before = cloneDocument(this.doc);
    let r: ReturnType<typeof applyOp>;
    try {
      r = applyOp(this.doc, op, args);
    } catch (e) {
      this.doc = before;
      throw e;
    }
    this.pushHistory(before, op);
    this.emit({ kind: "op", ops: [{ op, args: r.args }], origin });
    return r.result;
  }

  /** Group several ops into one undo step. Rolls back everything if `fn` throws. */
  transaction<T>(label: string, fn: (s: DocumentStore) => T, origin?: string): T {
    if (this.txn) return fn(this);
    this.txn = { before: cloneDocument(this.doc), ops: [], label };
    try {
      const out = fn(this);
      const { before, ops } = this.txn;
      this.txn = null;
      if (ops.length) {
        this.pushHistory(before, label);
        this.emit({ kind: "transaction", ops, origin });
      }
      return out;
    } catch (e) {
      this.doc = this.txn!.before;
      this.txn = null;
      throw e;
    }
  }

  private pushHistory(before: OpenBoneDocument, label: string) {
    this.past.push({ doc: before, label });
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  undo(origin?: string): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push({ doc: this.doc, label: prev.label });
    this.doc = prev.doc;
    this.emit({ kind: "undo", ops: [], origin });
    return true;
  }

  redo(origin?: string): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ doc: this.doc, label: next.label });
    this.doc = next.doc;
    this.emit({ kind: "redo", ops: [], origin });
    return true;
  }
}
