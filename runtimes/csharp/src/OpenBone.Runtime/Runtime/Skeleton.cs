using System;
using System.Collections.Generic;

namespace OpenBone
{
    /// <summary>
    /// Posed skeleton: bones, slots, constraints, particles and the draw list (runtime/skeleton.ts).
    /// The rules are in docs/runtime-spec.md; this class follows the TypeScript reference line by line.
    /// </summary>
    public sealed class Skeleton
    {
        public readonly Document Doc;
        public readonly List<Bone> Bones = new List<Bone>();
        public readonly List<Slot> Slots = new List<Slot>();
        public List<Slot> DrawOrder = new List<Slot>();
        public SkinData Skin;
        /// <summary>Live (keyable) constraint values by constraint id.</summary>
        public readonly Dictionary<string, Dictionary<string, double>> ConstraintValues = new Dictionary<string, Dictionary<string, double>>();
        /// <summary>Placement of the skeleton (applied to root bones).</summary>
        public double X, Y, ScaleX = 1, ScaleY = 1;
        /// <summary>Seconds passed to Update(); drives sequences when no animation is applied.</summary>
        public double Clock;
        /// <summary>Local time of the dominant animation applied this frame, or null.</summary>
        public double? AnimationTime;
        /// <summary>Live number input values by input id (set by the state machine).</summary>
        public readonly Dictionary<string, double> InputValues = new Dictionary<string, double>();
        /// <summary>"realtime" (by Update time) or "seek" (only through SeekParticles).</summary>
        public string ParticleClock = "realtime";
        /// <summary>Keyable emitter values by slot id.</summary>
        public readonly Dictionary<string, EmitterValues> ParticleValues = new Dictionary<string, EmitterValues>();
        /// <summary>Values for text templates by input name (a running state machine replaces this).</summary>
        public Func<string, object> TextValues;
        /// <summary>Text shown instead of an attachment's own template, by slot id.</summary>
        public readonly Dictionary<string, string> TextOverrides = new Dictionary<string, string>();

        readonly Dictionary<string, Bone> _boneById = new Dictionary<string, Bone>();
        readonly Dictionary<string, Slot> _slotById = new Dictionary<string, Slot>();
        readonly Dictionary<string, ImageAsset> _images = new Dictionary<string, ImageAsset>();
        readonly Dictionary<string, Packed> _packed = new Dictionary<string, Packed>();
        readonly Dictionary<string, double> _inputDefaults = new Dictionary<string, double>();
        readonly Dictionary<string, object> _inputDefaultsByName = new Dictionary<string, object>();
        readonly Dictionary<string, PhysicsState> _physics = new Dictionary<string, PhysicsState>();
        readonly Dictionary<string, ParticleEmitter> _emitters = new Dictionary<string, ParticleEmitter>();
        readonly Dictionary<string, double> _pendingBursts = new Dictionary<string, double>();
        readonly Dictionary<Attachment, ushort[]> _triCache = new Dictionary<Attachment, ushort[]>();
        readonly List<ConstraintData> _order;
        readonly HashSet<string> _inactiveConstraints = new HashSet<string>();
        White _white;
        double _pendingDt, _particlePending, _particleFrac;
        int _particleSteps;
        Dictionary<string, Affine> _setupCache;
        bool _activeComputed;
        SkinData _activeFor;

        sealed class Packed
        {
            public AtlasPage Page;
            public TextureRect Rect;
            public UvMap Map;
            public float[] RegionUvs;
            public double[] Trim;
            public float[] PolyImage, PolyUvs;
            public ushort[] PolyIndices;
        }

        sealed class White
        {
            public AtlasPage Page;
            public double U, V;
        }

        sealed class PhysicsParticle
        {
            public double X, Y, Vx, Vy, Px, Py;
        }

        sealed class PhysicsState
        {
            public PhysicsParticle Origin, Tip;
            public double LastOx, LastOy, LastTx, LastTy, Time;
            public double Steps;
        }

        const int MaxPhysicsSteps = 8;
        static readonly float[] RegionUvs = { 0, 0, 1, 0, 1, 1, 0, 1 };
        static readonly ushort[] RegionIndices = { 0, 1, 2, 0, 2, 3 };

        public Skeleton(Document doc)
        {
            Doc = doc;
            foreach (var bd in doc.Skeleton.Bones)
            {
                var b = new Bone(bd);
                if (!string.IsNullOrEmpty(bd.Parent))
                {
                    b.Parent = _boneById.TryGetValue(bd.Parent, out var p) ? p : null;
                    b.Parent?.Children.Add(b);
                }
                Bones.Add(b);
                _boneById[bd.Id] = b;
            }
            foreach (var sd in doc.Skeleton.Slots)
            {
                if (sd.Bone == null || !_boneById.TryGetValue(sd.Bone, out var bone)) continue;
                var s = new Slot(sd, bone);
                Slots.Add(s);
                _slotById[sd.Id] = s;
            }
            foreach (var img in doc.Images) _images[img.Id] = img;
            var pages = new Dictionary<string, AtlasPage>();
            if (doc.Atlas != null) foreach (var p in doc.Atlas.Pages) pages[p.Id] = p;
            if (doc.Atlas != null)
                foreach (var r in doc.Atlas.Regions)
                {
                    if (r.Page == null || !pages.TryGetValue(r.Page, out var page) || r.Image == null || !_images.ContainsKey(r.Image)) continue;
                    var map = UvMap.For(r, page);
                    double[] trim = IsTrimmed(r)
                        ? new[] { r.OffsetX / r.OriginalWidth, r.OffsetY / r.OriginalHeight, (r.OffsetX + r.Width) / r.OriginalWidth, (r.OffsetY + r.Height) / r.OriginalHeight }
                        : null;
                    float[] quad = trim != null ? new[] { (float)trim[0], (float)trim[1], (float)trim[2], (float)trim[1], (float)trim[2], (float)trim[3], (float)trim[0], (float)trim[3] } : RegionUvs;
                    var pk = new Packed
                    {
                        Page = page,
                        Rect = new TextureRect { X = r.X, Y = r.Y, Width = r.Rotated ? r.Height : r.Width, Height = r.Rotated ? r.Width : r.Height },
                        Map = map,
                        RegionUvs = map.Remap(quad),
                        Trim = trim,
                    };
                    if (r.Polygon != null && r.Polygon.Length >= 6)
                    {
                        var image = new float[r.Polygon.Length];
                        for (int i = 0; i + 1 < image.Length; i += 2)
                        {
                            image[i] = (float)(r.Polygon[i] / r.OriginalWidth);
                            image[i + 1] = (float)(r.Polygon[i + 1] / r.OriginalHeight);
                        }
                        int n = image.Length / 2;
                        var indices = new ushort[Math.Max(0, n - 2) * 3];
                        for (int i = 0; i < n - 2; i++)
                        {
                            indices[i * 3] = 0;
                            indices[i * 3 + 1] = (ushort)(i + 1);
                            indices[i * 3 + 2] = (ushort)(i + 2);
                        }
                        pk.PolyImage = image;
                        pk.PolyUvs = map.Remap(image);
                        pk.PolyIndices = indices;
                    }
                    _packed[r.Image] = pk;
                }
            foreach (var sm in doc.StateMachines)
                foreach (var i in sm.Inputs)
                {
                    if (i.Default is double d && i.Id != null) _inputDefaults[i.Id] = d;
                    if (i.Type != "trigger" && i.Default != null && i.Name != null && !_inputDefaultsByName.ContainsKey(i.Name)) _inputDefaultsByName[i.Name] = i.Default;
                }
            TextValues = name => name != null && _inputDefaultsByName.TryGetValue(name, out var v) ? v : null;
            var w = doc.Atlas?.White;
            if (w != null && w.Page != null && pages.TryGetValue(w.Page, out var wp))
                _white = new White { Page = wp, U = (w.X + w.Width / 2) / wp.Width, V = (w.Y + w.Height / 2) / wp.Height };
            _order = Constraints.Order(doc.Skeleton);
            UpdateActive();
            SetToSetupPose();
            UpdateWorldTransform();
        }

