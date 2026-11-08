/**
 * Snapping for editor drags: pull a point onto nearby lines (guides, artboard centre/edges, grid) or into
 * alignment with other points (smart guides). Pure geometry, independent of the UI.
 */

export type SnapKind = "guide" | "center" | "edge" | "origin" | "grid" | "point";

/** A vertical line (axis "x", at x = value) or horizontal line (axis "y", at y = value) to snap to. */
export interface SnapTarget {
  axis: "x" | "y";
  value: number;
  kind: SnapKind;
  /** For "point" targets: the point's other coordinate, so a smart guide can be drawn between the two. */
  other?: number;
}

export interface SnapLine extends SnapTarget {}

export interface SnapResult {
  x: number;
  y: number;
  /** Lines the point snapped to (at most one per axis), for drawing smart guides. */
  lines: SnapLine[];
}

/** When two candidates are about equally close, prefer intentional targets over the grid. */
const PRIORITY: Record<SnapKind, number> = { guide: 0, center: 1, origin: 1, edge: 2, point: 3, grid: 4 };

/**
 * Snap (x, y) independently on each axis to the closest target within `threshold` (same units as x/y).
 * `grid` adds lines at every multiple of its size.
 */
export function snapPoint(x: number, y: number, targets: SnapTarget[], threshold: number, grid?: number): SnapResult {
  const pick = (axis: "x" | "y", v: number): SnapLine | null => {
    const candidates = targets.filter((t) => t.axis === axis);
    if (grid && grid > 0) candidates.push({ axis, value: Math.round(v / grid) * grid, kind: "grid" });
    let best: SnapLine | null = null;
    let bestScore = Infinity;
    for (const t of candidates) {
      const d = Math.abs(t.value - v);
      if (d > threshold) continue;
      // Distance first, then priority as a tie-breaker within a quarter of the threshold.
      const score = d + PRIORITY[t.kind] * threshold * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  };
  const lx = pick("x", x);
  const ly = pick("y", y);
  return { x: lx ? lx.value : x, y: ly ? ly.value : y, lines: [lx, ly].filter((l): l is SnapLine => !!l) };
}

/** Artboard snap lines in skeleton space (y-up): edges, centre and the skeleton origin. */
export function artboardTargets(doc: { width: number; height: number; originX: number; originY: number }): SnapTarget[] {
  const left = -doc.originX;
  const right = doc.width - doc.originX;
  const top = doc.originY;
  const bottom = doc.originY - doc.height;
  return [
    { axis: "x", value: left, kind: "edge" },
    { axis: "x", value: right, kind: "edge" },
    { axis: "x", value: (left + right) / 2, kind: "center" },
    { axis: "y", value: top, kind: "edge" },
    { axis: "y", value: bottom, kind: "edge" },
    { axis: "y", value: (top + bottom) / 2, kind: "center" },
    { axis: "x", value: 0, kind: "origin" },
    { axis: "y", value: 0, kind: "origin" },
  ];
}

/** Smart-guide targets that align with other points (e.g. bone joints). */
export function pointTargets(points: [number, number][]): SnapTarget[] {
  return points.flatMap(([px, py]): SnapTarget[] => [
    { axis: "x", value: px, kind: "point", other: py },
    { axis: "y", value: py, kind: "point", other: px },
  ]);
}
