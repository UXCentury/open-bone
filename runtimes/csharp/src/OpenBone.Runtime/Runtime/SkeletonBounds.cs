using System;
using System.Collections.Generic;

namespace OpenBone
{
    /// <summary>One active bounding box: the world polygon of a slot's current bounding-box attachment.</summary>
    public sealed class BoundingBoxPolygon
    {
        public Slot Slot;
        /// <summary>Attachment name.</summary>
        public string Attachment;
        /// <summary>World x,y pairs (skeleton space, y up: the same coordinates as the draw list), float32 like the reference.</summary>
        public float[] Vertices;
        public double MinX, MinY, MaxX, MaxY;
    }

    /// <summary>
    /// The active bounding boxes of a skeleton for one pose (like Spine's SkeletonBounds; runtime/bounds.ts, spec §8.10):
    /// every slot, in draw order, whose bone is active and whose current attachment is a bounding box with at least three
    /// vertices. Call <see cref="Update"/> after the pose changes (or take a new one with
    /// <see cref="Skeleton.BoundingBoxes"/>). All coordinates are skeleton world space, the draw list's (y up); engine
    /// coordinates (screen pixels, a scene transform) must be converted to skeleton space before querying.
    /// When nothing is active the overall box is all zeros and every query returns nothing.
    /// </summary>
    public sealed class SkeletonBounds
    {
        public List<BoundingBoxPolygon> Boxes { get; private set; } = new List<BoundingBoxPolygon>();
        public double MinX { get; private set; }
        public double MinY { get; private set; }
        public double MaxX { get; private set; }
        public double MaxY { get; private set; }

        public SkeletonBounds() { }

        public SkeletonBounds(Skeleton skeleton)
        {
            if (skeleton != null) Update(skeleton);
        }

        /// <summary>Recompute the polygons from the skeleton's current world pose.</summary>
        public SkeletonBounds Update(Skeleton skeleton)
        {
            var boxes = new List<BoundingBoxPolygon>();
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity, maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
            foreach (var slot in skeleton.DrawOrder)
            {
                if (!slot.Bone.Active) continue;
                if (!(skeleton.GetAttachment(slot) is BoundingBoxAttachment att) || att.Vertices.Length < 6) continue;
                var v = skeleton.AttachmentWorldVertices(slot, att);
                var box = new BoundingBoxPolygon
                {
                    Slot = slot,
                    Attachment = att.Name,
                    Vertices = v,
                    MinX = double.PositiveInfinity,
                    MinY = double.PositiveInfinity,
                    MaxX = double.NegativeInfinity,
                    MaxY = double.NegativeInfinity,
                };
                for (int i = 0; i + 1 < v.Length; i += 2)
                {
                    box.MinX = Math.Min(box.MinX, v[i]);
                    box.MinY = Math.Min(box.MinY, v[i + 1]);
                    box.MaxX = Math.Max(box.MaxX, v[i]);
                    box.MaxY = Math.Max(box.MaxY, v[i + 1]);
                }
                minX = Math.Min(minX, box.MinX);
                minY = Math.Min(minY, box.MinY);
                maxX = Math.Max(maxX, box.MaxX);
                maxY = Math.Max(maxY, box.MaxY);
                boxes.Add(box);
            }
            if (boxes.Count == 0) minX = minY = maxX = maxY = 0;
            Boxes = boxes;
            MinX = minX;
            MinY = minY;
            MaxX = maxX;
            MaxY = maxY;
            return this;
        }

        /// <summary>True if the point is inside the overall AABB (edges included).</summary>
        public bool AabbContainsPoint(double x, double y) =>
            Boxes.Count > 0 && x >= MinX && x <= MaxX && y >= MinY && y <= MaxY;

        /// <summary>True if the overall AABB overlaps the given rectangle (edges included).</summary>
        public bool AabbIntersects(double minX, double minY, double maxX, double maxY) =>
            Boxes.Count > 0 && minX <= MaxX && maxX >= MinX && minY <= MaxY && maxY >= MinY;

