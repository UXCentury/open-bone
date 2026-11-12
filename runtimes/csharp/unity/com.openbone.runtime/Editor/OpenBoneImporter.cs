using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEngine;

namespace OpenBone.Unity.Editor
{
    /// <summary>
    /// Imports .obone (JSON) and .obonb (binary) files as an <see cref="OpenBoneAsset"/>. Textures: images and atlas
    /// pages embedded as data: URIs become sub-assets; others are looked up in the project relative to the file
    /// (their <c>src</c> path, else <c>&lt;name&gt;.png</c> next to it or in an <c>images/</c> folder). Audio: AudioClips
    /// at the asset's <c>src</c> are referenced; embedded WAVs are decoded at runtime. Fonts: .ttf / .otf files at the
    /// font's <c>src</c> are referenced; embedded fonts (data: URIs) are written once to a <c>&lt;document&gt;.fonts/</c>
    /// folder next to the file (Unity can't load font bytes at runtime), imported as Font assets, and the document is
    /// re-imported to reference them.
    /// </summary>
    [ScriptedImporter(3, new[] { "obone", "obonb" })]
    public sealed class OpenBoneImporter : ScriptedImporter
    {
        [Tooltip("Filter mode of textures embedded in the document.")]
        public FilterMode filterMode = FilterMode.Bilinear;

        public override void OnImportAsset(AssetImportContext ctx)
        {
            var bytes = File.ReadAllBytes(ctx.assetPath);
            Document doc;
            try
            {
                doc = DocumentLoader.Load(bytes);
            }
            catch (Exception e)
            {
                ctx.LogImportError($"OpenBone: {ctx.assetPath} is not a valid document: {e.Message}");
                return;
            }
            var asset = ScriptableObject.CreateInstance<OpenBoneAsset>();
            asset.name = Path.GetFileNameWithoutExtension(ctx.assetPath);
            asset.SetData(bytes);
            string dir = Path.GetDirectoryName(ctx.assetPath)?.Replace('\\', '/') ?? "";

            // Every texture the draw list can name: atlas pages, and images that aren't packed.
            var packed = new HashSet<string>();
            bool pma = false;
            if (doc.Atlas != null)
            {
                pma = doc.Atlas.PremultipliedAlpha;
                foreach (var r in doc.Atlas.Regions) if (r.Image != null) packed.Add(r.Image);
                foreach (var page in doc.Atlas.Pages) AddTexture(ctx, asset, dir, page, pma);
            }
            foreach (var img in doc.Images)
                if (!packed.Contains(img.Id) || !string.IsNullOrEmpty(img.Src)) AddTexture(ctx, asset, dir, img, false);

            if (doc.Audio != null)
                foreach (var a in doc.Audio.Assets)
                {
                    if (string.IsNullOrEmpty(a.Src) || a.Src.StartsWith("data:", StringComparison.Ordinal)) continue;
                    var clip = FindInProject<AudioClip>(ctx, dir, a.Src, a.Name, new[] { ".wav", ".ogg", ".mp3" });
                    if (clip != null) asset.AudioClips.Add(new OpenBoneAsset.AudioEntry { id = a.Id, clip = clip });
                    else ctx.LogImportWarning($"OpenBone: audio \"{a.Name}\" ({a.Src}) not found in the project");
                }

            ImportFonts(ctx, asset, doc, dir);

            ctx.AddObjectToAsset("document", asset);
            ctx.SetMainObject(asset);
        }

