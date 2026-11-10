// Shape outlines, earcut (mapbox earcut 3.2.4, ISC — ported for exact index parity, no-holes path) and path splines.
// SPDX-License-Identifier: MIT AND ISC
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>

#include "internal.hpp"

namespace openbone {

// ---------------- earcut ----------------
namespace {

struct Node {
  uint32_t i;
  double x, y;
  Node* prev = nullptr;
  Node* next = nullptr;
  uint32_t z = 0;
  Node* prevZ = nullptr;
  Node* nextZ = nullptr;
};

struct Earcut {
  std::deque<Node> pool;
  std::vector<uint32_t> triangles;
  bool filteredOut = false;

  Node* createNode(uint32_t i, double x, double y) {
    pool.push_back(Node{i, x, y});
    return &pool.back();
  }
  static double area(const Node* p, const Node* q, const Node* r) {
    return (q->y - p->y) * (r->x - q->x) - (q->x - p->x) * (r->y - q->y);
  }
  static bool equals(const Node* a, const Node* b) { return a->x == b->x && a->y == b->y; }

  Node* insertNode(uint32_t i, double x, double y, Node* last) {
    Node* p = createNode(i, x, y);
    if (!last) {
      p->prev = p;
      p->next = p;
    } else {
      p->next = last->next;
      p->prev = last;
      last->next->prev = p;
      last->next = p;
    }
    return p;
  }
  static void removeNode(Node* p) {
    p->next->prev = p->prev;
    p->prev->next = p->next;
    if (p->prevZ) p->prevZ->nextZ = p->nextZ;
    if (p->nextZ) p->nextZ->prevZ = p->prevZ;
  }

  static double signedArea(const std::vector<double>& data, size_t start, size_t end) {
    double sum = 0;
    for (size_t i = start, j = end - 2; i < end; i += 2) {
      sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
      j = i;
    }
    return sum;
  }

  Node* linkedList(const std::vector<double>& data, size_t start, size_t end, bool clockwise) {
    Node* last = nullptr;
    if (clockwise == (signedArea(data, start, end) > 0)) {
      for (size_t i = start; i < end; i += 2) last = insertNode(uint32_t(i / 2), data[i], data[i + 1], last);
    } else {
      for (long long i = (long long)end - 2; i >= (long long)start; i -= 2) last = insertNode(uint32_t(i / 2), data[i], data[i + 1], last);
    }
    if (last && equals(last, last->next)) {
      removeNode(last);
      last = last->next;
    }
    return last;
  }

  Node* filterPoints(Node* start, Node* end = nullptr) {
    if (!end) end = start;
    const bool full = end == start;
    Node* p = start;
    bool again;
    do {
      again = false;
      if (p != p->next && (equals(p, p->next) || area(p->prev, p, p->next) == 0)) {
        if (full || p == end) end = p->prev;
        filteredOut = true;
        removeNode(p);
        p = p->prev;
        again = true;
      } else if (full || p != end) {
        p = p->next;
        again = !full;
      }
    } while (again || p != end);
    return end;
  }

  static int32_t toInt32(double v) {
    // JS `| 0` (truncation toward zero, then wrap); inputs here are small.
    if (!std::isfinite(v)) return 0;
    double t = std::trunc(v);
    double m = std::fmod(t, 4294967296.0);
    if (m < 0) m += 4294967296.0;
    uint32_t u = uint32_t(m);
    return int32_t(u);
  }
  static uint32_t zOrder(double xd, double yd, double minX, double minY, double invSize) {
    int32_t x = toInt32((xd - minX) * invSize);
    int32_t y = toInt32((yd - minY) * invSize);
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;
    return uint32_t(x | (y << 1));
  }

  static bool pointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
    return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
           (bx - px) * (cy - py) >= (cx - px) * (by - py);
  }

