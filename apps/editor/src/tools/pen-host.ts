import type { Skeleton } from "@openbone/runtime";
import { createSignal } from "solid-js";
import type { Mat } from "./knots.ts";

/**
 * What the Pen tool needs from the viewport. The viewport registers one (`setPenHost`) so the tool modules stay
 * independent of `Viewport.tsx`.
 */
export interface PenHost {
  /** The viewport's posed skeleton (setup pose in Setup mode, the current frame in Animate mode). */
  sk(): Skeleton;
  /** Screen px per skeleton unit. */
  zoom(): number;
  /** Snap a skeleton-space point (Ctrl/⌘ bypasses); `extra` are more points to snap to. */
  snap(x: number, y: number, e: { ctrlKey: boolean; metaKey: boolean }, extra: [number, number][]): [number, number];
  clearSnap(): void;
  /** Pose a preview skeleton the way the viewport poses its own. */
  repose(s: Skeleton): void;
  /** The pointer in skeleton space, or null when it is outside the viewport. */
  pointer(): [number, number] | null;
}

let host: PenHost | null = null;
export const setPenHost = (h: PenHost | null) => (host = h);
export const penHost = () => host;

const IDENT: Mat = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
/** World matrix of a bone in the viewport's current pose. */
export const boneMat = (h: PenHost) => (id: string): Mat => h.sk().boneById_(id)?.world ?? IDENT;

/** Selected points of the edited path (point index = knot * 3 + 0 in / 1 anchor / 2 out) or polygon. */
export const [penSel, setPenSel] = createSignal<number[]>([]);
/** Point under the pointer (same indexing), or -1. */
export const [penHover, setPenHover] = createSignal(-1);

export const r3 = (n: number) => Math.round(n * 1000) / 1000;
