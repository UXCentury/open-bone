using System;
using System.Collections.Generic;
using System.Threading;
using OpenBone.Json;

namespace OpenBone
{
    public sealed class StateMachineOptions
    {
        public IScriptHost ScriptHost;
    }

    public sealed class StateChange
    {
        public string Layer, From, To;
    }

    /// <summary>
    /// Runs a state machine over a skeleton: inputs, layered states with cross-fades, pointer listeners, events,
    /// bindings and scripts (runtime/state-machine.ts, docs/runtime-spec.md §9).
    /// </summary>
    public sealed class StateMachineInstance
    {
        const double OnCompleteMix = 0.1;
        static long _stateCounter;

        sealed class StateInstance
        {
            public readonly string Uid = "state_" + Interlocked.Increment(ref _stateCounter);
            public readonly StateData Data;
            public double Time;
            public double PrevTime = -1e-6;
            public readonly List<IScriptHandle> Scripts = new List<IScriptHandle>();
            public StateInstance(StateData d) { Data = d; }
        }

        sealed class LayerInstance
        {
            public readonly LayerData Data;
            public StateInstance Current, From;
            public double MixTime, MixDuration;
            public bool Exited;
            public LayerInstance(LayerData d) { Data = d; }
        }

        sealed class PointerEvent
        {
            public string Type;
            public double X, Y;
        }

        sealed class SlotOverride
        {
            public string Color;
            public bool HasAttachment;
            public string Attachment;
        }

        public readonly Skeleton Skeleton;
        public readonly StateMachineData Data;
        public readonly Document Doc;
        /// <summary>Input values by input id: bool, double or string.</summary>
        public readonly Dictionary<string, object> Inputs = new Dictionary<string, object>();
        readonly List<string> _inputOrder = new List<string>();
        readonly HashSet<string> _fired = new HashSet<string>();
        readonly List<LayerInstance> _layers = new List<LayerInstance>();
        List<PointerEvent> _pending = new List<PointerEvent>();
        readonly HashSet<string> _hovered = new HashSet<string>();
        readonly HashSet<string> _pressed = new HashSet<string>();
        double _px, _py;
        bool _pdown;
        readonly List<IScriptHandle> _scripts = new List<IScriptHandle>();
        readonly List<KeyValuePair<string, Dictionary<string, double>>> _boneOverrides = new List<KeyValuePair<string, Dictionary<string, double>>>();
        readonly List<KeyValuePair<string, SlotOverride>> _slotOverrides = new List<KeyValuePair<string, SlotOverride>>();
        readonly List<KeyValuePair<string, bool>> _emitterOverrides = new List<KeyValuePair<string, bool>>();
        List<FiredEvent> _pendingEvents = new List<FiredEvent>();
        readonly Dictionary<string, IScriptHandle> _handles = new Dictionary<string, IScriptHandle>();
        readonly List<string> _handleOrder = new List<string>();
        readonly StateMachineOptions _opts;
        double _elapsed;
        bool _started;
        ScriptApi _api;

        public readonly AudioDirector Audio;

        public event Action<FiredEvent> Event;
        public event Action<StateChange> StateChanged;
        public event Action<string, object> InputChanged;
        public event Action<IReadOnlyList<JsonValue>> Log;
        public event Action<Exception> Error;
        public event Action<AudioCommand> AudioCommand;

        public StateMachineInstance(Skeleton skeleton, StateMachineData data, StateMachineOptions opts = null)
        {
            Skeleton = skeleton;
            Data = data;
            Doc = skeleton.Doc;
            _opts = opts ?? new StateMachineOptions();
            Audio = new AudioDirector(Doc, c => AudioCommand?.Invoke(c));
            foreach (var i in data.Inputs) SetRaw(i.Id ?? "", i.Type == "trigger" ? (object)false : i.Default);
            foreach (var l in data.Layers) _layers.Add(new LayerInstance(l));
            skeleton.TextValues = name => GetInput(name);
        }

