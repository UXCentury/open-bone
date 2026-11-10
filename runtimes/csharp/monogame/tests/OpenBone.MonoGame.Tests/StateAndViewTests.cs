using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Xunit;

namespace OpenBone.MonoGame.Tests
{
    public class RenderStateTests
    {
        [Theory]
        [InlineData("normal", Blend.One, Blend.InverseSourceAlpha)]
        [InlineData(null, Blend.One, Blend.InverseSourceAlpha)]
        [InlineData("unknown", Blend.One, Blend.InverseSourceAlpha)]
        [InlineData("additive", Blend.One, Blend.One)]
        [InlineData("multiply", Blend.DestinationColor, Blend.InverseSourceAlpha)]
        [InlineData("screen", Blend.One, Blend.InverseSourceColor)]
        public void BlendModesArePremultiplied(string mode, Blend src, Blend dst)
        {
            var s = RenderStates.ForBlend(mode);
            Assert.Equal(src, s.ColorSourceBlend);
            Assert.Equal(dst, s.ColorDestinationBlend);
            Assert.Equal(src, s.AlphaSourceBlend);
            Assert.Equal(dst, s.AlphaDestinationBlend);
            Assert.Equal(BlendFunction.Add, s.ColorBlendFunction);
            Assert.Equal(ColorWriteChannels.All, s.ColorWriteChannels);
        }

        [Fact]
        public void MaskBatchesWriteOnlyTheStencil()
        {
            Assert.Equal(ColorWriteChannels.None, RenderStates.ForBatch("additive", StencilMode.Write).ColorWriteChannels);
            Assert.Equal(ColorWriteChannels.None, RenderStates.ForBatch("normal", StencilMode.Clear).ColorWriteChannels);
            Assert.Same(RenderStates.Additive, RenderStates.ForBatch("additive", StencilMode.Test));

            var write = RenderStates.ForStencil(StencilMode.Write);
            Assert.True(write.StencilEnable);
            Assert.Equal(CompareFunction.Always, write.StencilFunction);
            Assert.Equal(StencilOperation.Replace, write.StencilPass);
            Assert.Equal(RenderStates.StencilRef, write.ReferenceStencil);

            var test = RenderStates.ForStencil(StencilMode.Test);
            Assert.Equal(CompareFunction.Equal, test.StencilFunction);
            Assert.Equal(StencilOperation.Keep, test.StencilPass);
            Assert.Equal(RenderStates.StencilRef, test.ReferenceStencil);

            var clear = RenderStates.ForStencil(StencilMode.Clear);
            Assert.Equal(StencilOperation.Zero, clear.StencilPass);

            var none = RenderStates.ForStencil(StencilMode.None);
            Assert.False(none.StencilEnable);
            Assert.False(none.DepthBufferEnable);
            Assert.Equal(CullMode.None, RenderStates.NoCull.CullMode);
        }
    }

    public class SkeletonViewTests
    {
        static Document Knight() => DocumentLoader.Load(File.ReadAllBytes(TestPaths.Example("knight.obone")));

        [Fact]
        public void SkeletonYUpMapsToScreenYDown()
        {
            var v = new SkeletonView(new Vector2(100, 200), 2);
            Assert.Equal(new Vector2(100, 200), v.SkeletonToScreen(0, 0));
            Assert.Equal(new Vector2(120, 180), v.SkeletonToScreen(10, 10));
            var back = v.ScreenToSkeleton(new Vector2(120, 180));
            Assert.Equal(10, back.X, 4);
            Assert.Equal(10, back.Y, 4);
        }

        [Fact]
        public void FlipAndRotationRoundTrip()
        {
            var v = new SkeletonView(new Vector2(50, 60), 1.5f) { Rotation = 0.7f, FlipX = true };
            var s = v.SkeletonToScreen(-33, 12);
            var k = v.ScreenToSkeleton(s);
            Assert.Equal(-33, k.X, 3);
            Assert.Equal(12, k.Y, 3);
        }

        [Fact]
        public void FitStageCentresTheDocumentCanvas()
        {
            var doc = Knight(); // 900 × 600, origin (400, 530)
            var v = SkeletonView.FitStage(doc, new Rectangle(0, 0, 1080, 720));
            Assert.Equal(1.2f, v.Scale, 4);
            // The canvas corners land on the viewport corners.
            var topLeft = v.SkeletonToScreen(-doc.OriginX, doc.OriginY);
            var bottomRight = v.SkeletonToScreen(doc.Width - doc.OriginX, doc.OriginY - doc.Height);
            Assert.Equal(0, topLeft.X, 3);
            Assert.Equal(0, topLeft.Y, 3);
            Assert.Equal(1080, bottomRight.X, 3);
            Assert.Equal(720, bottomRight.Y, 3);
            // The skeleton origin is the canvas's (originX, originY) pixel, scaled.
            Assert.Equal(new Vector2(480, 636), v.SkeletonToScreen(0, 0));
        }

