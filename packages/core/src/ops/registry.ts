import { z } from "zod";
import type { OpenBoneDocument } from "../types.ts";

export type OpGroup = "project" | "rig" | "attachment" | "constraint" | "animation" | "interactivity" | "audio";

export interface OpDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  group: OpGroup;
  description: string;
  schema: S;
  /** Mutates the document in place. May fill generated ids into `args` so replays are deterministic. */
  apply(doc: OpenBoneDocument, args: z.infer<S>): unknown;
}

export const registry = new Map<string, OpDef>();

export function defineOp<S extends z.ZodObject>(def: OpDef<S>): OpDef<S> {
  if (registry.has(def.name)) throw new Error(`Duplicate op ${def.name}`);
  registry.set(def.name, def as unknown as OpDef);
  return def;
}

export interface OpCall {
  op: string;
  args: Record<string, unknown>;
}

export class OpError extends Error {}

/**
 * Validate and apply an op to `doc` (mutating). Returns the op result and the
 * normalised args (with defaults and generated ids filled in) for replay/broadcast.
 */
export function applyOp(doc: OpenBoneDocument, op: string, args: unknown): { result: unknown; args: Record<string, unknown> } {
  const def = registry.get(op);
  if (!def) throw new OpError(`Unknown op "${op}". Known: ${[...registry.keys()].join(", ")}`);
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new OpError(`Invalid args for ${op}: ${z.prettifyError(parsed.error)}`);
  }
  const normalised = parsed.data as Record<string, unknown>;
  const result = def.apply(doc, normalised);
  return { result, args: normalised };
}

// ---- shared schema pieces ----
export const ref = (what: string) => z.string().min(1).describe(`${what} id or name`);
export const hex = z
  .string()
  .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
  .describe("Hex color like #ff8800 or #ff880080");
export const curve = z
  .union([z.literal("linear"), z.literal("stepped"), z.tuple([z.number(), z.number(), z.number(), z.number()])])
  .describe('"linear", "stepped" or bezier handles [cx1, cy1, cx2, cy2] (e.g. [0.42,0,0.58,1] for ease-in-out)');
export const optId = z.string().optional().describe("Optional explicit id (generated when omitted)");

export const EASINGS: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  backOut: [0.34, 1.56, 0.64, 1],
};