        static bool IsTrimmed(AtlasRegion r) => r.OffsetX != 0 || r.OffsetY != 0 || r.Width != r.OriginalWidth || r.Height != r.OriginalHeight;

        public Bone FindBone(string idOrName)
        {
            if (idOrName == null) return null;
            if (_boneById.TryGetValue(idOrName, out var b)) return b;
            foreach (var x in Bones) if (x.Data.Name == idOrName) return x;
            return null;
        }

        public Slot FindSlot(string idOrName)
        {
            if (idOrName == null) return null;
            if (_slotById.TryGetValue(idOrName, out var s)) return s;
            foreach (var x in Slots) if (x.Data.Name == idOrName) return x;
            return null;
        }

        public Bone BoneById(string id) => id != null && _boneById.TryGetValue(id, out var b) ? b : null;
        public Slot SlotById(string id) => id != null && _slotById.TryGetValue(id, out var s) ? s : null;

        /// <summary>Set the skin by id, then name (unknown or null ⇒ none) and recompute active bones/constraints.</summary>
        public void SetSkin(string idOrName)
        {
            SkinData skin = null;
            if (!string.IsNullOrEmpty(idOrName))
                foreach (var s in Doc.Skeleton.Skins)
                    if (s.Id == idOrName || s.Name == idOrName) { skin = s; break; }
            if (skin == Skin && _activeComputed && _activeFor == skin) return;
            Skin = skin;
            UpdateActive();
        }

        /// <summary>Recompute which bones and constraints are active for the current skin (§3.3).</summary>
        public void UpdateActive()
        {
            _activeComputed = true;
            _activeFor = Skin;
            var sk = Doc.Skeleton;
            Constraints.SkinRequired(sk, out var reqBones, out var reqCons);
            var active = reqBones.Count > 0 ? Constraints.ActiveBones(sk, Skin) : null;
            foreach (var b in Bones) b.Active = active == null || active.Contains(b.Data.Id);
            _inactiveConstraints.Clear();
            var mine = new HashSet<string>();
            if (Skin?.Constraints != null) foreach (var id in Skin.Constraints) if (id != null) mine.Add(id);
            bool Off(string id) => id != null && _boneById.TryGetValue(id, out var bb) && !bb.Active;
            foreach (var c in _order)
            {
                bool skip = c.Id != null && reqCons.Contains(c.Id) && !mine.Contains(c.Id);
                if (!skip && active != null)
                {
                    switch (c)
                    {
                        case PhysicsConstraintData ph:
                            skip = Off(ph.Bone);
                            break;
                        case PathConstraintData pa:
                            skip = pa.Bones.Exists(Off) || Off(SlotById(pa.Target)?.Bone.Data.Id ?? "");
                            break;
                        case IkConstraintData ik:
                            skip = ik.Bones.Exists(Off) || Off(ik.Target);
                            break;
                        case TransformConstraintData tc:
                            skip = tc.Bones.Exists(Off) || Off(tc.Target);
                            break;
                    }
                }
                if (skip && c.Id != null) _inactiveConstraints.Add(c.Id);
            }
        }

        public bool IsConstraintActive(string id) => !_inactiveConstraints.Contains(id);

        public void SetToSetupPose()
        {
            foreach (var b in Bones) b.SetToSetupPose();
            foreach (var s in Slots) s.SetToSetupPose();
            DrawOrder = new List<Slot>(Slots);
            AnimationTime = null;
            ConstraintValues.Clear();
            ParticleValues.Clear();
            foreach (var c in _order) if (c.Id != null) ConstraintValues[c.Id] = SetupValues(c);
        }

        static readonly string[] IkProps = { "mix", "softness", "bend", "stretch", "compress" };
        static readonly string[] TransformProps = { "mixRotate", "mixTranslate", "mixScale", "mixShear" };
        static readonly string[] PathProps = { "position", "spacing", "mixRotate", "mixX", "mixY" };
        static readonly string[] PhysicsProps = { "mix", "inertia", "strength", "damping", "mass", "gravity", "wind" };

        /// <summary>Setup values of a constraint's keyable fields (transform constraints also get mix = 1).</summary>
        public static Dictionary<string, double> SetupValues(ConstraintData c)
        {
            var o = new Dictionary<string, double>();
            string[] props;
            switch (c)
            {
                case IkConstraintData _: props = IkProps; break;
                case TransformConstraintData _: props = TransformProps; o["mix"] = 1; break;
                case PathConstraintData _: props = PathProps; break;
                default: props = PhysicsProps; break;
            }
            foreach (var p in props) o[p] = c.Json != null ? c.Json.Num(p, 0) : 0;
            if (c is IkConstraintData ik)
            {
                o["bend"] = ik.BendPositive ? 1 : -1;
                o["stretch"] = ik.Stretch ? 1 : 0;
                o["compress"] = ik.Compress ? 1 : 0;
            }
            return o;
        }

        Dictionary<string, double> Values(ConstraintData c)
        {
            if (!ConstraintValues.TryGetValue(c.Id, out var v)) ConstraintValues[c.Id] = v = SetupValues(c);
            return v;
        }

        static double V(Dictionary<string, double> v, string k) => v.TryGetValue(k, out var x) ? x : double.NaN;

        /// <summary>Advance simulated time (physics, particles, sequences). Call once per frame before UpdateWorldTransform.</summary>
        public void Update(double dt)
        {
            if (dt > 0)
            {
                _pendingDt += dt;
                Clock += dt;
                _particlePending += dt;
            }
        }

        // ---------------- Particles ----------------

        public void ResetParticles()
        {
            _emitters.Clear();
            _pendingBursts.Clear();
            _particlePending = 0;
            _particleFrac = 0;
            _particleSteps = 0;
        }

        public double ParticleTime => _particleSteps * ParticleEmitter.Step + _particleFrac;

        /// <summary>Deterministically bring particles to time t (seek mode); <paramref name="pose"/> poses the skeleton at a time.</summary>
        public void SeekParticles(double t, Action<double> pose)
        {
            ParticleClock = "seek";
            _particlePending = 0;
            int target = (int)Math.Max(0, Math.Floor(t / ParticleEmitter.Step + 1e-6));
            if (target < _particleSteps) ResetParticles();
            while (_particleSteps < target)
            {
                pose(_particleSteps * ParticleEmitter.Step);
                StepParticles(ParticleEmitter.Step);
                _particleSteps++;
            }
            _particleFrac = Math.Max(0, Math.Min(ParticleEmitter.Step, t - target * ParticleEmitter.Step));
        }

        public void SetEmitting(string slotRef, bool emitting)
        {
            var slot = FindSlot(slotRef);
            if (slot == null) return;
            ParticleValues.TryGetValue(slot.Data.Id, out var cur);
            var v = cur != null ? cur.Clone() : new EmitterValues();
            v.Emitting = emitting;
            ParticleValues[slot.Data.Id] = v;
        }

        public void RestartEmitter(string slotRef)
        {
            var slot = FindSlot(slotRef);
            if (slot != null && _emitters.TryGetValue(slot.Data.Id, out var em)) em.Restart();
        }

        public void EmitParticles(string slotRef, double count)
        {
            var slot = FindSlot(slotRef);
            if (slot == null || !(count > 0)) return;
            _pendingBursts.TryGetValue(slot.Data.Id, out var cur);
            _pendingBursts[slot.Data.Id] = cur + count;
        }

        public ParticleEmitter Emitter(string slotRef)
        {
            var slot = FindSlot(slotRef);
            if (slot == null || !_emitters.TryGetValue(slot.Data.Id, out var em)) return null;
            return em.Data == GetAttachment(slot) ? em : null;
        }

        void StepParticles(double h)
        {
            foreach (var slot in Slots)
            {
                if (!slot.Bone.Active) continue;
                var att = GetAttachment(slot);
                var id = slot.Data.Id;
                if (!(att is ParticlesAttachment pa))
                {
                    _emitters.Remove(id);
                    continue;
                }
                if (!_emitters.TryGetValue(id, out var em) || em.Data != pa)
                {
                    em = new ParticleEmitter(pa, Rng.HashString(slot.Data.Name ?? ""));
                    _emitters[id] = em;
                }
                if (_pendingBursts.TryGetValue(id, out var burst) && burst != 0) em.Pending += burst;
                ParticleValues.TryGetValue(id, out var values);
                em.StepOnce(h, slot.Bone.World, values);
            }
            _pendingBursts.Clear();
        }

