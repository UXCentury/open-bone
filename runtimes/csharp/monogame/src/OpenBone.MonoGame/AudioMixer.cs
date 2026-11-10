using System;
using System.Collections.Generic;

namespace OpenBone.MonoGame
{
    /// <summary>Gain and pitch maths for OpenBone audio commands on MonoGame voices.</summary>
    public static class AudioMath
    {
        /// <summary>
        /// MonoGame pitch (−1..1 octaves, 0 = normal) for a playback rate (1 = normal, 2 = an octave up):
        /// log2(rate), clamped to MonoGame's range. Rates ≤ 0 or NaN play at normal pitch.
        /// </summary>
        public static float Pitch(double rate)
        {
            if (!(rate > 0)) return 0;
            return (float)Math.Max(-1, Math.Min(1, Math.Log(rate, 2)));
        }

        /// <summary>Master × bus volume from the document's mixer (0 when either is muted; a missing bus counts as 1).</summary>
        public static double BusGain(AudioData audio, string busId) => BusGain(audio, busId, null);

        /// <summary>
        /// Master × bus volume, with <paramref name="mutes"/> (from "mix" commands: bus id, "" = master) overriding the
        /// document's muted flags: a muted bus or master gives 0; unmuting a bus the document mutes plays it at its volume.
        /// </summary>
        public static double BusGain(AudioData audio, string busId, IReadOnlyDictionary<string, bool> mutes)
        {
            bool masterMuted = mutes != null && mutes.TryGetValue("", out var mm) ? mm : audio != null && audio.Muted;
            if (masterMuted) return 0;
            if (audio == null) return 1;
            AudioBus bus = null;
            if (busId != null)
                foreach (var b in audio.Buses)
                    if (b.Id == busId || b.Name == busId) { bus = b; break; }
            if (bus != null)
            {
                bool busMuted = mutes != null && bus.Id != null && mutes.TryGetValue(bus.Id, out var bm) ? bm : bus.Muted;
                if (busMuted) return 0;
            }
            return audio.Master * (bus != null ? bus.Volume : 1);
        }

        /// <summary>Voice volume: command volume (sound × play) × fade level × master × bus × player volume, clamped to 0..1.</summary>
        public static float Volume(double commandVolume, double fadeLevel, double busGain, double playerVolume = 1)
        {
            double v = commandVolume * fadeLevel * busGain * playerVolume;
            if (!(v > 0)) return 0;
            return (float)Math.Min(1, v);
        }

        /// <summary>A linear fade from <paramref name="from"/> to <paramref name="to"/> after <paramref name="time"/> of <paramref name="duration"/>.</summary>
        public static double FadeLevel(double from, double to, double time, double duration)
        {
            if (!(duration > 0)) return to;
            double k = Math.Max(0, Math.Min(1, time / duration));
            return from + (to - from) * k;
        }
    }

    /// <summary>One playing sound, as the mixer drives it (a SoundEffectInstance in <see cref="OpenBoneSoundPlayer"/>).</summary>
    public interface ISoundVoice : IDisposable
    {
        float Volume { set; }
        float Pitch { set; }
        bool IsLooped { set; }
        bool IsPlaying { get; }
        void Play();
        void Stop();
    }

    /// <summary>
    /// Plays OpenBone audio commands (play with fade-in, loop and rate; stop with fade-out; fade to a volume; mix = mute or
    /// unmute a bus or the master on top of the document's mix) on voices
    /// from a factory, stepping fades every <see cref="Update"/>. Independent of MonoGame, so it can be tested.
    /// </summary>
    public sealed class AudioMixer : IDisposable
    {
        sealed class Voice
        {
            public string Id, Bus;
            public ISoundVoice Sound;
            public double Gain;         // command volume (sound × play)
            public double From = 1, To = 1, FadeTime, FadeDuration;
            public bool StopWhenFaded;
            public double Level => AudioMath.FadeLevel(From, To, FadeTime, FadeDuration);
        }

        readonly Func<string, ISoundVoice> _create;
        readonly List<Voice> _voices = new List<Voice>();
        readonly Dictionary<string, Voice> _byId = new Dictionary<string, Voice>();
        // "mix" overrides (bus id, "" = master) on top of the document's mute flags.
        readonly Dictionary<string, bool> _mutes = new Dictionary<string, bool>();