        /// <summary>The first box (in draw order) containing the point, or null. The last match is the one drawn on top.</summary>
        public BoundingBoxPolygon ContainsPoint(double x, double y)
        {
            foreach (var b in Boxes) if (BoxContains(b, x, y)) return b;
            return null;
        }

        /// <summary>Every box containing the point, in draw order.</summary>
        public List<BoundingBoxPolygon> ContainsPointAll(double x, double y)
        {
            var r = new List<BoundingBoxPolygon>();
            foreach (var b in Boxes) if (BoxContains(b, x, y)) r.Add(b);
            return r;
        }

        /// <summary>The first box (in draw order) the segment touches: it crosses an edge or starts inside. Null if none.</summary>
        public BoundingBoxPolygon IntersectsSegment(double x1, double y1, double x2, double y2)
        {
            foreach (var b in Boxes) if (BoxSegment(b, x1, y1, x2, y2)) return b;
            return null;
        }

        /// <summary>Every box the segment touches, in draw order.</summary>
        public List<BoundingBoxPolygon> IntersectsSegmentAll(double x1, double y1, double x2, double y2)
        {
            var r = new List<BoundingBoxPolygon>();
            foreach (var b in Boxes) if (BoxSegment(b, x1, y1, x2, y2)) r.Add(b);
            return r;
        }

        /// <summary>
        /// The first overlapping pair of polygons between these boxes and another skeleton's: (mine, theirs), scanning
        /// mine in draw order and theirs in draw order for each. Polygons overlap when edges cross or one holds the first
        /// vertex of the other. Null if none overlap.
        /// </summary>
        public (BoundingBoxPolygon Mine, BoundingBoxPolygon Theirs)? IntersectsBounds(SkeletonBounds other)
        {
            if (other == null || !AabbIntersects(other.MinX, other.MinY, other.MaxX, other.MaxY)) return null;
            foreach (var a in Boxes)
                foreach (var b in other.Boxes)
                    if (PolygonsOverlap(a, b)) return (a, b);
            return null;
        }

        static bool BoxContains(BoundingBoxPolygon b, double x, double y) =>
            x >= b.MinX && x <= b.MaxX && y >= b.MinY && y <= b.MaxY && MathUtil.PointInPolygon(x, y, b.Vertices);

        /// <summary>Closed segments p1-p2 and p3-p4 cross or touch (parallel ones never count).</summary>
        public static bool SegmentsIntersect(double x1, double y1, double x2, double y2, double x3, double y3, double x4, double y4)
        {
            double d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
            if (d == 0) return false;
            double ua = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
            double ub = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
            return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
        }

        static bool EdgeCrosses(float[] v, double x1, double y1, double x2, double y2)
        {
            int n = v.Length;
            for (int i = 0, j = n - 2; i < n; j = i, i += 2)
                if (SegmentsIntersect(x1, y1, x2, y2, v[j], v[j + 1], v[i], v[i + 1])) return true;
            return false;
        }

        static bool BoxSegment(BoundingBoxPolygon b, double x1, double y1, double x2, double y2)
        {
            if (Math.Max(x1, x2) < b.MinX || Math.Min(x1, x2) > b.MaxX || Math.Max(y1, y2) < b.MinY || Math.Min(y1, y2) > b.MaxY) return false;
            return EdgeCrosses(b.Vertices, x1, y1, x2, y2) || MathUtil.PointInPolygon(x1, y1, b.Vertices);
        }

        static bool PolygonsOverlap(BoundingBoxPolygon a, BoundingBoxPolygon b)
        {
            if (a.MaxX < b.MinX || a.MinX > b.MaxX || a.MaxY < b.MinY || a.MinY > b.MaxY) return false;
            var v = a.Vertices;
            int n = v.Length;
            for (int i = 0, j = n - 2; i < n; j = i, i += 2)
                if (EdgeCrosses(b.Vertices, v[j], v[j + 1], v[i], v[i + 1])) return true;
            return MathUtil.PointInPolygon(v[0], v[1], b.Vertices) || MathUtil.PointInPolygon(b.Vertices[0], b.Vertices[1], v);
        }
    }
}
