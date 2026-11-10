using System.Collections.Generic;
using OpenBone.Json;

namespace OpenBone
{
    /// <summary>An OpenBone document (.obone / .obonb), as described in docs/format.md.</summary>
    public sealed class Document
    {
        public string Name;
        public double Width, Height, OriginX, OriginY;
        public string Background;
        public double Fps;
        public List<ImageAsset> Images = new List<ImageAsset>();
        public AtlasData Atlas;
        public SkeletonData Skeleton = new SkeletonData();
        public List<EventData> Events = new List<EventData>();
        public List<AnimationData> Animations = new List<AnimationData>();
        public List<StateMachineData> StateMachines = new List<StateMachineData>();
        public List<ScriptData> Scripts = new List<ScriptData>();
        public AudioData Audio;
        /// <summary>The JSON the document was read from (normalised).</summary>
        public JsonValue Json;

        public SkinData DefaultSkin => Skeleton.Skins.Count > 0 ? Skeleton.Skins[0] : null;

        public AnimationData FindAnimation(string idOrName)
        {
            foreach (var a in Animations) if (a.Id == idOrName) return a;
            foreach (var a in Animations) if (a.Name == idOrName) return a;
            return null;
        }

        public AnimationData AnimationById(string id)
        {
            if (id == null) return null;
            foreach (var a in Animations) if (a.Id == id) return a;
            return null;
        }

        public EventData EventById(string id)
        {
            foreach (var e in Events) if (e.Id == id) return e;
            return null;
        }

        public ScriptData ScriptById(string id)
        {
            foreach (var s in Scripts) if (s.Id == id) return s;
            return null;
        }

        public StateMachineData FindStateMachine(string idOrName)
        {
            foreach (var s in StateMachines) if (s.Name == idOrName || s.Id == idOrName) return s;
            return null;
        }
    }

    /// <summary>Anything a draw item can sample: an image asset or an atlas page.</summary>
    public interface ITexture
    {
        string Id { get; }
        string Name { get; }
        string Src { get; }
        double Width { get; }
        double Height { get; }
    }

    public sealed class ImageAsset : ITexture
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Src { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
    }

    public sealed class AtlasPage : ITexture
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Src { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
    }

    /// <summary>A texture known only by id and size (the built-in particle dot).</summary>
    public sealed class TextureRef : ITexture
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Src { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
    }

    public sealed class AtlasRegion
    {
        public string Image, Page;
        public double X, Y, Width, Height, OffsetX, OffsetY, OriginalWidth, OriginalHeight;
        public bool Rotated;
        public double[] Polygon;
    }

    public sealed class AtlasWhite
    {
        public string Page;
        public double X, Y, Width, Height;
    }

    public sealed class AtlasData
    {
        public List<AtlasPage> Pages = new List<AtlasPage>();
        public List<AtlasRegion> Regions = new List<AtlasRegion>();
        public AtlasWhite White;
        public double Padding;
        public double? Scale;
        public bool PremultipliedAlpha, StripWhitespace, Polygons;
    }

    public sealed class BoneData
    {
        public string Id, Name, Parent;
        public double Length, X, Y, Rotation, ScaleX = 1, ScaleY = 1, ShearX, ShearY;
        public string Inherit = "normal";
        public string Color;
    }

    public sealed class SlotData
    {
        public string Id, Name, Bone;
        public string Color = "#ffffff";
        public string Attachment;
        public string Blend = "normal";
        public string Dark;
        public string Folder;
    }

    public sealed class SkinData
    {
        public string Id, Name;
        /// <summary>slot id → attachment name → attachment, in document (JavaScript object key) order.</summary>
        public Dictionary<string, OrderedMap<Attachment>> Attachments = new Dictionary<string, OrderedMap<Attachment>>();
        public List<string> Bones;
        public List<string> Constraints;

        public Attachment Get(string slotId, string name)
        {
            if (name == null) return null;
            return Attachments.TryGetValue(slotId, out var m) ? m.Get(name) : null;
        }
    }

    public abstract class ConstraintData
    {
        public string Id, Name;
        /// <summary>Position in the constraint update order; null = the default order.</summary>
        public double? Order;
        /// <summary>"ik", "transform", "path" or "physics".</summary>
        public abstract string Kind { get; }
        /// <summary>The constraint's JSON (keyable setup values are read from it).</summary>
        public JsonValue Json;
    }