        [Fact]
        public void FitStageLetterboxesAndPads()
        {
            var doc = Knight();
            var v = SkeletonView.FitStage(doc, new Rectangle(10, 0, 1000, 1000), 50);
            Assert.Equal(1f, v.Scale, 4); // (1000 − 100) / 900
            var centre = v.SkeletonToScreen(doc.Width / 2 - doc.OriginX, doc.OriginY - doc.Height / 2);
            Assert.Equal(510, centre.X, 3);
            Assert.Equal(500, centre.Y, 3);
        }

        [Fact]
        public void ClickOnTheBodyFiresTheAttackListener()
        {
            var doc = Knight();
            var inst = new OpenBoneInstance(doc);
            var sm = inst.UseStateMachine("knight");
            inst.Advance(0);
            var view = SkeletonView.FitStage(doc, new Rectangle(0, 0, 1080, 720));
            var tracker = new PointerTracker();
            var events = new List<PointerEvent>();
            var body = new Vector2(520, 460); // the torso (behind the shield) as the sample draws it
            tracker.Update(body, false, events);
            tracker.Update(body, true, events);
            tracker.Update(body, false, events);
            foreach (var e in events)
            {
                var p = view.ScreenToSkeleton(e.Position);
                inst.Pointer(e.Type, p.X, p.Y);
            }
            var states = new List<string>();
            inst.StateChanged += s => states.Add(s.To);
            inst.Advance(1 / 60.0);
            Assert.Contains("attack", states);
        }
    }

    public class PointerTrackerTests
    {
        [Fact]
        public void EmitsMoveThenButtonChanges()
        {
            var t = new PointerTracker();
            var e = new List<PointerEvent>();
            t.Update(new Vector2(1, 2), false, e);
            t.Update(new Vector2(1, 2), false, e);
            t.Update(new Vector2(3, 4), true, e);
            t.Update(new Vector2(3, 4), true, e);
            t.Update(new Vector2(3, 4), false, e);
            Assert.Equal(new[] { "move 1,2", "move 3,4", "down 3,4", "up 3,4" }, e.ConvertAll(x => $"{x.Type} {x.Position.X},{x.Position.Y}"));
        }

        [Fact]
        public void ResetReleasesAPressedPointer()
        {
            var t = new PointerTracker();
            var e = new List<PointerEvent>();
            t.Update(new Vector2(5, 5), true, e);
            e.Clear();
            t.Reset(e);
            Assert.Single(e);
            Assert.Equal("up", e[0].Type);
            Assert.False(t.IsDown);
        }
    }

    public class TextureTests
    {
        [Fact]
        public void PremultiplyRoundsPerChannel()
        {
            var px = new byte[] { 255, 128, 0, 128, 10, 20, 30, 255, 200, 200, 200, 0 };
            OpenBoneTextures.Premultiply(px);
            Assert.Equal(new byte[] { 128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0 }, px);
        }

        [Fact]
        public void ParticleDotIsPremultipliedWhite()
        {
            var px = OpenBoneTextures.ParticleDotPixels();
            int n = ParticleDot.Size;
            var centre = px[(n / 2) * n + n / 2];
            Assert.Equal(new Color(255, 255, 255, 255), centre);
            Assert.Equal(0, px[0].A);
            foreach (var c in px) Assert.True(c.R == c.A && c.G == c.A && c.B == c.A);
        }

        [Fact]
        public void DataUris()
        {
            Assert.True(DataUri.TryDecode("data:image/png;base64,AAEC", out var mime, out var bytes));
            Assert.Equal("image/png", mime);
            Assert.Equal(new byte[] { 0, 1, 2 }, bytes);
            Assert.True(DataUri.TryDecode("data:,", out _, out var empty));
            Assert.Empty(empty);
            Assert.False(DataUri.TryDecode("assets/a.png", out _, out _));
            Assert.False(DataUri.TryDecode("data:image/png;base64,***", out _, out _));
        }

