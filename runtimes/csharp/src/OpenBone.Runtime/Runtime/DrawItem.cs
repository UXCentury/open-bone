using System;

namespace OpenBone
{
    public sealed class TextureRect
    {
        public double X, Y, Width, Height;
    }

    public sealed class Stroke
    {
        public double[] Color;
        public double Width;
        public float[] Outline;
    }

    /// <summary>A clipping mask in world space (shared by consecutive items under it).</summary>
    public sealed class ClipRegion
    {
        public Slot Slot;
        public float[] Polygon;
        public ushort[] Indices;
    }

    public sealed class ParticleBatch
    {
        /// <summary>circle, square, spark or image.</summary>
        public string Look;
        public int Count;
    }

    /// <summary>A text attachment ready to draw (template already filled in).</summary>
    public sealed class TextDraw
    {
        public string Content, Font, Align;
        public double Size, Weight, Width, Height, OutlineWidth;
        public double[] Fill, Outline;
        /// <summary>Box centre → world (y-up).</summary>
        public Affine Matrix;
    }

    /// <summary>One renderable piece of geometry (runtime/skeleton.ts:DrawItem).</summary>
    public sealed class DrawItem
    {
        public Slot Slot;
        public Attachment Attachment;
        /// <summary>The image drawn (null = solid colour fill or built-in sprite).</summary>
        public ImageAsset Image;
        /// <summary>Texture to bind: the image or its atlas page (null = untextured).</summary>
        public ITexture Texture;
        /// <summary>Packed images: their rect inside the page (pixels, y-down).</summary>
        public TextureRect TextureRect;
        /// <summary>World x,y pairs (y-up skeleton space).</summary>
        public float[] Vertices;
        /// <summary>Texture space 0..1, v down.</summary>
        public float[] Uvs;
        public ushort[] Indices;
        /// <summary>RGBA tint (straight alpha).</summary>
        public double[] Color;
        /// <summary>Two-colour tint dark colour, or null (black).</summary>
        public double[] Dark;
        /// <summary>normal, additive, multiply or screen.</summary>
        public string Blend;
        public Stroke Stroke;
        public ClipRegion Clip;
        /// <summary>Per-vertex RGBA (particles); replaces <see cref="Color"/>.</summary>
        public float[] Colors;
        public ParticleBatch Particles;
        public TextDraw Text;

        /// <summary>What the suite records as the item's type: particles, text, or the attachment type.</summary>
        public string Type => Particles != null ? "particles" : Text != null ? "text" : Attachment.Type;
    }

    public static class ParticleDot
    {
        /// <summary>Texture id of the built-in soft round particle sprite; renderers generate it.</summary>
        public const string TextureId = "@openbone/particle-dot";
        public const int Size = 64;

        /// <summary>Alpha of the sprite at distance r from its centre (0 = centre, 1 = edge).</summary>
        public static double Alpha(double r) => r >= 1 ? 0 : Math.Pow(r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65, 1.6);
    }
}