        void SetRaw(string id, object v)
        {
            if (!Inputs.ContainsKey(id)) _inputOrder.Add(id);
            Inputs[id] = v;
        }

        public double Elapsed => _elapsed;

        // ---------------- Inputs ----------------

        InputData FindInput(string reference)
        {
            foreach (var i in Data.Inputs) if (i.Id == reference || i.Name == reference) return i;
            return null;
        }

        /// <summary>Input value by id or name (bool, double, string), or null.</summary>
        public object GetInput(string name)
        {
            var i = FindInput(name);
            return i != null && Inputs.TryGetValue(i.Id ?? "", out var v) ? v : null;
        }

        public void SetInput(string name, object value)
        {
            var i = FindInput(name) ?? throw new ArgumentException($"Input \"{name}\" not found");
            if (i.Type == "trigger")
            {
                Fire(name);
                return;
            }
            object v;
            if (i.Type == "string") v = Js.ToStr(value);
            else if (i.Type == "bool") v = value is string s ? s == "true" : Js.Truthy(value);
            else
            {
                double n = Js.ToNumber(value);
                if (double.IsNaN(n) || double.IsInfinity(n)) return;
                v = n;
            }
            if (Inputs.TryGetValue(i.Id ?? "", out var cur) && Js.StrictEquals(cur, v) && !(cur is double cd && double.IsNaN(cd))) return;
            SetRaw(i.Id ?? "", v);
            InputChanged?.Invoke(i.Name, v);
        }

        public void SetBool(string name, bool v) => SetInput(name, v);
        public void SetNumber(string name, double v) => SetInput(name, v);
        public void SetString(string name, string v) => SetInput(name, v);
        public void SetText(string slot, string text) => Skeleton.SetText(slot, text);

        public void Fire(string name)
        {
            var i = FindInput(name) ?? throw new ArgumentException($"Input \"{name}\" not found");
            _fired.Add(i.Id ?? "");
            InputChanged?.Invoke(i.Name, true);
        }

        /// <summary>Current state name per layer ("exit" once a layer exited, null if none).</summary>
        public Dictionary<string, string> ActiveStates
        {
            get
            {
                var o = new Dictionary<string, string>();
                foreach (var l in _layers) o[l.Data.Name ?? ""] = l.Exited ? "exit" : l.Current?.Data.Name;
                return o;
            }
        }

        // ---------------- Pointer ----------------

        /// <summary>Queue a pointer event (down, up, move) in skeleton space; processed on the next Advance.</summary>
        public void Pointer(string type, double x, double y) => _pending.Add(new PointerEvent { Type = type, X = x, Y = y });

        void ProcessPointer()
        {
            var evs = _pending;
            _pending = new List<PointerEvent>();
            foreach (var p in evs)
            {
                _px = p.X;
                _py = p.Y;
                _pdown = p.Type == "down" ? true : p.Type == "up" ? false : _pdown;
                foreach (var s in _scripts)
                {
                    var arg = new JsObject { ["type"] = p.Type, ["x"] = p.X, ["y"] = p.Y };
                    SafeCall(s, "onPointer", arg);
                }
                foreach (var li in Data.Listeners)
                {
                    bool hit = !string.IsNullOrEmpty(li.Slot) ? Hit(li.Slot, p.X, p.Y) : true;
                    string key = li.Id ?? "";
                    bool fire = false;
                    switch (li.Event)
                    {
                        case "move": fire = hit && p.Type == "move"; break;
                        case "down": fire = hit && p.Type == "down"; break;
                        case "up": fire = hit && p.Type == "up"; break;
                        case "click":
                            if (p.Type == "down" && hit) _pressed.Add(key);
                            if (p.Type == "up")
                            {
                                fire = hit && _pressed.Contains(key);
                                _pressed.Remove(key);
                            }
                            break;
                        case "enter":
                        case "exit":
                            {
                                bool was = _hovered.Contains(key);
                                if (hit && !was)
                                {
                                    _hovered.Add(key);
                                    fire = li.Event == "enter";
                                }
                                else if (!hit && was)
                                {
                                    _hovered.Remove(key);
                                    fire = li.Event == "exit";
                                }
                                break;
                            }
                    }
                    if (fire) RunActions(li);
                }
            }
        }

