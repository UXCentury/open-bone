using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenBone
{
    /// <summary>core/geometry.ts</summary>
    public static class Geometry
    {
        /// <summary>Outline polygon (flat x,y) of a shape attachment in slot-bone space.</summary>
        public static List<double> ShapeOutline(ShapeAttachment s, int segments = 32)
        {
            var pts = new List<double>();
            double hw = s.Width / 2, hh = s.Height / 2;
            if (s.Shape == "rect")
            {
                double r = Math.Min(s.Radius, Math.Min(hw, hh));
                if (r <= 0) pts.AddRange(new[] { -hw, -hh, hw, -hh, hw, hh, -hw, hh });
                else
                {
                    var corners = new[] { new[] { hw - r, -hh + r, -90 }, new[] { hw - r, hh - r, 0 }, new[] { -hw + r, hh - r, 90 }, new[] { -hw + r, -hh + r, 180 } };
                    int seg = (int)Math.Max(2, Js.Round(segments / 4.0));
                    foreach (var c in corners)
                        for (int i = 0; i <= seg; i++)
                        {
                            double a = (c[2] + 90.0 * i / seg) * MathUtil.DEG;
                            pts.Add(c[0] + Math.Cos(a) * r);
                            pts.Add(c[1] + Math.Sin(a) * r);
                        }
                }
            }
            else if (s.Shape == "ellipse")
            {
                for (int i = 0; i < segments; i++)
                {
                    double a = (double)i / segments * Math.PI * 2;
                    pts.Add(Math.Cos(a) * hw);
                    pts.Add(Math.Sin(a) * hh);
                }
            }
            else if (s.Points != null) pts.AddRange(s.Points);
            double cos = Math.Cos(s.Rotation * MathUtil.DEG), sin = Math.Sin(s.Rotation * MathUtil.DEG);
            for (int i = 0; i + 1 < pts.Count; i += 2)
            {
                double x = pts[i], y = pts[i + 1];
                pts[i] = s.X + x * cos - y * sin;
                pts[i + 1] = s.Y + x * sin + y * cos;
            }
            return pts;
        }
    }

    /// <summary>core/sequence.ts (frame selection and layout).</summary>
    public static class Sequences
    {
        /// <summary>Frame index for a counter, -1 = nothing shown.</summary>
        public static int FrameIndex(int count, string mode, double counter)
        {
            if (count <= 0 || double.IsNaN(counter) || double.IsInfinity(counter)) return count > 0 ? 0 : -1;
            double f = Math.Floor(counter);
            switch (mode)
            {
                case "loop": return (int)(((f % count) + count) % count);
                case "once": return f < 0 ? 0 : f >= count ? -1 : (int)f;
                case "holdLast": return (int)Math.Min(Math.Max(f, 0), count - 1);
                case "pingPong":
                    {
                        if (count == 1) return 0;
                        double period = 2 * count - 2;
                        double k = ((f % period) + period) % period;
                        return (int)(k < count ? k : period - k);
                    }
                default: return -1; // the reference's switch returns undefined ⇒ no frame
            }
        }

        public static double Counter(double fps, double offset, double time) => Math.Floor(time * fps + 1e-6) + offset;

        /// <summary>uv = frame rect in 0..1 image space; quad = the part of the attachment quad it covers (y-down fractions).</summary>
        public static void FrameLayout(SequenceFrame frame, double imageWidth, double imageHeight, out double[] uv, out double[] quad)
        {
            double rx = 0, ry = 0, rw = imageWidth, rh = imageHeight;
            if (frame.Rect != null) { rx = frame.Rect.X; ry = frame.Rect.Y; rw = frame.Rect.Width; rh = frame.Rect.Height; }
            uv = new[] { rx / imageWidth, ry / imageHeight, (rx + rw) / imageWidth, (ry + rh) / imageHeight };
            var t = frame.Trim;
            quad = t != null
                ? new[] { t.X / t.SourceWidth, t.Y / t.SourceHeight, (t.X + rw) / t.SourceWidth, (t.Y + rh) / t.SourceHeight }
                : new double[] { 0, 0, 1, 1 };
        }
    }

    /// <summary>Linear map from 0..1 uvs of an original image to uvs of its atlas page (core/atlas.ts).</summary>
    public sealed class UvMap
    {
        public double Ou, Ov, Su, Sv;
        public bool Rotated;

        public static UvMap For(AtlasRegion r, AtlasPage page)
        {
            if (r.Rotated)
                return new UvMap
                {
                    Ou = (r.X + r.Height + r.OffsetY) / page.Width,
                    Ov = (r.Y - r.OffsetX) / page.Height,
                    Su = r.OriginalHeight / page.Width,
                    Sv = r.OriginalWidth / page.Height,
                    Rotated = true,
                };
            return new UvMap
            {
                Ou = (r.X - r.OffsetX) / page.Width,
                Ov = (r.Y - r.OffsetY) / page.Height,
                Su = r.OriginalWidth / page.Width,
                Sv = r.OriginalHeight / page.Height,
            };
        }

        public float[] Remap(IReadOnlyList<double> uvs)
        {
            var o = new float[uvs.Count];
            for (int i = 0; i + 1 < uvs.Count; i += 2)
            {
                double u = uvs[i], v = uvs[i + 1];
                o[i] = (float)(Rotated ? Ou - v * Su : Ou + u * Su);
                o[i + 1] = (float)(Rotated ? Ov + u * Sv : Ov + v * Sv);
            }
            return o;
        }

        public float[] Remap(float[] uvs)
        {
            var o = new float[uvs.Length];
            for (int i = 0; i + 1 < uvs.Length; i += 2)
            {
                double u = uvs[i], v = uvs[i + 1];
                o[i] = (float)(Rotated ? Ou - v * Su : Ou + u * Su);
                o[i + 1] = (float)(Rotated ? Ov + u * Sv : Ov + v * Sv);
            }
            return o;
        }
    }

    /// <summary>core/template.ts: text templates and number patterns.</summary>
    public static class Template
    {
        static readonly Regex Placeholder = new Regex(@"\{\{|\}\}|\{([^{}:]+)(?::([^{}]*))?\}", RegexOptions.CultureInvariant);
        static readonly Regex Pattern = new Regex(@"^([^#0]*?)(\+?)([#0,]+)(?:\.([0#]+))?(%?)(.*)$", RegexOptions.Singleline | RegexOptions.CultureInvariant);
        static readonly Regex Thousands = new Regex(@"\B(?=(\d{3})+(?!\d))", RegexOptions.CultureInvariant);

        /// <summary>Fill <c>{name}</c> / <c>{name:pattern}</c> from <paramref name="lookup"/> (unknown names stay as written).</summary>
        public static string Format(string template, Func<string, object> lookup)
        {
            if (template == null) return "null";
            if (template.IndexOf('{') < 0 && template.IndexOf('}') < 0) return template;
            return Placeholder.Replace(template, m =>
            {
                if (m.Value == "{{") return "{";
                if (m.Value == "}}") return "}";
                object v = lookup(JsTrim(m.Groups[1].Value));
                if (v == null || v is Json.Undefined) return m.Value;
                return FormatValue(v, m.Groups[2].Success ? m.Groups[2].Value : null);
            });
        }

        static string JsTrim(string s) => s.Trim();

        public static string FormatValue(object v, string pattern)
        {
            if (Js.IsNumber(v) && !string.IsNullOrEmpty(pattern)) return FormatNumber(Js.ToNumber(v), pattern);
            return Plain(v);
        }

        static string Plain(object v)
        {
            if (Js.IsNumber(v))
            {
                double d = Js.ToNumber(v);
                if (double.IsNaN(d) || double.IsInfinity(d)) return Js.NumberToString(d);
                return Js.NumberToString(Js.StringToNumber(Js.ToFixed(d, 6)));
            }
            return Js.ToStr(v);
        }

        public static string FormatNumber(double value, string pattern)
        {
            var m = Pattern.Match(pattern);
            if (!m.Success) return Plain(value) + pattern;
            string prefix = m.Groups[1].Value, plus = m.Groups[2].Value, intP = m.Groups[3].Value;
            string frac = m.Groups[4].Success ? m.Groups[4].Value : "";
            string pct = m.Groups[5].Value, suffix = m.Groups[6].Value;
            double v = pct.Length > 0 ? value * 100 : value;
            if (double.IsNaN(v) || double.IsInfinity(v)) return prefix + Js.NumberToString(v) + pct + suffix;
            int minFrac = 0;
            while (minFrac < frac.Length && frac[minFrac] == '0') minFrac++;
            int maxFrac = frac.Length;
            bool neg = v < 0;
            v = Math.Abs(v);
            string s = Js.ToFixed(v, maxFrac);
            if (maxFrac > minFrac)
            {
                int end = s.Length;
                int keep = s.Length - (maxFrac - minFrac);
                while (end > keep && s[end - 1] == '0') end--;
                s = s.Substring(0, end);
                if (s.EndsWith(".", StringComparison.Ordinal)) s = s.Substring(0, s.Length - 1);
            }
            int dot = s.IndexOf('.');
            string ip = dot >= 0 ? s.Substring(0, dot) : s;
            string fp = dot >= 0 ? s.Substring(dot + 1) : null;
            int minInt = 0;
            foreach (char c in intP) if (c == '0') minInt++;
            if (ip.Length < minInt) ip = ip.PadLeft(minInt, '0');
            else if (minInt == 0 && ip == "0" && !string.IsNullOrEmpty(fp)) ip = "";
            if (intP.IndexOf(',') >= 0) ip = Thousands.Replace(ip, ",");
            bool zero = true;
            foreach (char c in ip + (fp ?? "")) if (c >= '1' && c <= '9') { zero = false; break; }
            string sign = neg && !zero ? "-" : plus.Length > 0 && !neg ? "+" : "";
            return prefix + sign + ip + (!string.IsNullOrEmpty(fp) ? "." + fp : "") + pct + suffix;
        }

        /// <summary>Linear map of v from [inMin, inMax] to [0, 1], clamped (step at inMax when the range is empty).</summary>
        public static double BindingT(double v, double inMin, double inMax)
        {
            if (inMax == inMin) return v >= inMax ? 1 : 0;
            double t = (v - inMin) / (inMax - inMin);
            return t < 0 ? 0 : t > 1 ? 1 : t;
        }
    }

    /// <summary>core/particles.ts:gradientColor</summary>
    public static class Gradient
    {
        public static double[] Color(List<ColorStop> stops, double t)
        {
            if (stops.Count == 0) return new double[] { 1, 1, 1, 1 };
            var sorted = stops;
            bool unsorted = false;
            for (int i = 1; i < stops.Count; i++) if (stops[i].T < stops[i - 1].T) { unsorted = true; break; }
            if (stops.Count > 1 && unsorted)
            {
                sorted = new List<ColorStop>(stops);
                StableSort(sorted, (a, b) => a.T.CompareTo(b.T));
            }
            if (t <= sorted[0].T) return MathUtil.ParseHex(sorted[0].Color);
            var last = sorted[sorted.Count - 1];
            if (t >= last.T) return MathUtil.ParseHex(last.Color);
            for (int i = 1; i < sorted.Count; i++)
            {
                var b = sorted[i];
                if (t <= b.T)
                {
                    var a = sorted[i - 1];
                    double span = b.T - a.T;
                    if (span == 0 || double.IsNaN(span)) span = 1;
                    return MathUtil.LerpColor(MathUtil.ParseHex(a.Color), MathUtil.ParseHex(b.Color), (t - a.T) / span);
                }
            }
            return MathUtil.ParseHex(last.Color);
        }

        /// <summary>Stable insertion sort (List.Sort is not stable).</summary>
        public static void StableSort<T>(List<T> list, Comparison<T> cmp)
        {
            for (int i = 1; i < list.Count; i++)
            {
                var x = list[i];
                int j = i - 1;
                while (j >= 0 && cmp(list[j], x) > 0) { list[j + 1] = list[j]; j--; }
                list[j + 1] = x;
            }
        }
    }

    /// <summary>core/constraints.ts</summary>
    public static class Constraints
    {
        /// <summary>Every constraint in update order: by <c>order ?? defaultIndex</c>, ties by default index.</summary>
        public static List<ConstraintData> Order(SkeletonData sk)
        {
            var list = new List<ConstraintData>();
            list.AddRange(sk.Ik);
            list.AddRange(sk.Transform);
            list.AddRange(sk.Path);
            list.AddRange(sk.Physics);
            bool any = false;
            foreach (var c in list) if (c.Order.HasValue) { any = true; break; }
            if (!any) return list;
            var keyed = new List<(ConstraintData c, int i, double k)>();
            for (int i = 0; i < list.Count; i++) keyed.Add((list[i], i, list[i].Order ?? i));
            Gradient.StableSort(keyed, (a, b) =>
            {
                double d = a.k - b.k;
                if (d != 0 && !double.IsNaN(d)) return d < 0 ? -1 : 1;
                return a.i.CompareTo(b.i);
            });
            var r = new List<ConstraintData>(list.Count);
            foreach (var x in keyed) r.Add(x.c);
            return r;
        }

        public static void SkinRequired(SkeletonData sk, out HashSet<string> bones, out HashSet<string> constraints)
        {
            bones = new HashSet<string>();
            constraints = new HashSet<string>();
            foreach (var skin in sk.Skins)
            {
                if (skin.Bones != null) foreach (var id in skin.Bones) if (id != null) bones.Add(id);
                if (skin.Constraints != null) foreach (var id in skin.Constraints) if (id != null) constraints.Add(id);
            }
        }

        public static HashSet<string> ActiveBones(SkeletonData sk, SkinData skin)
        {
            SkinRequired(sk, out var req, out _);
            var mine = new HashSet<string>();
            if (skin?.Bones != null) foreach (var id in skin.Bones) if (id != null) mine.Add(id);
            var o = new HashSet<string>();
            foreach (var b in sk.Bones)
            {
                if (!string.IsNullOrEmpty(b.Parent) && !o.Contains(b.Parent)) continue;
                if (!req.Contains(b.Id) || mine.Contains(b.Id)) o.Add(b.Id);
            }
            return o;
        }
    }
}
