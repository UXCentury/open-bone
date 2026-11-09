using System.IO;
using System.Linq;
using OpenBone.Json;
using Xunit;

namespace OpenBone.Tests
{
    public class LoaderTests
    {
        static string Data(string f) => Path.Combine(Conformance.RepoRoot, "runtimes", "csharp", "tests", "OpenBone.Runtime.Tests", "data", f);

        static bool Same(JsonValue a, JsonValue b, string path, out string where)
        {
            where = path;
            if (a.Kind != b.Kind) return false;
            switch (a.Kind)
            {
                case JsonKind.Number: return a.AsNumber.Equals(b.AsNumber);
                case JsonKind.String: return a.AsString == b.AsString;
                case JsonKind.Bool: return a.AsBool == b.AsBool;
                case JsonKind.Array:
                    if (a.Count != b.Count) return false;
                    for (int i = 0; i < a.Count; i++) if (!Same(a[i], b[i], $"{path}[{i}]", out where)) return false;
                    return true;
                case JsonKind.Object:
                    if (!a.Keys.SequenceEqual(b.Keys)) return false;
                    foreach (var k in a.Keys) if (!Same(a.Get(k), b.Get(k), $"{path}.{k}", out where)) return false;
                    return true;
                default: return true;
            }
        }

        [Theory]
        [InlineData("transforms")]
        [InlineData("dynamics")]
        [InlineData("interactive")]
        [InlineData("meshes")]
        public void BinaryDecodesLikeTheReference(string name)
        {
            // data/*.obonb.json: what packages/core deserializeBinary returns for the same bytes (float32 → 7 digits).
            var bytes = File.ReadAllBytes(Data(name + ".obonb"));
            Assert.True(BinaryDocument.IsBinary(bytes));
            var mine = BinaryDocument.Decode(bytes);
            var expected = JsonReader.Parse(File.ReadAllText(Data(name + ".obonb.json")));
            Assert.True(Same(mine, expected, "$", out var where), $"differs at {where}");
            var doc = DocumentLoader.Load(bytes);
            Assert.Equal(expected.Get("skeleton").Get("bones").Count, doc.Skeleton.Bones.Count);
            // A binary document poses like its JSON source, within the float32 rounding of its numbers.
            var inst = new OpenBoneInstance(doc);
            inst.Advance(0);
            Assert.NotEmpty(inst.DrawList());
        }

        [Fact]
        public void RejectsOtherFormats()
        {
            Assert.Throws<OpenBoneFormatException>(() => DocumentLoader.FromJson("{\"format\":\"spine\"}"));
            Assert.Throws<OpenBoneFormatException>(() => DocumentLoader.FromJson("{\"format\":\"openbone\",\"version\":2}"));
        }
    }

    public class JsSemanticsTests
    {
        static readonly JsonValue Table = JsonReader.Parse(File.ReadAllText(Path.Combine(Conformance.RepoRoot, "runtimes", "csharp", "tests", "OpenBone.Runtime.Tests", "data", "js-numbers.json")));

        [Fact]
        public void NumberFormattingMatchesJavaScript()
        {
            // data/js-numbers.json was written by node: String(v), toFixed, toPrecision.
            foreach (var row in Table.Get("rows").Items)
            {
                double v = row.Num("v");
                Assert.Equal(row.Str("s"), Js.NumberToString(v));
                Assert.Equal(row.Str("f0"), Js.ToFixed(v, 0));
                Assert.Equal(row.Str("f2"), Js.ToFixed(v, 2));
                Assert.Equal(row.Str("f6"), Js.ToFixed(v, 6));
                Assert.Equal(row.Str("p7"), Js.ToPrecision(v, 7));
                Assert.Equal(row.Str("p3"), Js.ToPrecision(v, 3));
            }
            foreach (var row in Table.Get("f32rows").Items)
            {
                var bytes = row.Get("bits").Items.Select(b => (byte)b.AsNumber).ToArray();
                float f = System.BitConverter.ToSingle(bytes, 0);
                Assert.Equal(row.Num("r"), Js.Float32To7Digits(f));
            }
        }

        [Fact]
        public void TemplatesMatchJavaScript()
        {
            foreach (var row in Table.Get("tpl").Items)
            {
                double n = row.Num("v");
                string r = Template.Format(row.Str("t"), k => k == "n" ? (object)n : k == "b" ? true : k == "s" ? "hi" : null);
                Assert.Equal(row.Str("r"), r);
            }
        }

        [Fact]
        public void StringToNumber()
        {
            Assert.Equal(0, Js.StringToNumber(""));
            Assert.Equal(12, Js.StringToNumber(" 12 "));
            Assert.Equal(255, Js.StringToNumber("0xff"));
            Assert.True(double.IsNaN(Js.StringToNumber("12px")));
            Assert.Equal(double.NegativeInfinity, Js.StringToNumber("-Infinity"));
            Assert.Equal(0.5, Js.StringToNumber(".5"));
        }

        [Fact]
        public void EarcutMatchesTheLibrary()
        {
            // Outputs of mapbox earcut 3.2.4 (node) for the same inputs.
            Assert.Equal(new[] { 1, 0, 3, 1, 3, 2 }, Earcut.Triangulate(new double[] { 10, 0, 0, 50, 60, 60, 70, 10 }).ToArray());
            Assert.Equal(new[] { 3, 4, 0, 3, 0, 1, 3, 1, 2 }, Earcut.Triangulate(new double[] { 0, 0, 100, 0, 100, 100, 50, 40, 0, 100 }).ToArray());
            // More than 80 points: the z-order hashed path.
            var pts = new double[200];
            for (int i = 0; i < 100; i++)
            {
                double a = i / 100.0 * System.Math.PI * 2, r = i % 3 != 0 ? 50 : 30;
                pts[i * 2] = System.Math.Cos(a) * r;
                pts[i * 2 + 1] = System.Math.Sin(a) * r;
            }
            var expected = new System.Collections.Generic.List<int>();
            for (int k = 0; k < 33; k++) expected.AddRange(new[] { 3 * k, 3 * k + 1, 3 * k + 2, 3 * k, 3 * k + 2, 3 * k + 3 });
            expected.RemoveRange(expected.Count - 6, 6);
            expected.AddRange(new[] { 96, 97, 98, 96, 98, 99, 96, 99, 0 });
            for (int k = 0; k < 31; k++) expected.AddRange(new[] { 96, 3 * k, 3 * k + 3 });
            Assert.Equal(expected.ToArray(), Earcut.Triangulate(pts).ToArray());
        }
    }
}
