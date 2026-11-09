using System;
using System.Collections.Generic;
using System.Threading;

namespace OpenBone
{
    public sealed class TrackEntry
    {
        static long _counter;
        /// <summary>Owner id for the sounds this entry starts.</summary>
        public readonly string Uid = "entry_" + Interlocked.Increment(ref _counter);
        public readonly AnimationData Animation;
        public bool Loop;
        /// <summary>Total elapsed time (seconds, unwrapped).</summary>
        public double Time;
        public double PrevTime = -1e-6;
        public double Speed = 1;
        public double Alpha = 1;
        public TrackEntry MixingFrom;
        public double MixTime, MixDuration;
        public double CompletedLoops;

        public TrackEntry(AnimationData animation, bool loop)
        {
            Animation = animation;
            Loop = loop;
        }

        public double Duration => Animation.ComputedDuration();
        public double LocalTime => Animations.LocalTime(Animation, Time, Loop);
        public bool IsComplete => !Loop && Time >= Duration;
    }

    /// <summary>Plays animations on numbered tracks with cross-fading (runtime/animation-state.ts).</summary>
    public sealed class AnimationState
    {
        sealed class Queued
        {
            public int Track;
            public TrackEntry Entry;
            public double Delay, Mix;
        }

        public readonly Skeleton Skeleton;
        public readonly List<TrackEntry> Tracks = new List<TrackEntry>();
        readonly List<Queued> _queue = new List<Queued>();
        public double DefaultMix = 0.2;
        public readonly AudioDirector Audio;

        public event Action<FiredEvent, int> Event;
        public event Action<TrackEntry, int> Start;
        public event Action<TrackEntry, int> Complete;
        public event Action<AudioCommand> AudioCommand;

        public AnimationState(Skeleton skeleton)
        {
            Skeleton = skeleton;
            Audio = new AudioDirector(skeleton.Doc, c => AudioCommand?.Invoke(c));
        }

        void EndEntry(TrackEntry e, double fade = 0)
        {
            if (e != null) Audio.StopOwner(e.Uid, fade);
        }

        AnimationData Resolve(string anim) => Skeleton.Doc.FindAnimation(anim) ?? throw new ArgumentException($"Animation \"{anim}\" not found");

        TrackEntry Get(int track) => track < Tracks.Count ? Tracks[track] : null;

        void Put(int track, TrackEntry e)
        {
            while (Tracks.Count <= track) Tracks.Add(null);
            Tracks[track] = e;
        }

        public TrackEntry SetAnimation(int track, string animation, bool loop = true, double? mix = null) => SetAnimation(track, Resolve(animation), loop, mix);

        public TrackEntry SetAnimation(int track, AnimationData animation, bool loop = true, double? mix = null)
        {
            double m = mix ?? DefaultMix;
            var entry = new TrackEntry(animation, loop);
            var cur = Get(track);
            EndEntry(cur, m);
            if (cur != null && m > 0)
            {
                entry.MixingFrom = cur;
                cur.MixingFrom = null;
                entry.MixDuration = m;
            }
            Put(track, entry);
            _queue.RemoveAll(q => q.Track == track);
            Start?.Invoke(entry, track);
            return entry;
        }

        /// <summary>Queue an animation after the current one completes (non-looping) or after delay seconds.</summary>
        public TrackEntry AddAnimation(int track, string animation, bool loop = true, double delay = 0, double? mix = null)
        {
            var entry = new TrackEntry(Resolve(animation), loop);
            if (Get(track) == null)
            {
                Put(track, entry);
                Start?.Invoke(entry, track);
            }
            else _queue.Add(new Queued { Track = track, Entry = entry, Delay = delay, Mix = mix ?? DefaultMix });
            return entry;
        }

        public void ClearTrack(int track)
        {
            EndEntry(Get(track));
            if (track < Tracks.Count) Tracks[track] = null;
        }

        public void ClearTracks()
        {
            Tracks.Clear();
            _queue.Clear();
            Audio.StopAll();
        }

        public void Update(double dt)
        {
            Audio.Update(dt);
            for (int track = 0; track < Tracks.Count; track++)
            {
                var e = Tracks[track];
                if (e == null) continue;
                e.PrevTime = e.Time > 0 ? e.Time : Math.Min(e.PrevTime, e.Time);
                e.Time += dt * e.Speed;
                if (e.MixingFrom != null)
                {
                    e.MixingFrom.PrevTime = e.MixingFrom.Time;
                    e.MixingFrom.Time += dt * e.MixingFrom.Speed;
                    e.MixTime += dt;
                    if (e.MixTime >= e.MixDuration) e.MixingFrom = null;
                }
                if (dt > 0)
                {
                    AudioDirector.PlayKeys(Audio, e.Animation, e.PrevTime, e.Time, e.Loop, e.Uid);
                    foreach (var ev in Animations.EventsBetween(Skeleton.Doc, e.Animation, e.PrevTime, e.Time, e.Loop))
                    {
                        if (!string.IsNullOrEmpty(ev.Audio)) Audio.Play(ev.Audio, new PlayOptions { Volume = ev.Volume, Owner = e.Uid, Source = "event:" + ev.Name });
                        Event?.Invoke(ev, track);
                    }
                }
                double d = e.Duration;
                if (d > 0)
                {
                    double loops = Math.Floor(e.Time / d);
                    if (e.Loop ? loops > e.CompletedLoops : e.PrevTime < d && e.Time >= d)
                    {
                        e.CompletedLoops = loops;
                        Complete?.Invoke(e, track);
                        if (!e.Loop) EndEntry(e);
                    }
                }
                var q = _queue.Find(x => x.Track == track);
                if (q != null && (q.Delay > 0 ? e.Time >= q.Delay : e.IsComplete || (e.Loop && d > 0 && e.Time >= d)))
                {
                    _queue.Remove(q);
                    EndEntry(e, q.Mix);
                    q.Entry.MixingFrom = e;
                    q.Entry.MixDuration = q.Mix;
                    Tracks[track] = q.Entry;
                    Start?.Invoke(q.Entry, track);
                }
            }
        }

        public void Apply() => Apply(Skeleton);

        public void Apply(Skeleton sk)
        {
            foreach (var e in Tracks)
            {
                if (e == null) continue;
                if (e.MixingFrom != null)
                {
                    Animations.Apply(sk, e.MixingFrom.Animation, e.MixingFrom.LocalTime, e.Alpha);
                    double md = e.MixDuration == 0 || double.IsNaN(e.MixDuration) ? 1 : e.MixDuration;
                    Animations.Apply(sk, e.Animation, e.LocalTime, e.Alpha * Math.Min(1, e.MixTime / md));
                }
                else Animations.Apply(sk, e.Animation, e.LocalTime, e.Alpha);
            }
        }
    }
}