    public sealed class IkConstraintData : ConstraintData
    {
        public override string Kind => "ik";
        public List<string> Bones = new List<string>();
        public string Target;
        public double Mix = 1;
        public bool BendPositive = true;
        public double Softness;
        public bool Stretch, Compress, Uniform;
    }

    public sealed class TransformConstraintData : ConstraintData
    {
        public override string Kind => "transform";
        public List<string> Bones = new List<string>();
        public string Target;
        public double MixRotate, MixTranslate, MixScale, MixShear;
        public double OffsetRotation, OffsetX, OffsetY, OffsetScaleX, OffsetScaleY, OffsetShear;
        public bool Local, Relative;
    }

    public sealed class PathConstraintData : ConstraintData
    {
        public override string Kind => "path";
        public List<string> Bones = new List<string>();
        public string Target;
        public string PositionMode = "fixed", SpacingMode = "length", RotateMode = "tangent";
        /// <summary>
        /// True (default, unset in the file): distances inside each bezier segment are measured by arc length, so bones
        /// stay evenly spaced however the handles are placed. False: the segment is still found by arc length, but the
        /// point inside it is at the raw bezier parameter (Spine's "constant speed" off), so bones bunch up where the
        /// handles are short.
        /// </summary>
        public bool ConstantSpeed = true;
        public double OffsetRotation, Position, Spacing, MixRotate, MixX, MixY;
    }

    public sealed class PhysicsConstraintData : ConstraintData
    {
        public override string Kind => "physics";
        public string Bone;
        public double X, Y, Rotate, ScaleX, Inertia, Strength, Damping, Mass, Gravity, Wind, Mix, Fps;
    }

    public sealed class SliderData
    {
        public string Id, Name, Animation, Bone, Property, Input;
        public double From, To, Mix;
        public double? TimeFrom, TimeTo;
        public bool Loop, Additive;
    }

    public sealed class SkeletonData
    {
        public List<BoneData> Bones = new List<BoneData>();
        public List<SlotData> Slots = new List<SlotData>();
        public List<SkinData> Skins = new List<SkinData>();
        public List<IkConstraintData> Ik = new List<IkConstraintData>();
        public List<TransformConstraintData> Transform = new List<TransformConstraintData>();
        public List<PathConstraintData> Path = new List<PathConstraintData>();
        public List<PhysicsConstraintData> Physics = new List<PhysicsConstraintData>();
        public List<SliderData> Sliders = new List<SliderData>();
        public double? ReferenceScale;
    }

    /// <summary>Insertion-ordered map with JavaScript object key order available (integer-like keys first).</summary>
    public sealed class OrderedMap<T> where T : class
    {
        readonly List<string> _keys = new List<string>();
        readonly Dictionary<string, T> _map = new Dictionary<string, T>();
        public IReadOnlyList<string> Keys => _keys;
        public int Count => _keys.Count;
        public T Get(string key) => key != null && _map.TryGetValue(key, out var v) ? v : null;
        public void Set(string key, T value)
        {
            if (!_map.ContainsKey(key)) _keys.Add(key);
            _map[key] = value;
        }

        /// <summary>Keys in the order JavaScript enumerates an object's own properties.</summary>
        public List<string> JsKeyOrder()
        {
            var ints = new List<(uint, string)>();
            var rest = new List<string>();
            foreach (var k in _keys)
            {
                if (IsArrayIndex(k, out var n)) ints.Add((n, k)); else rest.Add(k);
            }
            ints.Sort((a, b) => a.Item1.CompareTo(b.Item1));
            var out_ = new List<string>(_keys.Count);
            foreach (var x in ints) out_.Add(x.Item2);
            out_.AddRange(rest);
            return out_;
        }

        internal static bool IsArrayIndex(string k, out uint n)
        {
            n = 0;
            if (k.Length == 0 || k.Length > 10) return false;
            if (k.Length > 1 && k[0] == '0') return false;
            ulong acc = 0;
            foreach (char c in k)
            {
                if (c < '0' || c > '9') return false;
                acc = acc * 10 + (ulong)(c - '0');
            }
            if (acc >= 4294967295UL) return false;
            n = (uint)acc;
            return true;
        }
    }
}
