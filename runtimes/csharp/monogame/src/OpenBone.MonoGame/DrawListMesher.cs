using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;

namespace OpenBone.MonoGame
{
    /// <summary>How a batch uses the stencil buffer (clipping masks).</summary>
    public enum StencilMode
    {
        /// <summary>No clipping.</summary>
        None,
        /// <summary>Clipped: drawn only where the mask was written.</summary>
        Test,
        /// <summary>A clip polygon writing the mask (no colour).</summary>
        Write,
        /// <summary>The same polygon clearing the mask again after the clipped run.</summary>
        Clear,
    }

    /// <summary>A run of geometry drawn with one texture, blend mode and stencil mode, or one text item.</summary>
    public sealed class DrawBatch
    {
        /// <summary>Texture id (image or atlas page id, or <see cref="ParticleDot.TextureId"/>); null = white.</summary>
        public string TextureId;
        /// <summary>normal, additive, multiply or screen.</summary>
        public string Blend = "normal";
        public StencilMode Stencil;
        /// <summary>First vertex in <see cref="DrawListMesher.Vertices"/>; the batch's indices are relative to it.</summary>
        public int VertexStart, VertexCount;
        public int IndexStart, IndexCount;
        /// <summary>A text item (no geometry): draw it through a text hook.</summary>
        public DrawItem Text;
        /// <summary>Whether the batch holds two-colour-tinted vertices (needs the tint effect to look right).</summary>
        public bool HasDark;

        public int PrimitiveCount => IndexCount / 3;
    }

    /// <summary>
    /// Turns an OpenBone draw list into one vertex array, one 16-bit index array and a list of batches (no graphics
    /// device needed). Positions stay in skeleton space (y up); colours are premultiplied; clipping masks become
    /// stencil write / clear batches around the items they clip.
    /// </summary>
    public sealed class DrawListMesher
    {
        /// <summary>Most vertices in one batch (16-bit indices).</summary>
        public const int MaxBatchVertices = 65535;

        OpenBoneVertex[] _vertices = new OpenBoneVertex[1024];
        short[] _indices = new short[2048];
        int _batchCount;
        readonly List<DrawBatch> _pool = new List<DrawBatch>();
        DrawBatch _open;

        public OpenBoneVertex[] Vertices => _vertices;
        public int VertexCount { get; private set; }
        public short[] Indices => _indices;
        public int IndexCount { get; private set; }

        /// <summary>The batches of the last <see cref="Build"/> (reused between frames).</summary>
        public IReadOnlyList<DrawBatch> Batches => _pool.GetRange(0, _batchCount);
        public int BatchCount => _batchCount;
        public DrawBatch Batch(int i) => _pool[i];

        /// <summary>Optional filter: items whose texture it rejects (missing art) are skipped.</summary>
        public Func<ITexture, bool> CanDraw;

        /// <summary>Include text items as text batches (false: skip them).</summary>
        public bool IncludeText = true;

        public void Build(IReadOnlyList<DrawItem> items)
        {
            VertexCount = 0;
            IndexCount = 0;
            _batchCount = 0;
            _open = null;
            ClipRegion clip = null;
            foreach (var it in items)
            {
                if (it.Clip != clip)
                {
                    if (clip != null) Mask(clip, StencilMode.Clear);
                    clip = it.Clip;
                    if (clip != null) Mask(clip, StencilMode.Write);
                }
                var stencil = clip != null ? StencilMode.Test : StencilMode.None;
                string blend = it.Blend ?? "normal";
                if (it.Text != null)
                {
                    if (!IncludeText) continue;
                    var b = NewBatch(null, blend, stencil);
                    b.Text = it;
                    _open = null;
                    continue;
                }
                if (it.Vertices == null || it.Indices == null) continue;
                if (it.Texture != null && CanDraw != null && !CanDraw(it.Texture)) continue;
                string tex = it.Texture?.Id;
                AddItem(it, tex, blend, stencil);
                if (it.Stroke != null && it.Stroke.Width > 0 && it.Stroke.Color != null && it.Stroke.Color[3] > 0)
                    AddStroke(it.Stroke, blend, stencil);
            }
            if (clip != null) Mask(clip, StencilMode.Clear);
        }

        DrawBatch NewBatch(string texture, string blend, StencilMode stencil)
        {
            if (_batchCount == _pool.Count) _pool.Add(new DrawBatch());
            var b = _pool[_batchCount++];
            b.TextureId = texture;
            b.Blend = blend;
            b.Stencil = stencil;
            b.VertexStart = VertexCount;
            b.VertexCount = 0;
            b.IndexStart = IndexCount;
            b.IndexCount = 0;
            b.Text = null;
            b.HasDark = false;
            return b;
        }

        /// <summary>The open batch if it matches and has room for <paramref name="vertices"/> more, else a new one.</summary>
        DrawBatch Target(string texture, string blend, StencilMode stencil, int vertices)
        {
            var b = _open;
            if (b == null || b.TextureId != texture || b.Blend != blend || b.Stencil != stencil || b.VertexCount + vertices > MaxBatchVertices)
                b = _open = NewBatch(texture, blend, stencil);
            return b;
        }