        bool Hit(string slotId, double x, double y)
        {
            var slot = Skeleton.SlotById(slotId);
            return slot != null && Skeleton.HitTest(slot, x, y);
        }

        void RunActions(ListenerData li)
        {
            foreach (var a in li.Actions)
            {
                switch (a.Type)
                {
                    case "setInput": SetInput(a.Input, a.Value); break;
                    case "toggleInput":
                        Inputs.TryGetValue(a.Input ?? "", out var cur);
                        SetInput(a.Input, !Js.Truthy(cur));
                        break;
                    case "fireTrigger": Fire(a.Input); break;
                    case "reportEvent":
                        {
                            var ev = Doc.EventById(a.Event);
                            if (ev != null)
                            {
                                if (!string.IsNullOrEmpty(ev.Audio)) Audio.Play(ev.Audio, new PlayOptions { Volume = ev.Volume, Source = "event:" + ev.Name });
                                _pendingEvents.Add(new FiredEvent { Name = ev.Name, Id = ev.Id, Time = _elapsed, Int = ev.Int, Float = ev.Float, String = ev.String, Animation = "" });
                            }
                            break;
                        }
                    case "playSound": Audio.Play(a.Sound, new PlayOptions { Volume = a.Volume, Source = "listener:" + li.Name }); break;
                    case "stopSound": Audio.StopSound(a.Sound, a.Fade); break;
                    case "runScript":
                        {
                            var script = Doc.ScriptById(a.Script);
                            var handle = script != null ? ScriptFor(script.Id) : null;
                            if (handle != null) SafeCall(handle, a.Fn);
                            break;
                        }
                    case "setEmitter": SetEmitter(a.Slot, a.Emitting); break;
                    case "emitParticles": Skeleton.EmitParticles(a.Slot, a.Count); break;
                }
            }
        }

        /// <summary>Switch a slot's emitter; switching on restarts its cycle so bursts replay.</summary>
        public void SetEmitter(string slotRef, bool emitting)
        {
            var slot = Skeleton.FindSlot(slotRef);
            if (slot == null) return;
            int i = _emitterOverrides.FindIndex(x => x.Key == slot.Data.Id);
            if (i >= 0) _emitterOverrides[i] = new KeyValuePair<string, bool>(slot.Data.Id, emitting);
            else _emitterOverrides.Add(new KeyValuePair<string, bool>(slot.Data.Id, emitting));
            if (emitting) Skeleton.RestartEmitter(slot.Data.Id);
        }

        // ---------------- Scripts ----------------

        sealed class ScriptApi : IScriptApi
        {
            readonly StateMachineInstance _m;
            public ScriptApi(StateMachineInstance m) { _m = m; }
            public double Time() => _m._elapsed;
            public object Input(string name) => _m.GetInput(name);
            public void SetInput(string name, object value) => _m.SetInput(name, value);
            public void Fire(string name) => _m.Fire(name);

            public void Emit(string name, JsonValue payload)
            {
                EventData ev = null;
                foreach (var e in _m.Doc.Events) if (e.Name == name || e.Id == name) { ev = e; break; }
                if (ev != null && !string.IsNullOrEmpty(ev.Audio)) _m.Audio.Play(ev.Audio, new PlayOptions { Volume = ev.Volume, Source = "event:" + ev.Name });
                double? pInt = payload?.NumOpt("int"), pFloat = payload?.NumOpt("float");
                string pStr = payload?.Get("string") is JsonValue sv && !sv.IsNull ? Js.ToStr(Js.FromJson(sv)) : null;
                _m._pendingEvents.Add(new FiredEvent
                {
                    Name = name,
                    Id = ev?.Id ?? name,
                    Time = _m._elapsed,
                    Int = pInt ?? ev?.Int ?? 0,
                    Float = pFloat ?? ev?.Float ?? 0,
                    String = pStr ?? ev?.String ?? "",
                    Animation = "",
                });
            }

