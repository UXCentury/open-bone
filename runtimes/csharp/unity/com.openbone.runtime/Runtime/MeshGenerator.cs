using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace OpenBone.Unity
{
    /// <summary>
    /// Turns an OpenBone draw list into one Unity mesh with a submesh per run of items that share a texture, blend mode
    /// and clipping state. Clipping masks become stencil-writing submeshes (drawn before the clipped run and cleared
    /// after it). Two-colour tint goes in TEXCOORD1; per-vertex colours (particles) in COLOR.
    /// Text items are not meshed (see <see cref="TextRenderer"/>).
    /// </summary>
    public sealed class MeshGenerator
    {
        readonly List<Vector3> _pos = new List<Vector3>();
        readonly List<Color> _col = new List<Color>();
        readonly List<Vector2> _uv = new List<Vector2>();
        readonly List<Vector4> _dark = new List<Vector4>();
        readonly List<List<int>> _tris = new List<List<int>>();
        readonly HashSet<string> _warned = new HashSet<string>();
        int _sub;

        /// <summary>Called for each item whose texture id has no Texture2D in the asset (once per id).</summary>
        public Action<string> MissingTexture;

        enum Stencil { None, Test, Write, Clear }

        struct Key
        {
            public Texture2D Texture;
            public string Blend;
            public bool Pma;
            public Stencil Stencil;
            public bool Same(Key o) => Texture == o.Texture && Blend == o.Blend && Pma == o.Pma && Stencil == o.Stencil;
        }

        List<int> NewSubmesh(Key key, MaterialCache mats, List<Material> materials)
        {
            if (_sub == _tris.Count) _tris.Add(new List<int>());
            var t = _tris[_sub++];
            t.Clear();
            materials.Add(mats.Get(key.Texture, key.Blend, key.Pma, (int)key.Stencil));
            return t;
        }

        /// <summary>Fill <paramref name="mesh"/> and <paramref name="materials"/> from a draw list.</summary>
        public void Build(Mesh mesh, List<DrawItem> items, OpenBoneAsset asset, MaterialCache mats, float pixelsPerUnit, List<Material> materials)
        {
            _pos.Clear();
            _col.Clear();
            _uv.Clear();
            _dark.Clear();
            materials.Clear();
            _sub = 0;
            float s = pixelsPerUnit > 0 ? 1f / pixelsPerUnit : 1f;
            Key current = default;
            bool open = false;
            List<int> tris = null;
            ClipRegion clip = null;

            void Mask(ClipRegion region, Stencil mode)
            {
                var key = new Key { Texture = Texture2D.whiteTexture, Blend = "normal", Stencil = mode };
                var t = NewSubmesh(key, mats, materials);
                int baseIndex = _pos.Count;
                for (int i = 0; i + 1 < region.Polygon.Length; i += 2)
                {
                    _pos.Add(new Vector3(region.Polygon[i] * s, region.Polygon[i + 1] * s, 0));
                    _col.Add(Color.white);
                    _uv.Add(Vector2.zero);
                    _dark.Add(Vector4.zero);
                }
                foreach (var idx in region.Indices) t.Add(baseIndex + idx);
                open = false;
            }

            foreach (var it in items)
            {
                if (it.Text != null) continue;
                if (it.Clip != clip)
                {
                    if (clip != null) Mask(clip, Stencil.Clear);
                    clip = it.Clip;
                    if (clip != null) Mask(clip, Stencil.Write);
                }
                var tex = ResolveTexture(it.Texture, asset, out bool pma);
                if (tex == null) continue;
                var key = new Key { Texture = tex, Blend = it.Blend ?? "normal", Pma = pma, Stencil = clip != null ? Stencil.Test : Stencil.None };
                if (!open || !key.Same(current))
                {
                    tris = NewSubmesh(key, mats, materials);
                    current = key;
                    open = true;
                }
                AddItem(it, tris, s);
                if (it.Stroke != null && it.Stroke.Width > 0 && it.Stroke.Color[3] > 0)
                {
                    var skey = new Key { Texture = Texture2D.whiteTexture, Blend = key.Blend, Stencil = key.Stencil };
                    if (!skey.Same(current))
                    {
                        tris = NewSubmesh(skey, mats, materials);
                        current = skey;
                    }
                    AddStroke(it.Stroke, tris, s);
                }
            }
            if (clip != null) Mask(clip, Stencil.Clear);

            mesh.Clear();
            mesh.indexFormat = _pos.Count > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            mesh.SetVertices(_pos);
            mesh.SetColors(_col);
            mesh.SetUVs(0, _uv);
            mesh.SetUVs(1, _dark);
            mesh.subMeshCount = _sub;
            for (int i = 0; i < _sub; i++) mesh.SetTriangles(_tris[i], i, false);
            mesh.RecalculateBounds();
        }

        Texture2D ResolveTexture(ITexture t, OpenBoneAsset asset, out bool pma)
        {
            pma = false;
            if (t == null) return Texture2D.whiteTexture;
            if (t.Id == ParticleDot.TextureId) return ParticleDotTexture.Get();
            var e = asset.GetTexture(t.Id);
            if (e != null && e.texture != null)
            {
                pma = e.premultiplied;
                return e.texture;
            }
            if (_warned.Add(t.Id)) MissingTexture?.Invoke(t.Id);
            return null;
        }

        static Vector4 Dark(double[] d) => d == null ? Vector4.zero : new Vector4((float)d[0], (float)d[1], (float)d[2], 1);

        void AddItem(DrawItem it, List<int> tris, float s)
        {
            int baseIndex = _pos.Count;
            int n = it.Vertices.Length / 2;
            var color = new Color((float)it.Color[0], (float)it.Color[1], (float)it.Color[2], (float)it.Color[3]);
            var dark = Dark(it.Dark);
            for (int i = 0; i < n; i++)
            {
                _pos.Add(new Vector3(it.Vertices[i * 2] * s, it.Vertices[i * 2 + 1] * s, 0));
                _col.Add(it.Colors != null ? new Color(it.Colors[i * 4], it.Colors[i * 4 + 1], it.Colors[i * 4 + 2], it.Colors[i * 4 + 3]) : color);
                _uv.Add(i * 2 + 1 < it.Uvs.Length ? new Vector2(it.Uvs[i * 2], 1 - it.Uvs[i * 2 + 1]) : Vector2.zero);
                _dark.Add(dark);
            }
            foreach (var idx in it.Indices) tris.Add(baseIndex + idx);
        }

        /// <summary>A closed outline thickened to a band of the stroke width (centred on the outline).</summary>
        void AddStroke(Stroke st, List<int> tris, float s)
        {
            var o = st.Outline;
            int n = o.Length / 2;
            if (n < 2) return;
            var color = new Color((float)st.Color[0], (float)st.Color[1], (float)st.Color[2], (float)st.Color[3]);
            float half = (float)st.Width / 2;
            for (int i = 0; i < n; i++)
            {
                int j = (i + 1) % n;
                var a = new Vector2(o[i * 2], o[i * 2 + 1]);
                var b = new Vector2(o[j * 2], o[j * 2 + 1]);
                var d = b - a;
                float len = d.magnitude;
                if (len < 1e-6f) continue;
                var nrm = new Vector2(-d.y, d.x) / len * half;
                // Extend each segment by half the width so corners overlap instead of leaving notches.
                var ext = d / len * half;
                int bi = _pos.Count;
                foreach (var p in new[] { a - ext + nrm, b + ext + nrm, b + ext - nrm, a - ext - nrm })
                {
                    _pos.Add(new Vector3(p.x * s, p.y * s, 0));
                    _col.Add(color);
                    _uv.Add(new Vector2(0.5f, 0.5f));
                    _dark.Add(Vector4.zero);
                }
                tris.Add(bi); tris.Add(bi + 1); tris.Add(bi + 2);
                tris.Add(bi); tris.Add(bi + 2); tris.Add(bi + 3);
            }
        }
    }

    /// <summary>Materials per (texture, blend mode, premultiplied, stencil mode), all on the OpenBone/Skeleton shader.</summary>
    public sealed class MaterialCache : IDisposable
    {
        readonly Shader _shader;
        readonly Dictionary<(Texture2D, string, bool, int), Material> _cache = new Dictionary<(Texture2D, string, bool, int), Material>();

        public MaterialCache(Shader shader)
        {
            _shader = shader != null ? shader : Shader.Find("OpenBone/Skeleton");
        }

        /// <summary>stencil: 0 none, 1 test (clipped), 2 write mask, 3 clear mask.</summary>
        public Material Get(Texture2D texture, string blend, bool pma, int stencil)
        {
            var key = (texture, blend, pma, stencil);
            if (_cache.TryGetValue(key, out var m) && m != null) return m;
            m = new Material(_shader) { name = $"OpenBone {blend} {(texture != null ? texture.name : "white")}", hideFlags = HideFlags.DontSave };
            m.mainTexture = texture;
            m.SetFloat("_PMA", pma ? 1 : 0);
            BlendFactors(blend, out var src, out var dst);
            m.SetFloat("_SrcBlend", (float)src);
            m.SetFloat("_DstBlend", (float)dst);
            m.SetFloat("_StencilRef", 1);
            switch (stencil)
            {
                case 1:
                    m.SetFloat("_StencilComp", (float)CompareFunction.Equal);
                    m.SetFloat("_StencilOp", (float)StencilOp.Keep);
                    m.SetFloat("_ColorMask", 15);
                    break;
                case 2:
                case 3:
                    m.SetFloat("_StencilComp", (float)CompareFunction.Always);
                    m.SetFloat("_StencilOp", (float)(stencil == 2 ? StencilOp.Replace : StencilOp.Zero));
                    m.SetFloat("_ColorMask", 0);
                    break;
                default:
                    m.SetFloat("_StencilComp", (float)CompareFunction.Always);
                    m.SetFloat("_StencilOp", (float)StencilOp.Keep);
                    m.SetFloat("_ColorMask", 15);
                    break;
            }
            _cache[key] = m;
            return m;
        }

        /// <summary>Blend factors for premultiplied output (the shader always outputs rgb × a).</summary>
        public static void BlendFactors(string blend, out BlendMode src, out BlendMode dst)
        {
            switch (blend)
            {
                case "additive": src = BlendMode.One; dst = BlendMode.One; break;
                case "multiply": src = BlendMode.DstColor; dst = BlendMode.OneMinusSrcAlpha; break;
                case "screen": src = BlendMode.One; dst = BlendMode.OneMinusSrcColor; break;
                default: src = BlendMode.One; dst = BlendMode.OneMinusSrcAlpha; break;
            }
        }

        public void Dispose()
        {
            foreach (var m in _cache.Values)
                if (m != null)
                {
                    if (Application.isPlaying) UnityEngine.Object.Destroy(m);
                    else UnityEngine.Object.DestroyImmediate(m);
                }
            _cache.Clear();
        }
    }

    /// <summary>The built-in soft round particle sprite (white, straight alpha).</summary>
    public static class ParticleDotTexture
    {
        static Texture2D _tex;

        public static Texture2D Get()
        {
            if (_tex != null) return _tex;
            int n = ParticleDot.Size;
            _tex = new Texture2D(n, n, TextureFormat.RGBA32, false) { name = ParticleDot.TextureId, wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear, hideFlags = HideFlags.DontSave };
            var px = new Color32[n * n];
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    double dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
                    double a = ParticleDot.Alpha(Math.Sqrt(dx * dx + dy * dy));
                    px[y * n + x] = new Color32(255, 255, 255, (byte)Math.Round(Math.Max(0, Math.Min(1, a)) * 255));
                }
            _tex.SetPixels32(px);
            _tex.Apply();
            return _tex;
        }
    }
}