        void AdvanceParticles(double dt)
        {
            double acc = _particleFrac + dt;
            double n = Math.Floor(acc / ParticleEmitter.Step + 1e-6);
            int steps = (int)Math.Min(n, ParticleEmitter.MaxSteps);
            for (int i = 0; i < steps; i++) StepParticles(ParticleEmitter.Step);
            _particleSteps += steps;
            _particleFrac = Math.Max(0, Math.Min(ParticleEmitter.Step, acc - n * ParticleEmitter.Step));
        }

        public void ResetPhysics()
        {
            _physics.Clear();
            _pendingDt = 0;
        }

        public double UnitScaleX => (Doc.Skeleton.ReferenceScale ?? 100) / 100 * ScaleX;
        public double UnitScaleY => (Doc.Skeleton.ReferenceScale ?? 100) / 100 * ScaleY;

        Affine RootMatrix => new Affine(ScaleX, 0, 0, ScaleY, X, Y);

        /// <summary>Solve world transforms, then the active constraints in update order (§3.2).</summary>
        public void UpdateWorldTransform()
        {
            ApplySliders();
            var root = RootMatrix;
            foreach (var b in Bones)
            {
                if (!b.Active) continue;
                b.ResetApplied();
                b.UpdateWorld(root);
            }
            double dt = _pendingDt;
            _pendingDt = 0;
            foreach (var c in _order)
            {
                if (c.Id != null && _inactiveConstraints.Contains(c.Id)) continue;
                switch (c)
                {
                    case IkConstraintData ik: ApplyIk(ik, Values(c)); break;
                    case TransformConstraintData tc: ApplyTransform(tc, Values(c)); break;
                    case PathConstraintData pc: ApplyPath(pc, Values(c)); break;
                    case PhysicsConstraintData ph: ApplyPhysics(ph, Values(c), dt); break;
                }
            }
            double pdt = _particlePending;
            _particlePending = 0;
            if (ParticleClock == "realtime" && pdt > 0) AdvanceParticles(pdt);
        }

        // ---------------- Sliders ----------------

        static readonly string[] BoneProps = { "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY" };

        void ApplySliders()
        {
            var list = Doc.Skeleton.Sliders;
            if (list == null || list.Count == 0) return;
            var savedTime = AnimationTime;
            foreach (var sl in list)
            {
                if (sl.Mix <= 0) continue;
                var anim = Doc.AnimationById(sl.Animation);
                if (anim == null) continue;
                double? v = null;
                if (!string.IsNullOrEmpty(sl.Bone)) v = BoneById(sl.Bone)?.Get(sl.Property ?? "rotation");
                else if (!string.IsNullOrEmpty(sl.Input))
                    v = InputValues.TryGetValue(sl.Input, out var iv) ? iv : _inputDefaults.TryGetValue(sl.Input, out var dv) ? dv : 0;
                if (v == null) continue;
                double span = sl.To - sl.From;
                double f = span == 0 ? 0 : (v.Value - sl.From) / span;
                f = sl.Loop ? f - Math.Floor(f) : Math.Min(1, Math.Max(0, f));
                double t0 = sl.TimeFrom ?? 0;
                double t1 = sl.TimeTo ?? anim.ComputedDuration();
                double t = t0 + f * (t1 - t0);
                if (!sl.Additive)
                {
                    Animations.Apply(this, anim, anim.Timelines, t, sl.Mix);
                    continue;
                }
                var before = new double[Bones.Count][];
                var inherits = new string[Bones.Count];
                for (int i = 0; i < Bones.Count; i++)
                {
                    var b = Bones[i];
                    before[i] = new[] { b.X, b.Y, b.Rotation, b.ScaleX, b.ScaleY, b.ShearX, b.ShearY };
                    inherits[i] = b.Inherit;
                }
                foreach (var b in Bones) b.SetToSetupPose();
                var boneTls = anim.Timelines.FindAll(tl => tl.Target == "bone");
                Animations.Apply(this, anim, boneTls, t, 1);
                for (int i = 0; i < Bones.Count; i++)
                {
                    var b = Bones[i];
                    for (int k = 0; k < BoneProps.Length; k++)
                    {
                        string p = BoneProps[k];
                        double cur = b.Get(p).Value, setup = Bone.DataProp(b.Data, p);
                        double delta = p == "rotation" ? MathUtil.WrapDeg(cur - setup) : cur - setup;
                        b.Set(p, before[i][k] + delta * sl.Mix);
                    }
                }
                var keysInherit = new HashSet<string>();
                foreach (var tl in anim.Timelines) if (tl.Target == "bone" && tl.Property == "inherit" && tl.Id != null) keysInherit.Add(tl.Id);
                for (int i = 0; i < Bones.Count; i++)
                    if (sl.Mix < 0.5 || !keysInherit.Contains(Bones[i].Data.Id)) Bones[i].Inherit = inherits[i];
                var other = anim.Timelines.FindAll(tl => tl.Target != "bone");
                if (other.Count > 0) Animations.Apply(this, anim, other, t, sl.Mix);
            }
            AnimationTime = savedTime;
        }

        // ---------------- IK ----------------

        static double Det(Affine m)
        {
            double s = Math.Sign(m.A * m.D - m.B * m.C);
            return s == 0 || double.IsNaN(m.A * m.D - m.B * m.C) ? 1 : s;
        }

