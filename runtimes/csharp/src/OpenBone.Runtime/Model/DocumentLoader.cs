using System;
using System.Collections.Generic;
using System.Text;
using OpenBone.Json;

namespace OpenBone
{
    public sealed class OpenBoneFormatException : Exception
    {
        public OpenBoneFormatException(string m) : base(m) { }
    }

    /// <summary>
    /// Loads .obone (JSON) and .obonb (binary) documents (docs/runtime-spec.md §2): parse, check format and version,
    /// normalise, then build the typed model.
    /// </summary>
    public static class DocumentLoader
    {
        public const int FormatVersion = 1;

        /// <summary>Load from file bytes, whichever format they are in.</summary>
        public static Document Load(byte[] bytes)
        {
            if (BinaryDocument.IsBinary(bytes)) return FromJson(BinaryDocument.Decode(bytes));
            var text = new UTF8Encoding(false).GetString(bytes);
            if (text.Length > 0 && text[0] == (char)0xFEFF) text = text.Substring(1);
            return FromJson(text);
        }

        public static Document FromJson(string json) => FromJson(JsonReader.Parse(json));

        public static Document FromJson(JsonValue j)
        {
            if (j == null || !j.IsObject || j.Str("format") != "openbone") throw new OpenBoneFormatException("Not an OpenBone document (missing format: \"openbone\")");
            var version = j.Get("version");
            if (version != null && version.IsNumber && version.AsNumber > FormatVersion)
                throw new OpenBoneFormatException($"Document version {Js.NumberToString(version.AsNumber)} is newer than supported {FormatVersion}");
            return Build(j);
        }

        static string S(JsonValue o, string k) => o.Str(k);

        static List<string> StrList(JsonValue o, string k)
        {
            var v = o.Get(k);
            if (v == null || !v.IsArray) return null;
            var l = new List<string>(v.Count);
            foreach (var x in v.Items) l.Add(x.IsString ? x.AsString : null);
            return l;
        }

        static double[] Range(JsonValue o, string k, double[] def)
        {
            var a = o.NumArray(k);
            if (a == null) return (double[])def.Clone();
            if (a.Length < 2) Array.Resize(ref a, 2);
            return a;
        }

        static Document Build(JsonValue j)
        {
            var d = new Document
            {
                Json = j,
                Name = j.Str("name", ""),
                Width = j.Num("width"),
                Height = j.Num("height"),
                OriginX = j.Num("originX"),
                OriginY = j.Num("originY"),
                Background = j.Str("background"),
                Fps = j.Num("fps", 30),
            };
            foreach (var x in j.Arr("images"))
                d.Images.Add(new ImageAsset { Id = S(x, "id"), Name = S(x, "name"), Src = S(x, "src"), Width = x.Num("width"), Height = x.Num("height") });
            var atlas = j.Get("atlas");
            if (atlas != null && atlas.IsObject) d.Atlas = BuildAtlas(atlas);
            var sk = j.Get("skeleton") ?? JsonValue.NewObject();
            BuildSkeleton(sk, d.Skeleton);
            foreach (var e in j.Arr("events"))
                d.Events.Add(new EventData
                {
                    Id = S(e, "id"),
                    Name = S(e, "name"),
                    Int = e.Num("int"),
                    Float = e.Num("float"),
                    String = e.Str("string", ""),
                    Audio = e.Str("audio"),
                    Volume = e.NumOpt("volume"),
                });
            foreach (var a in j.Arr("animations")) d.Animations.Add(BuildAnimation(a));
            foreach (var s in j.Arr("stateMachines")) d.StateMachines.Add(BuildStateMachine(s));
            foreach (var s in j.Arr("scripts")) d.Scripts.Add(new ScriptData { Id = S(s, "id"), Name = S(s, "name"), Code = s.Str("code", "") });
            var audio = j.Get("audio");
            if (audio != null && audio.IsObject) d.Audio = BuildAudio(audio);
            return d;
        }

