using System;
using System.Collections.Generic;
using UnityEngine;

namespace OpenBone.Unity
{
    /// <summary>
    /// Draws text attachments with legacy <see cref="TextMesh"/> children (no package dependency). Text is drawn on top of
    /// the skeleton mesh (one renderer cannot interleave), and glyph metrics come from Unity's font, not the browser's.
    /// Each text uses its own font list ("Noto Serif JP, Georgia, serif"): the installed families in it, generic names
    /// (serif, sans-serif, monospace) mapped to the system's usual ones, as a dynamic OS font (later families and the
    /// system fill in missing characters). Set <see cref="Font"/> to use one font for every text instead.
    /// TextMesh has no outline, so an outlined text gets a ring of outline-coloured copies, offset by the outline width,
    /// drawn just under the fill (like the MonoGame renderer).
    /// For TextMesh Pro or your own text, turn this off on the component and handle <see cref="OpenBoneBehaviour.DrawListReady"/>.
    /// </summary>
    public sealed class TextRenderer
    {
        readonly Transform _parent;
        readonly List<TextMesh> _pool = new List<TextMesh>();
        /// <summary>Outline copies of each pooled text (children of it).</summary>
        readonly List<List<TextMesh>> _rings = new List<List<TextMesh>>();
        Font _font, _userFont;
        readonly Dictionary<string, Font> _fonts = new Dictionary<string, Font>();
        static HashSet<string> _installed;

        /// <summary>Font size TextMesh rasterises at; characterSize scales it to the attachment's size.</summary>
        const int RasterSize = 64;

        public TextRenderer(Transform parent)
        {
            _parent = parent;
        }

        /// <summary>One font for every text (null: each text's own font list; Unity's built-in font when none is installed).</summary>
        public Font Font
        {
            get => _userFont != null ? _userFont : Builtin;
            set => _userFont = value;
        }