        void ApplyIk(IkConstraintData c, Dictionary<string, double> v)
        {
            double mix = V(v, "mix");
            if (mix <= 0) return;
            bool bendPositive = (v.TryGetValue("bend", out var bd) ? bd : (c.BendPositive ? 1 : -1)) > 0;
            bool stretch = (v.TryGetValue("stretch", out var st) ? st : (c.Stretch ? 1 : 0)) > 0;
            bool compress = (v.TryGetValue("compress", out var cp) ? cp : (c.Compress ? 1 : 0)) > 0;
            bool uniform = c.Uniform;
            var target = BoneById(c.Target);
            var bones = new List<Bone>();
            foreach (var id in c.Bones) { var b = BoneById(id); if (b != null) bones.Add(b); }
            if (target == null || bones.Count == 0) return;
            var root = RootMatrix;
            double tx = target.World.X, ty = target.World.Y;
            if (bones.Count == 1)
            {
                var b = bones[0];
                var pw = b.Parent != null ? b.Parent.World : root;
                var inv = MathUtil.Invert(pw);
                double dx = tx - b.World.X, dy = ty - b.World.Y;
                double lx = inv.A * dx + inv.B * dy, ly = inv.C * dx + inv.D * dy;
                double want = Math.Atan2(ly, lx) * MathUtil.RAD - b.Applied.ShearX;
                b.Applied.Rotation += MathUtil.WrapDeg(want - b.Applied.Rotation) * mix;
                b.UpdateWorld(root);
                double len = b.Data.Length * MathUtil.WorldScaleX(b.World);
                if ((stretch || compress) && len > 1e-6)
                {
                    double k = Js.Hypot(dx, dy) / len;
                    if ((k > 1 && stretch) || (k < 1 && compress))
                    {
                        double s = 1 + (k - 1) * mix;
                        b.World.A *= s;
                        b.World.C *= s;
                        if (uniform)
                        {
                            b.World.B *= s;
                            b.World.D *= s;
                        }
                        b.SyncApplied(root);
                    }
                }
                b.UpdateSubtree(root, false);
                return;
            }
            var p = bones[0];
            var ch = bones[1];
            double px = p.World.X, py = p.World.Y;
            double l1 = Js.Hypot(ch.World.X - px, ch.World.Y - py);
            double l2 = ch.Data.Length * MathUtil.WorldScaleX(ch.World);
            double reach = l1 + l2;
            double dRaw = Js.Hypot(tx - px, ty - py);
            double dSoft = dRaw;
            double softness = v.TryGetValue("softness", out var sv) ? sv : 0;
            double soft = Math.Min(softness * Math.Abs(UnitScaleX), reach);
            if (soft > 1e-6 && dRaw > reach - soft) dSoft = reach - soft + soft * (1 - Math.Exp(-(dRaw - (reach - soft)) / soft));
            double dEff = Math.Min(Math.Max(dSoft, Math.Abs(l1 - l2) + 1e-4), reach - 1e-4);
            double ux = dRaw > 1e-9 ? (tx - px) / dRaw : 1;
            double uy = dRaw > 1e-9 ? (ty - py) / dRaw : 0;
            double ax = px + ux * dEff, ay = py + uy * dEff;
            double baseA = Math.Atan2(uy, ux);
            double denom = 2 * l1 * dEff;
            if (denom == 0 || double.IsNaN(denom)) denom = 1;
            double cosA = (l1 * l1 + dEff * dEff - l2 * l2) / denom;
            double a1 = baseA + (bendPositive ? -1 : 1) * Math.Acos(Math.Max(-1, Math.Min(1, cosA)));
            double curDir = Math.Atan2(ch.World.Y - py, ch.World.X - px);
            double sP = Det(p.Parent != null ? p.Parent.World : root);
            double deltaP = MathUtil.WrapDeg((a1 - curDir) * MathUtil.RAD) * sP;
            double pRot = p.Applied.Rotation, cRot = ch.Applied.Rotation;
            p.Applied.Rotation = pRot + deltaP;
            p.UpdateSubtree(root);
            double want2 = Math.Atan2(ay - ch.World.Y, ax - ch.World.X) * MathUtil.RAD;
            double sC = Det(p.World);
            double deltaC = MathUtil.WrapDeg(want2 - ch.WorldRotation) * sC;
            p.Applied.Rotation = pRot + deltaP * mix;
            ch.Applied.Rotation = cRot + deltaC * mix;
            p.UpdateWorld(root);
            ch.UpdateWorld(root);
            if (stretch && dRaw > dEff + 1e-9)
            {
                double s = 1 + (dRaw / dEff - 1) * mix;
                var cw = ch.World;
                double u = uniform ? s : 1;
                p.World.A *= s;
                p.World.C *= s;
                p.World.B *= u;
                p.World.D *= u;
                p.World.Apply(ch.Applied.X, ch.Applied.Y, out var ox, out var oy);
                ch.World = new Affine(cw.A * s, cw.B * u, cw.C * s, cw.D * u, ox, oy);
                p.SyncApplied(root);
                ch.SyncApplied(root);
            }
            ch.UpdateSubtree(root, false);
            foreach (var sib in p.Children) if (sib != ch) sib.UpdateSubtree(root);
        }

        // ---------------- Transform ----------------

        Affine SetupWorldOf(string id)
        {
            if (_setupCache == null)
            {
                _setupCache = new Dictionary<string, Affine>();
                foreach (var b in Doc.Skeleton.Bones)
                {
                    Affine parent = !string.IsNullOrEmpty(b.Parent) && _setupCache.TryGetValue(b.Parent, out var pw) ? pw : null;
                    var lt = new LocalTransform { X = b.X, Y = b.Y, Rotation = b.Rotation, ScaleX = b.ScaleX, ScaleY = b.ScaleY, ShearX = b.ShearX, ShearY = b.ShearY };
                    if (b.Id != null) _setupCache[b.Id] = MathUtil.BoneWorld(parent, lt, b.Inherit);
                }
            }
            return MathUtil.Multiply(RootMatrix, id != null && _setupCache.TryGetValue(id, out var m) ? m : Affine.Identity());
        }

        static void RotateAxes(Affine w, double rad)
        {
            if (rad == 0) return;
            double cos = Math.Cos(rad), sin = Math.Sin(rad);
            double a = w.A, b = w.B, c = w.C, d = w.D;
            w.A = cos * a - sin * c;
            w.B = cos * b - sin * d;
            w.C = sin * a + cos * c;
            w.D = sin * b + cos * d;
        }

        static double SkewOf(Affine m) => MathUtil.WrapDeg((Math.Atan2(m.D, m.B) - Math.Atan2(m.C, m.A)) * MathUtil.RAD - 90);

        static void SetSkew(Affine w, double skewDeg)
        {
            double ly = Js.Hypot(w.B, w.D);
            double ang = Math.Atan2(w.C, w.A) + (90 + skewDeg) * MathUtil.DEG;
            w.B = Math.Cos(ang) * ly;
            w.D = Math.Sin(ang) * ly;
        }

        static double Or1(double x) => x == 0 || double.IsNaN(x) ? 1 : x;

        void ApplyTransform(TransformConstraintData c, Dictionary<string, double> v)
        {
            double m = v.TryGetValue("mix", out var mm) ? mm : 1;
            double mr = V(v, "mixRotate") * m, mt = V(v, "mixTranslate") * m, ms = V(v, "mixScale") * m;
            double mh = (v.TryGetValue("mixShear", out var msh) ? msh : 0) * m;
            if (mr <= 0 && mt <= 0 && ms <= 0 && mh <= 0) return;
            var target = BoneById(c.Target);
            if (target == null) return;
            var root = RootMatrix;
            double offScaleX = c.OffsetScaleX, offScaleY = c.OffsetScaleY, offShear = c.OffsetShear;
            foreach (var id in c.Bones)
            {
                var b = BoneById(id);
                if (b == null || b == target) continue;
                if (c.Local)
                {
                    var p = b.Applied;
                    var t = target.Applied;
                    if (c.Relative)
                    {
                        var s = target.Data;
                        p.Rotation += (MathUtil.WrapDeg(t.Rotation - s.Rotation) + c.OffsetRotation) * mr;
                        p.X += (t.X - s.X + c.OffsetX) * mt;
                        p.Y += (t.Y - s.Y + c.OffsetY) * mt;
                        p.ScaleX *= 1 + ((s.ScaleX != 0 && !double.IsNaN(s.ScaleX) ? t.ScaleX / s.ScaleX : 1) - 1 + offScaleX) * ms;
                        p.ScaleY *= 1 + ((s.ScaleY != 0 && !double.IsNaN(s.ScaleY) ? t.ScaleY / s.ScaleY : 1) - 1 + offScaleY) * ms;
                        p.ShearY += (t.ShearY - s.ShearY + offShear) * mh;
                    }
                    else
                    {
                        p.Rotation += MathUtil.WrapDeg(t.Rotation + c.OffsetRotation - p.Rotation) * mr;
                        p.X += (t.X + c.OffsetX - p.X) * mt;
                        p.Y += (t.Y + c.OffsetY - p.Y) * mt;
                        p.ScaleX += (t.ScaleX + offScaleX - p.ScaleX) * ms;
                        p.ScaleY += (t.ScaleY + offScaleY - p.ScaleY) * ms;
                        p.ShearY += (t.ShearY + offShear - p.ShearY) * mh;
                    }
                    b.UpdateSubtree(root);
                    continue;
                }
                var w = b.World;
                var tw = target.World;
                if (c.Relative)
                {
                    var s = SetupWorldOf(target.Data.Id);
                    if (mr > 0) RotateAxes(w, (MathUtil.WrapDeg(MathUtil.WorldRotation(tw) - MathUtil.WorldRotation(s)) + c.OffsetRotation) * mr * MathUtil.DEG);
                    if (mt > 0)
                    {
                        w.X += (tw.X - s.X + c.OffsetX) * mt;
                        w.Y += (tw.Y - s.Y + c.OffsetY) * mt;
                    }
                    if (ms > 0)
                    {
                        double kx = 1 + (MathUtil.WorldScaleX(tw) / Or1(MathUtil.WorldScaleX(s)) - 1 + offScaleX) * ms;
                        double ky = 1 + (MathUtil.WorldScaleY(tw) / Or1(MathUtil.WorldScaleY(s)) - 1 + offScaleY) * ms;
                        w.A *= kx;
                        w.C *= kx;
                        w.B *= ky;
                        w.D *= ky;
                    }
                    if (mh > 0) SetSkew(w, SkewOf(w) + (MathUtil.WrapDeg(SkewOf(tw) - SkewOf(s)) + offShear) * mh);
                }
                else
                {
                    if (mr > 0) RotateAxes(w, MathUtil.WrapDeg(MathUtil.WorldRotation(tw) + c.OffsetRotation - MathUtil.WorldRotation(w)) * mr * MathUtil.DEG);
                    if (mt > 0)
                    {
                        tw.Apply(c.OffsetX, c.OffsetY, out var ox, out var oy);
                        w.X += (ox - w.X) * mt;
                        w.Y += (oy - w.Y) * mt;
                    }
                    if (ms > 0)
                    {
                        double sx = Or1(MathUtil.WorldScaleX(w)), sy = Or1(MathUtil.WorldScaleY(w));
                        double kx = (sx + (MathUtil.WorldScaleX(tw) + offScaleX - sx) * ms) / sx;
                        double ky = (sy + (MathUtil.WorldScaleY(tw) + offScaleY - sy) * ms) / sy;
                        w.A *= kx;
                        w.C *= kx;
                        w.B *= ky;
                        w.D *= ky;
                    }
                    if (mh > 0)
                    {
                        double sb = SkewOf(w);
                        SetSkew(w, sb + MathUtil.WrapDeg(SkewOf(tw) + offShear - sb) * mh);
                    }
                }
                b.SyncApplied(root);
                b.UpdateSubtree(root, false);
            }
        }