        static AtlasData BuildAtlas(JsonValue a)
        {
            var r = new AtlasData
            {
                Padding = a.Num("padding"),
                Scale = a.NumOpt("scale"),
                PremultipliedAlpha = a.Bool("premultipliedAlpha"),
                StripWhitespace = a.Bool("stripWhitespace"),
                Polygons = a.Bool("polygons"),
            };
            foreach (var p in a.Arr("pages"))
                r.Pages.Add(new AtlasPage { Id = S(p, "id"), Name = S(p, "name"), Src = S(p, "src"), Width = p.Num("width"), Height = p.Num("height") });
            foreach (var g in a.Arr("regions"))
                r.Regions.Add(new AtlasRegion
                {
                    Image = S(g, "image"),
                    Page = S(g, "page"),
                    X = g.Num("x"),
                    Y = g.Num("y"),
                    Width = g.Num("width"),
                    Height = g.Num("height"),
                    OffsetX = g.Num("offsetX"),
                    OffsetY = g.Num("offsetY"),
                    OriginalWidth = g.Num("originalWidth"),
                    OriginalHeight = g.Num("originalHeight"),
                    Rotated = g.Bool("rotated"),
                    Polygon = g.NumArray("polygon"),
                });
            var w = a.Get("white");
            if (w != null && w.IsObject) r.White = new AtlasWhite { Page = S(w, "page"), X = w.Num("x"), Y = w.Num("y"), Width = w.Num("width"), Height = w.Num("height") };
            return r;
        }