            public JsonValue Bone(string n)
            {
                var b = _m.Skeleton.FindBone(n);
                if (b == null) return null;
                var o = JsonValue.NewObject();
                o.Set("x", JsonValue.Number(b.X));
                o.Set("y", JsonValue.Number(b.Y));
                o.Set("rotation", JsonValue.Number(b.Rotation));
                o.Set("scaleX", JsonValue.Number(b.ScaleX));
                o.Set("scaleY", JsonValue.Number(b.ScaleY));
                o.Set("worldX", JsonValue.Number(b.World.X));
                o.Set("worldY", JsonValue.Number(b.World.Y));
                o.Set("worldRotation", JsonValue.Number(b.WorldRotation));
                return o;
            }

            public void SetBone(string n, JsonValue props)
            {
                var b = _m.Skeleton.FindBone(n);
                if (b == null || props == null || !props.IsObject) return;
                var list = _m._boneOverrides;
                int i = list.FindIndex(x => x.Key == b.Data.Id);
                var o = i >= 0 ? new Dictionary<string, double>(list[i].Value) : new Dictionary<string, double>();
                foreach (var k in props.Keys)
                {
                    var v = props.Get(k);
                    if (v.IsNumber) o[k] = v.AsNumber;
                }
                if (i >= 0) list[i] = new KeyValuePair<string, Dictionary<string, double>>(b.Data.Id, o);
                else list.Add(new KeyValuePair<string, Dictionary<string, double>>(b.Data.Id, o));
            }

            public void Slot(string n, JsonValue props)
            {
                var s = _m.Skeleton.FindSlot(n);
                if (s == null || props == null || !props.IsObject) return;
                var list = _m._slotOverrides;
                int i = list.FindIndex(x => x.Key == s.Data.Id);
                var prev = i >= 0 ? list[i].Value : null;
                var o = new SlotOverride { Color = prev?.Color, HasAttachment = prev?.HasAttachment ?? false, Attachment = prev?.Attachment };
                if (props.Has("color")) o.Color = props.Get("color").IsString ? props.Get("color").AsString : null;
                if (props.Has("attachment"))
                {
                    o.HasAttachment = true;
                    var a = props.Get("attachment");
                    o.Attachment = a.IsString ? a.AsString : null;
                }
                if (i >= 0) list[i] = new KeyValuePair<string, SlotOverride>(s.Data.Id, o);
                else list.Add(new KeyValuePair<string, SlotOverride>(s.Data.Id, o));
            }

            public JsonValue Pointer()
            {
                var o = JsonValue.NewObject();
                o.Set("x", JsonValue.Number(_m._px));
                o.Set("y", JsonValue.Number(_m._py));
                o.Set("down", JsonValue.Bool(_m._pdown));
                return o;
            }

            public void Log(IReadOnlyList<JsonValue> args) => _m.Log?.Invoke(args);
        }

        IScriptApi Api => _api ??= new ScriptApi(this);

        IScriptHandle ScriptFor(string id)
        {
            if (_opts.ScriptHost == null) return null;
            if (id != null && _handles.TryGetValue(id, out var h)) return h;
            var s = Doc.ScriptById(id);
            if (s == null) return null;
            try
            {
                h = _opts.ScriptHost.Load(s, Api);
            }
            catch (Exception e)
            {
                Error?.Invoke(e);
                return null;
            }
            _handles[id] = h;
            _handleOrder.Add(id);
            return h;
        }

        void SafeCall(IScriptHandle h, string fn, params object[] args)
        {
            try
            {
                if (h.Has(fn)) h.Call(fn, args);
            }
            catch (Exception e)
            {
                Error?.Invoke(e);
            }
        }