        // ---------------- Path ----------------

        void ApplyPath(PathConstraintData c, Dictionary<string, double> v)
        {
            double mixRotate = V(v, "mixRotate"), mixX = V(v, "mixX"), mixY = V(v, "mixY");
            if (mixRotate <= 0 && mixX <= 0 && mixY <= 0) return;
            var slot = SlotById(c.Target);
            if (slot == null) return;
            if (!(GetAttachment(slot) is PathAttachment att)) return;
            var spline = new Spline(AttachmentWorldVertices(slot, att), att.Closed, c.ConstantSpeed);
            double total = spline.Length;
            if (total <= 1e-9) return;
            var bones = new List<Bone>();
            foreach (var id in c.Bones) { var b = BoneById(id); if (b != null) bones.Add(b); }
            int n = bones.Count;
            if (n == 0) return;
            var lengths = new double[n];
            double sumLen = 0;
            for (int i = 0; i < n; i++) { lengths[i] = bones[i].Data.Length * MathUtil.WorldScaleX(bones[i].World); }
            for (int i = 0; i < n; i++) sumLen += lengths[i];
            var dist = new double[n + 1];
            double position = V(v, "position"), spacing = V(v, "spacing");
            dist[0] = c.PositionMode == "percent" ? position * total : position;
            for (int i = 0; i < n; i++)
            {
                double gap;
                switch (c.SpacingMode)
                {
                    case "fixed": gap = spacing; break;
                    case "percent": gap = spacing * total; break;
                    case "proportional": gap = spacing * total * (sumLen > 0 ? lengths[i] / sumLen : 1.0 / n); break;
                    default: gap = lengths[i] + spacing; break;
                }
                dist[i + 1] = dist[i] + gap;
            }
            var pts = new PathSample[n + 1];
            for (int i = 0; i <= n; i++) pts[i] = spline.Sample(dist[i]);
            var root = RootMatrix;
            double off = c.OffsetRotation * MathUtil.DEG;
            for (int i = 0; i < n; i++)
            {
                var b = bones[i];
                var w = b.World;
                var p = pts[i];
                w.X += (p.X - w.X) * mixX;
                w.Y += (p.Y - w.Y) * mixY;
                if (mixRotate > 0)
                {
                    double ang = p.Angle;
                    if (c.RotateMode != "tangent")
                    {
                        var q = pts[i + 1];
                        double dx = q.X - w.X, dy = q.Y - w.Y;
                        double d = Js.Hypot(dx, dy);
                        if (d > 1e-6)
                        {
                            ang = Math.Atan2(dy, dx);
                            if (c.RotateMode == "chainScale" && lengths[i] > 1e-6)
                            {
                                double k = 1 + (d / lengths[i] - 1) * mixRotate;
                                w.A *= k;
                                w.C *= k;
                            }
                        }
                    }
                    RotateAxes(w, MathUtil.WrapDeg((ang + off) * MathUtil.RAD - MathUtil.WorldRotation(w)) * mixRotate * MathUtil.DEG);
                    b.SyncApplied(root);
                }
                b.UpdateSubtree(root, false);
            }
        }

        // ---------------- Physics ----------------

        void ApplyPhysics(PhysicsConstraintData c, Dictionary<string, double> v, double dt)
        {
            var b = BoneById(c.Bone);
            if (b == null) return;
            var w = b.World;
            double len = b.Data.Length > 1e-6 ? b.Data.Length : 1;
            double ox = w.X, oy = w.Y;
            w.Apply(len, 0, out var tx, out var ty);
            if (!_physics.TryGetValue(c.Id ?? "", out var st))
            {
                st = new PhysicsState
                {
                    Origin = new PhysicsParticle { X = ox, Y = oy, Px = ox, Py = oy },
                    Tip = new PhysicsParticle { X = tx, Y = ty, Px = tx, Py = ty },
                    LastOx = ox, LastOy = oy, LastTx = tx, LastTy = ty,
                };
                _physics[c.Id ?? ""] = st;
            }
            double carry = 1 - Math.Min(1, Math.Max(0, V(v, "inertia")));
            Shift(st.Origin, (ox - st.LastOx) * carry, (oy - st.LastOy) * carry);
            Shift(st.Tip, (tx - st.LastTx) * carry, (ty - st.LastTy) * carry);
            st.LastOx = ox; st.LastOy = oy; st.LastTx = tx; st.LastTy = ty;

            double fps = c.Fps == 0 || double.IsNaN(c.Fps) ? 60 : c.Fps;
            double h = 1 / Math.Max(1, fps);
            st.Time += dt;
            double due = Math.Floor(st.Time / h + 1e-6);
            if (due - st.Steps > MaxPhysicsSteps) st.Steps = due - MaxPhysicsSteps;
            double k = Math.Min(Math.Max(0, V(v, "strength")) / Math.Max(1e-6, V(v, "mass")), 1 / (h * h));
            double decay = Math.Exp(-Math.Max(0, V(v, "damping")) * h);
            double wind = V(v, "wind") * UnitScaleX;
            double gravity = V(v, "gravity") * UnitScaleY;
            void StepP(PhysicsParticle p, double gx, double gy)
            {
                p.Px = p.X;
                p.Py = p.Y;
                p.Vx = (p.Vx + ((gx - p.X) * k + wind) * h) * decay;
                p.Vy = (p.Vy + ((gy - p.Y) * k - gravity) * h) * decay;
                p.X += p.Vx * h;
                p.Y += p.Vy * h;
            }
            for (; st.Steps < due; st.Steps++)
            {
                StepP(st.Origin, ox, oy);
                StepP(st.Tip, tx, ty);
            }
            double mix = Math.Min(1, Math.Max(0, V(v, "mix")));
            if (!(mix > 0)) return;
            double f = Math.Min(1, Math.Max(0, st.Time / h - st.Steps));
            double sox = st.Origin.Px + (st.Origin.X - st.Origin.Px) * f, soy = st.Origin.Py + (st.Origin.Y - st.Origin.Py) * f;
            double stx = st.Tip.Px + (st.Tip.X - st.Tip.Px) * f, sty = st.Tip.Py + (st.Tip.Y - st.Tip.Py) * f;
            w.X = ox + (sox - ox) * c.X * mix;
            w.Y = oy + (soy - oy) * c.Y * mix;
            if (c.Rotate > 0 || c.ScaleX > 0)
            {
                double dx = stx - w.X, dy = sty - w.Y;
                double d = Js.Hypot(dx, dy);
                if (d > 1e-9)
                {
                    double baseA = Math.Atan2(ty - oy, tx - ox);
                    RotateAxes(w, MathUtil.WrapDeg((Math.Atan2(dy, dx) - baseA) * MathUtil.RAD) * c.Rotate * mix * MathUtil.DEG);
                    if (c.ScaleX > 0 && b.Data.Length > 1e-6)
                    {
                        double rest = Or1Len(Js.Hypot(tx - ox, ty - oy), len);
                        double s = 1 + (d / rest - 1) * c.ScaleX * mix;
                        w.A *= s;
                        w.C *= s;
                    }
                }
            }
            b.SyncApplied(RootMatrix);
            b.UpdateSubtree(RootMatrix, false);
        }

