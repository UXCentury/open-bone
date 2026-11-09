using System;
using System.Globalization;

namespace OpenBone
{
    /// <summary>2×3 affine matrix, column vectors: world·(x,y) = (a·x + b·y + x0, c·x + d·y + y0). Mutable (like the reference).</summary>
    public sealed class Affine
    {
        public double A = 1, B, C, D = 1, X, Y;
        public Affine() { }
        public Affine(double a, double b, double c, double d, double x, double y) { A = a; B = b; C = c; D = d; X = x; Y = y; }
        public static Affine Identity() => new Affine();
        public Affine Clone() => new Affine(A, B, C, D, X, Y);
        public void Apply(double x, double y, out double ox, out double oy)
        {
            ox = A * x + B * y + X;
            oy = C * x + D * y + Y;
        }
        public override string ToString() => $"[{A}, {B}, {C}, {D}, {X}, {Y}]";
    }

    public sealed class LocalTransform
    {
        public double X, Y, Rotation, ScaleX = 1, ScaleY = 1, ShearX, ShearY;
        public LocalTransform Clone() => (LocalTransform)MemberwiseClone();
        public void CopyFrom(LocalTransform o)
        {
            X = o.X; Y = o.Y; Rotation = o.Rotation; ScaleX = o.ScaleX; ScaleY = o.ScaleY; ShearX = o.ShearX; ShearY = o.ShearY;
        }
    }

    /// <summary>core/math.ts</summary>
    public static class MathUtil
    {
        public const double DEG = Math.PI / 180;
        public const double RAD = 180 / Math.PI;

        public static Affine Multiply(Affine p, Affine l) => new Affine(
            p.A * l.A + p.B * l.C,
            p.A * l.B + p.B * l.D,
            p.C * l.A + p.D * l.C,
            p.C * l.B + p.D * l.D,
            p.A * l.X + p.B * l.Y + p.X,
            p.C * l.X + p.D * l.Y + p.Y);

        public static Affine Invert(Affine m)
        {
            double det = m.A * m.D - m.B * m.C;
            if (det == 0 || double.IsNaN(det)) det = 1e-9;
            double ia = m.D / det, ib = -m.B / det, ic = -m.C / det, id = m.A / det;
            return new Affine(ia, ib, ic, id, -(ia * m.X + ib * m.Y), -(ic * m.X + id * m.Y));
        }

        public static Affine LocalMatrix(double x, double y, double rotation, double scaleX, double scaleY, double shearX, double shearY)
        {
            double rx = (rotation + shearX) * DEG;
            double ry = (rotation + 90 + shearY) * DEG;
            return new Affine(Math.Cos(rx) * scaleX, Math.Cos(ry) * scaleY, Math.Sin(rx) * scaleX, Math.Sin(ry) * scaleY, x, y);
        }

        public static Affine LocalMatrix(LocalTransform t) => LocalMatrix(t.X, t.Y, t.Rotation, t.ScaleX, t.ScaleY, t.ShearX, t.ShearY);

        /// <summary>World matrix of a bone from its parent's world matrix and inherit mode (null parent ⇒ the local matrix).</summary>
        public static Affine BoneWorld(Affine parent, LocalTransform local, string inherit)
        {
            var l = LocalMatrix(local);
            if (parent == null) return l;
            parent.Apply(local.X, local.Y, out var wx, out var wy);
            switch (inherit)
            {
                case "onlyTranslation":
                    l.X = wx; l.Y = wy;
                    return l;
                case "noRotation":
                    {
                        double sx = Js.Hypot(parent.A, parent.C), sy = Js.Hypot(parent.B, parent.D);
                        return new Affine(l.A * sx, l.B * sy, l.C * sx, l.D * sy, wx, wy);
                    }
                case "noScale":
                    {
                        double sx = Js.Hypot(parent.A, parent.C), sy = Js.Hypot(parent.B, parent.D);
                        if (sx == 0 || double.IsNaN(sx)) sx = 1;
                        if (sy == 0 || double.IsNaN(sy)) sy = 1;
                        var p = new Affine(parent.A / sx, parent.B / sy, parent.C / sx, parent.D / sy, 0, 0);
                        var m = Multiply(p, l);
                        m.X = wx; m.Y = wy;
                        return m;
                    }
                case "normal":
                    return Multiply(parent, l);
                default:
                    // Unknown modes: the reference's switch falls through and returns undefined; treat as normal.
                    return Multiply(parent, l);
            }
        }

