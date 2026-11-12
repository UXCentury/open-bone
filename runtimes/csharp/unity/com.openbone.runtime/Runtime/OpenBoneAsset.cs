using System;
using System.Collections.Generic;
using UnityEngine;

namespace OpenBone.Unity
{
    /// <summary>
    /// An imported .obone / .obonb document: its bytes plus the textures and audio clips its ids resolve to.
    /// Created by the importer (Editor/OpenBoneImporter), or at runtime with <see cref="Create"/>.
    /// </summary>
    public sealed class OpenBoneAsset : ScriptableObject
    {
        [Serializable]
        public sealed class TextureEntry
        {
            [Tooltip("Image or atlas page id in the document.")]
            public string id;
            public Texture2D texture;
            [Tooltip("The texture holds premultiplied alpha (atlas pages packed with premultipliedAlpha).")]
            public bool premultiplied;
        }

        [Serializable]
        public sealed class AudioEntry
        {
            [Tooltip("Audio asset id in the document.")]
            public string id;
            public AudioClip clip;
        }

        [Serializable]
        public sealed class FontEntry
        {
            [Tooltip("The family name text attachments use in their font list.")]
            public string family;
            [Tooltip("CSS weight 100..900: a text gets the family's font closest to its own weight.")]
            public float weight = 400;
            public bool italic;
            public Font font;
        }

        [SerializeField, HideInInspector] byte[] data = new byte[0];
        [SerializeField] List<TextureEntry> textures = new List<TextureEntry>();
        [SerializeField] List<AudioEntry> audioClips = new List<AudioEntry>();
        [SerializeField] List<FontEntry> fonts = new List<FontEntry>();

        [NonSerialized] Document _doc;
        [NonSerialized] Dictionary<string, TextureEntry> _textureById;
        [NonSerialized] Dictionary<string, AudioClip> _clipById;

        /// <summary>The document's file bytes (.obone JSON or .obonb).</summary>
        public byte[] Data => data;
        public List<TextureEntry> Textures => textures;
        public List<AudioEntry> AudioClips => audioClips;
        /// <summary>The document's fonts as imported Font assets (the importer fills this; add your own at runtime).</summary>
        public List<FontEntry> Fonts => fonts;

        /// <summary>Build an asset at runtime from file bytes and textures (by image / atlas page id).</summary>
        public static OpenBoneAsset Create(byte[] bytes, IDictionary<string, Texture2D> textureById = null, IDictionary<string, AudioClip> clips = null)
        {
            var a = CreateInstance<OpenBoneAsset>();
            a.SetData(bytes);
            if (textureById != null) foreach (var kv in textureById) a.textures.Add(new TextureEntry { id = kv.Key, texture = kv.Value });
            if (clips != null) foreach (var kv in clips) a.audioClips.Add(new AudioEntry { id = kv.Key, clip = kv.Value });
            return a;
        }

        public void SetData(byte[] bytes)
        {
            data = bytes ?? new byte[0];
            _doc = null;
        }

        /// <summary>The parsed document (parsed once, shared by every component using this asset; never modified).</summary>
        public Document Document
        {
            get
            {
                if (_doc == null) _doc = DocumentLoader.Load(data);
                return _doc;
            }
        }

        public TextureEntry GetTexture(string id)
        {
            if (id == null) return null;
            if (_textureById == null || _textureById.Count != textures.Count)
            {
                _textureById = new Dictionary<string, TextureEntry>();
                foreach (var t in textures) if (t != null && t.id != null) _textureById[t.id] = t;
            }
            return _textureById.TryGetValue(id, out var e) ? e : null;
        }

        /// <summary>The clip for an audio asset id: a referenced AudioClip, else a WAV embedded as a data: URI (decoded once).</summary>
        public AudioClip GetClip(string assetId)
        {
            if (assetId == null) return null;
            if (_clipById == null)
            {
                _clipById = new Dictionary<string, AudioClip>();
                foreach (var c in audioClips) if (c != null && c.id != null && c.clip != null) _clipById[c.id] = c.clip;
            }
            if (_clipById.TryGetValue(assetId, out var clip)) return clip;
            clip = null;
            var audio = Document.Audio;
            if (audio != null)
                foreach (var a in audio.Assets)
                    if (a.Id == assetId && DataUri.TryDecode(a.Src, out var mime, out var bytes) && mime.Contains("wav"))
                    {
                        clip = Wav.ToClip(bytes, a.Name ?? a.Id);
                        break;
                    }
            _clipById[assetId] = clip;
            return clip;
        }

        void OnValidate()
        {
            _textureById = null;
            _clipById = null;
        }
    }

    /// <summary>data: URI decoding (base64 only, as OpenBone writes them).</summary>
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
            if (!head.EndsWith(";base64", StringComparison.Ordinal)) return false;
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

    /// <summary>Minimal PCM WAV decoder (8/16/24/32-bit integer and 32-bit float) for embedded sounds.</summary>
    public static class Wav
    {
        public static AudioClip ToClip(byte[] wav, string name)
        {
            if (!TryDecode(wav, out var samples, out var channels, out var rate)) return null;
            var clip = AudioClip.Create(name, samples.Length / channels, channels, rate, false);
            clip.SetData(samples, 0);
            return clip;
        }

        public static bool TryDecode(byte[] b, out float[] samples, out int channels, out int rate)
        {
            samples = null;
            channels = 0;
            rate = 0;
            if (b == null || b.Length < 12 || b[0] != 'R' || b[1] != 'I' || b[2] != 'F' || b[3] != 'F' || b[8] != 'W' || b[9] != 'A' || b[10] != 'V' || b[11] != 'E') return false;
            int p = 12, format = 0, bits = 0;
            while (p + 8 <= b.Length)
            {
                string id = System.Text.Encoding.ASCII.GetString(b, p, 4);
                int size = BitConverter.ToInt32(b, p + 4);
                int body = p + 8;
                if (size < 0 || body + size > b.Length) size = b.Length - body;
                if (id == "fmt ")
                {
                    format = BitConverter.ToInt16(b, body);
                    channels = BitConverter.ToInt16(b, body + 2);
                    rate = BitConverter.ToInt32(b, body + 4);
                    bits = BitConverter.ToInt16(b, body + 14);
                    if (format == -2 && size >= 26) format = BitConverter.ToInt16(b, body + 24); // WAVE_FORMAT_EXTENSIBLE
                }
                else if (id == "data" && channels > 0)
                {
                    int bytesPer = bits / 8;
                    if (bytesPer <= 0) return false;
                    int n = size / bytesPer;
                    samples = new float[n - n % channels];
                    for (int i = 0; i < samples.Length; i++)
                    {
                        int o = body + i * bytesPer;
                        switch (bits)
                        {
                            case 8: samples[i] = (b[o] - 128) / 128f; break;
                            case 16: samples[i] = BitConverter.ToInt16(b, o) / 32768f; break;
                            case 24: samples[i] = ((b[o] | (b[o + 1] << 8) | ((sbyte)b[o + 2] << 16))) / 8388608f; break;
                            case 32: samples[i] = format == 3 ? BitConverter.ToSingle(b, o) : BitConverter.ToInt32(b, o) / 2147483648f; break;
                            default: return false;
                        }
                    }
                    return format == 1 || format == 3;
                }
                p = body + size + (size & 1);
            }
            return false;
        }
    }
}