        static double Or1Len(double x, double len) => x == 0 || double.IsNaN(x) ? len : x;

        static void Shift(PhysicsParticle p, double dx, double dy)
        {
            p.X += dx;
            p.Y += dy;
            p.Px += dx;
            p.Py += dy;
        }

        // ---------------- Sequences ----------------

        public double SequenceCounter(Slot slot, SequenceAttachment att)
        {
            if (att.Name != null && slot.SequenceFrames.TryGetValue(att.Name, out var keyed)) return Math.Floor(keyed + 1e-6) + att.Offset;
            if (!string.IsNullOrEmpty(att.Input))
            {
                if (InputValues.TryGetValue(att.Input, out var iv)) return Math.Floor(iv + 1e-6) + att.Offset;
                if (_inputDefaults.TryGetValue(att.Input, out var dv)) return Math.Floor(dv + 1e-6) + att.Offset;
            }
            return Sequences.Counter(att.Fps, att.Offset, AnimationTime ?? Clock);
        }

        public int SequenceFrame(Slot slot, SequenceAttachment att) => Sequences.FrameIndex(att.Frames.Count, att.Mode, SequenceCounter(slot, att));

        DrawItem SequenceItem(Slot slot, SequenceAttachment att, int index)
        {
            if (index < 0 || index >= att.Frames.Count) return null;
            var frame = att.Frames[index];
            if (frame?.Image == null || !_images.TryGetValue(frame.Image, out var image)) return null;
            var color = MathUtil.MulColor(slot.Color, MathUtil.ParseHex(att.Color));
            if (color[3] <= 0) return null;
            Sequences.FrameLayout(frame, image.Width, image.Height, out var uv, out var quad);
            _packed.TryGetValue(frame.Image, out var packed);
            double u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
            double q0 = quad[0], p0 = quad[1], q1 = quad[2], p1 = quad[3];
            if (packed?.Trim != null)
            {
                double a0 = packed.Trim[0], b0 = packed.Trim[1], a1 = packed.Trim[2], b1 = packed.Trim[3];
                double nu0 = Math.Max(u0, a0), nv0 = Math.Max(v0, b0), nu1 = Math.Min(u1, a1), nv1 = Math.Min(v1, b1);
                if (nu0 >= nu1 || nv0 >= nv1) return null;
                double Fx(double u) => q0 + (u - u0) / (u1 - u0) * (q1 - q0);
                double Fy(double vv) => p0 + (vv - v0) / (v1 - v0) * (p1 - p0);
                double nq0 = Fx(nu0), np0 = Fy(nv0), nq1 = Fx(nu1), np1 = Fy(nv1);
                q0 = nq0; p0 = np0; q1 = nq1; p1 = np1;
                u0 = nu0; v0 = nv0; u1 = nu1; v1 = nv1;
            }
            var vertices = AttachmentWorldVertices(slot, att);
            if (q0 != 0 || p0 != 0 || q1 != 1 || p1 != 1) vertices = TrimQuad(vertices, q0, p0, q1, p1);
            var quadUvs = new[] { (float)u0, (float)v0, (float)u1, (float)v0, (float)u1, (float)v1, (float)u0, (float)v1 };
            ITexture texture = packed != null ? (ITexture)packed.Page : image;
            var uvs = packed != null ? packed.Map.Remap(quadUvs) : quadUvs;
            bool whole = packed == null && u0 == 0 && v0 == 0 && u1 == 1 && v1 == 1;
            TextureRect rect = whole ? null : new TextureRect
            {
                X = Math.Min(uvs[0], uvs[4]) * texture.Width,
                Y = Math.Min(uvs[1], uvs[5]) * texture.Height,
                Width = Math.Abs(uvs[4] - uvs[0]) * texture.Width,
                Height = Math.Abs(uvs[5] - uvs[1]) * texture.Height,
            };
            return new DrawItem
            {
                Slot = slot,
                Attachment = att,
                Image = image,
                Texture = texture,
                TextureRect = rect,
                Vertices = vertices,
                Uvs = uvs,
                Indices = RegionIndices,
                Color = color,
                Dark = slot.Dark,
                Blend = slot.Data.Blend,
            };
        }

        // ---------------- Text ----------------

        public void SetText(string slotRef, string text)
        {
            var slot = FindSlot(slotRef) ?? throw new ArgumentException($"Slot \"{slotRef}\" not found");
            if (text == null) TextOverrides.Remove(slot.Data.Id);
            else TextOverrides[slot.Data.Id] = text;
        }

        public string TextContent(Slot slot, TextAttachment att)
        {
            var t = TextOverrides.TryGetValue(slot.Data.Id, out var o) ? o : att.Text;
            return Template.Format(t, TextValues);
        }

        public Affine TextMatrix(Slot slot, TextAttachment att)
        {
            double r = att.Rotation * MathUtil.DEG, c = Math.Cos(r), s = Math.Sin(r);
            return MathUtil.Multiply(slot.Bone.World, new Affine(c, -s, s, c, att.X, att.Y));
        }

        // ---------------- Attachments ----------------

        /// <summary>Active skin's attachment, else the default skin's (skins[0]).</summary>
        public Attachment GetAttachment(Slot slot) => GetAttachment(slot, slot.AttachmentName);

        public Attachment GetAttachment(Slot slot, string name)
        {
            if (name == null) return null;
            var id = slot.Data.Id;
            return Skin?.Get(id, name) ?? Doc.DefaultSkin?.Get(id, name);
        }

