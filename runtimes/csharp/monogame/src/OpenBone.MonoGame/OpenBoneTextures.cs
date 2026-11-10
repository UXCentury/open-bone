using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// The textures a document's draw list names, by id: atlas pages and loose images, decoded from data: URIs or
    /// loaded from files relative to the document (their <c>src</c>, else <c>&lt;name&gt;.png</c> next to it or in an
    /// <c>images/</c> folder). Every texture is stored premultiplied: straight images are premultiplied on load, atlas
    /// pages packed with premultipliedAlpha are uploaded as they are.
    /// </summary>
    public sealed class OpenBoneTextures : IDisposable
    {
        readonly Dictionary<string, Texture2D> _byId = new Dictionary<string, Texture2D>();
        readonly List<Texture2D> _owned = new List<Texture2D>();
        readonly GraphicsDevice _device;

        /// <summary>1×1 white, for solid fills, strokes and clip masks.</summary>
        public Texture2D White { get; }
        /// <summary>The built-in soft round particle sprite.</summary>
        public Texture2D ParticleDot { get; }
        /// <summary>Ids that could not be loaded, with the reason.</summary>
        public readonly List<string> Warnings = new List<string>();

        public OpenBoneTextures(GraphicsDevice device)
        {
            _device = device;
            White = Own(new Texture2D(device, 1, 1));
            White.SetData(new[] { Color.White });
            int n = OpenBone.ParticleDot.Size;
            ParticleDot = Own(new Texture2D(device, n, n));
            ParticleDot.SetData(ParticleDotPixels());
        }

        /// <summary>Load every texture of <paramref name="doc"/>; files resolve against <paramref name="baseDirectory"/>.</summary>
        public static OpenBoneTextures Load(GraphicsDevice device, Document doc, string baseDirectory)
        {
            var t = new OpenBoneTextures(device);
            t.LoadDocument(doc, baseDirectory);
            return t;
        }

        public void LoadDocument(Document doc, string baseDirectory)
        {
            var packed = new HashSet<string>();
            if (doc.Atlas != null)
            {
                foreach (var r in doc.Atlas.Regions) if (r.Image != null) packed.Add(r.Image);
                foreach (var page in doc.Atlas.Pages) LoadTexture(page, baseDirectory, doc.Atlas.PremultipliedAlpha);
            }
            foreach (var img in doc.Images)
                if (!packed.Contains(img.Id) || !string.IsNullOrEmpty(img.Src)) LoadTexture(img, baseDirectory, false);
        }

        /// <summary>Use your own texture for an id (premultiplied alpha).</summary>
        public void Set(string id, Texture2D texture) => _byId[id] = texture;

        /// <summary>The texture for a draw item's texture (null = white); null when the id has no texture.</summary>
        public Texture2D Get(ITexture texture) => texture == null ? White : Get(texture.Id);

        public Texture2D Get(string id)
        {
            if (id == null) return White;
            if (id == OpenBone.ParticleDot.TextureId) return ParticleDot;
            return _byId.TryGetValue(id, out var t) ? t : null;
        }

        public bool Has(ITexture texture) => Get(texture) != null;

        void LoadTexture(ITexture t, string baseDirectory, bool premultiplied)
        {
            if (t.Id == null || _byId.ContainsKey(t.Id)) return;
            try
            {
                byte[] bytes = null;
                if (DataUri.TryDecode(t.Src, out _, out var data))
                {
                    if (data.Length <= 3) return; // "data:," placeholders (layout-only pages)
                    bytes = data;
                }
                else
                {
                    var path = FindFile(baseDirectory, t.Src, t.Name);
                    if (path == null)
                    {
                        Warnings.Add($"no image for \"{t.Name ?? t.Id}\" ({t.Src})");
                        return;
                    }
                    bytes = File.ReadAllBytes(path);
                }
                using var stream = new MemoryStream(bytes);
                var tex = premultiplied
                    ? Texture2D.FromStream(_device, stream, _ => { })
                    : Texture2D.FromStream(_device, stream, Premultiply);
                tex.Name = t.Name ?? t.Id;
                _byId[t.Id] = Own(tex);
            }
            catch (Exception e)
            {
                Warnings.Add($"cannot load image \"{t.Name ?? t.Id}\": {e.Message}");
            }
        }

        /// <summary>The file an image or page refers to, or null.</summary>
        public static string FindFile(string baseDirectory, string src, string name)
        {
            baseDirectory ??= "";
            if (!string.IsNullOrEmpty(src) && !src.Contains("://") && !src.StartsWith("data:", StringComparison.Ordinal))
            {
                var p = Path.IsPathRooted(src) ? src : Path.Combine(baseDirectory, src);
                if (File.Exists(p)) return p;
            }
            if (!string.IsNullOrEmpty(name))
                foreach (var ext in new[] { ".png", ".jpg", ".jpeg", ".webp" })
                {
                    string file = name.EndsWith(ext, StringComparison.OrdinalIgnoreCase) ? name : name + ext;
                    foreach (var p in new[] { Path.Combine(baseDirectory, file), Path.Combine(baseDirectory, "images", file) })
                        if (File.Exists(p)) return p;
                }
            return null;
        }

        /// <summary>RGBA8 pixels → premultiplied in place (rgb × a, rounded).</summary>
        public static void Premultiply(byte[] rgba)
        {
            for (int i = 0; i + 3 < rgba.Length; i += 4)
            {
                int a = rgba[i + 3];
                if (a == 255) continue;
                rgba[i] = (byte)((rgba[i] * a + 127) / 255);
                rgba[i + 1] = (byte)((rgba[i + 1] * a + 127) / 255);
                rgba[i + 2] = (byte)((rgba[i + 2] * a + 127) / 255);
            }
        }

        /// <summary>The particle sprite: white, premultiplied.</summary>
        public static Color[] ParticleDotPixels()
        {
            int n = OpenBone.ParticleDot.Size;
            var px = new Color[n * n];
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    double dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
                    double a = OpenBone.ParticleDot.Alpha(Math.Sqrt(dx * dx + dy * dy));
                    byte b = (byte)Math.Round(Math.Max(0, Math.Min(1, a)) * 255);
                    px[y * n + x] = new Color(b, b, b, b);
                }
            return px;
        }

        Texture2D Own(Texture2D t)
        {
            _owned.Add(t);
            return t;
        }

        public void Dispose()
        {
            foreach (var t in _owned) t.Dispose();
            _owned.Clear();
            _byId.Clear();
        }
    }

    /// <summary>data: URI decoding (base64, as OpenBone writes them).</summary>
    public static class DataUri
    {
        public static bool TryDecode(string src, out string mime, out byte[] bytes)
        {
            mime = null;
            bytes = null;
            if (string.IsNullOrEmpty(src) || !src.StartsWith("data:", StringComparison.Ordinal)) return false;
            int comma = src.IndexOf(',');
            if (comma < 0) return false;
            string head = src.Substring(5, comma - 5);
            if (!head.EndsWith(";base64", StringComparison.Ordinal))
            {
                // "data:," placeholders: no bytes.
                mime = head;
                bytes = Array.Empty<byte>();
                return head.Length == 0 && comma == src.Length - 1;
            }
            mime = head.Substring(0, head.Length - 7);
            try
            {
                bytes = Convert.FromBase64String(src.Substring(comma + 1));
                return true;
            }
            catch (FormatException)
            {
                return false;
            }
        }
    }
}
