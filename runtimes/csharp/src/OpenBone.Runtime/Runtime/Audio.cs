using System;
using System.Collections.Generic;
using System.Threading;

namespace OpenBone
{
    /// <summary>
    /// An audio command (runtime/audio.ts). The runtime never touches an audio API: a backend turns these into sound,
    /// applying the document's buses and master volume.
    /// </summary>
    public sealed class AudioCommand
    {
        /// <summary>play, stop, fade or mix.</summary>
        public string Type;
        /// <summary>Unique id of the playing instance (null for mix).</summary>
        public string Id;
        // play (Bus also for mix: the bus muted or unmuted, null = the master)
        public string Sound, Asset, Bus, Source;
        public double Volume, Rate, FadeIn;
        public bool Loop;
        // stop
        public double Fade;
        // fade (Volume is the target)
        public double Duration;
        /// <summary>mix: a setMute action muted (true) or unmuted <see cref="Bus"/> (null = the master) on top of the document's mix.</summary>
        public bool Muted;
    }

    public sealed class PlayOptions
    {
        public double? Volume, Rate;
        public bool? Loop;
        public string Owner, Tag, Source;
    }

    public sealed class PlayingSound
    {
        public string Id;
        public SoundData Sound;
        public string Owner, Tag;
        public bool Loop;
        public double Volume, StartedAt, EndsAt;
    }

    /// <summary>Tracks what is playing and turns play/stop requests into <see cref="AudioCommand"/>s (§10).</summary>
    public sealed class AudioDirector
    {
        static long _counter;
        const double UnknownLength = 10;

        readonly Document _doc;
        readonly Action<AudioCommand> _out;
        // Insertion-ordered (JavaScript Map semantics).
        readonly List<PlayingSound> _playing = new List<PlayingSound>();
        // Mutes set while playing (bus id, "" = master), on top of the document's mix.
        readonly Dictionary<string, bool> _mutes = new Dictionary<string, bool>();
        public double Time;

        public AudioDirector(Document doc, Action<AudioCommand> output)
        {
            _doc = doc;
            _out = output;
        }

        public IReadOnlyList<PlayingSound> Playing => _playing;

        static string NextId() => "play_" + ToBase36(Interlocked.Increment(ref _counter));

        static string ToBase36(long n)
        {
            const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
            if (n == 0) return "0";
            var s = new char[16];
            int i = s.Length;
            while (n > 0) { s[--i] = digits[(int)(n % 36)]; n /= 36; }
            return new string(s, i, s.Length - i);
        }

        /// <summary>A sound by id or name; else an audio asset by id or name, played with defaults on the sfx bus.</summary>
        public static SoundData ResolveSound(Document d, string r)
        {
            if (r == null || d.Audio == null) return null;
            foreach (var s in d.Audio.Sounds) if (s.Id == r) return s;
            foreach (var s in d.Audio.Sounds) if (s.Name == r) return s;
            AudioAsset a = null;
            foreach (var x in d.Audio.Assets) if (x.Id == r) { a = x; break; }
            if (a == null) foreach (var x in d.Audio.Assets) if (x.Name == r) { a = x; break; }
            if (a == null) return null;
            string bus = null;
            foreach (var b in d.Audio.Buses) if (b.Name == "sfx") { bus = b.Id; break; }
            return new SoundData { Id = a.Id, Name = a.Name, Asset = a.Id, Bus = bus, Volume = 1, Rate = 1, Loop = false, FadeIn = 0, FadeOut = 0 };
        }

        public void Update(double dt)
        {
            Time += dt;
            _playing.RemoveAll(p => p.EndsAt <= Time);
        }