        /// <summary>World-space vertices (float32) of a slot's attachment.</summary>
        public float[] AttachmentWorldVertices(Slot slot, Attachment att)
        {
            var m = slot.Bone.World;
            if (att is IQuadAttachment q)
            {
                bool text = att is TextAttachment;
                double sx = 1, sy = 1, skx = 0, sky = 0;
                if (att is RegionAttachment ra) { sx = ra.ScaleX; sy = ra.ScaleY; skx = ra.SkewX; sky = ra.SkewY; }
                else if (att is SequenceAttachment sa) { sx = sa.ScaleX; sy = sa.ScaleY; skx = sa.SkewX; sky = sa.SkewY; }
                double hw = q.Width / 2 * (text ? 1 : sx);
                double hh = q.Height / 2 * (text ? 1 : sy);
                double cos = Math.Cos(q.Rotation * MathUtil.DEG), sin = Math.Sin(q.Rotation * MathUtil.DEG);
                var corners = new[] { -hw, hh, hw, hh, hw, -hh, -hw, -hh };
                double kx = !text && skx != 0 && !double.IsNaN(skx) ? Math.Tan(skx * MathUtil.DEG) : 0;
                double ky = !text && sky != 0 && !double.IsNaN(sky) ? Math.Tan(sky * MathUtil.DEG) : 0;
                if ((kx != 0 && !double.IsNaN(kx)) || (ky != 0 && !double.IsNaN(ky)))
                    for (int i = 0; i < 8; i += 2)
                    {
                        double x = corners[i], y = corners[i + 1];
                        corners[i] = x + kx * y;
                        corners[i + 1] = y + ky * x;
                    }
                var o = new float[8];
                for (int i = 0; i < 8; i += 2)
                {
                    double lx = q.X + corners[i] * cos - corners[i + 1] * sin;
                    double ly = q.Y + corners[i] * sin + corners[i + 1] * cos;
                    o[i] = (float)(m.A * lx + m.B * ly + m.X);
                    o[i + 1] = (float)(m.C * lx + m.D * ly + m.Y);
                }
                return o;
            }
            if (att is MeshAttachment || att is PathAttachment || att is BoundingBoxAttachment)
            {
                double[] verts;
                VertexWeight[][] weights;
                string linked = null;
                if (att is MeshAttachment ma)
                {
                    verts = ma.Vertices; weights = ma.Weights;
                    if (ma.Linked != null && ma.Linked.Deform) linked = ma.Linked.Mesh;
                }
                else if (att is PathAttachment pa)
                {
                    verts = pa.Vertices; weights = pa.Weights;
                }
                else
                {
                    var bba = (BoundingBoxAttachment)att;
                    verts = bba.Vertices; weights = bba.Weights;
                }
                int n = verts.Length / 2;
                double[] deform = null;
                if (linked != null) slot.Deform.TryGetValue(linked, out deform);
                if (deform == null && att.Name != null) slot.Deform.TryGetValue(att.Name, out deform);
                var o = new float[n * 2];
                if (weights != null)
                {
                    for (int vi = 0; vi < n; vi++)
                    {
                        double wx = 0, wy = 0;
                        double dx = deform != null && vi * 2 < deform.Length ? deform[vi * 2] : 0;
                        double dy = deform != null && vi * 2 + 1 < deform.Length ? deform[vi * 2 + 1] : 0;
                        if (vi < weights.Length)
                            foreach (var inf in weights[vi])
                            {
                                var bm = BoneById(inf.Bone)?.World ?? m;
                                double lx = inf.X + dx, ly = inf.Y + dy;
                                wx += (bm.A * lx + bm.B * ly + bm.X) * inf.Weight;
                                wy += (bm.C * lx + bm.D * ly + bm.Y) * inf.Weight;
                            }
                        o[vi * 2] = (float)wx;
                        o[vi * 2 + 1] = (float)wy;
                    }
                }
                else
                {
                    for (int vi = 0; vi < n; vi++)
                    {
                        double lx = verts[vi * 2] + (deform != null && vi * 2 < deform.Length ? deform[vi * 2] : 0);
                        double ly = verts[vi * 2 + 1] + (deform != null && vi * 2 + 1 < deform.Length ? deform[vi * 2 + 1] : 0);
                        o[vi * 2] = (float)(m.A * lx + m.B * ly + m.X);
                        o[vi * 2 + 1] = (float)(m.C * lx + m.D * ly + m.Y);
                    }
                }
                return o;
            }
            IReadOnlyList<double> local;
            switch (att)
            {
                case ShapeAttachment sh: local = Geometry.ShapeOutline(sh); break;
                case ClippingAttachment cl: local = cl.Vertices; break;
                case PointAttachment pt: local = new[] { pt.X, pt.Y }; break;
                default: return new float[0];
            }
            var r = new float[local.Count];
            for (int i = 0; i + 1 < local.Count; i += 2)
            {
                r[i] = (float)(m.A * local[i] + m.B * local[i + 1] + m.X);
                r[i + 1] = (float)(m.C * local[i] + m.D * local[i + 1] + m.Y);
            }
            return r;
        }

        ushort[] Triangles(Attachment att, IReadOnlyList<double> polygon)
        {
            if (_triCache.TryGetValue(att, out var t)) return t;
            var tri = Earcut.Triangulate(polygon);
            t = new ushort[tri.Count];
            for (int i = 0; i < t.Length; i++) t[i] = (ushort)tri[i];
            _triCache[att] = t;
            return t;
        }

        static float[] Fill2(int n, double a, double b)
        {
            var o = new float[n];
            for (int i = 0; i + 1 < n; i += 2) { o[i] = (float)a; o[i + 1] = (float)b; }
            return o;
        }

        /// <summary>Renderable geometry in draw order (§8.4).</summary>
        public List<DrawItem> DrawList()
        {
            var items = new List<DrawItem>();
            ClipRegion clip = null;
            string clipEnd = null;
            foreach (var slot in DrawOrder)
            {
                var att = slot.Bone.Active ? GetAttachment(slot) : null;
                int first = items.Count;
                if (att != null) DrawAttachment(slot, att, items, ref clip, ref clipEnd);
                if (clip != null && clip.Slot != slot) for (int i = first; i < items.Count; i++) items[i].Clip = clip;
                if (clip != null && slot.Data.Id == clipEnd)
                {
                    clip = null;
                    clipEnd = null;
                }
            }
            return items;
        }

        void DrawAttachment(Slot slot, Attachment att, List<DrawItem> items, ref ClipRegion clip, ref string clipEnd)
        {
            switch (att)
            {
                case ClippingAttachment ca:
                    if (clip == null && ca.Vertices.Length >= 6)
                    {
                        clip = new ClipRegion { Slot = slot, Polygon = AttachmentWorldVertices(slot, ca), Indices = Triangles(ca, ca.Vertices) };
                        clipEnd = ca.End;
                    }
                    return;
                case RegionAttachment _:
                case MeshAttachment _:
                    {
                        string imageId = att is RegionAttachment r0 ? r0.Image : ((MeshAttachment)att).Image;
                        string attColor = att is RegionAttachment r1 ? r1.Color : ((MeshAttachment)att).Color;
                        ImageAsset image = imageId != null && _images.TryGetValue(imageId, out var im) ? im : null;
                        var color = MathUtil.MulColor(slot.Color, MathUtil.ParseHex(attColor));
                        if (color[3] <= 0) return;
                        var vertices = AttachmentWorldVertices(slot, att);
                        Packed packed = imageId != null && _packed.TryGetValue(imageId, out var pk) ? pk : null;
                        float[] uvs;
                        ushort[] indices;
                        if (att is RegionAttachment)
                        {
                            uvs = packed != null ? packed.RegionUvs : RegionUvs;
                            indices = RegionIndices;
                            if (packed?.PolyImage != null)
                            {
                                vertices = QuadPoints(vertices, packed.PolyImage);
                                uvs = packed.PolyUvs;
                                indices = packed.PolyIndices;
                            }
                            else if (packed?.Trim != null) vertices = TrimQuad(vertices, packed.Trim[0], packed.Trim[1], packed.Trim[2], packed.Trim[3]);
                        }
                        else
                        {
                            var mesh = (MeshAttachment)att;
                            if (packed != null) uvs = packed.Map.Remap(mesh.Uvs);
                            else
                            {
                                uvs = new float[mesh.Uvs.Length];
                                for (int i = 0; i < uvs.Length; i++) uvs[i] = (float)mesh.Uvs[i];
                            }
                            indices = new ushort[mesh.Triangles.Length];
                            for (int i = 0; i < indices.Length; i++) indices[i] = unchecked((ushort)mesh.Triangles[i]);
                        }
                        items.Add(new DrawItem
                        {
                            Slot = slot,
                            Attachment = att,
                            Image = image,
                            Texture = packed != null ? (ITexture)packed.Page : image,
                            TextureRect = packed?.Rect,
                            Vertices = vertices,
                            Uvs = uvs,
                            Indices = indices,
                            Color = color,
                            Dark = slot.Dark,
                            Blend = slot.Data.Blend,
                        });
                        return;
                    }
                case SequenceAttachment sq:
                    {
                        var item = SequenceItem(slot, sq, SequenceFrame(slot, sq));
                        if (item != null) items.Add(item);
                        return;
                    }
                case ParticlesAttachment pa:
                    {
                        var item = ParticleItem(slot, pa);
                        if (item != null) items.Add(item);
                        return;
                    }
                case TextAttachment ta:
                    {
                        var color = slot.Color;
                        if (color[3] <= 0) return;
                        items.Add(new DrawItem
                        {
                            Slot = slot,
                            Attachment = att,
                            Vertices = AttachmentWorldVertices(slot, att),
                            Uvs = RegionUvs,
                            Indices = RegionIndices,
                            Color = color,
                            Blend = slot.Data.Blend,
                            Text = new TextDraw
                            {
                                Content = TextContent(slot, ta),
                                Font = ta.Font,
                                Size = ta.Size,
                                Weight = ta.Weight,
                                Align = ta.Align,
                                Width = ta.Width,
                                Height = ta.Height,
                                Fill = MathUtil.ParseHex(ta.Color),
                                Outline = !string.IsNullOrEmpty(ta.Outline) && (ta.OutlineWidth ?? 0) != 0 ? MathUtil.ParseHex(ta.Outline) : null,
                                OutlineWidth = ta.OutlineWidth ?? 0,
                                Matrix = TextMatrix(slot, ta),
                            },
                        });
                        return;
                    }
                case ShapeAttachment sh:
                    {
                        var outline = AttachmentWorldVertices(slot, att);
                        var indices = Triangles(sh, Geometry.ShapeOutline(sh));
                        var color = MathUtil.MulColor(slot.Color, MathUtil.ParseHex(sh.Fill));
                        bool hasStroke = !string.IsNullOrEmpty(sh.Stroke) && (sh.StrokeWidth ?? 0) > 0;
                        if (color[3] <= 0 && !(hasStroke && MathUtil.MulColor(slot.Color, MathUtil.ParseHex(sh.Stroke))[3] > 0)) return;
                        bool strokeOn = !string.IsNullOrEmpty(sh.Stroke) && sh.StrokeWidth.HasValue && sh.StrokeWidth.Value != 0 && !double.IsNaN(sh.StrokeWidth.Value);
                        items.Add(new DrawItem
                        {
                            Slot = slot,
                            Attachment = att,
                            Texture = _white?.Page,
                            Vertices = outline,
                            Uvs = _white != null ? Fill2(outline.Length, _white.U, _white.V) : new float[outline.Length],
                            Indices = indices,
                            Color = color,
                            Blend = slot.Data.Blend,
                            Stroke = strokeOn ? new Stroke { Color = MathUtil.MulColor(slot.Color, MathUtil.ParseHex(sh.Stroke)), Width = sh.StrokeWidth.Value, Outline = outline } : null,
                        });
                        return;
                    }
            }
        }