        Font Builtin
        {
            get
            {
                if (_font == null)
                {
                    try { _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"); }
                    catch (Exception) { /* older editors */ }
                    if (_font == null)
                    {
                        try { _font = Resources.GetBuiltinResource<Font>("Arial.ttf"); }
                        catch (Exception) { /* none */ }
                    }
                }
                return _font;
            }
        }

        static readonly string[] Serif = { "Noto Serif", "DejaVu Serif", "Liberation Serif", "Times New Roman", "Georgia", "Times" };
        static readonly string[] Sans = { "Noto Sans", "DejaVu Sans", "Liberation Sans", "Segoe UI", "Arial", "Helvetica Neue", "Helvetica" };
        static readonly string[] Mono = { "DejaVu Sans Mono", "Liberation Mono", "Consolas", "Menlo", "Courier New" };

        /// <summary>The font for a CSS family list, made once per list.</summary>
        public Font FontFor(string families)
        {
            if (_userFont != null || string.IsNullOrEmpty(families)) return Font;
            if (_fonts.TryGetValue(families, out var f)) return f;
            if (_installed == null)
            {
                _installed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                try { foreach (var n in Font.GetOSInstalledFontNames()) _installed.Add(n); }
                catch (Exception) { /* platform without OS fonts */ }
            }
            var names = new List<string>();
            foreach (var part in families.Split(','))
            {
                var n = part.Trim().Trim('"', '\'');
                if (n.Length == 0) continue;
                var lower = n.ToLowerInvariant();
                var cands = lower == "serif" || lower == "ui-serif" ? Serif
                    : lower == "sans-serif" || lower == "system-ui" || lower == "ui-sans-serif" ? Sans
                    : lower == "monospace" || lower == "ui-monospace" ? Mono
                    : new[] { n };
                foreach (var c in cands)
                    if (_installed.Contains(c) && !names.Contains(c)) names.Add(c);
            }
            f = null;
            if (names.Count > 0)
            {
                try { f = Font.CreateDynamicFontFromOSFont(names.ToArray(), RasterSize); }
                catch (Exception) { f = null; }
                if (f != null) f.hideFlags = HideFlags.DontSave;
            }
            if (f == null) f = Builtin;
            _fonts[families] = f;
            return f;
        }

        /// <param name="sortingOrder">Outlines draw at this order, fills at the next one.</param>
        public void Render(List<DrawItem> items, float pixelsPerUnit, int sortingOrder)
        {
            int used = 0;
            float s = pixelsPerUnit > 0 ? 1f / pixelsPerUnit : 1f;
            foreach (var it in items)
            {
                if (it.Text == null) continue;
                var tm = Get(used++);
                var t = it.Text;
                var m = t.Matrix;
                tm.gameObject.SetActive(true);
                var tr = tm.transform;
                tr.localPosition = new Vector3((float)m.X * s, (float)m.Y * s, 0);
                float sx = (float)Math.Sqrt(m.A * m.A + m.C * m.C), sy = (float)Math.Sqrt(m.B * m.B + m.D * m.D);
                tr.localRotation = Quaternion.Euler(0, 0, (float)(Math.Atan2(m.C, m.A) * 180 / Math.PI));
                tr.localScale = new Vector3(sx, sy, 1);
                tm.text = t.Content;
                tm.font = FontFor(t.Font);
                tm.fontSize = RasterSize;
                // TextMesh: line height ≈ characterSize × fontSize / 10 world units.
                tm.characterSize = (float)t.Size * s * 10f / RasterSize;
                tm.anchor = t.Align == "left" ? TextAnchor.MiddleLeft : t.Align == "right" ? TextAnchor.MiddleRight : TextAnchor.MiddleCenter;
                tm.alignment = t.Align == "left" ? TextAlignment.Left : t.Align == "right" ? TextAlignment.Right : TextAlignment.Center;
                if (t.Align == "left") tr.localPosition += tr.localRotation * new Vector3((float)(-t.Width / 2 * s) * sx, 0, 0);
                else if (t.Align == "right") tr.localPosition += tr.localRotation * new Vector3((float)(t.Width / 2 * s) * sx, 0, 0);
                var c = it.Color;
                tm.color = new Color((float)(t.Fill[0] * c[0]), (float)(t.Fill[1] * c[1]), (float)(t.Fill[2] * c[2]), (float)(t.Fill[3] * c[3]));
                Style(tm, sortingOrder + 1);

                // Outline: copies in the outline colour around the fill, in its own (scaled) frame.
                var ring = _rings[used - 1];
                int copies = 0;
                if (t.Outline != null && t.OutlineWidth > 0 && t.Outline[3] > 0 && sx > 1e-9 && sy > 1e-9)
                {
                    double ow = t.OutlineWidth * s;
                    // 8 directions for thin outlines, more for thick ones so the corners stay round.
                    copies = t.OutlineWidth > 3 ? 16 : 8;
                    var oc = new Color((float)(t.Outline[0] * c[0]), (float)(t.Outline[1] * c[1]), (float)(t.Outline[2] * c[2]), (float)(t.Outline[3] * c[3]));
                    for (int k = 0; k < copies; k++)
                    {
                        while (ring.Count <= k)
                        {
                            var go = new GameObject("OpenBone Text Outline") { hideFlags = HideFlags.DontSave };
                            go.transform.SetParent(tm.transform, false);
                            ring.Add(go.AddComponent<TextMesh>());
                        }
                        var o = ring[k];
                        o.gameObject.SetActive(true);
                        double ang = k * 2 * Math.PI / copies;
                        o.transform.localPosition = new Vector3((float)(Math.Cos(ang) * ow / sx), (float)(Math.Sin(ang) * ow / sy), 0);
                        o.transform.localRotation = Quaternion.Euler(0, 0, 0);
                        o.transform.localScale = new Vector3(1, 1, 1);
                        o.text = tm.text;
                        o.font = tm.font;
                        o.fontSize = tm.fontSize;
                        o.characterSize = tm.characterSize;
                        o.anchor = tm.anchor;
                        o.alignment = tm.alignment;
                        o.color = oc;
                        Style(o, sortingOrder);
                    }
                }
                for (int k = copies; k < ring.Count; k++) if (ring[k] != null) ring[k].gameObject.SetActive(false);
            }
            for (int i = used; i < _pool.Count; i++) if (_pool[i] != null) _pool[i].gameObject.SetActive(false);
        }

        void Style(TextMesh tm, int order)
        {
            var r = tm.GetComponent<MeshRenderer>();
            if (r == null) return;
            if (tm.font != null) r.sharedMaterial = tm.font.material;
            r.sortingOrder = order;
        }

        TextMesh Get(int i)
        {
            while (_pool.Count <= i)
            {
                var go = new GameObject("OpenBone Text") { hideFlags = HideFlags.DontSave };
                go.transform.SetParent(_parent, false);
                _pool.Add(go.AddComponent<TextMesh>());
                _rings.Add(new List<TextMesh>());
            }
            return _pool[i];
        }

        public void Dispose()
        {
            foreach (var t in _pool)
                if (t != null)
                {
                    if (Application.isPlaying) UnityEngine.Object.Destroy(t.gameObject);
                    else UnityEngine.Object.DestroyImmediate(t.gameObject);
                }
            _pool.Clear();
            _rings.Clear();
            foreach (var f in _fonts.Values)
                if (f != null && f != _font && f != _userFont)
                {
                    if (Application.isPlaying) UnityEngine.Object.Destroy(f);
                    else UnityEngine.Object.DestroyImmediate(f);
                }
            _fonts.Clear();
        }
    }
}