        /// <summary>Local transform that puts a child at <paramref name="childWorld"/> under <paramref name="parentWorld"/> (shear X kept).</summary>
        public static LocalTransform LocalFromWorld(Affine parentWorld, Affine childWorld, string inherit, LocalTransform keep)
        {
            var inv = Invert(parentWorld);
            inv.Apply(childWorld.X, childWorld.Y, out var x, out var y);
            if (inherit != "normal")
            {
                var r = keep.Clone();
                r.X = x; r.Y = y;
                return r;
            }
            var m = Multiply(inv, childWorld);
            double rotation = Math.Atan2(m.C, m.A) * RAD - keep.ShearX;
            double scaleX = Js.Hypot(m.A, m.C);
            double scaleY = Js.Hypot(m.B, m.D);
            double shearY = WrapDeg(Math.Atan2(m.D, m.B) * RAD - 90 - rotation);
            return new LocalTransform { X = x, Y = y, Rotation = WrapDeg(rotation), ScaleX = scaleX, ScaleY = scaleY, ShearX = keep.ShearX, ShearY = shearY };
        }

        public static double WorldRotation(Affine m) => Math.Atan2(m.C, m.A) * RAD;
        public static double WorldScaleX(Affine m) => Js.Hypot(m.A, m.C);
        public static double WorldScaleY(Affine m) => Js.Hypot(m.B, m.D);

        /// <summary>Wrap degrees into (−180, 180].</summary>
        public static double WrapDeg(double d)
        {
            d %= 360;
            if (d > 180) d -= 360;
            else if (d <= -180) d += 360;
            return d;
        }

        public static double Lerp(double a, double b, double t) => a + (b - a) * t;
        public static double LerpAngle(double a, double b, double t) => a + WrapDeg(b - a) * t;
        public static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;

        /// <summary>Eased fraction for a key curve; bezier solved by bisection only (first probe s = t, 24 iterations).</summary>
        public static double EvalCurve(Curve curve, double t)
        {
            if (curve == null || curve.Kind == CurveKind.Linear) return t;
            if (curve.Kind == CurveKind.Stepped) return 0;
            double x1 = curve.X1, y1 = curve.Y1, x2 = curve.X2, y2 = curve.Y2;
            double lo = 0, hi = 1, s = t;
            for (int i = 0; i < 24; i++)
            {
                double x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s - t;
                if (Math.Abs(x) < 1e-6) break;
                if (x > 0) hi = s; else lo = s;
                s = (lo + hi) / 2;
            }
            return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
        }

        // ---------------- Colours ----------------

        /// <summary>parseHex: "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" ⇒ RGBA doubles (not premultiplied, never clamped).</summary>
        public static double[] ParseHex(string hex)
        {
            if (hex == null) hex = "null"; // String(null) like the reference would see
            int hashAt = hex.IndexOf('#');
            string h = hashAt >= 0 ? hex.Remove(hashAt, 1) : hex;
            if (h.Length == 3 || h.Length == 4)
            {
                var sb = new System.Text.StringBuilder(h.Length * 2);
                foreach (char c in h) sb.Append(c).Append(c);
                h = sb.ToString();
            }
            return new[] { HexPair(h, 0), HexPair(h, 2), HexPair(h, 4), h.Length >= 8 ? HexPair(h, 6) : 1 };
        }

        /// <summary>parseInt(h.slice(i, i+2), 16) / 255 with parseInt's prefix semantics (NaN when no hex digit).</summary>
        static double HexPair(string h, int i)
        {
            if (i >= h.Length) return double.NaN;
            string s = h.Substring(i, Math.Min(2, h.Length - i));
            int v = 0, n = 0;
            foreach (char c in s)
            {
                int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
                if (d < 0) break;
                v = v * 16 + d;
                n++;
            }
            return n == 0 ? double.NaN : v / 255.0;
        }

        public static double[] LerpColor(double[] a, double[] b, double t) =>
            new[] { Lerp(a[0], b[0], t), Lerp(a[1], b[1], t), Lerp(a[2], b[2], t), Lerp(a[3], b[3], t) };

        public static double[] MulColor(double[] a, double[] b) => new[] { a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3] };

        /// <summary>Even-odd point in polygon (flat x,y).</summary>
        public static bool PointInPolygon(double px, double py, float[] poly)
        {
            bool inside = false;
            int n = poly.Length / 2;
            for (int i = 0, j = n - 1; i < n; j = i++)
            {
                double xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
                if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        }

        internal static string F(double v) => v.ToString("R", CultureInfo.InvariantCulture);
    }
}
