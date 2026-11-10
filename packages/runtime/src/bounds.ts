import { pointInPolygon } from "@openbone/core";
import type { Skeleton, Slot } from "./skeleton.ts";

/** One active bounding box: the world polygon of a slot's current bounding-box attachment. */
export interface BoundingBoxPolygon {
  slot: Slot;
  /** Attachment name. */
  attachment: string;
  /** World x,y pairs (skeleton space, y up: the same coordinates as the draw list). */
  vertices: Float32Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The active bounding boxes of a skeleton for one pose (like Spine's SkeletonBounds): every slot, in draw order,
 * whose bone is active and whose current attachment is a bounding box. Call `update` after the pose changes (or
 * take a new one with `skeleton.boundingBoxes()`). All coordinates are skeleton world space, the draw list's.
 *
 * When nothing is active the overall box is all zeros and every query returns nothing.
 */
export class SkeletonBounds {
  boxes: BoundingBoxPolygon[] = [];
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;

  constructor(skeleton?: Skeleton) {
    if (skeleton) this.update(skeleton);
  }

  /** Recompute the polygons from the skeleton's current world pose. */
  update(skeleton: Skeleton): this {
    this.boxes = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const slot of skeleton.drawOrder) {
      if (!slot.bone.active) continue;
      const att = skeleton.getAttachment(slot);
      if (!att || att.type !== "boundingBox" || att.vertices.length < 6) continue;
      const v = skeleton.attachmentWorldVertices(slot, att);
      const box: BoundingBoxPolygon = { slot, attachment: att.name, vertices: v, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 0; i < v.length; i += 2) {
        box.minX = Math.min(box.minX, v[i]);
        box.minY = Math.min(box.minY, v[i + 1]);
        box.maxX = Math.max(box.maxX, v[i]);
        box.maxY = Math.max(box.maxY, v[i + 1]);
      }
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
      this.boxes.push(box);
    }
    if (!this.boxes.length) minX = minY = maxX = maxY = 0;
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    return this;
  }

  /** True if the point is inside the overall AABB (edges included). */
  aabbContainsPoint(x: number, y: number): boolean {
    return this.boxes.length > 0 && x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }

  /** True if the overall AABB overlaps the given rectangle (edges included). */
  aabbIntersects(minX: number, minY: number, maxX: number, maxY: number): boolean {
    return this.boxes.length > 0 && minX <= this.maxX && maxX >= this.minX && minY <= this.maxY && maxY >= this.minY;
  }

  /** The first box (in draw order) containing the point, or null. The last match is the one drawn on top. */
  containsPoint(x: number, y: number): BoundingBoxPolygon | null {
    for (const b of this.boxes) if (boxContains(b, x, y)) return b;
    return null;
  }

  /** Every box containing the point, in draw order. */
  containsPointAll(x: number, y: number): BoundingBoxPolygon[] {
    return this.boxes.filter((b) => boxContains(b, x, y));
  }

  /** The first box (in draw order) the segment touches: it crosses an edge or lies inside. Null if none. */
  intersectsSegment(x1: number, y1: number, x2: number, y2: number): BoundingBoxPolygon | null {
    for (const b of this.boxes) if (boxSegment(b, x1, y1, x2, y2)) return b;
    return null;
  }

  /** Every box the segment touches, in draw order. */
  intersectsSegmentAll(x1: number, y1: number, x2: number, y2: number): BoundingBoxPolygon[] {
    return this.boxes.filter((b) => boxSegment(b, x1, y1, x2, y2));
  }

  /**
   * The first overlapping pair of polygons between these boxes and another skeleton's: `[mine, theirs]`, scanning
   * mine in draw order and theirs in draw order for each. Polygons overlap when edges cross or one holds a vertex
   * of the other. Null if none overlap.
   */
  intersectsBounds(other: SkeletonBounds): [BoundingBoxPolygon, BoundingBoxPolygon] | null {
    if (!this.aabbIntersects(other.minX, other.minY, other.maxX, other.maxY)) return null;
    for (const a of this.boxes) for (const b of other.boxes) if (polygonsOverlap(a, b)) return [a, b];
    return null;
  }
}

function boxContains(b: BoundingBoxPolygon, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInPolygon(x, y, b.vertices);
}

/** Closed segments p1-p2 and p3-p4 cross or touch (not counting parallel ones). */
export function segmentsIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return false;
  const ua = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const ub = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

function edgeCrosses(v: ArrayLike<number>, x1: number, y1: number, x2: number, y2: number): boolean {
  const n = v.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) if (segmentsIntersect(x1, y1, x2, y2, v[j], v[j + 1], v[i], v[i + 1])) return true;
  return false;
}

function boxSegment(b: BoundingBoxPolygon, x1: number, y1: number, x2: number, y2: number): boolean {
  if (Math.max(x1, x2) < b.minX || Math.min(x1, x2) > b.maxX || Math.max(y1, y2) < b.minY || Math.min(y1, y2) > b.maxY) return false;
  return edgeCrosses(b.vertices, x1, y1, x2, y2) || pointInPolygon(x1, y1, b.vertices);
}

function polygonsOverlap(a: BoundingBoxPolygon, b: BoundingBoxPolygon): boolean {
  if (a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY) return false;
  const v = a.vertices;
  const n = v.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) if (edgeCrosses(b.vertices, v[j], v[j + 1], v[i], v[i + 1])) return true;
  return pointInPolygon(v[0], v[1], b.vertices) || pointInPolygon(b.vertices[0], b.vertices[1], v);
}
