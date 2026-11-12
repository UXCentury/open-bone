using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// Draws OpenBone text items with SpriteFonts (built by the MonoGame content pipeline, so premultiplied) through a
    /// SpriteBatch: the font is picked by family name, scaled to the item's size, aligned in its box (left, center,
    /// right; lines centred vertically), tinted with fill × slot colour, with an optional outline drawn as offset copies.
    /// Weight is ignored (pick a bold SpriteFont through <see cref="FontFor"/>).
    /// </summary>
    public sealed class SpriteFontTextRenderer : IOpenBoneTextRenderer
    {
        readonly SpriteBatch _batch;

        /// <summary>The font for a text item (family name, weight); null skips the item.</summary>
        public Func<string, double, SpriteFont> FontFor;

        public SpriteFontTextRenderer(SpriteBatch batch, SpriteFont font)
            : this(batch, (_, _) => font) { }

        public SpriteFontTextRenderer(SpriteBatch batch, Func<string, double, SpriteFont> fontFor)
        {
            _batch = batch ?? throw new ArgumentNullException(nameof(batch));
            FontFor = fontFor;
        }

        /// <summary>
        /// Text box space (centre origin, y down, one unit = one font pixel) → skeleton space → screen.
        /// <paramref name="scale"/> is skeleton units per font pixel.
        /// </summary>
        public static Matrix GlyphMatrix(TextDraw t, double scale, Matrix skeletonToScreen)
        {
            var m = t.Matrix ?? new Affine();
            var box = new Matrix(
                (float)m.A, (float)m.C, 0, 0,
                (float)m.B, (float)m.D, 0, 0,
                0, 0, 1, 0,
                (float)m.X, (float)m.Y, 0, 1);
            return Matrix.CreateScale((float)scale, -(float)scale, 1) * box * skeletonToScreen;
        }

        public void DrawText(DrawItem item, Matrix skeletonToScreen, DepthStencilState stencil)
        {
            var t = item.Text;
            if (t == null || string.IsNullOrEmpty(t.Content)) return;
            var font = FontFor?.Invoke(t.Font, t.Weight);
            if (font == null) return;
            double k = t.Size / Math.Max(1, font.LineSpacing);
            var matrix = GlyphMatrix(t, k, skeletonToScreen);
            var c = item.Color ?? new double[] { 1, 1, 1, 1 };
            var fill = t.Fill ?? new double[] { 1, 1, 1, 1 };
            var fillColor = DrawListMesher.Premultiply(fill[0] * c[0], fill[1] * c[1], fill[2] * c[2], fill[3] * c[3]);
            var lines = t.Content.Replace("\r", "").Split('\n');
            float lineHeight = font.LineSpacing;
            float top = -lines.Length * lineHeight / 2f;
            float halfBox = (float)(t.Width / 2 / k);

            _batch.Begin(SpriteSortMode.Deferred, RenderStates.ForBlend(item.Blend), SamplerState.LinearClamp, stencil, RenderStates.Raster(_batch.GraphicsDevice), null, matrix);
            for (int pass = 0; pass < 2; pass++)
            {
                bool outline = pass == 0;
                if (outline && (t.OutlineWidth <= 0 || t.Outline == null || t.Outline[3] <= 0)) continue;
                var color = outline ? DrawListMesher.Premultiply(t.Outline[0] * c[0], t.Outline[1] * c[1], t.Outline[2] * c[2], t.Outline[3] * c[3]) : fillColor;
                float ow = (float)(t.OutlineWidth / k);
                for (int i = 0; i < lines.Length; i++)
                {
                    var size = font.MeasureString(lines[i]);
                    float x = t.Align == "left" ? -halfBox : t.Align == "right" ? halfBox - size.X : -size.X / 2;
                    var pos = new Vector2(x, top + i * lineHeight);
                    if (!outline)
                    {
                        _batch.DrawString(font, lines[i], pos, color);
                        continue;
                    }
                    for (int a = 0; a < 8; a++)
                    {
                        double ang = a * Math.PI / 4;
                        _batch.DrawString(font, lines[i], pos + new Vector2((float)Math.Cos(ang) * ow, (float)Math.Sin(ang) * ow), color);
                    }
                }
            }
            _batch.End();
        }
    }
}
