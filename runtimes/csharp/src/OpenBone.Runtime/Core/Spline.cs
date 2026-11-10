using System;

namespace OpenBone
{
    public struct PathSample
    {
        public double X, Y;
        /// <summary>Tangent direction in radians.</summary>
        public double Angle;
    }

    /// <summary>
    /// Cubic bezier spline of a path attachment, sampled by arc length (core/path.ts:buildSpline). Without constant
    /// speed only the segment is found by arc length; the point inside it is at the raw bezier parameter.
    /// </summary>
    public sealed class Spline
    {
        const int Steps = 32;
        readonly double[] _ctrl;
        readonly double[] _table;
        readonly int _knots;
        readonly double _firstX, _firstY;
        public bool Closed { get; }
        public double Length { get; }
        public int Segments { get; }

        /// <summary>True: points inside a segment are placed by arc length; false: by the raw bezier parameter.</summary>
        public bool ConstantSpeed { get; }

        public Spline(float[] v, bool closed, bool constantSpeed = true) : this(ToDoubles(v), closed, constantSpeed) { }

        static double[] ToDoubles(float[] v)
        {
            var d = new double[v.Length];
            for (int i = 0; i < v.Length; i++) d[i] = v[i];
            return d;
        }

        public Spline(double[] vertices, bool closed, bool constantSpeed = true)
        {
            Closed = closed;
            ConstantSpeed = constantSpeed;
            _knots = vertices.Length / 6;
            int segCount = _knots < 2 ? 0 : closed ? _knots : _knots - 1;
            Segments = segCount;
            _firstX = _knots > 0 ? vertices[2] : 0;
            _firstY = _knots > 0 ? vertices[3] : 0;
            _ctrl = new double[Math.Max(segCount, 1) * 8];
            for (int s = 0; s < segCount; s++)
            {
                int a = s * 6, b = ((s + 1) % _knots) * 6, o = s * 8;
                _ctrl[o] = vertices[a + 2]; _ctrl[o + 1] = vertices[a + 3];
                _ctrl[o + 2] = vertices[a + 4]; _ctrl[o + 3] = vertices[a + 5];
                _ctrl[o + 4] = vertices[b]; _ctrl[o + 5] = vertices[b + 1];
                _ctrl[o + 6] = vertices[b + 2]; _ctrl[o + 7] = vertices[b + 3];
            }
            _table = new double[segCount * Steps + 1];
            double total = 0;
            for (int s = 0; s < segCount; s++)
            {
                int o = s * 8;
                double px = _ctrl[o], py = _ctrl[o + 1];
                for (int i = 1; i <= Steps; i++)
                {
                    double t = (double)i / Steps;
                    double x = Bez(_ctrl[o], _ctrl[o + 2], _ctrl[o + 4], _ctrl[o + 6], t);
                    double y = Bez(_ctrl[o + 1], _ctrl[o + 3], _ctrl[o + 5], _ctrl[o + 7], t);
                    total += Js.Hypot(x - px, y - py);
                    _table[s * Steps + i] = total;
                    px = x;
                    py = y;
                }
            }
            Length = total;
        }

        static double Bez(double a, double b, double c, double d, double t)
        {
            double u = 1 - t;
            return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
        }

        static double BezD(double a, double b, double c, double d, double t)
        {
            double u = 1 - t;
            return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
        }

        PathSample Point(int s, double t)
        {
            int o = s * 8;
            var c = _ctrl;
            double x = Bez(c[o], c[o + 2], c[o + 4], c[o + 6], t);
            double y = Bez(c[o + 1], c[o + 3], c[o + 5], c[o + 7], t);
            double dx = BezD(c[o], c[o + 2], c[o + 4], c[o + 6], t);
            double dy = BezD(c[o + 1], c[o + 3], c[o + 5], c[o + 7], t);
            if (dx * dx + dy * dy < 1e-12)
            {
                double t0 = Math.Max(0, t - 1e-3), t1 = Math.Min(1, t + 1e-3);
                dx = Bez(c[o], c[o + 2], c[o + 4], c[o + 6], t1) - Bez(c[o], c[o + 2], c[o + 4], c[o + 6], t0);
                dy = Bez(c[o + 1], c[o + 3], c[o + 5], c[o + 7], t1) - Bez(c[o + 1], c[o + 3], c[o + 5], c[o + 7], t0);
                if (dx * dx + dy * dy < 1e-18)
                {
                    dx = c[o + 6] - c[o];
                    dy = c[o + 7] - c[o + 1];
                }
            }
            return new PathSample { X = x, Y = y, Angle = Math.Atan2(dy, dx) };
        }

        /// <summary>Point and tangent at an arc-length distance (open paths extend straight past their ends; closed ones wrap).</summary>
        public PathSample Sample(double distance)
        {
            if (Segments == 0) return new PathSample { X = _firstX, Y = _firstY, Angle = 0 };
            double total = Length;
            double d = distance;
            if (Closed && total > 0) d = ((d % total) + total) % total;
            else if (d <= 0 || d >= total)
            {
                var end = d <= 0 ? Point(0, 0) : Point(Segments - 1, 1);
                double over = d <= 0 ? d : d - total;
                return new PathSample { X = end.X + Math.Cos(end.Angle) * over, Y = end.Y + Math.Sin(end.Angle) * over, Angle = end.Angle };
            }
            if (!ConstantSpeed)
            {
                // Segment by arc length (the first whose end is past d), then the raw parameter inside it.
                int sg = 0;
                while (sg < Segments - 1 && _table[(sg + 1) * Steps] <= d) sg++;
                double start = _table[sg * Steps];
                double len = _table[(sg + 1) * Steps] - start;
                return Point(sg, len > 0 ? Math.Min(1, (d - start) / len) : 0);
            }
            int lo = 0, hi = _table.Length - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (_table[mid] <= d) lo = mid; else hi = mid;
            }
            double span = _table[hi] - _table[lo];
            double f = span > 0 ? (d - _table[lo]) / span : 0;
            int seg = Math.Min(Segments - 1, lo / Steps);
            double tt = (lo - seg * Steps + f) / Steps;
            return Point(seg, Math.Min(1, tt));
        }
    }
}