        void Start()
        {
            _started = true;
            foreach (var id in Data.Scripts)
            {
                var h = ScriptFor(id);
                if (h != null)
                {
                    _scripts.Add(h);
                    SafeCall(h, "onStart");
                }
            }
            foreach (var l in _layers)
            {
                StateData entry = null;
                foreach (var s in l.Data.States) if (s.Id == l.Data.Entry) { entry = s; break; }
                if (entry != null) Enter(l, entry, 0);
            }
        }

        void StateSounds(StateData s, string on, string owner)
        {
            if (s.Sounds == null) return;
            foreach (var x in s.Sounds)
            {
                if (x.On != on) continue;
                if (x.Action == "stop") Audio.StopSound(x.Sound);
                else Audio.Play(x.Sound, new PlayOptions { Volume = x.Volume, Owner = owner, Tag = owner != null ? "hook:" + x.Sound : null, Source = "state:" + s.Name });
            }
        }

        void Enter(LayerInstance l, StateData state, double mix)
        {
            var prev = l.Current;
            if (prev != null)
            {
                foreach (var h in prev.Scripts) DisposeQuietly(h);
                Audio.StopOwner(prev.Uid, mix);
                StateSounds(prev.Data, "exit", null);
            }
            if (state.Type == "exit")
            {
                l.Exited = true;
                l.From = prev;
                l.Current = null;
                l.MixTime = 0;
                l.MixDuration = mix;
            }
            else
            {
                var inst = new StateInstance(state);
                l.From = mix > 0 ? prev : null;
                l.Current = inst;
                l.MixTime = 0;
                l.MixDuration = mix;
                l.Exited = false;
                StateSounds(state, "enter", inst.Uid);
                if (state.Emitters != null) foreach (var e in state.Emitters) SetEmitter(e.Slot, e.Emitting);
                if (state.Inputs != null) foreach (var x in state.Inputs) if (FindInput(x.Input) != null) SetInput(x.Input, x.Value);
                if (state.Scripts != null)
                    foreach (var id in state.Scripts)
                    {
                        var s = Doc.ScriptById(id);
                        if (s == null || _opts.ScriptHost == null) continue;
                        try
                        {
                            var h = _opts.ScriptHost.Load(s, Api);
                            inst.Scripts.Add(h);
                            SafeCall(h, "onStart");
                        }
                        catch (Exception e)
                        {
                            Error?.Invoke(e);
                        }
                    }
            }
            StateChanged?.Invoke(new StateChange { Layer = l.Data.Name, From = prev?.Data.Name, To = state.Name });
        }

        static void DisposeQuietly(IScriptHandle h)
        {
            try { h.Dispose(); } catch { /* ignore */ }
        }

        // ---------------- Transitions ----------------

        bool ConditionPasses(Condition c)
        {
            InputData input = null;
            foreach (var i in Data.Inputs) if (i.Id == c.Input) { input = i; break; }
            if (input == null) return false;
            if (input.Type == "trigger") return _fired.Contains(input.Id ?? "");
            Inputs.TryGetValue(input.Id ?? "", out var v);
            var want = c.Value;
            switch (c.Op)
            {
                case "==":
                    if (input.Type == "string") return Js.ToStr(v) == Js.ToStr(want);
                    return Js.StrictEquals(v, want) || (v is double a && want is double b && Math.Abs(a - b) < 1e-9);
                case "!=":
                    if (input.Type == "string") return Js.ToStr(v) != Js.ToStr(want);
                    return !Js.StrictEquals(v, want);
                case ">": return Js.ToNumber(v) > Js.ToNumber(want);
                case "<": return Js.ToNumber(v) < Js.ToNumber(want);
                case ">=": return Js.ToNumber(v) >= Js.ToNumber(want);
                case "<=": return Js.ToNumber(v) <= Js.ToNumber(want);
                default: return false;
            }
        }

        AnimationData Anim(string id) => string.IsNullOrEmpty(id) ? null : Doc.AnimationById(id);

