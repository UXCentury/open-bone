using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using FontStashSharp;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// Draws OpenBone text items in the document's own fonts, loaded at runtime with FontStashSharp (no content
    /// pipeline). A text's font is a CSS family list ("Noto Serif JP, Georgia, serif"): each family is looked up in the
    /// files you <see cref="Register"/>, then among installed fonts (fontconfig on Linux, the font folders on Windows and
    /// macOS), and every family found joins one font system in list order, so characters the first font lacks (Japanese
    /// in a Latin font) come from the next. Glyphs are rasterised on demand. Outlines are drawn under the fill as a ring
    /// of offset copies, matching the web player's stroke. Weight is ignored.
    /// </summary>
    public sealed class FontStashTextRenderer : IOpenBoneTextRenderer, IDisposable
    {
        readonly SpriteBatch _batch;
        readonly Dictionary<string, string> _registered = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, FontSystem> _systems = new Dictionary<string, FontSystem>();
        /// <summary>Per family list: FontStashSharp's size unit (ascent to descent) per em of its first font.</summary>
        readonly Dictionary<string, float> _emScale = new Dictionary<string, float>();

        /// <summary>Glyphs are rasterised at this multiple of the text size, so text stays sharp when zoomed in.</summary>
        public float Oversample = 2f;

        public FontStashTextRenderer(SpriteBatch batch)
        {
            _batch = batch ?? throw new ArgumentNullException(nameof(batch));
        }

        /// <summary>Use this .ttf / .otf file for a family name (as the document writes it), before installed fonts.</summary>
        public FontStashTextRenderer Register(string family, string file)
        {
            _registered[family.Trim()] = file;
            foreach (var s in _systems.Values) s.Dispose();
            _systems.Clear();
            _emScale.Clear();
            return this;
        }

        public void DrawText(DrawItem item, Matrix skeletonToScreen, DepthStencilState stencil)
        {
            var t = item.Text;
            if (t == null || string.IsNullOrEmpty(t.Content)) return;
            var system = SystemFor(t.Font);
            if (system == null) return;
            // FontStashSharp sizes a font by its ascent-to-descent height, CSS by its em: convert so the em matches.
            float em = _emScale.TryGetValue(t.Font ?? "sans-serif", out var e) ? e : 1f;
            var font = system.GetFont(Math.Max(4, (float)t.Size * em * Oversample));
            double k = 1 / Oversample;  // skeleton units per glyph pixel
            var matrix = SpriteFontTextRenderer.GlyphMatrix(t, k, skeletonToScreen);
            var c = item.Color ?? new double[] { 1, 1, 1, 1 };
            var fill = t.Fill ?? new double[] { 1, 1, 1, 1 };
            var fillColor = DrawListMesher.Premultiply(fill[0] * c[0], fill[1] * c[1], fill[2] * c[2], fill[3] * c[3]);
            var lines = t.Content.Replace("\r", "").Split('\n');
            // Lines are 1.2 × size apart like the web player, centred in the box on each line's glyph box.
            float lineHeight = (float)(t.Size * 1.2 / k);
            float halfBox = (float)(t.Width / 2 / k);
            float first = -(lines.Length - 1) * lineHeight / 2f;
            bool outlined = t.OutlineWidth > 0 && t.Outline != null && t.Outline[3] > 0;
            var mb = font.TextBounds("Mg", Vector2.Zero);
            float middle = (mb.Y + mb.Y2) / 2f;

            _batch.Begin(SpriteSortMode.Deferred, RenderStates.ForBlend(item.Blend), SamplerState.LinearClamp, stencil, RenderStates.Raster(_batch.GraphicsDevice), null, matrix);
            for (int pass = outlined ? 0 : 1; pass < 2; pass++)
            {
                bool outline = pass == 0;
                var color = outline ? DrawListMesher.Premultiply(t.Outline[0] * c[0], t.Outline[1] * c[1], t.Outline[2] * c[2], t.Outline[3] * c[3]) : fillColor;
                float ow = (float)(t.OutlineWidth / k);
                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].Length == 0) continue;
                    var b = font.TextBounds(lines[i], Vector2.Zero);
                    float w = b.X2 - b.X;
                    float x = t.Align == "left" ? -halfBox : t.Align == "right" ? halfBox - w : -w / 2;
                    // Every line of a font shares one middle (that of "Mg"), like the canvas's "middle" baseline.
                    var pos = new Vector2(x - b.X, first + i * lineHeight - middle);
                    if (!outline)
                    {
                        font.DrawText(_batch, lines[i], pos, color);
                        continue;
                    }
                    int rings = ow > 4 ? 2 : 1;
                    for (int r = 1; r <= rings; r++)
                        for (int a = 0; a < 16; a++)
                        {
                            double ang = a * Math.PI / 8, rad = ow * r / rings;
                            font.DrawText(_batch, lines[i], pos + new Vector2((float)(Math.Cos(ang) * rad), (float)(Math.Sin(ang) * rad)), color);
                        }
                }
            }
            _batch.End();
        }

        /// <summary>The font system for a CSS family list: its installed / registered families, in order.</summary>
        FontSystem SystemFor(string families)
        {
            families ??= "sans-serif";
            if (_systems.TryGetValue(families, out var sys)) return sys;
            var faces = new List<FontFiles.Face>();
            foreach (var fam in SplitFamilies(families).Append("sans-serif"))
            {
                var face = _registered.TryGetValue(fam, out var reg) ? new FontFiles.Face(reg, 0) : FontFiles.Find(fam);
                if (face != null && File.Exists(face.Path) && !faces.Contains(face)) faces.Add(face);
            }
            sys = null;
            foreach (var f in faces)
            {
                try
                {
                    var bytes = FontFiles.ReadFace(f);
                    if (bytes == null) continue;
                    if (sys == null) _emScale[families] = FontFiles.HeightPerEm(bytes);
                    sys ??= new FontSystem();
                    sys.AddFont(bytes);
                }
                catch (Exception) { /* unreadable or unsupported font file */ }
            }
            _systems[families] = sys;
            return sys;
        }

        /// <summary>A CSS font-family list as names, without quotes.</summary>
        public static IEnumerable<string> SplitFamilies(string list) =>
            list.Split(',').Select(p => p.Trim().Trim('"', '\'')).Where(p => p.Length > 0);

        public void Dispose()
        {
            foreach (var s in _systems.Values) s?.Dispose();
            _systems.Clear();
        }
    }

    /// <summary>Installed font files by family name (generic serif / sans-serif / monospace included).</summary>
    public static class FontFiles
    {
        /// <summary>A font file and the face in it (collections such as .ttc hold several).</summary>
        public sealed record Face(string Path, int Index);

        static readonly Dictionary<string, Face> Cache = new Dictionary<string, Face>(StringComparer.OrdinalIgnoreCase);

        /// <summary>(hhea ascender − descender) / head unitsPerEm of a single font, 1 when the tables can't be read.</summary>
        public static float HeightPerEm(byte[] font)
        {
            try
            {
                int U16(int o) => font[o] << 8 | font[o + 1];
                int tables = U16(4);
                int head = -1, hhea = -1;
                for (int i = 0; i < tables; i++)
                {
                    int rec = 12 + 16 * i;
                    string tag = System.Text.Encoding.ASCII.GetString(font, rec, 4);
                    int offset = font[rec + 8] << 24 | font[rec + 9] << 16 | font[rec + 10] << 8 | font[rec + 11];
                    if (tag == "head") head = offset;
                    else if (tag == "hhea") hhea = offset;
                }
                if (head < 0 || hhea < 0) return 1;
                int unitsPerEm = U16(head + 18);
                int ascender = (short)U16(hhea + 4), descender = (short)U16(hhea + 6);
                return unitsPerEm > 0 && ascender - descender > 0 ? (float)(ascender - descender) / unitsPerEm : 1;
            }
            catch (Exception) { return 1; }
        }

        /// <summary>
        /// The bytes of one face as a standalone font: the file itself, or for a collection (.ttc, "ttcf") the chosen
        /// face's tables copied into a font of their own, since FontStashSharp reads single fonts only.
        /// </summary>
        public static byte[] ReadFace(Face face)
        {
            var data = File.ReadAllBytes(face.Path);
            if (data.Length < 12 || data[0] != 't' || data[1] != 't' || data[2] != 'c' || data[3] != 'f') return data;
            uint U32(int o) => (uint)(data[o] << 24 | data[o + 1] << 16 | data[o + 2] << 8 | data[o + 3]);
            int U16(int o) => data[o] << 8 | data[o + 1];
            int count = (int)U32(8);
            if (face.Index < 0 || face.Index >= count) return null;
            int dir = (int)U32(12 + 4 * face.Index);
            int tables = U16(dir + 4);
            int headerSize = 12 + 16 * tables;
            var entries = new List<(int rec, int offset, int length)>();
            for (int i = 0; i < tables; i++)
            {
                int rec = dir + 12 + 16 * i;
                entries.Add((rec, (int)U32(rec + 8), (int)U32(rec + 12)));
            }
            int total = headerSize + entries.Sum(e => (e.length + 3) & ~3);
            var outBytes = new byte[total];
            Array.Copy(data, dir, outBytes, 0, 12);
            int pos = headerSize;
            for (int i = 0; i < entries.Count; i++)
            {
                var (rec, offset, length) = entries[i];
                int outRec = 12 + 16 * i;
                Array.Copy(data, rec, outBytes, outRec, 8);  // tag + checksum
                outBytes[outRec + 8] = (byte)(pos >> 24); outBytes[outRec + 9] = (byte)(pos >> 16);
                outBytes[outRec + 10] = (byte)(pos >> 8); outBytes[outRec + 11] = (byte)pos;
                Array.Copy(data, rec + 12, outBytes, outRec + 12, 4);  // length
                Array.Copy(data, offset, outBytes, pos, length);
                pos += (length + 3) & ~3;
            }
            return outBytes;
        }
        static readonly string[] Generic = { "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace" };

        public static Face Find(string family)
        {
            lock (Cache)
            {
                if (Cache.TryGetValue(family, out var hit)) return hit;
                Face file = null;
                try { file = OperatingSystem.IsLinux() ? FontConfig(family) : ScanFolders(family); }
                catch (Exception) { file = null; }
                Cache[family] = file;
                return file;
            }
        }

        /// <summary>Linux: fontconfig's match, kept only when it is that family (it always answers something).</summary>
        static Face FontConfig(string family)
        {
            var fam = family.ToLowerInvariant();
            bool generic = Array.IndexOf(Generic, fam) >= 0;
            string query = fam == "system-ui" || fam == "ui-sans-serif" ? "sans-serif" : fam == "ui-serif" ? "serif" : fam == "ui-monospace" ? "monospace" : family;
            var psi = new ProcessStartInfo("fc-match", new[] { "-f", "%{family}\n%{file}\n%{index}\n", query })
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p == null) return null;
            var lines = p.StandardOutput.ReadToEnd().Split('\n');
            p.WaitForExit(5000);
            if (lines.Length < 3) return null;
            bool named = generic || lines[0].Split(',').Any(n => string.Equals(n.Trim(), family, StringComparison.OrdinalIgnoreCase));
            if (!named || !File.Exists(lines[1])) return null;
            return new Face(lines[1], int.TryParse(lines[2].Trim(), out var index) ? index : 0);
        }

        /// <summary>Windows and macOS: font files whose names start with the family name (spaces and dashes ignored).</summary>
        static Face ScanFolders(string family)
        {
            var fam = family.ToLowerInvariant();
            bool win = OperatingSystem.IsWindows();
            var dirs = new List<string>();
            if (win)
            {
                dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Fonts));
                var local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (local != null) dirs.Add(Path.Combine(local, "Microsoft", "Windows", "Fonts"));
            }
            else
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                dirs.AddRange(new[] { "/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", Path.Combine(home, "Library/Fonts") });
            }
            string[] names = fam switch
            {
                "serif" or "ui-serif" => new[] { "times", "georgia" },
                "monospace" or "ui-monospace" => win ? new[] { "consola", "cour" } : new[] { "menlo", "courier" },
                "sans-serif" or "system-ui" or "ui-sans-serif" => win ? new[] { "segoeui", "arial" } : new[] { "helvetica", "arial" },
                _ => new[] { Bare(fam) },
            };
            foreach (var want in names)
                foreach (var d in dirs.Where(Directory.Exists))
                {
                    string hit = null;
                    foreach (var f in Directory.EnumerateFiles(d))
                    {
                        var n = Path.GetFileName(f).ToLowerInvariant();
                        if (!(n.EndsWith(".ttf") || n.EndsWith(".otf") || n.EndsWith(".ttc"))) continue;
                        var bare = Bare(n);
                        if (!bare.StartsWith(want)) continue;
                        if (hit == null || bare.Contains("regular") || (n.Length < Path.GetFileName(hit).Length && !hit.ToLowerInvariant().Contains("regular"))) hit = f;
                    }
                    if (hit != null) return new Face(hit, 0);
                }
            return null;
        }

        static string Bare(string s) => new string(s.Where(ch => ch != ' ' && ch != '-' && ch != '_').ToArray());
    }
}
