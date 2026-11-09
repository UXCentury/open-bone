using System;
using System.Collections.Generic;

namespace OpenBone
{
    /// <summary>
    /// Port of mapbox earcut 3.x (ISC licence, https://github.com/mapbox/earcut) for polygons without holes, which is
    /// all OpenBone triangulates (shape outlines, clipping masks). Indices must match the JavaScript library exactly.
    /// </summary>
    public static class Earcut
    {
        sealed class Node
        {
            public int I;
            public double X, Y;
            public Node Prev, Next, PrevZ, NextZ;
            public int Z;
        }

        [ThreadStatic] static bool _filteredOut;

        public static List<int> Triangulate(IReadOnlyList<double> data)
        {
            var triangles = new List<int>();
            int outerLen = data.Count;
            var outerNode = LinkedList(data, 0, outerLen, true);
            if (outerNode == null || outerNode.Next == outerNode.Prev) return triangles;
            double minX = 0, minY = 0, invSize = 0;
            if (data.Count > 80 * 2)
            {
                minX = data[0];
                minY = data[1];
                double maxX = minX, maxY = minY;
                for (int i = 2; i < outerLen; i += 2)
                {
                    double x = data[i], y = data[i + 1];
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
                invSize = Math.Max(maxX - minX, maxY - minY);
                invSize = invSize != 0 ? 32767 / invSize : 0;
            }
            EarcutLinked(outerNode, triangles, minX, minY, invSize);
            return triangles;
        }

        static Node LinkedList(IReadOnlyList<double> data, int start, int end, bool clockwise)
        {
            Node last = null;
            if (clockwise == (SignedArea(data, start, end) > 0))
            {
                for (int i = start; i < end; i += 2) last = InsertNode(i / 2, data[i], data[i + 1], last);
            }
            else
            {
                for (int i = end - 2; i >= start; i -= 2) last = InsertNode(i / 2, data[i], data[i + 1], last);
            }
            if (last != null && EqualsN(last, last.Next))
            {
                RemoveNode(last);
                last = last.Next;
            }
            return last;
        }

        static Node FilterPoints(Node start, Node end = null)
        {
            if (end == null) end = start;
            bool full = end == start;
            Node p = start;
            bool again;
            do
            {
                again = false;
                if (p != p.Next && (EqualsN(p, p.Next) || Area(p.Prev, p, p.Next) == 0))
                {
                    if (full || p == end) end = p.Prev;
                    _filteredOut = true;
                    RemoveNode(p);
                    p = p.Prev;
                    again = true;
                }
                else if (full || p != end)
                {
                    p = p.Next;
                    again = !full;
                }
            } while (again || p != end);
            return end;
        }

        static void EarcutLinked(Node ear, List<int> triangles, double minX, double minY, double invSize)
        {
            if (invSize != 0) IndexCurve(ear, minX, minY, invSize);
            Node stop = ear;
            bool cured = false;
            while (ear.Prev != ear.Next)
            {
                Node prev = ear.Prev, next = ear.Next;
                if (Area(prev, ear, next) < 0 && (invSize != 0 ? IsEarHashed(ear, minX, minY, invSize) : IsEar(ear)))
                {
                    triangles.Add(prev.I);
                    triangles.Add(ear.I);
                    triangles.Add(next.I);
                    RemoveNode(ear);
                    ear = next;
                    stop = next;
                    continue;
                }
                ear = next;
                if (ear == stop)
                {
                    _filteredOut = false;
                    ear = FilterPoints(ear);
                    if (_filteredOut) { stop = ear; continue; }
                    if (!cured)
                    {
                        ear = CureLocalIntersections(ear, triangles);
                        stop = ear;
                        cured = true;
                        continue;
                    }
                    SplitEarcut(ear, triangles, minX, minY, invSize);
                    break;
                }
            }
        }

        static bool IsEar(Node ear)
        {
            Node a = ear.Prev, b = ear, c = ear.Next;
            double ax = a.X, bx = b.X, cx = c.X, ay = a.Y, by = b.Y, cy = c.Y;
            double x0 = Math.Min(ax, Math.Min(bx, cx)), y0 = Math.Min(ay, Math.Min(by, cy));
            double x1 = Math.Max(ax, Math.Max(bx, cx)), y1 = Math.Max(ay, Math.Max(by, cy));
            Node p = c.Next;
            while (p != a)
            {
                if (p.X >= x0 && p.X <= x1 && p.Y >= y0 && p.Y <= y1 && !(ax == p.X && ay == p.Y) &&
                    PointInTriangle(ax, ay, bx, by, cx, cy, p.X, p.Y) && Area(p.Prev, p, p.Next) >= 0) return false;
                p = p.Next;
            }
            return true;
        }

        static bool IsEarHashed(Node ear, double minX, double minY, double invSize)
        {
            Node a = ear.Prev, b = ear, c = ear.Next;
            double ax = a.X, bx = b.X, cx = c.X, ay = a.Y, by = b.Y, cy = c.Y;
            double x0 = Math.Min(ax, Math.Min(bx, cx)), y0 = Math.Min(ay, Math.Min(by, cy));
            double x1 = Math.Max(ax, Math.Max(bx, cx)), y1 = Math.Max(ay, Math.Max(by, cy));
            int minZ = ZOrder(x0, y0, minX, minY, invSize), maxZ = ZOrder(x1, y1, minX, minY, invSize);
            Node p = ear.PrevZ;
            while (p != null && p.Z >= minZ)
            {
                if (p.X >= x0 && p.X <= x1 && p.Y >= y0 && p.Y <= y1 && p != c && !(ax == p.X && ay == p.Y) &&
                    PointInTriangle(ax, ay, bx, by, cx, cy, p.X, p.Y) && Area(p.Prev, p, p.Next) >= 0) return false;
                p = p.PrevZ;
            }
            Node n = ear.NextZ;
            while (n != null && n.Z <= maxZ)
            {
                if (n.X >= x0 && n.X <= x1 && n.Y >= y0 && n.Y <= y1 && n != c && !(ax == n.X && ay == n.Y) &&
                    PointInTriangle(ax, ay, bx, by, cx, cy, n.X, n.Y) && Area(n.Prev, n, n.Next) >= 0) return false;
                n = n.NextZ;
            }
            return true;
        }

        static Node CureLocalIntersections(Node start, List<int> triangles)
        {
            Node p = start;
            bool cured = false;
            do
            {
                Node a = p.Prev, b = p.Next.Next;
                if (Intersects(a, p, p.Next, b, false) && LocallyInside(a, b) && LocallyInside(b, a))
                {
                    triangles.Add(a.I);
                    triangles.Add(p.I);
                    triangles.Add(b.I);
                    RemoveNode(p);
                    RemoveNode(p.Next);
                    p = start = b;
                    cured = true;
                }
                p = p.Next;
            } while (p != start);
            return cured ? FilterPoints(p) : p;
        }

        static void SplitEarcut(Node start, List<int> triangles, double minX, double minY, double invSize)
        {
            Node a = start;
            do
            {
                Node b = a.Next.Next;
                while (b != a.Prev)
                {
                    if (a.I != b.I && IsValidDiagonal(a, b))
                    {
                        Node c = SplitPolygon(a, b);
                        a = FilterPoints(a, a.Next);
                        c = FilterPoints(c, c.Next);
                        EarcutLinked(a, triangles, minX, minY, invSize);
                        EarcutLinked(c, triangles, minX, minY, invSize);
                        return;
                    }
                    b = b.Next;
                }
                a = a.Next;
            } while (a != start);
        }

        static void IndexCurve(Node start, double minX, double minY, double invSize)
        {
            var list = new List<Node>();
            Node p = start;
            do
            {
                p.Z = ZOrder(p.X, p.Y, minX, minY, invSize);
                list.Add(p);
                p = p.Next;
            } while (p != start);
            // Stable sort by z (the library's insertion/radix sorts are both stable).
            var sorted = new List<Node>(list.Count);
            for (int i = 0; i < list.Count; i++) sorted.Add(list[i]);
            MergeSort(sorted);
            Node prev = null;
            foreach (var node in sorted)
            {
                node.PrevZ = prev;
                if (prev != null) prev.NextZ = node;
                prev = node;
            }
            prev.NextZ = null;
        }

        static void MergeSort(List<Node> a)
        {
            var arr = a.ToArray();
            var tmp = new Node[arr.Length];
            for (int width = 1; width < arr.Length; width *= 2)
            {
                for (int lo = 0; lo < arr.Length; lo += 2 * width)
                {
                    int mid = Math.Min(lo + width, arr.Length), hi = Math.Min(lo + 2 * width, arr.Length);
                    int i = lo, j = mid, k = lo;
                    while (i < mid && j < hi) tmp[k++] = arr[j].Z < arr[i].Z ? arr[j++] : arr[i++];
                    while (i < mid) tmp[k++] = arr[i++];
                    while (j < hi) tmp[k++] = arr[j++];
                }
                var t = arr; arr = tmp; tmp = t;
            }
            for (int i = 0; i < arr.Length; i++) a[i] = arr[i];
        }

        static int ZOrder(double fx, double fy, double minX, double minY, double invSize)
        {
            int x = Js.ToInt32((fx - minX) * invSize);
            int y = Js.ToInt32((fy - minY) * invSize);
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

        static bool PointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) =>
            (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
            (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
            (bx - px) * (cy - py) >= (cx - px) * (by - py);

        static bool IsValidDiagonal(Node a, Node b)
        {
            bool zeroLength = EqualsN(a, b) && Area(a.Prev, a, a.Next) > 0 && Area(b.Prev, b, b.Next) > 0;
            return a.Next.I != b.I && (zeroLength || LocallyInside(a, b) && LocallyInside(b, a) &&
                (Area(a.Prev, a, b.Prev) != 0 || Area(a, b.Prev, b) != 0)) &&
                !IntersectsPolygon(a, b) && (zeroLength || MiddleInside(a, b));
        }

        static double Area(Node p, Node q, Node r) => (q.Y - p.Y) * (r.X - q.X) - (q.X - p.X) * (r.Y - q.Y);

        static bool EqualsN(Node p1, Node p2) => p1.X == p2.X && p1.Y == p2.Y;

        static bool Intersects(Node p1, Node q1, Node p2, Node q2, bool includeBoundary = true)
        {
            double o1 = Area(p1, q1, p2), o2 = Area(p1, q1, q2), o3 = Area(p2, q2, p1), o4 = Area(p2, q2, q1);
            if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
            if (!includeBoundary) return false;
            if (o1 == 0 && OnSegment(p1, p2, q1)) return true;
            if (o2 == 0 && OnSegment(p1, q2, q1)) return true;
            if (o3 == 0 && OnSegment(p2, p1, q2)) return true;
            if (o4 == 0 && OnSegment(p2, q1, q2)) return true;
            return false;
        }

        static bool OnSegment(Node p, Node q, Node r) =>
            q.X <= Math.Max(p.X, r.X) && q.X >= Math.Min(p.X, r.X) && q.Y <= Math.Max(p.Y, r.Y) && q.Y >= Math.Min(p.Y, r.Y);

        static bool IntersectsPolygon(Node a, Node b)
        {
            double minX = Math.Min(a.X, b.X), maxX = Math.Max(a.X, b.X), minY = Math.Min(a.Y, b.Y), maxY = Math.Max(a.Y, b.Y);
            Node p = a;
            do
            {
                Node n = p.Next;
                if ((p.X > maxX && n.X > maxX) || (p.X < minX && n.X < minX) || (p.Y > maxY && n.Y > maxY) || (p.Y < minY && n.Y < minY))
                {
                    p = n;
                    continue;
                }
                if (p.I != a.I && n.I != a.I && p.I != b.I && n.I != b.I && Intersects(p, n, a, b)) return true;
                p = n;
            } while (p != a);
            return false;
        }

        static bool LocallyInside(Node a, Node b) =>
            Area(a.Prev, a, a.Next) < 0
                ? Area(a, b, a.Next) >= 0 && Area(a, a.Prev, b) >= 0
                : Area(a, b, a.Prev) < 0 || Area(a, a.Next, b) < 0;

        static bool MiddleInside(Node a, Node b)
        {
            Node p = a;
            bool inside = false;
            double px = (a.X + b.X) / 2, py = (a.Y + b.Y) / 2;
            do
            {
                Node n = p.Next;
                if (((p.Y > py) != (n.Y > py)) && (px < (n.X - p.X) * (py - p.Y) / (n.Y - p.Y) + p.X)) inside = !inside;
                p = n;
            } while (p != a);
            return inside;
        }

        static Node SplitPolygon(Node a, Node b)
        {
            Node a2 = new Node { I = a.I, X = a.X, Y = a.Y }, b2 = new Node { I = b.I, X = b.X, Y = b.Y };
            Node an = a.Next, bp = b.Prev;
            a.Next = b; b.Prev = a;
            a2.Next = an; an.Prev = a2;
            b2.Next = a2; a2.Prev = b2;
            bp.Next = b2; b2.Prev = bp;
            return b2;
        }

        static Node InsertNode(int i, double x, double y, Node last)
        {
            var p = new Node { I = i, X = x, Y = y };
            if (last == null)
            {
                p.Prev = p;
                p.Next = p;
            }
            else
            {
                p.Next = last.Next;
                p.Prev = last;
                last.Next.Prev = p;
                last.Next = p;
            }
            return p;
        }

        static void RemoveNode(Node p)
        {
            p.Next.Prev = p.Prev;
            p.Prev.Next = p.Next;
            if (p.PrevZ != null) p.PrevZ.NextZ = p.NextZ;
            if (p.NextZ != null) p.NextZ.PrevZ = p.PrevZ;
        }

        static double SignedArea(IReadOnlyList<double> data, int start, int end)
        {
            double sum = 0;
            for (int i = start, j = end - 2; i < end; i += 2)
            {
                sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
                j = i;
            }
            return sum;
        }
    }
}