        [Fact]
        public void FilesResolveRelativeToTheDocument()
        {
            var knight = TestPaths.Example("knight.obone");
            var dir = Path.GetDirectoryName(knight);
            var p = OpenBoneTextures.FindFile(dir, "assets/eleven/knight-torso.png", "knight-torso");
            Assert.NotNull(p);
            Assert.True(File.Exists(p));
            Assert.Null(OpenBoneTextures.FindFile(dir, "nope/missing.png", "missing-image-name"));
        }
    }

    public class TintEffectTests
    {
        [Fact]
        public void WritesAnOpenGLMgfxContainer()
        {
            var b = TintEffect.Bytes;
            Assert.Equal("MGFX", Encoding.ASCII.GetString(b, 0, 4));
            Assert.Equal(TintEffect.MgfxVersion, b[4]);
            Assert.Equal(TintEffect.OpenGLProfile, b[5]);
            Assert.Equal(TintEffect.Signature, BitConverter.ToInt32(b, b.Length - 4));
            var text = Encoding.ASCII.GetString(b);
            Assert.Contains("uniform vec4 vs_uniforms_vec4[4];", text);
            Assert.Contains("uniform vec4 posFixup;", text);
            Assert.Contains("uniform sampler2D ps_s0;", text);
            Assert.Contains("WorldViewProjection", text);
        }

        [Fact]
        public void ContainerParsesLikeMonoGameReadsIt()
        {
            // Walk the layout Effect.ReadEffect expects, so a writer mistake shows up without a GPU.
            var b = TintEffect.Bytes;
            using var r = new BinaryReader(new MemoryStream(b, 10, b.Length - 10));
            Assert.Equal(1, r.ReadInt32());
            Assert.Equal(TintEffect.ConstantBufferName, r.ReadString());
            Assert.Equal(64, r.ReadInt16());
            Assert.Equal(1, r.ReadInt32());
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(0, r.ReadUInt16());
            Assert.Equal(2, r.ReadInt32());
            for (int s = 0; s < 2; s++)
            {
                bool vertex = r.ReadBoolean();
                Assert.Equal(s == 0, vertex);
                r.ReadString();
                r.ReadString();
                var glsl = Encoding.ASCII.GetString(r.ReadBytes(r.ReadInt32()));
                Assert.Contains("void main()", glsl);
                int samplers = r.ReadByte();
                for (int i = 0; i < samplers; i++)
                {
                    r.ReadByte(); r.ReadByte(); r.ReadByte();
                    Assert.False(r.ReadBoolean());
                    Assert.Equal(TintEffect.SamplerName, r.ReadString());
                    Assert.Equal(1, r.ReadByte());
                }
                int cbuffers = r.ReadByte();
                for (int i = 0; i < cbuffers; i++) r.ReadByte();
                int attributes = r.ReadByte();
                Assert.Equal(vertex ? 4 : 0, attributes);
                for (int i = 0; i < attributes; i++)
                {
                    Assert.Equal("vs_v" + i, r.ReadString());
                    r.ReadByte(); r.ReadByte(); r.ReadInt16();
                }
            }
            Assert.Equal(2, r.ReadInt32());
            // WorldViewProjection: matrix of singles, identity default.
            Assert.Equal((byte)EffectParameterClass.Matrix, r.ReadByte());
            Assert.Equal((byte)EffectParameterType.Single, r.ReadByte());
            Assert.Equal("WorldViewProjection", r.ReadString());
            r.ReadString();
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(4, r.ReadByte());
            Assert.Equal(4, r.ReadByte());
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(0, r.ReadInt32());
            for (int i = 0; i < 16; i++) Assert.Equal(i % 5 == 0 ? 1f : 0f, r.ReadSingle());
            Assert.Equal((byte)EffectParameterClass.Object, r.ReadByte());
            Assert.Equal((byte)EffectParameterType.Texture2D, r.ReadByte());
            Assert.Equal("Texture", r.ReadString());
            r.ReadString();
            r.ReadInt32(); r.ReadByte(); r.ReadByte(); r.ReadInt32(); r.ReadInt32();
            Assert.Equal(1, r.ReadInt32());
            Assert.Equal("TwoColorTint", r.ReadString());
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(1, r.ReadInt32());
            Assert.Equal("P0", r.ReadString());
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(0, r.ReadInt32());
            Assert.Equal(1, r.ReadInt32());
            Assert.False(r.ReadBoolean());
            Assert.False(r.ReadBoolean());
            Assert.False(r.ReadBoolean());
            Assert.Equal(TintEffect.Signature, r.ReadInt32());
            Assert.Equal(r.BaseStream.Length, r.BaseStream.Position);
        }
    }
}