        void ImportFonts(AssetImportContext ctx, OpenBoneAsset asset, Document doc, string dir)
        {
            string folder = null;
            var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var pending = new List<(string path, byte[] data)>();
            foreach (var f in doc.Fonts)
            {
                if (string.IsNullOrEmpty(f.Family) || string.IsNullOrEmpty(f.Src)) continue;
                Font font;
                if (f.Src.StartsWith("data:", StringComparison.Ordinal))
                {
                    if (!DataUri.TryDecode(f.Src, out _, out var data) || data.Length < 4)
                    {
                        ctx.LogImportWarning($"OpenBone: font \"{f.Name}\" has unreadable embedded data");
                        continue;
                    }
                    string ext = FontExtension(data);
                    if (ext == null)
                    {
                        ctx.LogImportWarning($"OpenBone: font \"{f.Name}\" is not a TrueType / OpenType font (WOFF fonts work on the web only); \"{f.Family}\" uses installed fonts");
                        continue;
                    }
                    folder ??= (dir.Length > 0 ? dir + "/" : "") + Path.GetFileNameWithoutExtension(ctx.assetPath) + ".fonts";
                    string stem = SafeFileName(f.Name ?? f.Family);
                    if (!usedNames.Add(stem)) usedNames.Add(stem = stem + "-" + SafeFileName(f.Id ?? usedNames.Count.ToString()));
                    string path = folder + "/" + stem + ext;
                    // The file stays as written: when it already holds these bytes it is used, else it is (re)written.
                    if (File.Exists(path) && SameBytes(path, data))
                    {
                        ctx.DependsOnArtifact(path);
                        font = AssetDatabase.LoadAssetAtPath<Font>(path);
                    }
                    else
                    {
                        pending.Add((path, data));
                        continue;
                    }
                }
                else font = FindInProject<Font>(ctx, dir, f.Src, f.Name, new[] { ".ttf", ".otf" });
                if (font != null) asset.Fonts.Add(new OpenBoneAsset.FontEntry { family = f.Family, weight = (float)f.Weight, italic = f.Style == "italic", font = font });
                else ctx.LogImportWarning($"OpenBone: font \"{f.Name}\" ({(f.Src.StartsWith("data:", StringComparison.Ordinal) ? "embedded" : f.Src)}) not found in the project; \"{f.Family}\" uses installed fonts");
            }
            if (pending.Count > 0) WriteFontsLater(ctx.assetPath, pending);
        }

        /// <summary>
        /// Writes embedded fonts and re-imports the document once they are Font assets. Creating assets isn't allowed
        /// during an import, so this runs on the editor's next update.
        /// </summary>
        static void WriteFontsLater(string documentPath, List<(string path, byte[] data)> fonts)
        {
            EditorApplication.delayCall += () =>
            {
                try
                {
                    AssetDatabase.StartAssetEditing();
                    foreach (var (path, data) in fonts)
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        if (!File.Exists(path) || !SameBytes(path, data)) File.WriteAllBytes(path, data);
                        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
                    }
                }
                finally { AssetDatabase.StopAssetEditing(); }
                AssetDatabase.ImportAsset(documentPath, ImportAssetOptions.ForceUpdate);
            };
        }

        /// <summary>.ttf / .otf / .ttc by the font's first bytes; null for WOFF / WOFF2 and anything else.</summary>
        static string FontExtension(byte[] d)
        {
            if (d[0] == 0 && d[1] == 1 && d[2] == 0 && d[3] == 0) return ".ttf";
            if (d[0] == 't' && d[1] == 'r' && d[2] == 'u' && d[3] == 'e') return ".ttf";
            if (d[0] == 'O' && d[1] == 'T' && d[2] == 'T' && d[3] == 'O') return ".otf";
            if (d[0] == 't' && d[1] == 't' && d[2] == 'c' && d[3] == 'f') return ".ttc";
            return null;
        }

        static bool SameBytes(string path, byte[] data)
        {
            var info = new FileInfo(path);
            if (info.Length != data.Length) return false;
            var existing = File.ReadAllBytes(path);
            for (int i = 0; i < data.Length; i++) if (existing[i] != data[i]) return false;
            return true;
        }

        static string SafeFileName(string s)
        {
            var bad = Path.GetInvalidFileNameChars();
            var chars = s.Trim().ToCharArray();
            for (int i = 0; i < chars.Length; i++) if (Array.IndexOf(bad, chars[i]) >= 0 || chars[i] == '/' || chars[i] == '\\') chars[i] = '_';
            var r = new string(chars);
            return r.Length > 0 ? r : "font";
        }

