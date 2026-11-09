using System;
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenBone
{
    /// <summary>
    /// JavaScript number and value semantics the reference runtime depends on (docs/runtime-spec.md §12):
    /// <c>String(number)</c>, <c>toFixed</c>/<c>toPrecision</c> (exact decimal ties round up), <c>Number(x)</c>,
    /// truthiness, strict equality, <c>Math.hypot</c> as V8 computes it.
    /// Input values (state-machine inputs, script values) are boxed <see cref="bool"/>, <see cref="double"/> or
    /// <see cref="string"/>; C# null stands for JavaScript null/undefined.
    /// </summary>
    public static class Js
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        /// <summary>JavaScript <c>%</c> (fmod; the result has the sign of the dividend). C# <c>%</c> on doubles is the same.</summary>
        public static double Mod(double a, double b) => a % b;

        /// <summary>V8's Math.hypot for two values (scaled, Kahan-compensated sum).</summary>
        public static double Hypot(double x, double y)
        {
            double ax = Math.Abs(x), ay = Math.Abs(y);
            if (double.IsInfinity(ax) || double.IsInfinity(ay)) return double.PositiveInfinity;
            if (double.IsNaN(ax) || double.IsNaN(ay)) return double.NaN;
            double max = Math.Max(ax, ay);
            if (max == 0) return 0;
            double sum = 0, comp = 0;
            double n = ax / max;
            double summand = n * n - comp;
            double prelim = sum + summand;
            comp = (prelim - sum) - summand;
            sum = prelim;
            n = ay / max;
            summand = n * n - comp;
            prelim = sum + summand;
            sum = prelim;
            return Math.Sqrt(sum) * max;
        }

        /// <summary>ECMAScript ToInt32.</summary>
        public static int ToInt32(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            double t = Math.Truncate(v);
            double m = t % 4294967296.0;
            if (m < 0) m += 4294967296.0;
            return unchecked((int)(uint)m);
        }

        public static uint ToUint32(double v) => unchecked((uint)ToInt32(v));

        /// <summary>JavaScript Math.round (halves round towards +∞).</summary>
        public static double Round(double v) => Math.Floor(v + 0.5);

        // ---------------- Number → string ----------------

        /// <summary>Shortest decimal digits and exponent: value = 0.d1d2…dk × 10^n (digits without leading zeros).</summary>
        static void ShortestDigits(double v, out string digits, out int n)
        {
            // "R" is the shortest round-trip form on .NET Core 3.0+.
            string r = Math.Abs(v).ToString("R", Inv);
            int e = 0;
            int ei = r.IndexOfAny(new[] { 'E', 'e' });
            if (ei >= 0)
            {
                e = int.Parse(r.Substring(ei + 1), NumberStyles.AllowLeadingSign, Inv);
                r = r.Substring(0, ei);
            }
            int dot = r.IndexOf('.');
            string intPart = dot >= 0 ? r.Substring(0, dot) : r;
            string frac = dot >= 0 ? r.Substring(dot + 1) : "";
            string all = intPart + frac;
            int pointPos = intPart.Length + e; // position of the decimal point within `all`
            int lead = 0;
            while (lead < all.Length - 1 && all[lead] == '0') lead++;
            all = all.Substring(lead);
            pointPos -= lead;
            all = all.TrimEnd('0');
            if (all.Length == 0) { all = "0"; pointPos = 1; }
            digits = all;
            n = pointPos;
        }

        /// <summary>JavaScript <c>String(number)</c>.</summary>
        public static string NumberToString(double v)
        {
            if (double.IsNaN(v)) return "NaN";
            if (v == 0) return "0";
            if (double.IsPositiveInfinity(v)) return "Infinity";
            if (double.IsNegativeInfinity(v)) return "-Infinity";
            ShortestDigits(v, out var s, out var n);
            int k = s.Length;
            var sb = new StringBuilder();
            if (v < 0) sb.Append('-');
            if (k <= n && n <= 21)
            {
                sb.Append(s).Append('0', n - k);
            }
            else if (0 < n && n <= 21)
            {
                sb.Append(s, 0, n).Append('.').Append(s, n, k - n);
            }
            else if (-6 < n && n <= 0)
            {
                sb.Append("0.").Append('0', -n).Append(s);
            }
            else
            {
                int e = n - 1;
                sb.Append(s[0]);
                if (k > 1) sb.Append('.').Append(s, 1, k - 1);
                sb.Append('e').Append(e >= 0 ? "+" : "-").Append(Math.Abs(e).ToString(Inv));
            }
            return sb.ToString();
        }

        /// <summary>Exact value of a finite double as numerator / 2^shift (numerator may be negative).</summary>
        static void Exact(double v, out BigInteger mant, out int exp2)
        {
            long bits = BitConverter.DoubleToInt64Bits(v);
            bool neg = bits < 0;
            int exp = (int)((bits >> 52) & 0x7FF);
            long frac = bits & 0xFFFFFFFFFFFFFL;
            if (exp == 0) exp = 1; else frac |= 1L << 52;
            mant = frac;
            exp2 = exp - 1075; // value = mant · 2^exp2
            if (neg) mant = -mant;
        }

        /// <summary>round-half-up(|v| · 10^p) computed exactly (p may be negative).</summary>
        static BigInteger ScaledRound(double v, int p)
        {
            Exact(Math.Abs(v), out var m, out var e2);
            BigInteger num = m, den = BigInteger.One;
            if (e2 >= 0) num <<= e2; else den <<= -e2;
            if (p >= 0) num *= BigInteger.Pow(10, p); else den *= BigInteger.Pow(10, -p);
            return BigInteger.Divide(2 * num + den, 2 * den);
        }

        /// <summary>JavaScript <c>Number.prototype.toFixed</c> (0 ≤ digits ≤ 100).</summary>
        public static string ToFixed(double v, int digits)
        {
            if (double.IsNaN(v)) return "NaN";
            if (Math.Abs(v) >= 1e21 || double.IsInfinity(v)) return NumberToString(v);
            var n = ScaledRound(v, digits);
            string s = n.ToString(Inv);
            if (digits > 0)
            {
                if (s.Length <= digits) s = new string('0', digits + 1 - s.Length) + s;
                s = s.Substring(0, s.Length - digits) + "." + s.Substring(s.Length - digits);
            }
            // JS: if x < 0, the result is "-" + toFixed(-x) (so -0.0001.toFixed(2) is "-0.00").
            return (v < 0 ? "-" : "") + s;
        }

        /// <summary>JavaScript <c>Number.prototype.toPrecision</c> (1 ≤ p ≤ 100).</summary>
        public static string ToPrecision(double v, int p)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return NumberToString(v);
            string sign = v < 0 ? "-" : "";
            double x = Math.Abs(v);
            string m;
            int e;
            if (x == 0)
            {
                m = new string('0', p);
                e = 0;
            }
            else
            {
                e = (int)Math.Floor(Math.Log10(x));
                BigInteger n = ScaledRound(x, p - 1 - e);
                var lo = BigInteger.Pow(10, p - 1);
                var hi = BigInteger.Pow(10, p);
                if (n >= hi) { e++; n = ScaledRound(x, p - 1 - e); }
                else if (n < lo) { e--; n = ScaledRound(x, p - 1 - e); }
                if (n >= hi) { e++; n = ScaledRound(x, p - 1 - e); }
                m = n.ToString(Inv);
            }
            if (e < -6 || e >= p)
            {
                var sb = new StringBuilder(sign);
                sb.Append(m[0]);
                if (p > 1) sb.Append('.').Append(m, 1, p - 1);
                sb.Append('e').Append(e >= 0 ? '+' : '-').Append(Math.Abs(e).ToString(Inv));
                return sb.ToString();
            }
            if (e == p - 1) return sign + m;
            if (e >= 0) return sign + m.Substring(0, e + 1) + "." + m.Substring(e + 1);
            return sign + "0." + new string('0', -(e + 1)) + m;
        }

        /// <summary><c>Number(x.toPrecision(7))</c> for a float32 widened to double (binary documents).</summary>
        public static double Float32To7Digits(float f) => ParseDouble(ToPrecision(f, 7));

        static double ParseDouble(string s) => double.Parse(s, NumberStyles.Float, Inv);

        // ---------------- Conversions on boxed values ----------------

        static readonly Regex DecimalLiteral = new Regex(@"^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$", RegexOptions.CultureInvariant);

        /// <summary>JavaScript StringToNumber.</summary>
        public static double StringToNumber(string s)
        {
            s = s.Trim(' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\ufeff', '\u2028', '\u2029');
            if (s.Length == 0) return 0;
            if (s.Length > 2 && s[0] == '0')
            {
                char k = char.ToLowerInvariant(s[1]);
                int radix = k == 'x' ? 16 : k == 'o' ? 8 : k == 'b' ? 2 : 0;
                if (radix != 0)
                {
                    double acc = 0;
                    for (int i = 2; i < s.Length; i++)
                    {
                        int d = HexDigit(s[i]);
                        if (d < 0 || d >= radix) return double.NaN;
                        acc = acc * radix + d;
                    }
                    return acc;
                }
            }
            if (!DecimalLiteral.IsMatch(s)) return double.NaN;
            if (s.EndsWith("Infinity", StringComparison.Ordinal)) return s[0] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
            return ParseDouble(s);
        }

        static int HexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        /// <summary>JavaScript <c>Number(v)</c> (null ⇒ 0).</summary>
        public static double ToNumber(object v)
        {
            switch (v)
            {
                case null: return 0;
                case double d: return d;
                case float f: return f;
                case int i: return i;
                case long l: return l;
                case bool b: return b ? 1 : 0;
                case string s: return StringToNumber(s);
                case Json.Undefined _: return double.NaN;
                default: return double.NaN;
            }
        }

        /// <summary>JavaScript <c>String(v)</c>.</summary>
        public static string ToStr(object v)
        {
            switch (v)
            {
                case null: return "null";
                case string s: return s;
                case bool b: return b ? "true" : "false";
                case double d: return NumberToString(d);
                case float f: return NumberToString(f);
                case int i: return i.ToString(Inv);
                case long l: return l.ToString(Inv);
                case Json.Undefined _: return "undefined";
                default: return v.ToString();
            }
        }

        /// <summary>JavaScript truthiness.</summary>
        public static bool Truthy(object v)
        {
            switch (v)
            {
                case null: return false;
                case bool b: return b;
                case double d: return d != 0 && !double.IsNaN(d);
                case float f: return f != 0 && !float.IsNaN(f);
                case int i: return i != 0;
                case string s: return s.Length > 0;
                case Json.Undefined _: return false;
                default: return true;
            }
        }

        /// <summary>JavaScript <c>===</c> on input values.</summary>
        public static bool StrictEquals(object a, object b)
        {
            if (a == null || b == null) return a == null && b == null;
            if (IsNumber(a) && IsNumber(b)) return ToNumber(a) == ToNumber(b);
            if (a is bool ba && b is bool bb) return ba == bb;
            if (a is string sa && b is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
            return false;
        }

        public static bool IsNumber(object v) => v is double || v is float || v is int || v is long;

        /// <summary>A JSON value as an input value (bool, double, string; null otherwise).</summary>
        public static object FromJson(Json.JsonValue v)
        {
            if (v == null) return null;
            switch (v.Kind)
            {
                case Json.JsonKind.Bool: return v.AsBool;
                case Json.JsonKind.Number: return v.AsNumber;
                case Json.JsonKind.String: return v.AsString;
                default: return null;
            }
        }
    }
}