        double Progress(StateInstance s)
        {
            var pair = BlendPair(s.Data);
            var anim = pair != null ? (pair.T >= 0.5 ? pair.Hi : pair.Lo) : Anim(s.Data.Animation);
            double d = anim != null ? anim.ComputedDuration() : 0;
            return d > 0 ? s.Time / d : 1;
        }

        bool CanTake(TransitionData t, StateInstance s)
        {
            if (t.From != TransitionData.AnyState && s != null && t.To == s.Data.Id && t.Conditions.Count == 0) return false;
            if (t.From == TransitionData.AnyState && s != null && t.To == s.Data.Id) return false;
            double? exitTime = t.ExitTime ?? (t.Conditions.Count == 0 ? 1 : (double?)null);
            if (exitTime != null && s != null && Progress(s) < exitTime.Value) return false;
            foreach (var c in t.Conditions) if (!ConditionPasses(c)) return false;
            return true;
        }

        TransitionData Evaluate(LayerInstance l)
        {
            if (l.Exited) return null;
            var cur = l.Current;
            var candidates = new List<TransitionData>();
            foreach (var t in l.Data.Transitions) if (t.From == TransitionData.AnyState || (cur != null && t.From == cur.Data.Id)) candidates.Add(t);
            Gradient.StableSort(candidates, (a, b) => (a.From == TransitionData.AnyState ? 1 : 0) - (b.From == TransitionData.AnyState ? 1 : 0));
            foreach (var t in candidates)
            {
                if (!CanTake(t, cur)) continue;
                StateData to = null;
                foreach (var s in l.Data.States) if (s.Id == t.To) { to = s; break; }
                if (to == null) continue;
                Enter(l, to, t.Duration);
                return t;
            }
            var next = cur?.Data.OnComplete;
            if (cur != null && !string.IsNullOrEmpty(next) && Progress(cur) >= 1)
            {
                StateData to = null;
                foreach (var s in l.Data.States) if (s.Id == next) { to = s; break; }
                if (to != null) Enter(l, to, OnCompleteMix);
            }
            return null;
        }

        void Settle(LayerInstance l)
        {
            for (int hop = 0; hop < 4; hop++)
            {
                var t = Evaluate(l);
                if (t == null) return;
                foreach (var c in t.Conditions) if (c.Input != null) _fired.Remove(c.Input);
            }
        }

        // ---------------- Apply ----------------

        sealed class Pair
        {
            public AnimationData Lo, Hi;
            public double T;
        }

        Pair BlendPair(StateData d)
        {
            if (d.Type != "blend1d" || d.Blend == null || d.Blend.Count == 0) return null;
            Inputs.TryGetValue(d.BlendInput ?? "", out var raw);
            double v = Js.ToNumber(raw ?? 0.0);
            var entries = new List<BlendEntry>(d.Blend);
            Gradient.StableSort(entries, (a, b) => { double x = a.Value - b.Value; return x < 0 ? -1 : x > 0 ? 1 : 0; });
            var lo = entries[0];
            var hi = entries[0];
            double t = 0;
            if (v >= entries[entries.Count - 1].Value) lo = hi = entries[entries.Count - 1];
            else
                for (int i = 0; i < entries.Count - 1; i++)
                    if (v >= entries[i].Value && v <= entries[i + 1].Value)
                    {
                        lo = entries[i];
                        hi = entries[i + 1];
                        double span = hi.Value - lo.Value;
                        if (span == 0 || double.IsNaN(span)) span = 1;
                        t = (v - lo.Value) / span;
                        break;
                    }
            return new Pair { Lo = Anim(lo.Animation), Hi = Anim(hi.Animation), T = t };
        }

        /// <summary>The animations a state is playing now (a blend state's current pair).</summary>
        List<AnimationData> StateAnimations(StateInstance s)
        {
            var d = s.Data;
            var out_ = new List<AnimationData>();
            if (d.Type == "animation")
            {
                var anim = Anim(d.Animation);
                if (anim != null) out_.Add(anim);
            }
            else if (d.Type == "blend1d")
            {
                var pair = BlendPair(d);
                if (pair != null)
                {
                    if (pair.Lo != null) out_.Add(pair.Lo);
                    if (pair.Hi != null) out_.Add(pair.Hi);
                }
            }
            return out_;
        }