        void Reserve(int vertices, int indices)
        {
            if (VertexCount + vertices > _vertices.Length) Array.Resize(ref _vertices, Math.Max(_vertices.Length * 2, VertexCount + vertices));
            if (IndexCount + indices > _indices.Length) Array.Resize(ref _indices, Math.Max(_indices.Length * 2, IndexCount + indices));
        }

        void Mask(ClipRegion region, StencilMode mode)
        {
            int n = region.Polygon.Length / 2;
            var b = NewBatch(null, "normal", mode);
            _open = null;
            Reserve(n, region.Indices.Length);
            for (int i = 0; i < n; i++)
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(region.Polygon[i * 2], region.Polygon[i * 2 + 1], 0), Color.White, Vector2.Zero, Color.Black);
            foreach (var idx in region.Indices) _indices[IndexCount++] = (short)idx;
            b.VertexCount = n;
            b.IndexCount = region.Indices.Length;
        }

        void AddItem(DrawItem it, string texture, string blend, StencilMode stencil)
        {
            int n = it.Vertices.Length / 2;
            if (n == 0 || it.Indices.Length == 0) return;
            if (n > MaxBatchVertices) return; // cannot happen with 16-bit draw-list indices
            var b = Target(texture, blend, stencil, n);
            Reserve(n, it.Indices.Length);
            int local = b.VertexCount;
            var color = it.Color ?? White;
            var itemColor = Premultiply(color[0], color[1], color[2], color[3]);
            var itemDark = Dark(it.Dark, color[3]);
            if (it.Dark != null && (it.Dark[0] > 0 || it.Dark[1] > 0 || it.Dark[2] > 0)) b.HasDark = true;
            var uvs = it.Uvs;
            var cols = it.Colors;
            for (int i = 0; i < n; i++)
            {
                Color c = itemColor, d = itemDark;
                if (cols != null && i * 4 + 3 < cols.Length)
                {
                    c = Premultiply(cols[i * 4], cols[i * 4 + 1], cols[i * 4 + 2], cols[i * 4 + 3]);
                    d = Dark(it.Dark, cols[i * 4 + 3]);
                }
                var uv = uvs != null && i * 2 + 1 < uvs.Length ? new Vector2(uvs[i * 2], uvs[i * 2 + 1]) : Vector2.Zero;
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(it.Vertices[i * 2], it.Vertices[i * 2 + 1], 0), c, uv, d);
            }
            foreach (var idx in it.Indices) _indices[IndexCount++] = (short)(ushort)(local + idx);
            b.VertexCount += n;
            b.IndexCount += it.Indices.Length;
        }

        /// <summary>A closed outline thickened to a band of the stroke width (centred on the outline), untextured.</summary>
        void AddStroke(Stroke st, string blend, StencilMode stencil)
        {
            var o = st.Outline;
            int n = o == null ? 0 : o.Length / 2;
            if (n < 2) return;
            var color = Premultiply(st.Color[0], st.Color[1], st.Color[2], st.Color[3]);
            float half = (float)st.Width / 2;
            for (int i = 0; i < n; i++)
            {
                int j = (i + 1) % n;
                var a = new Vector2(o[i * 2], o[i * 2 + 1]);
                var c = new Vector2(o[j * 2], o[j * 2 + 1]);
                var d = c - a;
                float len = d.Length();
                if (len < 1e-6f) continue;
                var nrm = new Vector2(-d.Y, d.X) / len * half;
                // Extend each segment by half the width so corners overlap instead of leaving notches.
                var ext = d / len * half;
                var b = Target(null, blend, stencil, 4);
                Reserve(4, 6);
                int bi = b.VertexCount;
                var uv = new Vector2(0.5f, 0.5f);
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(a - ext + nrm, 0), color, uv, Color.Black);
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(c + ext + nrm, 0), color, uv, Color.Black);
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(c + ext - nrm, 0), color, uv, Color.Black);
                _vertices[VertexCount++] = new OpenBoneVertex(new Vector3(a - ext - nrm, 0), color, uv, Color.Black);
                _indices[IndexCount++] = (short)bi;
                _indices[IndexCount++] = (short)(bi + 1);
                _indices[IndexCount++] = (short)(bi + 2);
                _indices[IndexCount++] = (short)bi;
                _indices[IndexCount++] = (short)(bi + 2);
                _indices[IndexCount++] = (short)(bi + 3);
                b.VertexCount += 4;
                b.IndexCount += 6;
            }
        }

        static readonly double[] White = { 1, 1, 1, 1 };

        static byte Byte(double v) => (byte)Math.Round(Math.Max(0, Math.Min(1, v)) * 255);

        /// <summary>A straight-alpha colour as a premultiplied <see cref="Color"/> (rgb × a, a).</summary>
        public static Color Premultiply(double r, double g, double b, double a)
        {
            a = Math.Max(0, Math.Min(1, a));
            return new Color(Byte(r * a), Byte(g * a), Byte(b * a), Byte(a));
        }

        /// <summary>The two-colour tint dark colour premultiplied by the vertex alpha (black when there is none).</summary>
        public static Color Dark(double[] dark, double alpha)
        {
            if (dark == null) return new Color((byte)0, (byte)0, (byte)0, (byte)255);
            alpha = Math.Max(0, Math.Min(1, alpha));
            return new Color(Byte(dark[0] * alpha), Byte(dark[1] * alpha), Byte(dark[2] * alpha), (byte)255);
        }
    }
}
