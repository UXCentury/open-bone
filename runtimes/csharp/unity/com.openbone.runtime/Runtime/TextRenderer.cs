using System;
using System.Collections.Generic;
using UnityEngine;

namespace OpenBone.Unity
{
    /// <summary>
    /// Draws text attachments with legacy <see cref="TextMesh"/> children (no package dependency). Text is drawn on top of
    /// the skeleton mesh (one renderer cannot interleave), and glyph metrics come from Unity's font, not the browser's.
    /// For TextMesh Pro or your own text, turn this off on the component and handle <see cref="OpenBoneBehaviour.DrawListReady"/>.
    /// </summary>
    public sealed class TextRenderer
    {
        readonly Transform _parent;
        readonly List<TextMesh> _pool = new List<TextMesh>();
        Font _font;

        /// <summary>Font size TextMesh rasterises at; characterSize scales it to the attachment's size.</summary>
        const int RasterSize = 64;

        public TextRenderer(Transform parent)
        {
            _parent = parent;
        }

        public Font Font
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
            set => _font = value;
        }

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
                tm.font = Font;
                tm.fontSize = RasterSize;
                // TextMesh: line height ≈ characterSize × fontSize / 10 world units.
                tm.characterSize = (float)t.Size * s * 10f / RasterSize;
                tm.anchor = t.Align == "left" ? TextAnchor.MiddleLeft : t.Align == "right" ? TextAnchor.MiddleRight : TextAnchor.MiddleCenter;
                tm.alignment = t.Align == "left" ? TextAlignment.Left : t.Align == "right" ? TextAlignment.Right : TextAlignment.Center;
                if (t.Align == "left") tr.localPosition += tr.localRotation * new Vector3((float)(-t.Width / 2 * s) * sx, 0, 0);
                else if (t.Align == "right") tr.localPosition += tr.localRotation * new Vector3((float)(t.Width / 2 * s) * sx, 0, 0);
                var c = it.Color;
                tm.color = new Color((float)(t.Fill[0] * c[0]), (float)(t.Fill[1] * c[1]), (float)(t.Fill[2] * c[2]), (float)(t.Fill[3] * c[3]));
                var r = tm.GetComponent<MeshRenderer>();
                if (r != null)
                {
                    if (Font != null) r.sharedMaterial = Font.material;
                    r.sortingOrder = sortingOrder;
                }
            }
            for (int i = used; i < _pool.Count; i++) if (_pool[i] != null) _pool[i].gameObject.SetActive(false);
        }

        TextMesh Get(int i)
        {
            while (_pool.Count <= i)
            {
                var go = new GameObject("OpenBone Text") { hideFlags = HideFlags.DontSave };
                go.transform.SetParent(_parent, false);
                _pool.Add(go.AddComponent<TextMesh>());
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
        }
    }
}