        void AddTexture(AssetImportContext ctx, OpenBoneAsset asset, string dir, ITexture t, bool premultiplied)
        {
            if (t.Id == null) return;
            Texture2D tex = null;
            if (DataUri.TryDecode(t.Src, out var mime, out var data))
            {
                if (data.Length <= 3) return; // "data:," placeholders (layout-only pages)
                tex = new Texture2D(2, 2, TextureFormat.RGBA32, false) { name = t.Name ?? t.Id, wrapMode = TextureWrapMode.Clamp, filterMode = filterMode };
                if (!tex.LoadImage(data))
                {
                    ctx.LogImportWarning($"OpenBone: cannot decode image \"{t.Name}\" ({mime})");
                    return;
                }
                ctx.AddObjectToAsset("tex:" + t.Id, tex);
            }
            else
            {
                tex = FindInProject<Texture2D>(ctx, dir, t.Src, t.Name, new[] { ".png", ".jpg", ".jpeg", ".webp" });
                if (tex == null)
                {
                    if (!string.IsNullOrEmpty(t.Src)) ctx.LogImportWarning($"OpenBone: texture \"{t.Name}\" ({t.Src}) not found in the project");
                    return;
                }
            }
            asset.Textures.Add(new OpenBoneAsset.TextureEntry { id = t.Id, texture = tex, premultiplied = premultiplied });
        }

        static T FindInProject<T>(AssetImportContext ctx, string dir, string src, string name, string[] extensions) where T : UnityEngine.Object
        {
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(src) && !src.Contains("://")) candidates.Add(Normalize(dir + "/" + src));
            if (!string.IsNullOrEmpty(name))
                foreach (var ext in extensions)
                {
                    string file = name.EndsWith(ext, StringComparison.OrdinalIgnoreCase) ? name : name + ext;
                    candidates.Add(Normalize(dir + "/" + file));
                    candidates.Add(Normalize(dir + "/images/" + file));
                }
            foreach (var path in candidates)
            {
                if (!File.Exists(path)) continue;
                // The file may not be imported yet (a project's first import goes in no particular order): depending on
                // its import result makes Unity import it first, and re-import this document whenever it changes.
                ctx.DependsOnArtifact(path);
                var found = AssetDatabase.LoadAssetAtPath<T>(path);
                if (found != null) return found;
            }
            return null;
        }

        static string Normalize(string path)
        {
            var parts = new List<string>();
            foreach (var p in path.Replace('\\', '/').Split('/'))
            {
                if (p == "" || p == ".") continue;
                if (p == ".." && parts.Count > 0) parts.RemoveAt(parts.Count - 1);
                else parts.Add(p);
            }
            return string.Join("/", parts);
        }
    }

    /// <summary>Inspector for imported documents: what they contain.</summary>
    [CustomEditor(typeof(OpenBoneAsset))]
    public sealed class OpenBoneAssetEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var asset = (OpenBoneAsset)target;
            Document doc = null;
            try { doc = asset.Document; }
            catch (Exception e) { EditorGUILayout.HelpBox(e.Message, MessageType.Error); }
            if (doc != null)
            {
                EditorGUILayout.LabelField("Document", doc.Name);
                EditorGUILayout.LabelField("Bones / slots", $"{doc.Skeleton.Bones.Count} / {doc.Skeleton.Slots.Count}");
                EditorGUILayout.LabelField("Skins", string.Join(", ", doc.Skeleton.Skins.ConvertAll(s => s.Name)));
                EditorGUILayout.LabelField("Animations", string.Join(", ", doc.Animations.ConvertAll(a => a.Name)));
                EditorGUILayout.LabelField("State machines", string.Join(", ", doc.StateMachines.ConvertAll(s => s.Name)));
                if (doc.Fonts.Count > 0) EditorGUILayout.LabelField("Fonts", string.Join(", ", doc.Fonts.ConvertAll(f => $"{f.Family} {f.Weight}{(f.Style == "italic" ? " italic" : "")}")));
            }
            EditorGUILayout.Space();
            DrawDefaultInspector();
        }
    }
}
