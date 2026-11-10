using System;
using System.Collections.Generic;
using OpenBone.Json;

namespace OpenBone
{
    /// <summary>An event fired by an animation key, a listener or a script.</summary>
    public sealed class FiredEvent : IJsonWritable
    {
        public string Name, Id;
        public double Time, Int, Float;
        public string String;
        /// <summary>Sound (or audio asset) the event plays, and its volume multiplier.</summary>
        public string Audio;
        public double? Volume;
        public string Animation;

        public JsonValue ToJson()
        {
            var o = JsonValue.NewObject();
            o.Set("name", JsonValue.String(Name));
            o.Set("id", JsonValue.String(Id));
            o.Set("time", JsonValue.Number(Time));
            o.Set("int", JsonValue.Number(Int));
            o.Set("float", JsonValue.Number(Float));
            o.Set("string", JsonValue.String(String));
            if (!string.IsNullOrEmpty(Audio)) o.Set("audio", JsonValue.String(Audio));
            if (Volume.HasValue) o.Set("volume", JsonValue.Number(Volume.Value));
            o.Set("animation", JsonValue.String(Animation));
            return o;
        }
    }

    /// <summary>
    /// How an animation being faded out is applied during a cross-fade: its blending timelines that none of <see cref="Into"/>
    /// key use <see cref="Alpha"/> (the outgoing weight, 1 - mix) instead of the full weight, so they ease back to the pose
    /// underneath (the setup pose on the first track / layer) instead of holding and snapping when the fade ends.
    /// </summary>
    public sealed class MixOut
    {
        public IReadOnlyList<AnimationData> Into;
        public double Alpha;
    }

    /// <summary>runtime/animation.ts: timeline sampling and application.</summary>
    public static class Animations
    {
        struct Located
        {
            public Key A, B;
            public double T;
        }

        static Located Locate(List<Key> keys, double time)
        {
            if (time <= keys[0].Time) return new Located { A = keys[0] };
            var last = keys[keys.Count - 1];
            if (time >= last.Time) return new Located { A = last };
            int lo = 0, hi = keys.Count - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (keys[mid].Time <= time) lo = mid; else hi = mid;
            }
            var a = keys[lo];
            var b = keys[hi];
            double span = b.Time - a.Time;
            if (span == 0 || double.IsNaN(span)) span = 1;
            double f = (time - a.Time) / span;
            return new Located { A = a, B = b, T = MathUtil.EvalCurve(a.Curve, f) };
        }

        static double Num(object v) => v is double d ? d : Js.ToNumber(v);

        public static double SampleNumber(List<Key> keys, double time)
        {
            var l = Locate(keys, time);
            if (l.B == null || l.A.Curve.Kind == CurveKind.Stepped) return Num(l.A.Value);
            return MathUtil.Lerp(Num(l.A.Value), Num(l.B.Value), l.T);
        }

        public static double[] SampleArray(List<Key> keys, double time)
        {
            var l = Locate(keys, time);
            var av = l.A.Value as double[] ?? new double[0];
            if (l.B == null || l.A.Curve.Kind == CurveKind.Stepped) return av;
            var bv = l.B.Value as double[] ?? new double[0];
            int n = Math.Max(av.Length, bv.Length);
            var o = new double[n];
            for (int i = 0; i < n; i++) o[i] = MathUtil.Lerp(i < av.Length ? av[i] : 0, i < bv.Length ? bv[i] : 0, l.T);
            return o;
        }

        public static object SampleStep(List<Key> keys, double time) => Locate(keys, time).A.Value;

        /// <summary>Local playback time for a total elapsed time.</summary>
        public static double LocalTime(AnimationData anim, double total, bool loop)
        {
            double d = anim.ComputedDuration();
            if (d <= 0) return 0;
            if (loop) return ((total % d) + d) % d;
            return Math.Min(Math.Max(total, 0), d);
        }

        public static void Apply(Skeleton sk, AnimationData anim, double time, double alpha = 1, MixOut mixOut = null) => Apply(sk, anim, anim.Timelines, time, alpha, mixOut);

