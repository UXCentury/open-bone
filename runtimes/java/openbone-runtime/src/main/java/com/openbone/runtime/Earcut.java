package com.openbone.runtime;

import java.util.ArrayList;
import java.util.List;

/**
 * Polygon triangulation: a port of mapbox earcut 3.2.4 (ISC licence, Copyright (c) 2024 Mapbox) for simple polygons
 * without holes. Results match the JavaScript library exactly (the conformance suite compares indices).
 */
public final class Earcut {
  private Earcut() {}

  private static final class Node {
    final int i;
    final double x, y;
    Node prev, next, prevZ, nextZ;
    int z;

    Node(int i, double x, double y) {
      this.i = i;
      this.x = x;
      this.y = y;
    }
  }

  private static final class State {
    boolean filteredOut;
  }

  /** Triangles (index triplets) of a polygon given as flat x,y pairs. */
  public static int[] triangulate(double[] data) {
    List<Integer> triangles = new ArrayList<>();
    int outerLen = data.length;
    Node outerNode = linkedList(data, 0, outerLen, true);
    if (outerNode == null || outerNode.next == outerNode.prev) return new int[0];
    double minX = 0, minY = 0, invSize = 0;
    if (data.length > 80 * 2) {
      minX = data[0];
      minY = data[1];
      double maxX = minX, maxY = minY;
      for (int i = 2; i < outerLen; i += 2) {
        double x = data[i], y = data[i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      invSize = Math.max(maxX - minX, maxY - minY);
      invSize = invSize != 0 ? 32767 / invSize : 0;
    }
    earcutLinked(outerNode, triangles, minX, minY, invSize, new State());
    int[] out = new int[triangles.size()];
    for (int i = 0; i < out.length; i++) out[i] = triangles.get(i);
    return out;
  }

  private static Node linkedList(double[] data, int start, int end, boolean clockwise) {
    Node last = null;
    if (clockwise == (signedArea(data, start, end) > 0)) {
      for (int i = start; i < end; i += 2) last = insertNode(i / 2, data[i], data[i + 1], last);
    } else {
      for (int i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i], data[i + 1], last);
    }
    if (last != null && equals(last, last.next)) {
      removeNode(last);
      last = last.next;
    }
    return last;
  }

  private static Node filterPoints(Node start, Node end, State st) {
    boolean full = end == start;
    Node p = start;
    boolean again;
    do {
      again = false;
      if (p != p.next && (equals(p, p.next) || area(p.prev, p, p.next) == 0)) {
        if (full || p == end) end = p.prev;
        st.filteredOut = true;
        removeNode(p);
        p = p.prev;
        again = true;
      } else if (full || p != end) {
        p = p.next;
        again = !full;
      }
    } while (again || p != end);
    return end;
  }

  private static void earcutLinked(Node ear, List<Integer> triangles, double minX, double minY, double invSize, State st) {
    if (invSize != 0) indexCurve(ear, minX, minY, invSize);
    Node stop = ear;
    boolean cured = false;
    while (ear.prev != ear.next) {
      Node prev = ear.prev;
      Node next = ear.next;
      if (area(prev, ear, next) < 0 && (invSize != 0 ? isEarHashed(ear, minX, minY, invSize) : isEar(ear))) {
        triangles.add(prev.i);
        triangles.add(ear.i);
        triangles.add(next.i);
        removeNode(ear);
        ear = next;
        stop = next;
        continue;
      }
      ear = next;
      if (ear == stop) {
        st.filteredOut = false;
        ear = filterPoints(ear, ear, st);
        if (st.filteredOut) {
          stop = ear;
          continue;
        }
        if (!cured) {
          ear = cureLocalIntersections(ear, triangles, st);
          stop = ear;
          cured = true;
          continue;
        }
        splitEarcut(ear, triangles, minX, minY, invSize, st);
        break;
      }
    }
  }

  private static boolean isEar(Node ear) {
    Node a = ear.prev, b = ear, c = ear.next;
    double ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    double x0 = Math.min(ax, Math.min(bx, cx)), y0 = Math.min(ay, Math.min(by, cy));
    double x1 = Math.max(ax, Math.max(bx, cx)), y1 = Math.max(ay, Math.max(by, cy));
    Node p = c.next;
    while (p != a) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && !(ax == p.x && ay == p.y)
          && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.next;
    }
    return true;
  }

