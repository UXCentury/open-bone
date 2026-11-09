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
    /// at the asset's <c>src</c> are referenced; embedded WAVs are decoded at runtime.
    /// </summary>
    [ScriptedImporter(1, new[] { "obone", "obonb" })]
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

            ctx.AddObjectToAsset("document", asset);
            ctx.SetMainObject(asset);
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
                var found = AssetDatabase.LoadAssetAtPath<T>(path);
                if (found == null) continue;
                // Re-import this document when the texture or clip changes.
                ctx.DependsOnSourceAsset(path);
                return found;
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
            }
            EditorGUILayout.Space();
            DrawDefaultInspector();
        }
    }
}
