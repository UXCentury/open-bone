using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace OpenBone.MonoGame.Tests
{
    public class FontTests
    {
        static void Put16(List<byte> b, int v) { b.Add((byte)(v >> 8)); b.Add((byte)v); }
        static void Put32(List<byte> b, int v) { b.Add((byte)(v >> 24)); b.Add((byte)(v >> 16)); b.Add((byte)(v >> 8)); b.Add((byte)v); }

        /// <summary>A font file holding only a head table (unitsPerEm) and an hhea table (ascender, descender).</summary>
        static (byte[] dir, byte[] head, byte[] hhea) Tables(int unitsPerEm, int ascender, int descender)
        {
            var head = new byte[54];
            head[18] = (byte)(unitsPerEm >> 8); head[19] = (byte)unitsPerEm;
            var hhea = new byte[36];
            hhea[4] = (byte)(ascender >> 8); hhea[5] = (byte)ascender;
            hhea[6] = (byte)(descender >> 8); hhea[7] = (byte)descender;
            return (null, head, hhea);
        }

        /// <summary>A single font (offsets from `baseOffset`, so it can sit inside a collection).</summary>
        static List<byte> Sfnt(int baseOffset, byte[] head, byte[] hhea, out List<byte> body)
        {
            var dir = new List<byte>();
            Put32(dir, 0x00010000);
            Put16(dir, 2); Put16(dir, 32); Put16(dir, 1); Put16(dir, 0);
            int pos = baseOffset + 12 + 16 * 2;
            body = new List<byte>();
            foreach (var (tag, data) in new[] { ("head", head), ("hhea", hhea) })
            {
                dir.AddRange(Encoding.ASCII.GetBytes(tag));
                Put32(dir, 0);
                Put32(dir, pos);
                Put32(dir, data.Length);
                body.AddRange(data);
                pos += data.Length;
            }
            return dir;
        }

        [Fact]
        public void HeightPerEmIsAscentToDescentOverUnitsPerEm()
        {
            var (_, head, hhea) = Tables(1000, 880, -120);
            var dir = Sfnt(0, head, hhea, out var body);
            Assert.Equal(1.0f, FontFiles.HeightPerEm(dir.Concat(body).ToArray()), 3);
            (_, head, hhea) = Tables(1000, 1160, -288);  // Noto CJK's metrics: 1.448 em from ascent to descent
            dir = Sfnt(0, head, hhea, out body);
            Assert.Equal(1.448f, FontFiles.HeightPerEm(dir.Concat(body).ToArray()), 3);
        }

        [Fact]
        public void ReadsOneFaceOutOfACollection()
        {
            // ttcf header with two faces; the second face says 2048 units per em.
            var (_, h1, x1) = Tables(1000, 800, -200);
            var (_, h2, x2) = Tables(2048, 1900, -500);
            const int header = 12 + 4 * 2;
            var face1 = Sfnt(header, h1, x1, out var body1);
            int face2At = header + face1.Count + body1.Count;
            var face2 = Sfnt(face2At, h2, x2, out var body2);
            var file = new List<byte>(Encoding.ASCII.GetBytes("ttcf"));
            Put32(file, 0x00010000);
            Put32(file, 2);
            Put32(file, header);
            Put32(file, face2At);
            file.AddRange(face1); file.AddRange(body1); file.AddRange(face2); file.AddRange(body2);

            var path = Path.Combine(Path.GetTempPath(), "openbone-test-" + System.Guid.NewGuid() + ".ttc");
            File.WriteAllBytes(path, file.ToArray());
            try
            {
                var one = FontFiles.ReadFace(new FontFiles.Face(path, 1));
                Assert.Equal(0x00, one[0]);  // a plain font now, not "ttcf"
                Assert.Equal(2400f / 2048f, FontFiles.HeightPerEm(one), 3);
                Assert.Equal(1.0f, FontFiles.HeightPerEm(FontFiles.ReadFace(new FontFiles.Face(path, 0))), 3);
                Assert.Null(FontFiles.ReadFace(new FontFiles.Face(path, 2)));
            }
            finally { File.Delete(path); }
        }

        [Fact]
        public void SplitsCssFamilyLists()
        {
            Assert.Equal(new[] { "Noto Serif JP", "Georgia", "serif" }, FontStashTextRenderer.SplitFamilies("Noto Serif JP, 'Georgia' , \"serif\""));
        }
    }
}