  static bool isEar(Node* ear) {
    const Node *a = ear->prev, *b = ear, *c = ear->next;
    const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
    const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy}), x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
    Node* p = c->next;
    while (p != a) {
      if (p->x >= x0 && p->x <= x1 && p->y >= y0 && p->y <= y1 && !(ax == p->x && ay == p->y) &&
          pointInTriangle(ax, ay, bx, by, cx, cy, p->x, p->y) && area(p->prev, p, p->next) >= 0)
        return false;
      p = p->next;
    }
    return true;
  }

  static bool isEarHashed(Node* ear, double minX, double minY, double invSize) {
    const Node *a = ear->prev, *b = ear, *c = ear->next;
    const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
    const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy}), x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
    const uint32_t minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
    Node* p = ear->prevZ;
    while (p && p->z >= minZ) {
      if (p->x >= x0 && p->x <= x1 && p->y >= y0 && p->y <= y1 && p != c && !(ax == p->x && ay == p->y) &&
          pointInTriangle(ax, ay, bx, by, cx, cy, p->x, p->y) && area(p->prev, p, p->next) >= 0)
        return false;
      p = p->prevZ;
    }
    Node* n = ear->nextZ;
    while (n && n->z <= maxZ) {
      if (n->x >= x0 && n->x <= x1 && n->y >= y0 && n->y <= y1 && n != c && !(ax == n->x && ay == n->y) &&
          pointInTriangle(ax, ay, bx, by, cx, cy, n->x, n->y) && area(n->prev, n, n->next) >= 0)
        return false;
      n = n->nextZ;
    }
    return true;
  }

  static bool onSegment(const Node* p, const Node* q, const Node* r) {
    return q->x <= std::max(p->x, r->x) && q->x >= std::min(p->x, r->x) && q->y <= std::max(p->y, r->y) && q->y >= std::min(p->y, r->y);
  }
  static bool intersects(const Node* p1, const Node* q1, const Node* p2, const Node* q2, bool includeBoundary = true) {
    const double o1 = area(p1, q1, p2), o2 = area(p1, q1, q2), o3 = area(p2, q2, p1), o4 = area(p2, q2, q1);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    if (!includeBoundary) return false;
    if (o1 == 0 && onSegment(p1, p2, q1)) return true;
    if (o2 == 0 && onSegment(p1, q2, q1)) return true;
    if (o3 == 0 && onSegment(p2, p1, q2)) return true;
    if (o4 == 0 && onSegment(p2, q1, q2)) return true;
    return false;
  }
  static bool intersectsPolygon(const Node* a, const Node* b) {
    const double minX = std::min(a->x, b->x), maxX = std::max(a->x, b->x), minY = std::min(a->y, b->y), maxY = std::max(a->y, b->y);
    const Node* p = a;
    do {
      const Node* n = p->next;
      if ((p->x > maxX && n->x > maxX) || (p->x < minX && n->x < minX) || (p->y > maxY && n->y > maxY) || (p->y < minY && n->y < minY)) {
        p = n;
        continue;
      }
      if (p->i != a->i && n->i != a->i && p->i != b->i && n->i != b->i && intersects(p, n, a, b)) return true;
      p = n;
    } while (p != a);
    return false;
  }
  static bool locallyInside(const Node* a, const Node* b) {
    return area(a->prev, a, a->next) < 0 ? area(a, b, a->next) >= 0 && area(a, a->prev, b) >= 0
                                          : area(a, b, a->prev) < 0 || area(a, a->next, b) < 0;
  }
  static bool middleInside(const Node* a, const Node* b) {
    const Node* p = a;
    bool inside = false;
    const double px = (a->x + b->x) / 2, py = (a->y + b->y) / 2;
    do {
      const Node* n = p->next;
      if (((p->y > py) != (n->y > py)) && (px < (n->x - p->x) * (py - p->y) / (n->y - p->y) + p->x)) inside = !inside;
      p = n;
    } while (p != a);
    return inside;
  }
  static bool isValidDiagonal(const Node* a, const Node* b) {
    const bool zeroLength = equals(a, b) && area(a->prev, a, a->next) > 0 && area(b->prev, b, b->next) > 0;
    return a->next->i != b->i &&
           (zeroLength || (locallyInside(a, b) && locallyInside(b, a) && (area(a->prev, a, b->prev) != 0 || area(a, b->prev, b) != 0))) &&
           !intersectsPolygon(a, b) && (zeroLength || middleInside(a, b));
  }

  Node* splitPolygon(Node* a, Node* b) {
    Node* a2 = createNode(a->i, a->x, a->y);
    Node* b2 = createNode(b->i, b->x, b->y);
    Node* an = a->next;
    Node* bp = b->prev;
    a->next = b;
    b->prev = a;
    a2->next = an;
    an->prev = a2;
    b2->next = a2;
    a2->prev = b2;
    bp->next = b2;
    b2->prev = bp;
    return b2;
  }

  Node* cureLocalIntersections(Node* start) {
    Node* p = start;
    bool cured = false;
    do {
      Node* a = p->prev;
      Node* b = p->next->next;
      if (intersects(a, p, p->next, b, false) && locallyInside(a, b) && locallyInside(b, a)) {
        triangles.push_back(a->i);
        triangles.push_back(p->i);
        triangles.push_back(b->i);
        removeNode(p);
        removeNode(p->next);
        p = start = b;
        cured = true;
      }
      p = p->next;
    } while (p != start);
    return cured ? filterPoints(p) : p;
  }

  void splitEarcut(Node* start, double minX, double minY, double invSize) {
    Node* a = start;
    do {
      Node* b = a->next->next;
      while (b != a->prev) {
        if (a->i != b->i && isValidDiagonal(a, b)) {
          Node* c = splitPolygon(a, b);
          a = filterPoints(a, a->next);
          c = filterPoints(c, c->next);
          earcutLinked(a, minX, minY, invSize);
          earcutLinked(c, minX, minY, invSize);
          return;
        }
        b = b->next;
      }
      a = a->next;
    } while (a != start);
  }

  void indexCurve(Node* start, double minX, double minY, double invSize) {
    std::vector<Node*> arr;
    Node* p = start;
    do {
      p->z = zOrder(p->x, p->y, minX, minY, invSize);
      arr.push_back(p);
      p = p->next;
    } while (p != start);
    const size_t n = arr.size();
    if (n <= 32) {
      for (size_t i = 1; i < n; i++) {
        Node* node = arr[i];
        uint32_t z = node->z;
        long long j = (long long)i - 1;
        while (j >= 0 && arr[j]->z > z) {
          arr[j + 1] = arr[j];
          j--;
        }
        arr[j + 1] = node;
      }
    } else {
      // LSD radix sort on the z values (stable), as earcut does.
      std::stable_sort(arr.begin(), arr.end(), [](const Node* a, const Node* b) { return a->z < b->z; });
    }
    Node* prev = nullptr;
    for (Node* node : arr) {
      node->prevZ = prev;
      if (prev) prev->nextZ = node;
      prev = node;
    }
    if (prev) prev->nextZ = nullptr;
  }

  void earcutLinked(Node* ear, double minX, double minY, double invSize) {
    if (!ear) return;
    if (invSize != 0) indexCurve(ear, minX, minY, invSize);
    Node* stop = ear;
    bool cured = false;
    while (ear->prev != ear->next) {
      Node* prev = ear->prev;
      Node* next = ear->next;
      if (area(prev, ear, next) < 0 && (invSize != 0 ? isEarHashed(ear, minX, minY, invSize) : isEar(ear))) {
        triangles.push_back(prev->i);
        triangles.push_back(ear->i);
        triangles.push_back(next->i);
        removeNode(ear);
        ear = next;
        stop = next;
        continue;
      }
      ear = next;
      if (ear == stop) {
        filteredOut = false;
        ear = filterPoints(ear);
        if (filteredOut) {
          stop = ear;
          continue;
        }
        if (!cured) {
          ear = cureLocalIntersections(ear);
          stop = ear;
          cured = true;
          continue;
        }
        splitEarcut(ear, minX, minY, invSize);
        break;
      }
    }
  }
};

}  // namespace