  private static boolean isEarHashed(Node ear, double minX, double minY, double invSize) {
    Node a = ear.prev, b = ear, c = ear.next;
    double ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    double x0 = Math.min(ax, Math.min(bx, cx)), y0 = Math.min(ay, Math.min(by, cy));
    double x1 = Math.max(ax, Math.max(bx, cx)), y1 = Math.max(ay, Math.max(by, cy));
    int minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
    Node p = ear.prevZ;
    while (p != null && p.z >= minZ) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p != c && !(ax == p.x && ay == p.y)
          && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.prevZ;
    }
    Node n = ear.nextZ;
    while (n != null && n.z <= maxZ) {
      if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n != c && !(ax == n.x && ay == n.y)
          && pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
      n = n.nextZ;
    }
    return true;
  }

  private static Node cureLocalIntersections(Node start, List<Integer> triangles, State st) {
    Node p = start;
    boolean cured = false;
    do {
      Node a = p.prev, b = p.next.next;
      if (intersects(a, p, p.next, b, false) && locallyInside(a, b) && locallyInside(b, a)) {
        triangles.add(a.i);
        triangles.add(p.i);
        triangles.add(b.i);
        removeNode(p);
        removeNode(p.next);
        p = start = b;
        cured = true;
      }
      p = p.next;
    } while (p != start);
    return cured ? filterPoints(p, p, st) : p;
  }

  private static void splitEarcut(Node start, List<Integer> triangles, double minX, double minY, double invSize, State st) {
    Node a = start;
    do {
      Node b = a.next.next;
      while (b != a.prev) {
        if (a.i != b.i && isValidDiagonal(a, b)) {
          Node c = splitPolygon(a, b);
          a = filterPoints(a, a.next, st);
          c = filterPoints(c, c.next, st);
          earcutLinked(a, triangles, minX, minY, invSize, st);
          earcutLinked(c, triangles, minX, minY, invSize, st);
          return;
        }
        b = b.next;
      }
      a = a.next;
    } while (a != start);
  }

  private static void indexCurve(Node start, double minX, double minY, double invSize) {
    List<Node> nodes = new ArrayList<>();
    Node p = start;
    do {
      p.z = zOrder(p.x, p.y, minX, minY, invSize);
      nodes.add(p);
      p = p.next;
    } while (p != start);
    // Stable sort by z (earcut uses insertion sort / LSD radix, both stable).
    nodes.sort((u, v) -> Integer.compareUnsigned(u.z, v.z));
    Node prev = null;
    for (Node node : nodes) {
      node.prevZ = prev;
      if (prev != null) prev.nextZ = node;
      prev = node;
    }
    prev.nextZ = null;
  }

  private static int zOrder(double xd, double yd, double minX, double minY, double invSize) {
    int x = (int) (long) ((xd - minX) * invSize);
    int y = (int) (long) ((yd - minY) * invSize);
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;
    return x | (y << 1);
  }

  private static boolean pointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
    return (cx - px) * (ay - py) >= (ax - px) * (cy - py)
        && (ax - px) * (by - py) >= (bx - px) * (ay - py)
        && (bx - px) * (cy - py) >= (cx - px) * (by - py);
  }

  private static boolean isValidDiagonal(Node a, Node b) {
    boolean zeroLength = equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0;
    return a.next.i != b.i
        && (zeroLength || locallyInside(a, b) && locallyInside(b, a) && (area(a.prev, a, b.prev) != 0 || area(a, b.prev, b) != 0))
        && !intersectsPolygon(a, b)
        && (zeroLength || middleInside(a, b));
  }

  private static double area(Node p, Node q, Node r) {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  }

  private static boolean equals(Node p1, Node p2) {
    return p1.x == p2.x && p1.y == p2.y;
  }

  private static boolean intersects(Node p1, Node q1, Node p2, Node q2, boolean includeBoundary) {
    double o1 = area(p1, q1, p2), o2 = area(p1, q1, q2), o3 = area(p2, q2, p1), o4 = area(p2, q2, q1);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    if (!includeBoundary) return false;
    if (o1 == 0 && onSegment(p1, p2, q1)) return true;
    if (o2 == 0 && onSegment(p1, q2, q1)) return true;
    if (o3 == 0 && onSegment(p2, p1, q2)) return true;
    if (o4 == 0 && onSegment(p2, q1, q2)) return true;
    return false;
  }

  private static boolean onSegment(Node p, Node q, Node r) {
    return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
  }

  private static boolean intersectsPolygon(Node a, Node b) {
    double minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    Node p = a;
    do {
      Node n = p.next;
      if ((p.x > maxX && n.x > maxX) || (p.x < minX && n.x < minX) || (p.y > maxY && n.y > maxY) || (p.y < minY && n.y < minY)) {
        p = n;
        continue;
      }
      if (p.i != a.i && n.i != a.i && p.i != b.i && n.i != b.i && intersects(p, n, a, b, true)) return true;
      p = n;
    } while (p != a);
    return false;
  }

  private static boolean locallyInside(Node a, Node b) {
    return area(a.prev, a, a.next) < 0
        ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
        : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
  }

  private static boolean middleInside(Node a, Node b) {
    Node p = a;
    boolean inside = false;
    double px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
    do {
      Node n = p.next;
      if (((p.y > py) != (n.y > py)) && (px < (n.x - p.x) * (py - p.y) / (n.y - p.y) + p.x)) inside = !inside;
      p = n;
    } while (p != a);
    return inside;
  }

  private static Node splitPolygon(Node a, Node b) {
    Node a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
    a.next = b;
    b.prev = a;
    a2.next = an;
    an.prev = a2;
    b2.next = a2;
    a2.prev = b2;
    bp.next = b2;
    b2.prev = bp;
    return b2;
  }

  private static Node insertNode(int i, double x, double y, Node last) {
    Node p = new Node(i, x, y);
    if (last == null) {
      p.prev = p;
      p.next = p;
    } else {
      p.next = last.next;
      p.prev = last;
      last.next.prev = p;
      last.next = p;
    }
    return p;
  }

  private static void removeNode(Node p) {
    p.next.prev = p.prev;
    p.prev.next = p.next;
    if (p.prevZ != null) p.prevZ.nextZ = p.nextZ;
    if (p.nextZ != null) p.nextZ.prevZ = p.prevZ;
  }

  private static double signedArea(double[] data, int start, int end) {
    double sum = 0;
    for (int i = start, j = end - 2; i < end; i += 2) {
      sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
      j = i;
    }
    return sum;
  }
}
