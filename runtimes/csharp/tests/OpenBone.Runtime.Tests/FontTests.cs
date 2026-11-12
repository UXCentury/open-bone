using System.IO;
using System.Linq;
using Xunit;

namespace OpenBone.Tests
{
    public class DocumentFontTests
    {
        static string Data(string f) => Path.Combine(Conformance.RepoRoot, "runtimes", "csharp", "tests", "OpenBone.Runtime.Tests", "data", f);

        // data/fonts.obonb: data/fonts.obone written by packages/core serializeBinary (its data: font becomes raw bytes).
        [Theory]
        [InlineData("fonts.obone")]
        [InlineData("fonts.obonb")]
        public void ReadsFonts(string file)
        {
            var doc = DocumentLoader.Load(File.ReadAllBytes(Data(file)));
            Assert.Equal(3, doc.Fonts.Count);
            var f = doc.Fonts[0];
            Assert.Equal("f1", f.Id);
            Assert.Equal("Brand Regular", f.Name);
            Assert.Equal("Brand Sans", f.Family);
            Assert.StartsWith("data:font/ttf;base64,", f.Src);
            Assert.Equal(400, f.Weight);
            Assert.Equal("normal", f.Style);
            Assert.Equal("fonts/BrandSans-Bold.ttf", doc.Fonts[1].Src);
            Assert.Equal(700, doc.Fonts[1].Weight);
            Assert.Equal("italic", doc.Fonts[2].Style);
        }

        [Fact]
        public void BinaryKeepsTheEmbeddedBytes()
        {
            var json = DocumentLoader.Load(File.ReadAllBytes(Data("fonts.obone")));
            var bin = DocumentLoader.Load(File.ReadAllBytes(Data("fonts.obonb")));
            Assert.Equal(json.Fonts.Select(x => x.Src), bin.Fonts.Select(x => x.Src));
        }

        [Fact]
        public void DocumentsWithoutFontsHaveAnEmptyList()
        {
            var doc = DocumentLoader.FromJson("{\"format\":\"openbone\",\"version\":1,\"skeleton\":{}}");
            Assert.Empty(doc.Fonts);
            Assert.Null(doc.PickFont("Brand Sans, serif"));
        }

        [Fact]
        public void PicksTheFirstListedFamilyAndTheClosestWeight()
        {
            var doc = DocumentLoader.Load(File.ReadAllBytes(Data("fonts.obone")));
            // The text asks for "'brand sans', serif" at 600: case-insensitive family, 700 is closer than 400.
            var text = (TextAttachment)doc.DefaultSkin.Attachments["s"].Get("t");
            Assert.Equal("f2", doc.PickFont(text.Font, text.Weight).Id);
            Assert.Equal("f1", doc.PickFont("Brand Sans", 400).Id);
            Assert.Equal("f1", doc.PickFont("Brand Sans", 100).Id);
            Assert.Equal("f1", doc.PickFont("Brand Sans", 550).Id);  // tie: the first listed wins
            Assert.Equal("f3", doc.PickFont("Brand Sans", 700, italic: true).Id);
            Assert.Equal("f2", doc.PickFont("Georgia, \"BRAND SANS\"", 900).Id);  // families the document lacks are skipped
            Assert.Null(doc.PickFont("Georgia, serif"));
        }

        [Fact]
        public void SplitsCssFamilyLists()
        {
            Assert.Equal(new[] { "Noto Serif JP", "Georgia", "serif" }, FontAsset.SplitFamilies("Noto Serif JP, 'Georgia' , \"serif\",,"));
        }
    }
}