        static void BuildSkeleton(JsonValue sk, SkeletonData s)
        {
            foreach (var b in sk.Arr("bones"))
                s.Bones.Add(new BoneData
                {
                    Id = S(b, "id"),
                    Name = S(b, "name"),
                    Parent = S(b, "parent"),
                    Length = b.Num("length"),
                    X = b.Num("x"),
                    Y = b.Num("y"),
                    Rotation = b.Num("rotation"),
                    ScaleX = b.Num("scaleX", 1),
                    ScaleY = b.Num("scaleY", 1),
                    ShearX = b.Num("shearX"),
                    ShearY = b.Num("shearY"),
                    Inherit = b.Str("inherit", "normal"),
                    Color = S(b, "color"),
                });
            foreach (var x in sk.Arr("slots"))
                s.Slots.Add(new SlotData
                {
                    Id = S(x, "id"),
                    Name = S(x, "name"),
                    Bone = S(x, "bone"),
                    Color = x.Str("color", "#ffffff"),
                    Attachment = S(x, "attachment"),
                    Blend = x.Str("blend", "normal"),
                    Dark = S(x, "dark"),
                    Folder = S(x, "folder"),
                });
            foreach (var k in sk.Arr("skins"))
            {
                var skin = new SkinData { Id = S(k, "id"), Name = S(k, "name"), Bones = StrList(k, "bones"), Constraints = StrList(k, "constraints") };
                var atts = k.Get("attachments");
                if (atts != null && atts.IsObject)
                    foreach (var slotId in atts.Keys)
                    {
                        var map = new OrderedMap<Attachment>();
                        var byName = atts.Get(slotId);
                        if (byName != null && byName.IsObject)
                            foreach (var name in byName.Keys)
                            {
                                var a = byName.Get(name);
                                if (a != null && a.IsObject) map.Set(name, BuildAttachment(a));
                            }
                        skin.Attachments[slotId] = map;
                    }
                s.Skins.Add(skin);
            }
            foreach (var c in sk.Arr("ik"))
                s.Ik.Add(Base(new IkConstraintData
                {
                    Bones = StrList(c, "bones") ?? new List<string>(),
                    Target = S(c, "target"),
                    Mix = c.Num("mix"),
                    BendPositive = c.Bool("bendPositive"),
                    Softness = c.Num("softness"),
                    Stretch = c.Bool("stretch"),
                    Compress = c.Bool("compress"),
                    Uniform = c.Bool("uniform"),
                }, c));
            foreach (var c in sk.Arr("transform"))
                s.Transform.Add(Base(new TransformConstraintData
                {
                    Bones = StrList(c, "bones") ?? new List<string>(),
                    Target = S(c, "target"),
                    MixRotate = c.Num("mixRotate"),
                    MixTranslate = c.Num("mixTranslate"),
                    MixScale = c.Num("mixScale"),
                    MixShear = c.Num("mixShear"),
                    OffsetRotation = c.Num("offsetRotation"),
                    OffsetX = c.Num("offsetX"),
                    OffsetY = c.Num("offsetY"),
                    OffsetScaleX = c.Num("offsetScaleX"),
                    OffsetScaleY = c.Num("offsetScaleY"),
                    OffsetShear = c.Num("offsetShear"),
                    Local = c.Bool("local"),
                    Relative = c.Bool("relative"),
                }, c));
            foreach (var c in sk.Arr("path"))
                s.Path.Add(Base(new PathConstraintData
                {
                    Bones = StrList(c, "bones") ?? new List<string>(),
                    Target = S(c, "target"),
                    PositionMode = c.Str("positionMode", "fixed"),
                    SpacingMode = c.Str("spacingMode", "length"),
                    RotateMode = c.Str("rotateMode", "tangent"),
                    ConstantSpeed = ConstantSpeed(c),
                    OffsetRotation = c.Num("offsetRotation"),
                    Position = c.Num("position"),
                    Spacing = c.Num("spacing"),
                    MixRotate = c.Num("mixRotate"),
                    MixX = c.Num("mixX"),
                    MixY = c.Num("mixY"),
                }, c));
            foreach (var c in sk.Arr("physics"))
                s.Physics.Add(Base(new PhysicsConstraintData
                {
                    Bone = S(c, "bone"),
                    X = c.Num("x"),
                    Y = c.Num("y"),
                    Rotate = c.Num("rotate"),
                    ScaleX = c.Num("scaleX"),
                    Inertia = c.Num("inertia"),
                    Strength = c.Num("strength"),
                    Damping = c.Num("damping"),
                    Mass = c.Num("mass"),
                    Gravity = c.Num("gravity"),
                    Wind = c.Num("wind"),
                    Mix = c.Num("mix"),
                    Fps = c.Num("fps"),
                }, c));
            foreach (var x in sk.Arr("sliders"))
                s.Sliders.Add(new SliderData
                {
                    Id = S(x, "id"),
                    Name = S(x, "name"),
                    Animation = S(x, "animation"),
                    Bone = S(x, "bone"),
                    Property = S(x, "property"),
                    Input = S(x, "input"),
                    From = x.Num("from"),
                    To = x.Num("to"),
                    TimeFrom = x.NumOpt("timeFrom"),
                    TimeTo = x.NumOpt("timeTo"),
                    Mix = x.Num("mix"),
                    Loop = x.Bool("loop"),
                    Additive = x.Bool("additive"),
                });
            s.ReferenceScale = sk.NumOpt("referenceScale");
        }

        static T Base<T>(T c, JsonValue j) where T : ConstraintData
        {
            c.Id = S(j, "id");
            c.Name = S(j, "name");
            c.Order = j.NumOpt("order");
            c.Json = j;
            return c;
        }

        /// <summary>Path constraint `constantSpeed`: only an explicit `false` turns it off (unset = true).</summary>
        static bool ConstantSpeed(JsonValue c)
        {
            var v = c.Get("constantSpeed");
            return !(v != null && v.Kind == JsonKind.Bool && !v.Truthy);
        }

        static VertexWeight[][] Weights(JsonValue a)
        {
            var w = a.Get("weights");
            if (w == null || !w.IsArray) return null;
            var r = new VertexWeight[w.Count][];
            for (int i = 0; i < r.Length; i++)
            {
                var list = w[i];
                r[i] = new VertexWeight[list.Count];
                for (int k = 0; k < list.Count; k++)
                {
                    var inf = list[k];
                    r[i][k] = new VertexWeight { Bone = S(inf, "bone"), X = inf.Num("x"), Y = inf.Num("y"), Weight = inf.Num("weight") };
                }
            }
            return r;
        }