        DrawItem ParticleItem(Slot slot, ParticlesAttachment att)
        {
            if (!_emitters.TryGetValue(slot.Data.Id, out var em) || em.Data != att || em.Alive == 0) return null;
            var geo = em.Geometry(_particleFrac, slot.Bone.World, slot.Color);
            if (geo.Count == 0) return null;
            ITexture texture = null;
            ImageAsset image = null;
            var uvs = geo.Uvs;
            TextureRect rect = null;
            if (att.Look == "image")
            {
                image = !string.IsNullOrEmpty(att.Image) && _images.TryGetValue(att.Image, out var im) ? im : null;
                Packed packed = !string.IsNullOrEmpty(att.Image) && _packed.TryGetValue(att.Image, out var pk) ? pk : null;
                if (packed != null)
                {
                    texture = packed.Page;
                    rect = packed.Rect;
                    uvs = packed.Map.Remap(geo.Uvs);
                }
                else texture = image;
                if (texture == null) return null;
            }
            else if (att.Look == "square")
            {
                if (_white != null)
                {
                    texture = _white.Page;
                    uvs = Fill2(geo.Uvs.Length, _white.U, _white.V);
                }
            }
            else texture = new TextureRef { Id = ParticleDot.TextureId, Name = ParticleDot.TextureId, Width = ParticleDot.Size, Height = ParticleDot.Size };
            return new DrawItem
            {
                Slot = slot,
                Attachment = att,
                Image = image,
                Texture = texture,
                TextureRect = rect,
                Vertices = geo.Vertices,
                Uvs = uvs,
                Indices = geo.Indices,
                Color = slot.Color,
                Colors = geo.Colors,
                Blend = att.Blend,
                Particles = new ParticleBatch { Look = att.Look, Count = geo.Count },
            };
        }

        /// <summary>
        /// World polygon used for hit-testing a slot: the current attachment if it is a bounding box, else the first
        /// bounding box on the slot (default skin overlaid by the active skin, JS key order), else the current attachment.
        /// </summary>
        public float[] HitPolygon(Slot slot)
        {
            var att = GetAttachment(slot);
            if (!(att is BoundingBoxAttachment))
            {
                var found = FirstBoundingBox(slot.Data.Id);
                if (found != null) att = found;
            }
            if (att == null) return null;
            switch (att)
            {
                case BoundingBoxAttachment _:
                case ShapeAttachment _:
                case ClippingAttachment _:
                case RegionAttachment _:
                case SequenceAttachment _:
                case TextAttachment _:
                    return AttachmentWorldVertices(slot, att);
                case MeshAttachment mesh:
                    {
                        var v = AttachmentWorldVertices(slot, att);
                        int len = Math.Max(0, Math.Min(v.Length, mesh.Hull * 2));
                        var o = new float[len];
                        Array.Copy(v, o, len);
                        return o;
                    }
                default: return null;
            }
        }

        Attachment FirstBoundingBox(string slotId)
        {
            OrderedMap<Attachment> def = null, mine = null;
            Doc.DefaultSkin?.Attachments.TryGetValue(slotId, out def);
            Skin?.Attachments.TryGetValue(slotId, out mine);
            var merged = new OrderedMap<Attachment>();
            if (def != null) foreach (var k in def.JsKeyOrder()) merged.Set(k, def.Get(k));
            if (mine != null) foreach (var k in mine.JsKeyOrder()) merged.Set(k, mine.Get(k));
            foreach (var k in merged.JsKeyOrder())
                if (merged.Get(k) is BoundingBoxAttachment bb) return bb;
            return null;
        }

        /// <summary>
        /// The active bounding boxes in the current pose (world polygons, their AABB, point / segment / AABB / skeleton
        /// overlap queries). A snapshot: take a new one, or call <see cref="SkeletonBounds.Update"/> on it, after the pose changes.
        /// </summary>
        public SkeletonBounds BoundingBoxes() => new SkeletonBounds(this);

        public bool HitTest(Slot slot, double x, double y)
        {
            if (!slot.Bone.Active) return false;
            var poly = HitPolygon(slot);
            return poly != null && MathUtil.PointInPolygon(x, y, poly);
        }

        /// <summary>Axis-aligned bounds of everything drawn and every bone (world space).</summary>
        public void Bounds(out double minX, out double minY, out double maxX, out double maxY)
        {
            double x0 = double.PositiveInfinity, y0 = double.PositiveInfinity, x1 = double.NegativeInfinity, y1 = double.NegativeInfinity;
            void Add(double x, double y)
            {
                x0 = Math.Min(x0, x); y0 = Math.Min(y0, y); x1 = Math.Max(x1, x); y1 = Math.Max(y1, y);
            }
            foreach (var it in DrawList()) for (int i = 0; i + 1 < it.Vertices.Length; i += 2) Add(it.Vertices[i], it.Vertices[i + 1]);
            foreach (var b in Bones)
            {
                Add(b.World.X, b.World.Y);
                b.World.Apply(b.Data.Length, 0, out var ex, out var ey);
                Add(ex, ey);
            }
            minX = x0; minY = y0; maxX = x1; maxY = y1;
        }

        static float[] TrimQuad(float[] q, double u0, double v0, double u1, double v1)
        {
            double ux = q[2] - (double)q[0], uy = q[3] - (double)q[1];
            double vx = q[6] - (double)q[0], vy = q[7] - (double)q[1];
            float Px(double u, double v) => (float)(q[0] + ux * u + vx * v);
            float Py(double u, double v) => (float)(q[1] + uy * u + vy * v);
            return new[] { Px(u0, v0), Py(u0, v0), Px(u1, v0), Py(u1, v0), Px(u1, v1), Py(u1, v1), Px(u0, v1), Py(u0, v1) };
        }

        static float[] QuadPoints(float[] q, float[] uv)
        {
            double ux = q[2] - (double)q[0], uy = q[3] - (double)q[1];
            double vx = q[6] - (double)q[0], vy = q[7] - (double)q[1];
            var o = new float[uv.Length];
            for (int i = 0; i + 1 < uv.Length; i += 2)
            {
                o[i] = (float)(q[0] + ux * uv[i] + vx * uv[i + 1]);
                o[i + 1] = (float)(q[1] + uy * uv[i] + vy * uv[i + 1]);
            }
            return o;
        }
    }
}
