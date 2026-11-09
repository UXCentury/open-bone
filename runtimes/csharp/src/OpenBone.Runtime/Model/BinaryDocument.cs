using System;
using System.Text;
using OpenBone.Json;

namespace OpenBone
{
    /// <summary>
    /// .obonb decoder (packages/core/src/binary.ts): magic "OBNB", u8 version, string table, one tagged value.
    /// Tags: 0 null · 1 false · 2 true · 3 uint · 4 negative int · 5 float32 · 6 float64 · 7 string · 8 array ·
    /// 9 object · 10 data: URL. Decoded to the same JSON value as the .obone file (float32 rounded to 7 significant
    /// digits; non-finite numbers and -0 as JSON.stringify writes them).
    /// </summary>
    public static class BinaryDocument
    {
        const int Version = 1;

        public static bool IsBinary(byte[] b) => b != null && b.Length >= 5 && b[0] == 0x4f && b[1] == 0x42 && b[2] == 0x4e && b[3] == 0x42;

        public static JsonValue Decode(byte[] bytes)
        {
            if (!IsBinary(bytes)) throw new OpenBoneFormatException("Not an OpenBone binary document (missing OBNB header)");
            if (bytes[4] > Version) throw new OpenBoneFormatException($"Binary version {bytes[4]} is newer than supported {Version}");
            int p = 5;
            var utf8 = new UTF8Encoding(false, false);
            double Varint()
            {
                double n = 0, mul = 1;
                for (; ; )
                {
                    if (p >= bytes.Length) throw Corrupt();
                    int b = bytes[p++];
                    n += (b & 0x7f) * mul;
                    if (b < 0x80) return n;
                    mul *= 0x80;
                    if (mul > Math.Pow(2, 56)) throw Corrupt();
                }
            }
            int count = (int)Varint();
            var strings = new string[count];
            for (int i = 0; i < count; i++)
            {
                int n = (int)Varint();
                if (p + n > bytes.Length) throw Corrupt();
                strings[i] = utf8.GetString(bytes, p, n);
                p += n;
            }
            string Str()
            {
                double i = Varint();
                if (i >= strings.Length) throw Corrupt();
                return strings[(int)i];
            }
            JsonValue Num(double v)
            {
                // JSON.stringify: non-finite ⇒ null, -0 ⇒ 0.
                if (double.IsNaN(v) || double.IsInfinity(v)) return JsonValue.Null;
                return JsonValue.Number(v == 0 ? 0 : v);
            }
            JsonValue Value(int depth)
            {
                if (depth > 1000 || p >= bytes.Length) throw Corrupt();
                int tag = bytes[p++];
                switch (tag)
                {
                    case 0: return JsonValue.Null;
                    case 1: return JsonValue.False;
                    case 2: return JsonValue.True;
                    case 3: return Num(Varint());
                    case 4: return Num(-Varint() - 1);
                    case 5:
                        {
                            if (p + 4 > bytes.Length) throw Corrupt();
                            float f = BitConverter.ToSingle(LittleEndian(bytes, p, 4), 0);
                            p += 4;
                            if (float.IsNaN(f) || float.IsInfinity(f)) return JsonValue.Null;
                            return Num(Js.Float32To7Digits(f));
                        }
                    case 6:
                        {
                            if (p + 8 > bytes.Length) throw Corrupt();
                            double d = BitConverter.ToDouble(LittleEndian(bytes, p, 8), 0);
                            p += 8;
                            return Num(d);
                        }
                    case 7: return JsonValue.String(Str());
                    case 8:
                        {
                            int n = (int)Varint();
                            var a = JsonValue.NewArray();
                            for (int i = 0; i < n; i++) a.Add(Value(depth + 1));
                            return a;
                        }
                    case 9:
                        {
                            int n = (int)Varint();
                            var o = JsonValue.NewObject();
                            for (int i = 0; i < n; i++)
                            {
                                var k = Str();
                                o.Set(k, Value(depth + 1));
                            }
                            return o;
                        }
                    case 10:
                        {
                            var mime = Str();
                            int n = (int)Varint();
                            if (p + n > bytes.Length) throw Corrupt();
                            var url = "data:" + mime + ";base64," + Convert.ToBase64String(bytes, p, n);
                            p += n;
                            return JsonValue.String(url);
                        }
                    default: throw Corrupt();
                }
            }
            return Value(0);
        }

        static byte[] LittleEndian(byte[] b, int p, int n)
        {
            var r = new byte[n];
            Array.Copy(b, p, r, 0, n);
            if (!BitConverter.IsLittleEndian) Array.Reverse(r);
            return r;
        }

        static Exception Corrupt() => new OpenBoneFormatException("Corrupt OpenBone binary document");
    }
}