        static double[] Nums(JsonValue a, string k) => a.NumArray(k) ?? new double[0];

        static Attachment BuildAttachment(JsonValue a)
        {
            string type = a.Str("type", "");
            Attachment r;
            switch (type)
            {
                case "region":
                    r = new RegionAttachment
                    {
                        Image = S(a, "image"),
                        X = a.Num("x"),
                        Y = a.Num("y"),
                        Rotation = a.Num("rotation"),
                        ScaleX = a.Num("scaleX", 1),
                        ScaleY = a.Num("scaleY", 1),
                        SkewX = a.Num("skewX"),
                        SkewY = a.Num("skewY"),
                        Width = a.Num("width"),
                        Height = a.Num("height"),
                        Color = a.Str("color", "#ffffff"),
                    };
                    break;
                case "mesh":
                    {
                        var tri = a.NumArray("triangles") ?? new double[0];
                        var ti = new int[tri.Length];
                        for (int i = 0; i < tri.Length; i++) ti[i] = (int)tri[i];
                        var m = new MeshAttachment
                        {
                            Image = S(a, "image"),
                            Uvs = Nums(a, "uvs"),
                            Triangles = ti,
                            Vertices = Nums(a, "vertices"),
                            Weights = Weights(a),
                            Hull = (int)a.Num("hull"),
                            Color = a.Str("color", "#ffffff"),
                        };
                        var l = a.Get("linked");
                        if (l != null && l.IsObject) m.Linked = new LinkedMesh { Mesh = S(l, "mesh"), Slot = S(l, "slot"), Skin = S(l, "skin"), Deform = l.Bool("deform") };
                        r = m;
                        break;
                    }
                case "shape":
                    r = new ShapeAttachment
                    {
                        Shape = a.Str("shape", "rect"),
                        X = a.Num("x"),
                        Y = a.Num("y"),
                        Rotation = a.Num("rotation"),
                        Width = a.Num("width"),
                        Height = a.Num("height"),
                        Radius = a.Num("radius"),
                        Points = a.NumArray("points"),
                        Fill = a.Str("fill", "#ffffff"),
                        Stroke = a.Str("stroke"),
                        StrokeWidth = a.NumOpt("strokeWidth"),
                    };
                    break;
                case "boundingBox":
                    r = new BoundingBoxAttachment { Vertices = Nums(a, "vertices"), Weights = Weights(a) };
                    break;
                case "point":
                    r = new PointAttachment { X = a.Num("x"), Y = a.Num("y"), Rotation = a.Num("rotation") };
                    break;
                case "clipping":
                    r = new ClippingAttachment { Vertices = Nums(a, "vertices"), End = S(a, "end") };
                    break;
                case "path":
                    r = new PathAttachment { Vertices = Nums(a, "vertices"), Weights = Weights(a), Closed = a.Bool("closed"), Color = S(a, "color") };
                    break;
                case "sequence":
                    {
                        var q = new SequenceAttachment
                        {
                            X = a.Num("x"),
                            Y = a.Num("y"),
                            Rotation = a.Num("rotation"),
                            ScaleX = a.Num("scaleX", 1),
                            ScaleY = a.Num("scaleY", 1),
                            SkewX = a.Num("skewX"),
                            SkewY = a.Num("skewY"),
                            Width = a.Num("width"),
                            Height = a.Num("height"),
                            Color = a.Str("color", "#ffffff"),
                            Fps = a.Num("fps"),
                            Mode = a.Str("mode", "loop"),
                            Offset = a.Num("offset"),
                            Input = S(a, "input"),
                        };
                        foreach (var f in a.Arr("frames"))
                        {
                            var fr = new SequenceFrame { Image = S(f, "image") };
                            var rc = f.Get("rect");
                            if (rc != null && rc.IsObject) fr.Rect = new FrameRect { X = rc.Num("x"), Y = rc.Num("y"), Width = rc.Num("width"), Height = rc.Num("height") };
                            var tr = f.Get("trim");
                            if (tr != null && tr.IsObject) fr.Trim = new FrameTrim { X = tr.Num("x"), Y = tr.Num("y"), SourceWidth = tr.Num("sourceWidth"), SourceHeight = tr.Num("sourceHeight") };
                            q.Frames.Add(fr);
                        }
                        r = q;
                        break;
                    }
                case "particles":
                    r = BuildParticles(a);
                    break;
                case "text":
                    r = new TextAttachment
                    {
                        Text = a.Str("text", ""),
                        X = a.Num("x"),
                        Y = a.Num("y"),
                        Rotation = a.Num("rotation"),
                        Width = a.Num("width"),
                        Height = a.Num("height"),
                        Font = a.Str("font", "sans-serif"),
                        Size = a.Num("size", 16),
                        Weight = a.Num("weight", 400),
                        Color = a.Str("color", "#ffffff"),
                        Align = a.Str("align", "center"),
                        Outline = S(a, "outline"),
                        OutlineWidth = a.NumOpt("outlineWidth"),
                    };
                    break;
                default:
                    r = new UnknownAttachment { TypeName = type };
                    break;
            }
            r.Name = a.Str("name", "");
            r.Json = a;
            return r;
        }

