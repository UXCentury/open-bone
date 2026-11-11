using System.Collections.Generic;

namespace OpenBone
{
    public enum CurveKind { Linear, Stepped, Bezier }

    public sealed class Curve
    {
        public static readonly Curve Linear = new Curve { Kind = CurveKind.Linear };
        public static readonly Curve Stepped = new Curve { Kind = CurveKind.Stepped };
        public CurveKind Kind;
        public double X1, Y1, X2, Y2;
    }

    /// <summary>
    /// A key. <see cref="Value"/> holds what the timeline keys: a double (numbers; IK switches converted with
    /// <c>Number()</c>), a string or null (inherit modes, colours, attachment names), a bool (emitting),
    /// a double[] (deform offsets) or a string[] (draw order).
    /// </summary>
    public sealed class Key
    {
        public double Time;
        public Curve Curve = Curve.Linear;
        public object Value;
        public double Num => Value is double d ? d : 0;
    }

    public sealed class Timeline
    {
        /// <summary>bone, slot, ik, transform, path, physics, sequence, particles, deform, drawOrder.</summary>
        public string Target;
        public string Id;
        public string Property;
        /// <summary>Attachment name (deform and sequence timelines).</summary>
        public string Attachment;
        public List<Key> Keys = new List<Key>();
    }

    public sealed class EventKey
    {
        public double Time;
        public string Event;
        public double? Int, Float;
        public string String;
    }

    public sealed class AudioKey
    {
        public double Time;
        public string Sound;
        public double? Volume, Rate;
        public bool? Loop;
    }

    public sealed class AnimationData
    {
        public string Id, Name;
        public double Duration;
        public List<Timeline> Timelines = new List<Timeline>();
        public List<EventKey> Events = new List<EventKey>();
        public List<AudioKey> Audio = new List<AudioKey>();

        /// <summary>Explicit duration if &gt; 0, else the last key time of any timeline, event or audio key.</summary>
        public double ComputedDuration()
        {
            if (Duration > 0) return Duration;
            double t = 0;
            foreach (var tl in Timelines) foreach (var k in tl.Keys) t = System.Math.Max(t, k.Time);
            foreach (var e in Events) t = System.Math.Max(t, e.Time);
            foreach (var k in Audio) t = System.Math.Max(t, k.Time);
            return t;
        }
    }

    public sealed class EventData
    {
        public string Id, Name;
        public double Int, Float;
        public string String = "";
        public string Audio;
        public double? Volume;
    }

    // ---------------- Audio ----------------

    public sealed class AudioAsset
    {
        public string Id, Name, Src;
        public double Duration;
    }

    public sealed class AudioBus
    {
        public string Id, Name;
        public double Volume = 1;
        public bool Muted;
    }

    public sealed class SoundData
    {
        public string Id, Name, Asset, Bus;
        public double Volume = 1, Rate = 1, FadeIn, FadeOut;
        public bool Loop;
    }

    public sealed class AudioData
    {
        public double Master = 1;
        public bool Muted;
        public List<AudioAsset> Assets = new List<AudioAsset>();
        public List<AudioBus> Buses = new List<AudioBus>();
        public List<SoundData> Sounds = new List<SoundData>();
    }

    // ---------------- State machines ----------------

    public sealed class InputData
    {
        public string Id, Name;
        /// <summary>bool, number, trigger or string.</summary>
        public string Type;
        /// <summary>bool, double or string (null when absent).</summary>
        public object Default;
        /// <summary>Bool inputs: the input owns a bus's mute (true mutes it); <see cref="Mutes"/> null = the master.</summary>
        public bool OwnsMute;
        /// <summary>The bus id this input mutes (null with <see cref="OwnsMute"/> = every sound).</summary>
        public string Mutes;
    }

    public sealed class Condition
    {
        public string Input;
        public string Op = "==";
        public object Value;
    }

    public sealed class BlendEntry
    {
        public string Animation;
        public double Value;
    }

    public sealed class StateSound
    {
        public string Sound, On, Action;
        public double? Volume;
    }

    public sealed class StateEmitter
    {
        public string Slot;
        public bool Emitting;
    }

    public sealed class StateInput
    {
        public string Input;
        public object Value;
    }

    public sealed class StateData
    {
        public string Id, Name;
        /// <summary>animation, blend1d or exit.</summary>
        public string Type = "animation";
        public string Animation;
        public bool Loop;
        public double Speed = 1;
        public string BlendInput;
        public List<BlendEntry> Blend;
        public List<string> Scripts;
        public List<StateSound> Sounds;
        public List<StateEmitter> Emitters;
        public List<StateInput> Inputs;
        public string OnComplete;
    }

    public sealed class TransitionData
    {
        public const string AnyState = "@any";
        public string Id, From, To;
        public List<Condition> Conditions = new List<Condition>();
        public double Duration;
        public double? ExitTime;
    }

    public sealed class LayerData
    {
        public string Id, Name, Entry;
        public List<StateData> States = new List<StateData>();
        public List<TransitionData> Transitions = new List<TransitionData>();
    }

    public sealed class ListenerAction
    {
        /// <summary>setInput, toggleInput, fireTrigger, reportEvent, runScript, playSound, stopSound, setEmitter, emitParticles, setMute.</summary>
        public string Type;
        public string Input, Event, Script, Fn, Sound, Slot;
        public object Value;
        public double? Volume, Fade;
        public bool Emitting;
        public double Count;
        /// <summary>setMute: the bus id (null = the master).</summary>
        public string Bus;
        /// <summary>setMute: true / false, or null to toggle.</summary>
        public bool? Muted;
    }

    public sealed class ListenerData
    {
        public string Id, Name, Slot;
        /// <summary>down, up, enter, exit, move, click.</summary>
        public string Event;
        public List<ListenerAction> Actions = new List<ListenerAction>();
    }

    public sealed class ScriptData
    {
        public string Id, Name, Code;
    }

    public sealed class InputBinding
    {
        public string Id, Input, Target, Object, Property;
        public double InMin, InMax;
        /// <summary>double or hex string.</summary>
        public object OutMin, OutMax;
    }

    public sealed class StateMachineData
    {
        public string Id, Name;
        public List<InputData> Inputs = new List<InputData>();
        public List<InputBinding> Bindings = new List<InputBinding>();
        public List<LayerData> Layers = new List<LayerData>();
        public List<ListenerData> Listeners = new List<ListenerData>();
        public List<string> Scripts = new List<string>();
    }
}