        /// <summary>True for timelines whose values blend (a mix fades them); false for the ones that switch at keys.</summary>
        static bool Blends(Timeline tl)
        {
            switch (tl.Target)
            {
                case "bone": return tl.Property != "inherit";
                case "slot": return tl.Property == "color" || tl.Property == "dark";
                case "ik": return tl.Property != "bend" && tl.Property != "stretch" && tl.Property != "compress";
                case "transform":
                case "path":
                case "physics":
                case "deform": return true;
                case "particles": return tl.Property == "rate";
                default: return false;
            }
        }

        /// <summary>Whether any of <paramref name="anims"/> has a keyed timeline for the same value as <paramref name="tl"/> (same target, id, property and attachment).</summary>
        public static bool KeyedBy(IReadOnlyList<AnimationData> anims, Timeline tl)
        {
            foreach (var a in anims)
                foreach (var o in a.Timelines)
                    if (o.Keys.Count > 0 && o.Target == tl.Target && o.Id == tl.Id && o.Property == tl.Property && o.Attachment == tl.Attachment) return true;
            return false;
        }

        /// <summary>Pose the skeleton with an animation's timelines at local time, blended over the current pose by alpha (§5).
        /// With <paramref name="mixOut"/> (an animation being faded out), blending timelines none of its <c>Into</c> key use its alpha (§5.1a).</summary>
        public static void Apply(Skeleton sk, AnimationData anim, List<Timeline> timelines, double time, double full, MixOut mixOut = null)
        {
            if (full <= 0) return;
            if (full >= 0.5 || sk.AnimationTime == null) sk.AnimationTime = time;
            foreach (var tl in timelines)
            {
                if (tl.Keys.Count == 0) continue;
                double alpha = mixOut != null && Blends(tl) && !KeyedBy(mixOut.Into, tl) ? mixOut.Alpha : full;
                if (alpha <= 0) continue;
                switch (tl.Target)
                {
                    case "bone":
                        {
                            var bone = sk.BoneById(tl.Id);
                            if (bone == null) break;
                            if (tl.Property == "inherit")
                            {
                                if (alpha >= 0.5) bone.Inherit = SampleStep(tl.Keys, time) as string;
                                break;
                            }
                            double v = SampleNumber(tl.Keys, time);
                            var cur = bone.Get(tl.Property);
                            if (cur == null) break;
                            bone.Set(tl.Property, alpha >= 1 ? v : tl.Property == "rotation" ? MathUtil.LerpAngle(cur.Value, v, alpha) : MathUtil.Lerp(cur.Value, v, alpha));
                            break;
                        }
                    case "slot":
                        {
                            var slot = sk.SlotById(tl.Id);
                            if (slot == null) break;
                            if (tl.Property == "color" || tl.Property == "dark")
                            {
                                var l = Locate(tl.Keys, time);
                                var ca = MathUtil.ParseHex(l.A.Value as string);
                                var v = l.B == null || l.A.Curve.Kind == CurveKind.Stepped ? ca : MathUtil.LerpColor(ca, MathUtil.ParseHex(l.B.Value as string), l.T);
                                if (tl.Property == "color") slot.Color = alpha >= 1 ? v : MathUtil.LerpColor(slot.Color, v, alpha);
                                else slot.Dark = alpha >= 1 ? v : MathUtil.LerpColor(slot.Dark ?? new double[] { 0, 0, 0, 1 }, v, alpha);
                            }
                            else if (alpha >= 0.5)
                            {
                                slot.AttachmentName = SampleStep(tl.Keys, time) as string;
                            }
                            break;
                        }
                    case "ik":
                    case "transform":
                    case "path":
                    case "physics":
                        {
                            if (tl.Id == null || !sk.ConstraintValues.TryGetValue(tl.Id, out var values)) break;
                            var prop = tl.Property ?? "undefined";
                            if (tl.Target == "ik" && (prop == "bend" || prop == "stretch" || prop == "compress"))
                            {
                                if (alpha >= 0.5) values[prop] = Num(SampleStep(tl.Keys, time));
                            }
                            else values[prop] = MathUtil.Lerp(values.TryGetValue(prop, out var c0) ? c0 : 0, SampleNumber(tl.Keys, time), alpha);
                            break;
                        }
                    case "particles":
                        {
                            var slot = sk.SlotById(tl.Id);
                            if (slot == null) break;
                            sk.ParticleValues.TryGetValue(tl.Id, out var cur);
                            cur = cur ?? new EmitterValues();
                            if (tl.Property == "emitting")
                            {
                                if (alpha >= 0.5) cur.Emitting = Js.Truthy(SampleStep(tl.Keys, time));
                            }
                            else
                            {
                                var att = sk.GetAttachment(slot);
                                double baseRate = cur.Rate ?? (att is ParticlesAttachment pa ? pa.Rate : 0);
                                cur.Rate = MathUtil.Lerp(baseRate, SampleNumber(tl.Keys, time), alpha);
                            }
                            sk.ParticleValues[tl.Id] = cur;
                            break;
                        }
                    case "deform":
                        {
                            var slot = sk.SlotById(tl.Id);
                            if (slot == null) break;
                            var v = SampleArray(tl.Keys, time);
                            var name = tl.Attachment ?? "undefined";
                            slot.Deform.TryGetValue(name, out var cur);
                            double[] o;
                            if (cur != null && alpha < 1)
                            {
                                o = new double[v.Length];
                                for (int i = 0; i < v.Length; i++) o[i] = MathUtil.Lerp(i < cur.Length ? cur[i] : 0, v[i], alpha);
                            }
                            else if (alpha < 1)
                            {
                                o = new double[v.Length];
                                for (int i = 0; i < v.Length; i++) o[i] = v[i] * alpha;
                            }
                            else o = v;
                            slot.Deform[name] = o;
                            break;
                        }
                    case "sequence":
                        {
                            var slot = sk.SlotById(tl.Id);
                            if (slot == null) break;
                            if (alpha >= 0.5) slot.SequenceFrames[tl.Attachment ?? "undefined"] = SampleNumber(tl.Keys, time);
                            break;
                        }
                    case "drawOrder":
                        {
                            if (alpha < 0.5) break;
                            var order = SampleStep(tl.Keys, time) as string[] ?? new string[0];
                            var listed = new List<Slot>();
                            foreach (var id in order) { var s = sk.SlotById(id); if (s != null) listed.Add(s); }
                            var placed = new HashSet<Slot>(listed);
                            var outArr = new Slot[sk.Slots.Count];
                            for (int i = 0; i < sk.Slots.Count; i++) if (!placed.Contains(sk.Slots[i])) outArr[i] = sk.Slots[i];
                            int next = 0;
                            for (int i = 0; i < outArr.Length && next < listed.Count; i++) if (outArr[i] == null) outArr[i] = listed[next++];
                            var dro = new List<Slot>();
                            foreach (var s in outArr) if (s != null) dro.Add(s);
                            sk.DrawOrder = dro;
                            break;
                        }
                }
            }
        }

