using System.Collections.Generic;
using UnityEngine;

namespace OpenBone.Unity
{
    /// <summary>
    /// Plays the audio commands of an OpenBone component through pooled AudioSources: play (with fade-in, loop, pitch =
    /// rate), stop (with fade-out), fade and mix (setMute: mute or unmute a bus or the master), at master × bus × sound ×
    /// play volume from the document's mixer.
    /// Clips come from the asset (referenced AudioClips, or WAVs embedded in the document).
    /// </summary>
    [AddComponentMenu("OpenBone/OpenBone Audio")]
    [RequireComponent(typeof(OpenBoneBehaviour))]
    public sealed class OpenBoneAudio : MonoBehaviour
    {
        [Tooltip("Volume multiplier on top of the document's master volume.")]
        [Range(0, 2)] public float volume = 1;
        [Tooltip("0 = 2D, 1 = 3D (sources sit on this object).")]
        [Range(0, 1)] public float spatialBlend;
        [Tooltip("Optional mixer group for every source.")]
        public UnityEngine.Audio.AudioMixerGroup output;

        sealed class Voice
        {
            public AudioSource Source;
            public string Id;
            public string Bus;
            public float Gain;         // sound × play volume
            public float From, To;     // fade ramp (gain multipliers)
            public float FadeTime, FadeDuration;
            public bool StopWhenFaded;
        }

        OpenBoneBehaviour _owner;
        readonly List<Voice> _voices = new List<Voice>();
        readonly Dictionary<string, Voice> _byId = new Dictionary<string, Voice>();
        // "mix" overrides (bus id, "" = master) on top of the document's mute flags.
        readonly Dictionary<string, bool> _mutes = new Dictionary<string, bool>();

        void OnEnable()
        {
            _owner = GetComponent<OpenBoneBehaviour>();
            if (_owner != null) _owner.AudioCommand += OnCommand;
        }

        void OnDisable()
        {
            if (_owner != null) _owner.AudioCommand -= OnCommand;
            foreach (var v in _voices) if (v.Source != null) v.Source.Stop();
            _byId.Clear();
        }

        /// <summary>
        /// Master × bus gain (0 when muted; a missing bus counts as 1). Mutes from "mix" commands (setMute listener actions)
        /// override the document's flags; unmuting a bus the document mutes plays it at its volume.
        /// </summary>
        float BusGain(string busId)
        {
            var audio = _owner != null && _owner.asset != null ? _owner.asset.Document.Audio : null;
            if (IsMuted(null)) return 0;
            if (audio == null) return 1;
            AudioBus bus = null;
            if (busId != null) foreach (var b in audio.Buses) if (b.Id == busId) { bus = b; break; }
            if (bus != null && IsMuted(bus.Id)) return 0;
            return (float)(audio.Master * (bus != null ? bus.Volume : 1));
        }

        /// <summary>Whether a bus (null = the master) is muted: by a setMute action, else by the document.</summary>
        public bool IsMuted(string busId)
        {
            if (_mutes.TryGetValue(busId ?? "", out var m)) return m;
            var audio = _owner != null && _owner.asset != null ? _owner.asset.Document.Audio : null;
            if (audio == null) return false;
            if (busId == null) return audio.Muted;
            foreach (var b in audio.Buses) if (b.Id == busId) return b.Muted;
            return false;
        }

        void OnCommand(AudioCommand c)
        {
            switch (c.Type)
            {
                case "play": Play(c); break;
                case "stop":
                    if (_byId.TryGetValue(c.Id, out var v))
                    {
                        _byId.Remove(c.Id);
                        if (c.Fade > 0) Ramp(v, 0, (float)c.Fade, true);
                        else Silence(v);
                    }
                    break;
                case "fade":
                    if (_byId.TryGetValue(c.Id, out var f) && f.Gain > 0) Ramp(f, (float)c.Volume / f.Gain, (float)c.Duration, false);
                    break;
                case "mix":
                    _mutes[c.Bus ?? ""] = c.Muted;
                    foreach (var voice in _voices) if (voice.Source != null && voice.Source.isPlaying) Apply(voice);
                    break;
            }
        }

        void Play(AudioCommand c)
        {
            var clip = _owner.asset != null ? _owner.asset.GetClip(c.Asset) : null;
            if (clip == null)
            {
                Debug.LogWarning($"OpenBone: no AudioClip for audio asset \"{c.Asset}\"", this);
                return;
            }
            var v = FreeVoice();
            v.Id = c.Id;
            v.Bus = c.Bus;
            v.Gain = (float)c.Volume;
            v.StopWhenFaded = false;
            var s = v.Source;
            s.clip = clip;
            s.loop = c.Loop;
            s.pitch = (float)c.Rate;
            s.spatialBlend = spatialBlend;
            s.outputAudioMixerGroup = output;
            if (c.FadeIn > 0) Ramp(v, 1, (float)c.FadeIn, false, 0);
            else { v.From = v.To = 1; v.FadeDuration = 0; }
            Apply(v);
            s.Play();
            _byId[c.Id] = v;
        }

        Voice FreeVoice()
        {
            foreach (var v in _voices)
                if (v.Source != null && !v.Source.isPlaying && (v.Id == null || !_byId.ContainsKey(v.Id))) return v;
            var go = new GameObject("OpenBone Audio") { hideFlags = HideFlags.DontSave };
            go.transform.SetParent(transform, false);
            var src = go.AddComponent<AudioSource>();
            src.playOnAwake = false;
            var voice = new Voice { Source = src };
            _voices.Add(voice);
            return voice;
        }

        void Ramp(Voice v, float to, float duration, bool stop, float? from = null)
        {
            v.From = from ?? Level(v);
            v.To = to;
            v.FadeTime = 0;
            v.FadeDuration = duration;
            v.StopWhenFaded = stop;
        }

        static float Level(Voice v) => v.FadeDuration > 0 ? Mathf.Lerp(v.From, v.To, Mathf.Clamp01(v.FadeTime / v.FadeDuration)) : v.To;

        void Apply(Voice v)
        {
            if (v.Source != null) v.Source.volume = v.Gain * Level(v) * BusGain(v.Bus) * volume;
        }

        static void Silence(Voice v)
        {
            if (v.Source != null) v.Source.Stop();
            v.Id = null;
        }

        void Update()
        {
            float dt = Time.unscaledDeltaTime;
            foreach (var v in _voices)
            {
                if (v.Source == null || !v.Source.isPlaying) continue;
                if (v.FadeDuration > 0 && v.FadeTime < v.FadeDuration) v.FadeTime += dt;
                Apply(v);
                if (v.StopWhenFaded && v.FadeTime >= v.FadeDuration) Silence(v);
            }
        }
    }
}