        /// <summary>Start a sound; returns the instance id or null.</summary>
        public string Play(string reference, PlayOptions o = null)
        {
            o = o ?? new PlayOptions();
            var sound = ResolveSound(_doc, reference);
            if (sound == null) return null;
            bool loop = o.Loop ?? sound.Loop;
            if (loop && o.Tag != null)
                foreach (var p in _playing)
                    if (p.Loop && p.Owner == o.Owner && p.Tag == o.Tag) return p.Id;
            double rate = o.Rate ?? sound.Rate;
            double volume = sound.Volume * (o.Volume ?? 1);
            double len = 0;
            if (_doc.Audio != null) foreach (var a in _doc.Audio.Assets) if (a.Id == sound.Asset) { len = a.Duration; break; }
            var id = NextId();
            _playing.Add(new PlayingSound
            {
                Id = id,
                Sound = sound,
                Owner = o.Owner,
                Tag = o.Tag,
                Loop = loop,
                Volume = volume,
                StartedAt = Time,
                EndsAt = loop ? double.PositiveInfinity : Time + (len > 0 ? len / rate : UnknownLength),
            });
            _out(new AudioCommand { Type = "play", Id = id, Sound = sound.Id, Asset = sound.Asset, Bus = sound.Bus, Volume = volume, Rate = rate, Loop = loop, FadeIn = sound.FadeIn, Source = o.Source ?? "" });
            return id;
        }

        public void Stop(string id, double? fade = null)
        {
            int i = _playing.FindIndex(p => p.Id == id);
            if (i < 0) return;
            var p = _playing[i];
            _playing.RemoveAt(i);
            _out(new AudioCommand { Type = "stop", Id = id, Fade = fade ?? p.Sound.FadeOut });
        }

        public void StopSound(string reference, double? fade = null)
        {
            var s = ResolveSound(_doc, reference);
            if (s == null) return;
            foreach (var p in _playing.ToArray()) if (p.Sound.Id == s.Id) Stop(p.Id, fade);
        }

        /// <summary>Stop an owner's looping sounds (or all of them), fading at least by each sound's fadeOut.</summary>
        public void StopOwner(string owner, double fade = 0, bool all = false)
        {
            foreach (var p in _playing.ToArray())
                if (p.Owner == owner && (all || p.Loop)) Stop(p.Id, Math.Max(fade, p.Sound.FadeOut));
        }

        public void Fade(string id, double volume, double duration)
        {
            var p = _playing.Find(x => x.Id == id);
            if (p == null) return;
            p.Volume = volume;
            _out(new AudioCommand { Type = "fade", Id = id, Volume = volume, Duration = duration });
        }

        public void StopAll(double fade = 0)
        {
            foreach (var p in _playing.ToArray()) Stop(p.Id, fade);
        }

        /// <summary>Whether a bus (null = the master) is muted right now: a setMute override, else the document's flag.</summary>
        public bool IsMuted(string bus)
        {
            if (_mutes.TryGetValue(bus ?? "", out var m)) return m;
            var a = _doc.Audio;
            if (a == null) return false;
            if (bus == null) return a.Muted;
            foreach (var b in a.Buses) if (b.Id == bus) return b.Muted;
            return false;
        }

        /// <summary>Mute, unmute or toggle (null) a bus (null = the master); emits a "mix" command. Returns the new state.</summary>
        public bool SetMute(string bus, bool? muted)
        {
            bool next = muted ?? !IsMuted(bus);
            _mutes[bus ?? ""] = next;
            _out(new AudioCommand { Type = "mix", Bus = bus, Muted = next });
            return next;
        }

        /// <summary>Audio keys crossed between two total times, with their index (same rule as events).</summary>
        public static List<(AudioKey key, int index)> KeysBetween(AnimationData anim, double prev, double next, bool loop)
        {
            var o = new List<(AudioKey, int)>();
            var keys = anim.Audio;
            if (keys == null || keys.Count == 0 || next <= prev) return o;
            double d = anim.ComputedDuration();
            for (int index = 0; index < keys.Count; index++)
            {
                var key = keys[index];
                if (!loop || d <= 0)
                {
                    if (key.Time > prev && key.Time <= next) o.Add((key, index));
                    continue;
                }
                for (double c = Math.Floor(prev / d); c <= Math.Floor(next / d); c++)
                {
                    double at = c * d + key.Time;
                    if (at > prev && at <= next) o.Add((key, index));
                }
            }
            return o;
        }

        public static void PlayKeys(AudioDirector dir, AnimationData anim, double prev, double next, bool loop, string owner)
        {
            foreach (var (key, index) in KeysBetween(anim, prev, next, loop))
                dir.Play(key.Sound, new PlayOptions { Volume = key.Volume, Rate = key.Rate, Loop = key.Loop, Owner = owner, Tag = anim.Id + "#" + index, Source = "key:" + anim.Name });
        }
    }
}