        /// <summary>Event keys crossed when total time moves from prev (exclusive) to next (inclusive) (§5.2).</summary>
        public static List<FiredEvent> EventsBetween(Document doc, AnimationData anim, double prev, double next, bool loop)
        {
            var o = new List<FiredEvent>();
            if (anim.Events.Count == 0 || next <= prev) return o;
            double d = anim.ComputedDuration();
            foreach (var k in anim.Events)
            {
                var ev = doc.EventById(k.Event);
                if (ev == null) continue;
                if (!loop || d <= 0)
                {
                    if (k.Time > prev && k.Time <= next) o.Add(Make(k, ev, anim));
                    continue;
                }
                double first = Math.Floor(prev / d), lastC = Math.Floor(next / d);
                for (double c = first; c <= lastC; c++)
                {
                    double at = c * d + k.Time;
                    if (at > prev && at <= next) o.Add(Make(k, ev, anim));
                }
            }
            return o;
        }

        static FiredEvent Make(EventKey k, EventData ev, AnimationData anim) => new FiredEvent
        {
            Name = ev.Name,
            Id = ev.Id,
            Time = k.Time,
            Int = k.Int ?? ev.Int,
            Float = k.Float ?? ev.Float,
            String = k.String ?? ev.String,
            Audio = string.IsNullOrEmpty(ev.Audio) ? null : ev.Audio,
            Volume = ev.Volume,
            Animation = anim.Name,
        };

        /// <summary>Pose with an animation (or the setup pose) at a time, with particles brought there deterministically.</summary>
        public static void Seek(Skeleton sk, AnimationData anim, double time)
        {
            void Pose(double t)
            {
                sk.SetToSetupPose();
                if (anim != null) Apply(sk, anim, t);
                sk.UpdateWorldTransform();
            }
            sk.SeekParticles(time, Pose);
            Pose(time);
        }
    }
}
