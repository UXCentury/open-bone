using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Xna.Framework.Audio;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// Plays a document's audio commands with <see cref="SoundEffect"/> / <see cref="SoundEffectInstance"/>: volume =
    /// command volume × bus × master × <see cref="Volume"/>, pitch = log2(rate) (MonoGame's −1..1 octaves), loop, and
    /// fades stepped in <see cref="Update"/>. Sounds are WAV files (data: URIs in the document, or files relative to it);
    /// load other formats yourself and register them with <see cref="Set"/>.
    /// </summary>
    public sealed class OpenBoneSoundPlayer : IDisposable
    {
        readonly Dictionary<string, SoundEffect> _effects = new Dictionary<string, SoundEffect>();
        readonly List<SoundEffect> _owned = new List<SoundEffect>();
        readonly AudioMixer _mixer;

        /// <summary>Sounds that could not be loaded, and audio hardware errors.</summary>
        public readonly List<string> Warnings = new List<string>();
        /// <summary>False when no audio device could be opened (commands are then ignored).</summary>
        public bool Available { get; private set; } = true;

        public OpenBoneSoundPlayer(Document doc, string baseDirectory)
        {
            _mixer = new AudioMixer(doc.Audio, CreateVoice);
            _mixer.MissingSound += id => Warnings.Add($"no sound for audio asset \"{id}\"");
            if (doc.Audio != null)
                foreach (var a in doc.Audio.Assets) Load(a, baseDirectory);
        }

        /// <summary>Extra volume on top of the document's master volume.</summary>
        public double Volume
        {
            get => _mixer.Volume;
            set => _mixer.Volume = value;
        }

        public AudioMixer Mixer => _mixer;

        /// <summary>Use your own SoundEffect for an audio asset id (e.g. from the content pipeline).</summary>
        public void Set(string assetId, SoundEffect effect) => _effects[assetId] = effect;

        public void Handle(AudioCommand command)
        {
            if (Available) _mixer.Handle(command);
        }

        /// <summary>Step fades (call once per frame).</summary>
        public void Update(double dt) => _mixer.Update(dt);

        public void StopAll() => _mixer.StopAll();

        void Load(AudioAsset a, string baseDirectory)
        {
            if (a.Id == null || string.IsNullOrEmpty(a.Src) || !Available) return;
            try
            {
                SoundEffect effect;
                if (DataUri.TryDecode(a.Src, out var mime, out var bytes))
                {
                    if (bytes.Length == 0) return;
                    if (mime != null && !mime.Contains("wav"))
                    {
                        Warnings.Add($"sound \"{a.Name}\": {mime} is not supported (WAV only)");
                        return;
                    }
                    using var ms = new MemoryStream(bytes);
                    effect = SoundEffect.FromStream(ms);
                }
                else
                {
                    var path = a.Src.Contains("://") ? null : Path.IsPathRooted(a.Src) ? a.Src : Path.Combine(baseDirectory ?? "", a.Src);
                    if (path == null || !File.Exists(path))
                    {
                        Warnings.Add($"sound \"{a.Name}\" ({a.Src}) not found");
                        return;
                    }
                    effect = SoundEffect.FromFile(path);
                }
                effect.Name = a.Name ?? a.Id;
                _owned.Add(effect);
                _effects[a.Id] = effect;
            }
            catch (NoAudioHardwareException e)
            {
                Available = false;
                Warnings.Add("no audio hardware: " + e.Message);
            }
            catch (Exception e)
            {
                Warnings.Add($"cannot load sound \"{a.Name}\": {e.Message}");
            }
        }

        ISoundVoice CreateVoice(string assetId)
        {
            if (assetId == null || !_effects.TryGetValue(assetId, out var effect)) return null;
            try
            {
                return new Voice(effect.CreateInstance());
            }
            catch (Exception e)
            {
                Warnings.Add($"cannot play \"{assetId}\": {e.Message}");
                return null;
            }
        }

        sealed class Voice : ISoundVoice
        {
            readonly SoundEffectInstance _i;
            public Voice(SoundEffectInstance i) { _i = i; }
            public float Volume { set => _i.Volume = Math.Max(0, Math.Min(1, value)); }
            public float Pitch { set => _i.Pitch = Math.Max(-1, Math.Min(1, value)); }
            public bool IsLooped { set => _i.IsLooped = value; }
            public bool IsPlaying => !_i.IsDisposed && _i.State == SoundState.Playing;
            public void Play() => _i.Play();
            public void Stop() { if (!_i.IsDisposed) _i.Stop(); }
            public void Dispose() => _i.Dispose();
        }

        public void Dispose()
        {
            _mixer.Dispose();
            foreach (var e in _owned) e.Dispose();
            _owned.Clear();
            _effects.Clear();
        }
    }
}
