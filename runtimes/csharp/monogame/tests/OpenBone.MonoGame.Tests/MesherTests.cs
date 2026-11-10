using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Xna.Framework;
using Xunit;

namespace OpenBone.MonoGame.Tests
{
    public class MesherTests
    {
        static readonly ImageAsset ImgA = new ImageAsset { Id = "a" };
        static readonly ImageAsset ImgB = new ImageAsset { Id = "b" };

        static DrawItem Quad(ITexture tex, float x = 0, string blend = "normal", ClipRegion clip = null, double[] color = null, double[] dark = null) => new DrawItem
        {
            Texture = tex,
            Vertices = new[] { x, 0f, x + 10, 0f, x + 10, 10f, x, 10f },
            Uvs = new[] { 0f, 1f, 1f, 1f, 1f, 0f, 0f, 0f },
            Indices = new ushort[] { 0, 1, 2, 0, 2, 3 },
            Color = color ?? new double[] { 1, 1, 1, 1 },
            Dark = dark,
            Blend = blend,
            Clip = clip,
        };

        static ClipRegion Clip() => new ClipRegion
        {
            Polygon = new[] { 0f, 0f, 20f, 0f, 20f, 20f },
            Indices = new ushort[] { 0, 1, 2 },
        };

        [Fact]
        public void ItemsSharingTextureAndBlendShareABatchWithRebasedIndices()
        {
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA), Quad(ImgA, 20) });
            Assert.Equal(1, m.BatchCount);
            var b = m.Batch(0);
            Assert.Equal("a", b.TextureId);
            Assert.Equal(8, b.VertexCount);
            Assert.Equal(12, b.IndexCount);
            Assert.Equal(4, b.PrimitiveCount);
            Assert.Equal(new short[] { 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7 }, m.Indices.Take(12).ToArray());
            // Positions stay in skeleton space; uvs are copied (v down).
            Assert.Equal(new Vector3(30, 10, 0), m.Vertices[6].Position);
            Assert.Equal(new Vector2(1, 0), m.Vertices[6].TextureCoordinate);
        }

        [Fact]
        public void TextureOrBlendChangesStartANewBatch()
        {
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA), Quad(ImgB), Quad(ImgB, 0, "additive"), Quad(null) });
            Assert.Equal(4, m.BatchCount);
            Assert.Equal(new[] { "a", "b", "b", null }, Enumerable.Range(0, 4).Select(i => m.Batch(i).TextureId).ToArray());
            Assert.Equal("additive", m.Batch(2).Blend);
            // Each batch indexes from its own first vertex.
            Assert.Equal(4, m.Batch(1).VertexStart);
            Assert.Equal(0, m.Indices[m.Batch(1).IndexStart]);
        }

        [Fact]
        public void ColoursArePremultipliedAndDarkIsScaledByAlpha()
        {
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA, color: new[] { 1, 0.5, 0, 0.5 }, dark: new[] { 0.2, 0.4, 1.0 }) });
            var v = m.Vertices[0];
            Assert.Equal(new Color(128, 64, 0, 128), v.Color);
            Assert.Equal(new Color(26, 51, 128, 255), v.Dark);
            Assert.True(m.Batch(0).HasDark);
        }

        [Fact]
        public void NoDarkMeansBlack()
        {
            Assert.Equal(new Color(0, 0, 0, 255), DrawListMesher.Dark(null, 0.5));
            Assert.Equal(new Color(255, 255, 255, 255), DrawListMesher.Premultiply(1, 1, 1, 1));
            Assert.Equal(new Color(0, 0, 0, 0), DrawListMesher.Premultiply(1, 1, 1, -3));
        }

        [Fact]
        public void ParticleColoursArePerVertex()
        {
            var it = Quad(new ImageAsset { Id = ParticleDot.TextureId });
            it.Colors = new[] { 1f, 0, 0, 1, 0, 1, 0, 0.5f, 0, 0, 1, 0, 1, 1, 1, 1 };
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { it });
            Assert.Equal(new Color(255, 0, 0, 255), m.Vertices[0].Color);
            Assert.Equal(new Color(0, 128, 0, 128), m.Vertices[1].Color);
            Assert.Equal(new Color(0, 0, 0, 0), m.Vertices[2].Color);
            Assert.Equal(ParticleDot.TextureId, m.Batch(0).TextureId);
        }

        [Fact]
        public void ClippedItemsAreWrappedInStencilWriteAndClear()
        {
            var clip = Clip();
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA), Quad(ImgA, 0, clip: clip), Quad(ImgA, 5, clip: clip), Quad(ImgA) });
            var modes = Enumerable.Range(0, m.BatchCount).Select(i => m.Batch(i).Stencil).ToArray();
            Assert.Equal(new[] { StencilMode.None, StencilMode.Write, StencilMode.Test, StencilMode.Clear, StencilMode.None }, modes);
            var write = m.Batch(1);
            Assert.Null(write.TextureId);
            Assert.Equal(3, write.VertexCount);
            Assert.Equal(new Vector3(20, 20, 0), m.Vertices[write.VertexStart + 2].Position);
            Assert.Equal(8, m.Batch(2).VertexCount); // both clipped quads in one batch
        }

        [Fact]
        public void ClipAtTheEndIsCleared()
        {
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA, clip: Clip()) });
            Assert.Equal(StencilMode.Clear, m.Batch(m.BatchCount - 1).Stencil);
        }

        [Fact]
        public void TextItemsBecomeTextBatchesOrAreSkipped()
        {
            var text = new DrawItem { Text = new TextDraw { Content = "hi" }, Color = new double[] { 1, 1, 1, 1 }, Blend = "normal" };
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { Quad(ImgA), text, Quad(ImgA) });
            Assert.Equal(3, m.BatchCount);
            Assert.Same(text, m.Batch(1).Text);
            m.IncludeText = false;
            m.Build(new List<DrawItem> { Quad(ImgA), text, Quad(ImgA) });
            Assert.Equal(1, m.BatchCount);
        }

        [Fact]
        public void MissingTexturesAreSkipped()
        {
            var m = new DrawListMesher { CanDraw = t => t.Id != "b" };
            m.Build(new List<DrawItem> { Quad(ImgA), Quad(ImgB), Quad(ImgA) });
            Assert.Equal(1, m.BatchCount);
            Assert.Equal(8, m.VertexCount);
        }

        [Fact]
        public void StrokesAddUntexturedBands()
        {
            var it = Quad(ImgA);
            it.Stroke = new Stroke { Color = new double[] { 0, 0, 0, 1 }, Width = 2, Outline = new[] { 0f, 0f, 10f, 0f, 10f, 10f } };
            var m = new DrawListMesher();
            m.Build(new List<DrawItem> { it });
            Assert.Equal(2, m.BatchCount);
            Assert.Null(m.Batch(1).TextureId);
            Assert.Equal(12, m.Batch(1).VertexCount); // 3 segments × 4
        }

        [Fact]
        public void LargeRunsSplitAt16BitIndices()
        {
            var items = Enumerable.Range(0, 20000).Select(i => Quad(ImgA, i)).ToList(); // 80 000 vertices
            var m = new DrawListMesher();
            m.Build(items);
            Assert.Equal(2, m.BatchCount);
            Assert.True(m.Batch(0).VertexCount <= DrawListMesher.MaxBatchVertices);
            Assert.Equal(80000, m.Batch(0).VertexCount + m.Batch(1).VertexCount);
            // The last index of the first batch is unsigned 16-bit.
            Assert.Equal(m.Batch(0).VertexCount - 1, (ushort)m.Indices[m.Batch(0).IndexStart + m.Batch(0).IndexCount - 1]);
        }

        [Fact]
        public void KnightDrawListMeshes()
        {
            var doc = DocumentLoader.Load(File.ReadAllBytes(TestPaths.Example("knight.obone")));
            var inst = new OpenBoneInstance(doc);
            inst.UseStateMachine("knight");
            inst.Advance(0.1);
            var items = inst.DrawList();
            var m = new DrawListMesher();
            m.Build(items);
            Assert.Equal(items.Sum(i => i.Vertices.Length / 2), m.VertexCount);
            Assert.Equal(items.Sum(i => i.Indices.Length), m.IndexCount);
            Assert.All(Enumerable.Range(0, m.BatchCount).Select(m.Batch), b =>
            {
                Assert.Equal(StencilMode.None, b.Stencil);
                for (int i = 0; i < b.IndexCount; i++) Assert.InRange((ushort)m.Indices[b.IndexStart + i], 0, b.VertexCount - 1);
            });
        }
    }
}