        /// <summary>Pose a state at weight alpha. With <paramref name="into"/> (the state being faded to) and its outgoing weight,
        /// the blending values none of <paramref name="into"/> key are applied at <paramref name="outAlpha"/> instead (§5.1a).</summary>
        void ApplyState(StateInstance s, double alpha, List<AnimationData> into = null, double outAlpha = 0)
        {
            var d = s.Data;
            if (d.Type == "animation")
            {
                var anim = Anim(d.Animation);
                if (anim != null) Animations.Apply(Skeleton, anim, Animations.LocalTime(anim, s.Time, d.Loop), alpha, into == null ? null : new MixOut { Into = into, Alpha = outAlpha });
            }
            else if (d.Type == "blend1d")
            {
                var pair = BlendPair(d);
                if (pair == null) return;
                if (pair.Lo != null) Animations.Apply(Skeleton, pair.Lo, Animations.LocalTime(pair.Lo, s.Time, d.Loop), alpha, into == null ? null : new MixOut { Into = into, Alpha = outAlpha });
                if (pair.Hi != null && pair.Hi != pair.Lo && pair.T > 0)
                    Animations.Apply(Skeleton, pair.Hi, Animations.LocalTime(pair.Hi, s.Time, d.Loop), alpha * pair.T, into == null ? null : new MixOut { Into = into, Alpha = outAlpha * pair.T });
            }
        }

        void CollectEvents(StateInstance s)
        {
            var d = s.Data;
            AnimationData anim = null;
            if (d.Type == "animation") anim = Anim(d.Animation);
            else if (d.Type == "blend1d")
            {
                var pair = BlendPair(d);
                anim = pair != null ? (pair.T >= 0.5 ? pair.Hi : pair.Lo) : null;
            }
            if (anim == null) return;
            AudioDirector.PlayKeys(Audio, anim, s.PrevTime, s.Time, d.Loop, s.Uid);
            foreach (var ev in Animations.EventsBetween(Doc, anim, s.PrevTime, s.Time, d.Loop))
            {
                if (!string.IsNullOrEmpty(ev.Audio)) Audio.Play(ev.Audio, new PlayOptions { Volume = ev.Volume, Owner = s.Uid, Source = "event:" + ev.Name });
                _pendingEvents.Add(ev);
            }
        }