        /// <summary>The document's mixer (master, buses, mute); null = everything at 1.</summary>
        public AudioData Audio;
        /// <summary>Extra volume on top of the document's master volume.</summary>
        public double Volume = 1;
        /// <summary>A play command whose asset has no sound (asset id).</summary>
        public event Action<string> MissingSound;

        /// <param name="audio">The document's audio settings (for master and bus volumes).</param>
        /// <param name="createVoice">A new, stopped voice for an audio asset id, or null when there is no such sound.</param>
        public AudioMixer(AudioData audio, Func<string, ISoundVoice> createVoice)
        {
            Audio = audio;
            _create = createVoice ?? throw new ArgumentNullException(nameof(createVoice));
        }

        /// <summary>Voices playing or fading out.</summary>
        public int ActiveVoices => _voices.Count;

        /// <summary>Whether a bus (null = the master) is muted: by a "mix" command (mute button), else by the document.</summary>
        public bool IsMuted(string bus)
        {
            if (_mutes.TryGetValue(bus ?? "", out var m)) return m;
            if (Audio == null) return false;
            if (bus == null) return Audio.Muted;
            foreach (var b in Audio.Buses) if (b.Id == bus) return b.Muted;
            return false;
        }

        public void Handle(AudioCommand c)
        {
            switch (c.Type)
            {
                case "play": Play(c); break;
                case "stop":
                    if (c.Id != null && _byId.TryGetValue(c.Id, out var v))
                    {
                        _byId.Remove(c.Id);
                        if (c.Fade > 0) Ramp(v, 0, c.Fade, true);
                        else Remove(v);
                    }
                    break;
                case "fade":
                    if (c.Id != null && _byId.TryGetValue(c.Id, out var f) && f.Gain > 0) Ramp(f, c.Volume / f.Gain, c.Duration, false);
                    break;
                case "mix":
                    _mutes[c.Bus ?? ""] = c.Muted;
                    foreach (var voice in _voices) Apply(voice);
                    break;
            }
        }

        void Play(AudioCommand c)
        {
            var sound = _create(c.Asset);
            if (sound == null)
            {
                MissingSound?.Invoke(c.Asset);
                return;
            }
            if (c.Id != null && _byId.TryGetValue(c.Id, out var old)) Remove(old);
            var v = new Voice { Id = c.Id, Bus = c.Bus, Sound = sound, Gain = c.Volume };
            if (c.FadeIn > 0) { v.From = 0; v.To = 1; v.FadeDuration = c.FadeIn; }
            sound.IsLooped = c.Loop;
            sound.Pitch = AudioMath.Pitch(c.Rate);
            Apply(v);
            sound.Play();
            _voices.Add(v);
            if (c.Id != null) _byId[c.Id] = v;
        }

        void Ramp(Voice v, double to, double duration, bool stop)
        {
            v.From = v.Level;
            v.To = to;
            v.FadeTime = 0;
            v.FadeDuration = duration;
            v.StopWhenFaded = stop;
        }

        void Apply(Voice v) => v.Sound.Volume = AudioMath.Volume(v.Gain, v.Level, AudioMath.BusGain(Audio, v.Bus, _mutes), Volume);

        void Remove(Voice v)
        {
            v.Sound.Stop();
            v.Sound.Dispose();
            _voices.Remove(v);
            if (v.Id != null && _byId.TryGetValue(v.Id, out var cur) && cur == v) _byId.Remove(v.Id);
        }

        /// <summary>Step fades by <paramref name="dt"/> seconds, apply volumes, drop finished voices.</summary>
        public void Update(double dt)
        {
            for (int i = _voices.Count - 1; i >= 0; i--)
            {
                var v = _voices[i];
                if (!v.Sound.IsPlaying)
                {
                    Remove(v);
                    continue;
                }
                if (v.FadeDuration > 0 && v.FadeTime < v.FadeDuration) v.FadeTime = Math.Min(v.FadeDuration, v.FadeTime + dt);
                Apply(v);
                if (v.StopWhenFaded && v.FadeTime >= v.FadeDuration) Remove(v);
            }
        }

        public void StopAll()
        {
            for (int i = _voices.Count - 1; i >= 0; i--) Remove(_voices[i]);
            _byId.Clear();
        }

        public void Dispose() => StopAll();
    }
}