        /// <summary>Particles: every missing field comes from the defaults (core/particles.ts:defaultParticleSettings).</summary>
        static ParticlesAttachment BuildParticles(JsonValue a)
        {
            var p = new ParticlesAttachment
            {
                Emitting = a.Bool("emitting", true),
                Rate = a.Num("rate", 20),
                MaxParticles = a.Num("maxParticles", 200),
                Duration = a.Num("duration", 1),
                Loop = a.Bool("loop", true),
                Prewarm = a.Bool("prewarm", false),
                Shape = a.Str("shape", "point"),
                X = a.Num("x"),
                Y = a.Num("y"),
                Rotation = a.Num("rotation", 90),
                Angle = a.Num("angle", 30),
                Radius = a.Num("radius", 10),
                Width = a.Num("width", 40),
                Height = a.Num("height", 40),
                Space = a.Str("space", "world"),
                Lifetime = Range(a, "lifetime", new[] { 0.8, 1.2 }),
                Speed = Range(a, "speed", new[] { 80.0, 120 }),
                Gravity = a.Num("gravity"),
                Drag = a.Num("drag"),
                StartSize = Range(a, "startSize", new[] { 10.0, 14 }),
                EndSize = Range(a, "endSize", new[] { 2.0, 4 }),
                StartRotation = Range(a, "startRotation", new[] { 0.0, 0 }),
                EndRotation = Range(a, "endRotation", new[] { 0.0, 0 }),
                AngularVelocity = Range(a, "angularVelocity", new[] { 0.0, 0 }),
                Blend = a.Str("blend", "normal"),
                Look = a.Str("look", "circle"),
                Image = S(a, "image"),
                Stretch = a.Num("stretch", 0.05),
                Seed = a.Num("seed", 1),
            };
            if (a.Has("bursts"))
                foreach (var b in a.Arr("bursts")) p.Bursts.Add(new ParticleBurst { Time = b.Num("time"), Count = b.Num("count") });
            if (a.Has("colors"))
                foreach (var c in a.Arr("colors")) p.Colors.Add(new ColorStop { T = c.Num("t"), Color = c.Str("color", "#ffffff") });
            else
            {
                p.Colors.Add(new ColorStop { T = 0, Color = "#ffffffff" });
                p.Colors.Add(new ColorStop { T = 1, Color = "#ffffff00" });
            }
            return p;
        }

        static Curve BuildCurve(JsonValue c)
        {
            if (c == null) return Curve.Linear;
            if (c.IsString) return c.AsString == "stepped" ? Curve.Stepped : Curve.Linear;
            if (c.IsArray && c.Count >= 4)
                return new Curve { Kind = CurveKind.Bezier, X1 = c[0].AsNumber, Y1 = c[1].AsNumber, X2 = c[2].AsNumber, Y2 = c[3].AsNumber };
            return Curve.Linear;
        }