        /// <summary>Step the machine by dt seconds and pose the skeleton (§9.1).</summary>
        public void Advance(double dt)
        {
            if (!_started) Start();
            _elapsed += dt;
            Audio.Update(dt);
            ProcessPointer();
            foreach (var s in _scripts.ToArray()) SafeCall(s, "onUpdate", dt);
            foreach (var l in _layers) if (l.Current != null) foreach (var h in l.Current.Scripts.ToArray()) SafeCall(h, "onUpdate", dt);

            foreach (var l in _layers) Settle(l);
            _fired.Clear();

            foreach (var l in _layers)
            {
                foreach (var s in new[] { l.Current, l.From })
                {
                    if (s == null) continue;
                    s.PrevTime = s.Time > 0 ? s.Time : Math.Min(s.PrevTime, s.Time);
                    s.Time += dt * s.Data.Speed;
                }
                if (l.Current != null && dt > 0) CollectEvents(l.Current);
                if (l.From != null)
                {
                    l.MixTime += dt;
                    if (l.MixTime >= l.MixDuration) l.From = null;
                }
            }

            var sk = Skeleton;
            sk.SetToSetupPose();
            foreach (var l in _layers)
            {
                double mixA = l.MixDuration > 0 ? Math.Min(1, l.MixTime / l.MixDuration) : 1;
                if (l.From != null)
                {
                    // Fading to a state: what it doesn't key fades from the old state's value to the pose underneath.
                    if (l.Current != null) ApplyState(l.From, 1, StateAnimations(l.Current), 1 - mixA);
                    else ApplyState(l.From, l.Exited ? 1 - mixA : 1);
                }
                if (l.Current != null) ApplyState(l.Current, l.From != null ? mixA : 1);
            }
            foreach (var kv in _boneOverrides)
            {
                var b = sk.BoneById(kv.Key);
                if (b == null) continue;
                foreach (var p in kv.Value) b.Set(p.Key, p.Value);
            }
            foreach (var kv in _slotOverrides)
            {
                var s = sk.SlotById(kv.Key);
                if (s == null) continue;
                if (!string.IsNullOrEmpty(kv.Value.Color)) s.Color = MathUtil.ParseHex(kv.Value.Color);
                if (kv.Value.HasAttachment) s.AttachmentName = kv.Value.Attachment;
            }
            foreach (var id in _inputOrder) if (Inputs[id] is double n) sk.InputValues[id] = n;
            foreach (var kv in _emitterOverrides)
            {
                sk.ParticleValues.TryGetValue(kv.Key, out var cur);
                var v = cur != null ? cur.Clone() : new EmitterValues();
                v.Emitting = kv.Value;
                sk.ParticleValues[kv.Key] = v;
            }
            ApplyBindings();
            sk.Update(dt);
            sk.UpdateWorldTransform();

            var evs = _pendingEvents;
            _pendingEvents = new List<FiredEvent>();
            foreach (var e in evs)
            {
                Event?.Invoke(e);
                foreach (var h in _scripts.ToArray()) SafeCall(h, "onEvent", e);
                foreach (var l in _layers) if (l.Current != null) foreach (var h in l.Current.Scripts.ToArray()) SafeCall(h, "onEvent", e);
            }
        }

        static double LerpNum(InputBinding b, double t)
        {
            double lo = Js.ToNumber(b.OutMin), hi = Js.ToNumber(b.OutMax);
            return lo + (hi - lo) * t;
        }

        /// <summary>Drive bound properties from their inputs (after animations and script overrides).</summary>
        public void ApplyBindings()
        {
            var sk = Skeleton;
            foreach (var b in Data.Bindings)
            {
                if (!Inputs.TryGetValue(b.Input ?? "", out var raw)) continue;
                double n = Js.ToNumber(raw);
                if (double.IsNaN(n) || double.IsInfinity(n)) continue;
                double t = Template.BindingT(n, b.InMin, b.InMax);
                if (b.Target == "bone")
                {
                    sk.BoneById(b.Object)?.Set(b.Property, LerpNum(b, t));
                }
                else if (b.Target == "slot")
                {
                    var slot = sk.SlotById(b.Object);
                    if (slot == null) continue;
                    if (b.Property == "alpha") slot.Color = new[] { slot.Color[0], slot.Color[1], slot.Color[2], LerpNum(b, t) };
                    else if (b.Property == "color")
                    {
                        var lo = MathUtil.ParseHex(Js.ToStr(b.OutMin));
                        var hi = MathUtil.ParseHex(Js.ToStr(b.OutMax));
                        var c = new double[4];
                        for (int k = 0; k < 4; k++) c[k] = lo[k] + (hi[k] - lo[k]) * t;
                        slot.Color = c;
                    }
                }
                else
                {
                    if (b.Object != null && sk.ConstraintValues.TryGetValue(b.Object, out var v)) v[b.Property ?? "undefined"] = LerpNum(b, t);
                }
            }
        }

        /// <summary>Clear persistent script overrides.</summary>
        public void ClearOverrides()
        {
            _boneOverrides.Clear();
            _slotOverrides.Clear();
        }

        public void Dispose()
        {
            Audio.StopAll();
            foreach (var id in _handleOrder) _handles[id].Dispose();
            foreach (var l in _layers) if (l.Current != null) foreach (var h in l.Current.Scripts) h.Dispose();
            _handles.Clear();
            _handleOrder.Clear();
        }
    }
}
