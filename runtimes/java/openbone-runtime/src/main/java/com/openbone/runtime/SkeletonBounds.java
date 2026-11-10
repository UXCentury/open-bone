package com.openbone.runtime;

import com.openbone.runtime.data.Attachment;
import com.openbone.runtime.data.BoundingBoxAttachment;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The active bounding boxes of a skeleton for one pose (like Spine's SkeletonBounds; runtime bounds.ts, spec §8.10):
 * every slot, in draw order, whose bone is active and whose current attachment is a bounding box. Call {@link #update}
 * after the pose changes (or take a new one with {@link Skeleton#boundingBoxes()}). All coordinates are skeleton world
 * space (y up), the draw list's.
 *
 * <p>When nothing is active the overall box is all zeros and every query returns nothing.
 */
public final class SkeletonBounds {
  /** One active bounding box: the world polygon of a slot's current bounding-box attachment. */
  public static final class Box {
    public final Slot slot;
    /** Attachment name. */
    public final String attachment;
    /** World x,y pairs (float32 values held in doubles). */
    public final double[] vertices;
    public final double minX, minY, maxX, maxY;

    Box(Slot slot, String attachment, double[] vertices) {
      this.slot = slot;
      this.attachment = attachment;
      this.vertices = vertices;
      double x0 = Double.POSITIVE_INFINITY, y0 = Double.POSITIVE_INFINITY, x1 = Double.NEGATIVE_INFINITY, y1 = Double.NEGATIVE_INFINITY;
      for (int i = 0; i + 1 < vertices.length; i += 2) {
        x0 = Math.min(x0, vertices[i]);
        y0 = Math.min(y0, vertices[i + 1]);
        x1 = Math.max(x1, vertices[i]);
        y1 = Math.max(y1, vertices[i + 1]);
      }
      minX = x0;
      minY = y0;
      maxX = x1;
      maxY = y1;
    }

    @Override
    public String toString() {
      return slot.data.name + "/" + attachment;
    }
  }

  /** A pair of overlapping boxes from {@link #intersectsBounds}: one of these bounds, one of the other's. */
  public static final class Pair {
    public final Box mine, theirs;

    Pair(Box mine, Box theirs) {
      this.mine = mine;
      this.theirs = theirs;
    }
  }

  private final List<Box> boxes = new ArrayList<>();
  private final List<Box> boxesView = Collections.unmodifiableList(boxes);
  public double minX, minY, maxX, maxY;

  public SkeletonBounds() {}

  public SkeletonBounds(Skeleton skeleton) {
    update(skeleton);
  }

  /** The active boxes in draw order (read-only; replaced by {@link #update}). */
  public List<Box> boxes() {
    return boxesView;
  }

  /** Recompute the polygons from the skeleton's current world pose. */
  public SkeletonBounds update(Skeleton skeleton) {
    boxes.clear();
    double x0 = Double.POSITIVE_INFINITY, y0 = Double.POSITIVE_INFINITY, x1 = Double.NEGATIVE_INFINITY, y1 = Double.NEGATIVE_INFINITY;
    for (Slot slot : skeleton.drawOrder) {
      if (!slot.bone.active) continue;
      Attachment att = skeleton.getAttachment(slot);
      if (!(att instanceof BoundingBoxAttachment) || ((BoundingBoxAttachment) att).vertices.length < 6) continue;
      Box box = new Box(slot, att.name, skeleton.attachmentWorldVertices(slot, att));
      x0 = Math.min(x0, box.minX);
      y0 = Math.min(y0, box.minY);
      x1 = Math.max(x1, box.maxX);
      y1 = Math.max(y1, box.maxY);
      boxes.add(box);
    }
    if (boxes.isEmpty()) x0 = y0 = x1 = y1 = 0;
    minX = x0;
    minY = y0;
    maxX = x1;
    maxY = y1;
    return this;
  }

  /** True if the point is inside the overall AABB (edges included). */
  public boolean aabbContainsPoint(double x, double y) {
    return !boxes.isEmpty() && x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  /** True if the overall AABB overlaps the given rectangle (edges included). */
  public boolean aabbIntersects(double minX, double minY, double maxX, double maxY) {
    return !boxes.isEmpty() && minX <= this.maxX && maxX >= this.minX && minY <= this.maxY && maxY >= this.minY;
  }

  /** The first box (in draw order) containing the point, or null. The last match is the one drawn on top. */
  public Box containsPoint(double x, double y) {
    for (Box b : boxes) if (boxContains(b, x, y)) return b;
    return null;
  }

  /** Every box containing the point, in draw order. */
  public List<Box> containsPointAll(double x, double y) {
    List<Box> out = new ArrayList<>();
    for (Box b : boxes) if (boxContains(b, x, y)) out.add(b);
    return out;
  }

  /** The first box (in draw order) the segment touches: it crosses an edge or starts inside. Null if none. */
  public Box intersectsSegment(double x1, double y1, double x2, double y2) {
    for (Box b : boxes) if (boxSegment(b, x1, y1, x2, y2)) return b;
    return null;
  }

  /** Every box the segment touches, in draw order. */
  public List<Box> intersectsSegmentAll(double x1, double y1, double x2, double y2) {
    List<Box> out = new ArrayList<>();
    for (Box b : boxes) if (boxSegment(b, x1, y1, x2, y2)) out.add(b);
    return out;
  }

  /**
   * The first overlapping pair of polygons between these boxes and another skeleton's, scanning mine in draw order
   * and theirs in draw order for each. Polygons overlap when edges cross or one holds a vertex of the other. Null if
   * none overlap.
   */
  public Pair intersectsBounds(SkeletonBounds other) {
    if (!aabbIntersects(other.minX, other.minY, other.maxX, other.maxY)) return null;
    for (Box a : boxes) for (Box b : other.boxes) if (polygonsOverlap(a, b)) return new Pair(a, b);
    return null;
  }

  /** Closed segments p1-p2 and p3-p4 cross or touch (parallel ones never count). */
  public static boolean segmentsIntersect(double x1, double y1, double x2, double y2, double x3, double y3, double x4, double y4) {
    double d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (d == 0) return false;
    double ua = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    double ub = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
  }

  private static boolean boxContains(Box b, double x, double y) {
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && MathUtil.pointInPolygon(x, y, b.vertices);
  }

  private static boolean edgeCrosses(double[] v, double x1, double y1, double x2, double y2) {
    int n = v.length;
    for (int i = 0, j = n - 2; i < n; j = i, i += 2) if (segmentsIntersect(x1, y1, x2, y2, v[j], v[j + 1], v[i], v[i + 1])) return true;
    return false;
  }

  private static boolean boxSegment(Box b, double x1, double y1, double x2, double y2) {
    if (Math.max(x1, x2) < b.minX || Math.min(x1, x2) > b.maxX || Math.max(y1, y2) < b.minY || Math.min(y1, y2) > b.maxY) return false;
    return edgeCrosses(b.vertices, x1, y1, x2, y2) || MathUtil.pointInPolygon(x1, y1, b.vertices);
  }

  private static boolean polygonsOverlap(Box a, Box b) {
    if (a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY) return false;
    double[] v = a.vertices;
    int n = v.length;
    for (int i = 0, j = n - 2; i < n; j = i, i += 2) if (edgeCrosses(b.vertices, v[j], v[j + 1], v[i], v[i + 1])) return true;
    return MathUtil.pointInPolygon(v[0], v[1], b.vertices) || MathUtil.pointInPolygon(b.vertices[0], b.vertices[1], v);
  }
}