        static object KeyValue(string target, string property, JsonValue v)
        {
            if (v == null) return null;
            switch (target)
            {
                case "bone":
                    if (property == "inherit") return v.IsString ? v.AsString : null;
                    return Js.ToNumber(Js.FromJson(v));
                case "slot":
                    return v.IsString ? v.AsString : null;
                case "ik":
                case "transform":
                case "path":
                case "physics":
                case "sequence":
                    return Js.ToNumber(Js.FromJson(v));
                case "particles":
                    if (property == "emitting") return v.Truthy;
                    return Js.ToNumber(Js.FromJson(v));
                case "deform":
                    {
                        var a = new double[v.Count];
                        for (int i = 0; i < a.Length; i++) a[i] = v[i].IsNumber ? v[i].AsNumber : 0;
                        return a;
                    }
                case "drawOrder":
                    {
                        var a = new string[v.Count];
                        for (int i = 0; i < a.Length; i++) a[i] = v[i].IsString ? v[i].AsString : null;
                        return a;
                    }
                default:
                    return Js.FromJson(v);
            }
        }

        static AnimationData BuildAnimation(JsonValue a)
        {
            var r = new AnimationData { Id = S(a, "id"), Name = S(a, "name"), Duration = a.Num("duration") };
            foreach (var t in a.Arr("timelines"))
            {
                var tl = new Timeline { Target = S(t, "target"), Id = S(t, "id"), Property = S(t, "property"), Attachment = S(t, "attachment") };
                foreach (var k in t.Arr("keys"))
                    tl.Keys.Add(new Key { Time = k.Num("time"), Curve = BuildCurve(k.Get("curve")), Value = KeyValue(tl.Target, tl.Property, k.Get("value")) });
                r.Timelines.Add(tl);
            }
            foreach (var e in a.Arr("events"))
                r.Events.Add(new EventKey { Time = e.Num("time"), Event = S(e, "event"), Int = e.NumOpt("int"), Float = e.NumOpt("float"), String = e.Str("string") });
            foreach (var k in a.Arr("audio"))
                r.Audio.Add(new AudioKey { Time = k.Num("time"), Sound = S(k, "sound"), Volume = k.NumOpt("volume"), Rate = k.NumOpt("rate"), Loop = k.Has("loop") && !k.Get("loop").IsNull ? k.Get("loop").Truthy : (bool?)null });
            return r;
        }

        static AudioData BuildAudio(JsonValue a)
        {
            var r = new AudioData { Master = a.Num("master", 1), Muted = a.Bool("muted") };
            foreach (var x in a.Arr("assets")) r.Assets.Add(new AudioAsset { Id = S(x, "id"), Name = S(x, "name"), Src = S(x, "src"), Duration = x.Num("duration") });
            foreach (var x in a.Arr("buses")) r.Buses.Add(new AudioBus { Id = S(x, "id"), Name = S(x, "name"), Volume = x.Num("volume", 1), Muted = x.Bool("muted") });
            foreach (var x in a.Arr("sounds"))
                r.Sounds.Add(new SoundData
                {
                    Id = S(x, "id"),
                    Name = S(x, "name"),
                    Asset = S(x, "asset"),
                    Bus = S(x, "bus"),
                    Volume = x.Num("volume", 1),
                    Rate = x.Num("rate", 1),
                    Loop = x.Bool("loop"),
                    FadeIn = x.Num("fadeIn"),
                    FadeOut = x.Num("fadeOut"),
                });
            return r;
        }