std::vector<uint32_t> earcut(const std::vector<double>& data) {
  Earcut e;
  const size_t outerLen = data.size() & ~size_t(1);
  if (outerLen < 2) return {};
  Node* outer = e.linkedList(data, 0, outerLen, true);
  if (!outer || outer->next == outer->prev) return {};
  double minX = 0, minY = 0, invSize = 0;
  if (data.size() > 80 * 2) {
    minX = data[0];
    minY = data[1];
    double maxX = minX, maxY = minY;
    for (size_t i = 2; i < outerLen; i += 2) {
      const double x = data[i], y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    invSize = std::max(maxX - minX, maxY - minY);
    invSize = invSize != 0 ? 32767 / invSize : 0;
  }
  e.earcutLinked(outer, minX, minY, invSize);
  return e.triangles;
}

// ---------------- Shapes ----------------

std::vector<double> shapeOutline(const Attachment& s, int segments) {
  std::vector<double> pts;
  const double hw = s.width / 2, hh = s.height / 2;
  if (s.shape == ShapeKind::Rect) {
    const double r = std::min({s.radius, hw, hh});
    if (r <= 0 || std::isnan(r)) pts = {-hw, -hh, hw, -hh, hw, hh, -hw, hh};
    else {
      const double corners[4][3] = {{hw - r, -hh + r, -90}, {hw - r, hh - r, 0}, {-hw + r, hh - r, 90}, {-hw + r, -hh + r, 180}};
      const int seg = std::max(2, (int)std::floor(segments / 4.0 + 0.5));
      for (const auto& c : corners)
        for (int i = 0; i <= seg; i++) {
          const double a = (c[2] + (90.0 * i) / seg) * DEG;
          pts.push_back(c[0] + std::cos(a) * r);
          pts.push_back(c[1] + std::sin(a) * r);
        }
    }
  } else if (s.shape == ShapeKind::Ellipse) {
    for (int i = 0; i < segments; i++) {
      const double a = ((double)i / segments) * PI * 2;
      pts.push_back(std::cos(a) * hw);
      pts.push_back(std::sin(a) * hh);
    }
  } else {
    pts = s.points;
  }
  const double cos = std::cos(s.rotation * DEG), sin = std::sin(s.rotation * DEG);
  for (size_t i = 0; i + 1 < pts.size(); i += 2) {
    const double x = pts[i], y = pts[i + 1];
    pts[i] = s.x + x * cos - y * sin;
    pts[i + 1] = s.y + x * sin + y * cos;
  }
  return pts;
}

// ---------------- Splines ----------------

namespace {
constexpr int STEPS = 32;
inline double bez(double a, double b, double c, double d, double t) {
  const double u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}
inline double bezD(double a, double b, double c, double d, double t) {
  const double u = 1 - t;
  return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
}
}  // namespace

Spline::Spline(const std::vector<float>& v, bool closed_, bool constantSpeed_) : closed(closed_), constantSpeed(constantSpeed_) {
  knots = (int)(v.size() / 6);
  segments = knots < 2 ? 0 : closed ? knots : knots - 1;
  if (knots) {
    v2 = v[2];
    v3 = v[3];
  }
  ctrl.assign(std::max(segments, 1) * 8, 0.0);
  for (int s = 0; s < segments; s++) {
    const int a = s * 6, b = ((s + 1) % knots) * 6;
    const double c[8] = {v[a + 2], v[a + 3], v[a + 4], v[a + 5], v[b], v[b + 1], v[b + 2], v[b + 3]};
    for (int k = 0; k < 8; k++) ctrl[s * 8 + k] = c[k];
  }
  table.assign(segments * STEPS + 1, 0.0);
  double total = 0;
  for (int s = 0; s < segments; s++) {
    const int o = s * 8;
    double px = ctrl[o], py = ctrl[o + 1];
    for (int i = 1; i <= STEPS; i++) {
      const double t = (double)i / STEPS;
      const double x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
      const double y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
      total += jsHypot(x - px, y - py);
      table[s * STEPS + i] = total;
      px = x;
      py = y;
    }
  }
  length = total;
}

PathSample Spline::point(int s, double t) const {
  const int o = s * 8;
  const double* c = ctrl.data() + o;
  const double x = bez(c[0], c[2], c[4], c[6], t), y = bez(c[1], c[3], c[5], c[7], t);
  double dx = bezD(c[0], c[2], c[4], c[6], t), dy = bezD(c[1], c[3], c[5], c[7], t);
  if (dx * dx + dy * dy < 1e-12) {
    const double t0 = std::max(0.0, t - 1e-3), t1 = std::min(1.0, t + 1e-3);
    dx = bez(c[0], c[2], c[4], c[6], t1) - bez(c[0], c[2], c[4], c[6], t0);
    dy = bez(c[1], c[3], c[5], c[7], t1) - bez(c[1], c[3], c[5], c[7], t0);
    if (dx * dx + dy * dy < 1e-18) {
      dx = c[6] - c[0];
      dy = c[7] - c[1];
    }
  }
  return {x, y, std::atan2(dy, dx)};
}

PathSample Spline::sample(double distance) const {
  if (segments == 0) return {knots ? v2 : 0, knots ? v3 : 0, 0};
  double d = distance;
  const double total = length;
  if (closed && total > 0) d = std::fmod(std::fmod(d, total) + total, total);
  else if (d <= 0 || d >= total) {
    const PathSample end = d <= 0 ? point(0, 0) : point(segments - 1, 1);
    const double over = d <= 0 ? d : d - total;
    return {end.x + std::cos(end.angle) * over, end.y + std::sin(end.angle) * over, end.angle};
  }
  if (!constantSpeed) {
    // Segment by arc length (the first whose end is past d), then the raw bezier parameter inside it.
    int seg = 0;
    while (seg < segments - 1 && table[(seg + 1) * STEPS] <= d) seg++;
    const double start = table[seg * STEPS];
    const double span = table[(seg + 1) * STEPS] - start;
    return point(seg, span > 0 ? std::min(1.0, (d - start) / span) : 0);
  }
  size_t lo = 0, hi = table.size() - 1;
  while (hi - lo > 1) {
    const size_t mid = (lo + hi) >> 1;
    if (table[mid] <= d) lo = mid;
    else hi = mid;
  }
  const double span = table[hi] - table[lo];
  const double f = span > 0 ? (d - table[lo]) / span : 0;
  const int seg = std::min(segments - 1, (int)(lo / STEPS));
  const double t = (lo - seg * STEPS + f) / STEPS;
  return point(seg, std::min(1.0, t));
}

}  // namespace openbone
