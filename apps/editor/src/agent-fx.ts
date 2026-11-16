/**
 * Live view of what an MCP agent is doing: every op that arrives over the bridge lights up what it touched. Bones
 * glow along their length with a ripple at the joint, parts glow around their outline, and the op ("Add bone “arm”")
 * floats up from the spot and fades. The same bones and parts flash in the Hierarchy, and a pill next to the MCP
 * button shows the agent's latest action while it is working.
 *
 * Only edits from the agent (origin "bridge") are shown; your own edits and loads are not.
 */
import { type ChangeEvent, type OpCall, type OpenBoneDocument, find } from "@openbone/core";
import { createSignal } from "solid-js";
import { describeOp, humanizeOp } from "./activity.ts";

/** How long a glow lasts (ms). */
export const FX_MS = 1600;
/** The pill stays this long after the agent's last op (ms). */
const BUSY_MS = 3000;
/** At most this many glows at once: a big transaction lights up its first targets, not hundreds. */
const MAX_FX = 24;

export interface AgentFx {
  kind: "bone" | "slot";
  id: string;
  /** The op's readable line; only the first effect of an op carries it, so one label floats per op. */
  label: string | null;
  start: number;
}

let fx: AgentFx[] = [];
/** Effects alive now (drops finished ones). */
export function agentEffects(now = performance.now()): AgentFx[] {
  if (fx.length && now - fx[0].start > FX_MS) fx = fx.filter((f) => now - f.start <= FX_MS);
  return fx;
}

const [flashing, setFlashing] = createSignal<ReadonlySet<string>>(new Set());
/** Hierarchy rows to flash (bone and slot ids). */
export const agentFlash = (id: string) => flashing().has(id);

const [action, setAction] = createSignal<{ text: string; count: number } | null>(null);
/** The agent's latest action while it is working, for the toolbar pill (null when idle). */
export const agentAction = action;

let busyTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** Bones and slots an op names, by id or name, anywhere in its arguments (a few levels deep). */
export function opTargets(doc: OpenBoneDocument, args: unknown): { kind: "bone" | "slot"; id: string }[] {
  const out: { kind: "bone" | "slot"; id: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: "bone" | "slot", id: string) => {
    if (seen.has(id) || out.length >= MAX_FX) return;
    seen.add(id);
    out.push({ kind, id });
  };
  const walk = (v: unknown, depth: number) => {
    if (out.length >= MAX_FX || depth > 4) return;
    if (typeof v === "string") {
      if (!v || v.length > 200) return;
      const s = find.slot(doc, v);
      if (s) add("slot", s.id);
      const b = find.bone(doc, v);
      if (b) add("bone", b.id);
    } else if (Array.isArray(v)) for (const x of v.slice(0, 200)) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
}

/** "Update bone “arm”": the op and the name of what it touched (ops often name it by id). */
export function agentLabel(doc: OpenBoneDocument, o: OpCall, targets = opTargets(doc, o.args)): string {
  const t = targets[0];
  const name = t && (t.kind === "bone" ? find.bone(doc, t.id) : find.slot(doc, t.id))?.name;
  return name ? `${humanizeOp(o.op)} “${name}”${targets.length > 1 ? ` +${targets.length - 1}` : ""}` : describeOp(o).text;
}

/** Show one batch of agent ops (an op, or a transaction's ops). */
export function showAgentOps(doc: OpenBoneDocument, ops: OpCall[], now = performance.now()) {
  if (!ops.length) return;
  const flash = new Set(flashing());
  for (const o of ops.slice(0, MAX_FX)) {
    const targets = opTargets(doc, o.args);
    const label = agentLabel(doc, o, targets);
    targets.forEach((t, i) => {
      // A repeat on the same target restarts its glow instead of stacking.
      fx = fx.filter((f) => !(f.kind === t.kind && f.id === t.id));
      fx.push({ ...t, label: i === 0 ? label : null, start: now });
      flash.add(t.id);
    });
  }
  if (fx.length > MAX_FX) fx = fx.slice(fx.length - MAX_FX);
  setFlashing(flash);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setFlashing(new Set<string>()), FX_MS);

  const first = agentLabel(doc, ops[0]);
  const text = ops.length > 1 ? `${first} (+${ops.length - 1} more)` : first;
  setAction((a) => ({ text, count: (a?.count ?? 0) + ops.length }));
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => setAction(null), BUSY_MS);
}

/** Store listener: agent edits only. */
export function onStoreChange(doc: OpenBoneDocument, e: ChangeEvent) {
  if (e.origin !== "bridge" || e.quiet) return;
  if (e.kind === "op" || e.kind === "transaction") showAgentOps(doc, e.ops);
}

/** Forget everything (disconnecting). */
export function clearAgentFx() {
  fx = [];
  setFlashing(new Set<string>());
  setAction(null);
  clearTimeout(busyTimer);
  clearTimeout(flashTimer);
}