        static StateMachineData BuildStateMachine(JsonValue s)
        {
            var r = new StateMachineData { Id = S(s, "id"), Name = S(s, "name"), Scripts = StrList(s, "scripts") ?? new List<string>() };
            foreach (var i in s.Arr("inputs"))
                r.Inputs.Add(new InputData { Id = S(i, "id"), Name = S(i, "name"), Type = S(i, "type"), Default = Js.FromJson(i.Get("default")) });
            foreach (var b in s.Arr("bindings"))
                r.Bindings.Add(new InputBinding
                {
                    Id = S(b, "id"),
                    Input = S(b, "input"),
                    Target = S(b, "target"),
                    Object = S(b, "object"),
                    Property = S(b, "property"),
                    InMin = b.Num("inMin"),
                    InMax = b.Num("inMax"),
                    OutMin = Js.FromJson(b.Get("outMin")),
                    OutMax = Js.FromJson(b.Get("outMax")),
                });
            foreach (var l in s.Arr("layers"))
            {
                var layer = new LayerData { Id = S(l, "id"), Name = S(l, "name"), Entry = S(l, "entry") };
                foreach (var st in l.Arr("states"))
                {
                    var state = new StateData
                    {
                        Id = S(st, "id"),
                        Name = S(st, "name"),
                        Type = st.Str("type", "animation"),
                        Animation = S(st, "animation"),
                        Loop = st.Bool("loop"),
                        Speed = st.Num("speed", 1),
                        BlendInput = S(st, "blendInput"),
                        Scripts = StrList(st, "scripts"),
                        OnComplete = S(st, "onComplete"),
                    };
                    if (st.Has("blend"))
                    {
                        state.Blend = new List<BlendEntry>();
                        foreach (var e in st.Arr("blend")) state.Blend.Add(new BlendEntry { Animation = S(e, "animation"), Value = e.Num("value") });
                    }
                    if (st.Has("sounds"))
                    {
                        state.Sounds = new List<StateSound>();
                        foreach (var x in st.Arr("sounds")) state.Sounds.Add(new StateSound { Sound = S(x, "sound"), On = S(x, "on"), Action = S(x, "action"), Volume = x.NumOpt("volume") });
                    }
                    if (st.Has("emitters"))
                    {
                        state.Emitters = new List<StateEmitter>();
                        foreach (var x in st.Arr("emitters")) state.Emitters.Add(new StateEmitter { Slot = S(x, "slot"), Emitting = x.Bool("emitting") });
                    }
                    if (st.Has("inputs"))
                    {
                        state.Inputs = new List<StateInput>();
                        foreach (var x in st.Arr("inputs")) state.Inputs.Add(new StateInput { Input = S(x, "input"), Value = Js.FromJson(x.Get("value")) });
                    }
                    layer.States.Add(state);
                }
                foreach (var t in l.Arr("transitions"))
                {
                    var tr = new TransitionData { Id = S(t, "id"), From = S(t, "from"), To = S(t, "to"), Duration = t.Num("duration"), ExitTime = t.NumOpt("exitTime") };
                    foreach (var c in t.Arr("conditions")) tr.Conditions.Add(new Condition { Input = S(c, "input"), Op = c.Str("op", "=="), Value = Js.FromJson(c.Get("value")) });
                    layer.Transitions.Add(tr);
                }
                r.Layers.Add(layer);
            }
            foreach (var li in s.Arr("listeners"))
            {
                var l = new ListenerData { Id = S(li, "id"), Name = S(li, "name"), Slot = S(li, "slot"), Event = S(li, "event") };
                foreach (var a in li.Arr("actions"))
                {
                    var bus = a.Get("bus");
                    var muted = a.Get("muted");
                    l.Actions.Add(new ListenerAction
                    {
                        Type = S(a, "type"),
                        Input = S(a, "input"),
                        Event = S(a, "event"),
                        Script = S(a, "script"),
                        Fn = S(a, "fn"),
                        Sound = S(a, "sound"),
                        Slot = S(a, "slot"),
                        Value = Js.FromJson(a.Get("value")),
                        Volume = a.NumOpt("volume"),
                        Fade = a.NumOpt("fade"),
                        Emitting = a.Bool("emitting"),
                        Count = a.Num("count"),
                        Bus = bus != null && bus.IsString ? bus.AsString : null,
                        Muted = muted != null && muted.IsBool ? muted.AsBool : (bool?)null, // otherwise "toggle"
                    });
                }
                r.Listeners.Add(l);
            }
            return r;
        }
    }
}
