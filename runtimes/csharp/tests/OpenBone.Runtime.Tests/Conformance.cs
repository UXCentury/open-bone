using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenBone.Scripting;

namespace OpenBone.Tests
{
    /// <summary>
    /// Runs conformance/expected/*.json against this runtime, as conformance/README.md describes, and lists every
    /// difference beyond the tolerances (docs/runtime-spec.md §1).
    /// </summary>
    public static class Conformance
    {
        public const double Dt = 1.0 / 60;
        public const int SampleEvery = 10;
        const double Round = 5e-5 + 1e-9; // the reference rounds to 4 decimals

        public static string RepoRoot
        {
            get
            {
                var dir = new DirectoryInfo(AppContext.BaseDirectory);
                while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "conformance", "expected"))) dir = dir.Parent;
                return dir?.FullName ?? throw new DirectoryNotFoundException("conformance/expected not found above the test binaries");
            }
        }

        public static IEnumerable<string> ExpectedFiles() =>
            Directory.GetFiles(Path.Combine(RepoRoot, "conformance", "expected"), "*.json").Select(Path.GetFileName).OrderBy(x => x, StringComparer.Ordinal);

        /// <summary>Script host used by the suite. Generous budgets: a cold Jint engine can take more than 16 ms on its first call.</summary>
        public static IScriptHost Host() => new JintScriptHost { CallTimeout = TimeSpan.FromSeconds(2), LoadTimeout = TimeSpan.FromSeconds(5) };

        sealed class Recorder
        {
            public List<FiredEvent> Events = new List<FiredEvent>();
            public List<Dictionary<string, object>> Audio = new List<Dictionary<string, object>>();
            readonly Dictionary<string, string> _ids = new Dictionary<string, string>();

            public Recorder(OpenBoneInstance inst)
            {
                inst.Event += e => Events.Add(e);
                inst.AudioCommand += c =>
                {
                    if (!_ids.TryGetValue(c.Id, out var id)) _ids[c.Id] = id = "p" + (_ids.Count + 1);
                    var d = new Dictionary<string, object> { ["type"] = c.Type, ["id"] = id };
                    switch (c.Type)
                    {
                        case "play":
                            d["sound"] = c.Sound; d["asset"] = c.Asset; d["bus"] = c.Bus; d["volume"] = c.Volume; d["rate"] = c.Rate;
                            d["loop"] = c.Loop; d["fadeIn"] = c.FadeIn; d["source"] = c.Source;
                            break;
                        case "stop": d["fade"] = c.Fade; break;
                        case "fade": d["volume"] = c.Volume; d["duration"] = c.Duration; break;
                    }
                    Audio.Add(d);
                };
            }
        }

        sealed class Sample
        {
            public double T;
            public OpenBoneInstance Inst;
            public List<DrawItem> Draw;
            public List<FiredEvent> Events;
            public List<Dictionary<string, object>> Audio;
            public Dictionary<string, string> States;
            public List<double[]> Bones;
            public List<(string name, double[] color, double[] dark)> Slots;
            public SkeletonBounds Bounds;
        }

        /// <summary>A file's top-level `queries` (conformance/README.md "Bounding-box queries"), with the `others` placements posed.</summary>
        sealed class Queries
        {
            public List<double[]> Points, Segments, Aabbs;
            public List<SkeletonBounds> Others;
        }

        static List<double[]> QueryList(JsonElement q, string key) =>
            q.GetProperty(key).EnumerateArray().Select(a => a.EnumerateArray().Select(x => x.GetDouble()).ToArray()).ToList();

        static Queries LoadQueries(JsonElement root, Document doc, IScriptHost host)
        {
            if (!root.TryGetProperty("queries", out var q)) return null;
            var others = new List<SkeletonBounds>();
            foreach (var p in QueryList(q, "others"))
            {
                var o = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = host });
                o.Skeleton.X = p[0];
                o.Skeleton.Y = p[1];
                o.Advance(0);
                others.Add(o.Skeleton.BoundingBoxes());
                o.Dispose();
            }
            return new Queries { Points = QueryList(q, "points"), Segments = QueryList(q, "segments"), Aabbs = QueryList(q, "aabbs"), Others = others };
        }

        static Sample Take(OpenBoneInstance inst, Recorder rec, double t, Queries queries)
        {
            var s = new Sample
            {
                T = t,
                Inst = inst,
                Bones = inst.Skeleton.Bones.Select(b => new[] { b.World.A, b.World.B, b.World.C, b.World.D, b.World.X, b.World.Y }).ToList(),
                Slots = inst.Skeleton.Slots.Select(x => (x.AttachmentName, (double[])x.Color.Clone(), x.Dark != null ? (double[])x.Dark.Clone() : null)).ToList(),
                Draw = inst.Skeleton.DrawList(),
                Events = rec.Events,
                Audio = rec.Audio,
                States = inst.StateMachine?.ActiveStates,
                Bounds = queries != null ? inst.Skeleton.BoundingBoxes() : null,
            };
            rec.Events = new List<FiredEvent>();
            rec.Audio = new List<Dictionary<string, object>>();
            return s;
        }

        /// <summary>Run every case of one expected file; returns the mismatches (empty = conformant).</summary>
        /// <summary>Samples compared so far (a guard against a harness that silently compares nothing).</summary>
        public static int Compared;
        public static List<string> Run(string file, int maxErrors = 40)
        {
            var errors = new List<string>();
            using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "conformance", "expected", file)));
            var root = json.RootElement;
            var docPath = Path.Combine(RepoRoot, root.GetProperty("document").GetString());
            var doc = DocumentLoader.Load(File.ReadAllBytes(docPath));
            var host = Host();
            var queries = LoadQueries(root, doc, host);
            foreach (var c in root.GetProperty("cases").EnumerateArray())
            {
                if (errors.Count >= maxErrors) break;
                string name = c.GetProperty("name").GetString();
                string kind = c.GetProperty("kind").GetString();
                int steps = (int)Math.Round(c.GetProperty("duration").GetDouble() / Dt);
                var inst = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = host });
                Action<int, double> before = null;
                if (kind == "setup" || kind == "animation")
                {
                    var skin = c.GetProperty("skin");
                    inst.Skeleton.SetSkin(skin.ValueKind == JsonValueKind.String ? skin.GetString() : null);
                    if (kind == "animation") inst.Play(c.GetProperty("animation").GetString(), true);
                }
                else
                {
                    var sm = inst.UseStateMachine(c.GetProperty("stateMachine").GetString());
                    var actions = c.GetProperty("actions").EnumerateArray().ToList();
                    before = (i, t) =>
                    {
                        foreach (var a in actions)
                        {
                            if (Math.Abs(a.GetProperty("t").GetDouble() - t) > Dt / 2) continue;
                            if (a.TryGetProperty("fire", out var f)) sm.Fire(f.GetString());
                            else if (a.TryGetProperty("input", out var inp)) sm.SetInput(inp.GetString(), Value(a.GetProperty("value")));
                            else inst.Pointer(a.GetProperty("pointer").GetString(), a.GetProperty("x").GetDouble(), a.GetProperty("y").GetDouble());
                        }
                    };
                }
                var rec = new Recorder(inst);
                var samples = new List<Sample>();
                try
                {
                    inst.Advance(0);
                    samples.Add(Take(inst, rec, 0, queries));
                    for (int i = 1; i <= steps; i++)
                    {
                        before?.Invoke(i, (i - 1) * Dt);
                        inst.Advance(Dt);
                        if (i % SampleEvery == 0) samples.Add(Take(inst, rec, i * Dt, queries));
                    }
                }
                catch (Exception e)
                {
                    errors.Add($"{file} {name}: threw {e}");
                    continue;
                }
                finally
                {
                    inst.Dispose();
                }
                var expected = c.GetProperty("samples").EnumerateArray().ToList();
                if (expected.Count != samples.Count)
                {
                    errors.Add($"{file} {name}: {samples.Count} samples, expected {expected.Count}");
                    continue;
                }
                Compared += samples.Count;
                for (int i = 0; i < samples.Count && errors.Count < maxErrors; i++)
                    {
                    string where = $"{file} {name} t={expected[i].GetProperty("t").GetDouble()}";
                    CompareSample(where, samples[i], expected[i], errors, maxErrors);
                    if (queries != null) CompareBounds(where, samples[i].Bounds, queries, expected[i], errors, maxErrors);
                    else if (expected[i].TryGetProperty("bounds", out _)) errors.Add($"{where}: bounds recorded but the file has no queries");
                }
            }
            return errors;
        }

        static object Value(JsonElement v) => v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.String => v.GetString(),
            _ => null,
        };

        static double R4(double v)
        {
            double r = Math.Floor(v * 1e4 + 0.5) / 1e4;
            return r == 0 ? 0 : r;
        }

        static bool Near(double mine, JsonElement e, double tol) => Near(mine, e.GetDouble(), tol);
        static bool Near(double mine, double e, double tol) => Math.Abs(mine - e) <= tol + Round || (double.IsNaN(mine) && double.IsNaN(e));

        static void Nums(string where, IReadOnlyList<double> mine, JsonElement exp, double tol, List<string> errors, int max)
        {
            int n = exp.GetArrayLength();
            if (mine.Count != n)
            {
                errors.Add($"{where}: length {mine.Count}, expected {n}");
                return;
            }
            int i = 0;
            foreach (var x in exp.EnumerateArray())
            {
                if (!Near(mine[i], x, tol))
                {
                    errors.Add($"{where}[{i}]: {mine[i].ToString("R", CultureInfo.InvariantCulture)}, expected {x.GetDouble().ToString("R", CultureInfo.InvariantCulture)}");
                    return;
                }
                i++;
            }
        }

        static double[] D(float[] f) => f.Select(x => (double)x).ToArray();
        static double[] D(ushort[] f) => f.Select(x => (double)x).ToArray();

        /// <summary>Bounding-box queries: boxes (names exact, vertices 1e-3), aabb (1e-3 or null), points / segments (index lists exact, first-hit variants agree), aabbs, others.</summary>
        static void CompareBounds(string where, SkeletonBounds b, Queries q, JsonElement e, List<string> errors, int max)
        {
            if (!e.TryGetProperty("bounds", out var be))
            {
                errors.Add($"{where}: no bounds in the expected sample");
                return;
            }
            where += ": bounds";
            var boxes = be.GetProperty("boxes").EnumerateArray().ToList();
            if (boxes.Count != b.Boxes.Count)
            {
                errors.Add($"{where}: {b.Boxes.Count} boxes, expected {boxes.Count}: mine [{string.Join(", ", b.Boxes.Select(x => x.Slot.Name + "/" + x.Attachment))}] vs [{string.Join(", ", boxes.Select(x => x.GetProperty("slot").GetString() + "/" + x.GetProperty("attachment").GetString()))}]");
                return;
            }
            for (int i = 0; i < boxes.Count; i++)
            {
                var x = boxes[i];
                var m = b.Boxes[i];
                string w = $"{where} box {i} ({m.Slot.Name}/{m.Attachment})";
                if (x.GetProperty("slot").GetString() != m.Slot.Name || x.GetProperty("attachment").GetString() != m.Attachment)
                    errors.Add($"{w}: expected {x.GetProperty("slot").GetString()}/{x.GetProperty("attachment").GetString()}");
                Nums($"{w} vertices", D(m.Vertices), x.GetProperty("vertices"), 1e-3, errors, max);
            }
            var aabb = be.GetProperty("aabb");
            if (aabb.ValueKind == JsonValueKind.Null) { if (b.Boxes.Count > 0) errors.Add($"{where}: aabb present, expected null"); }
            else Nums($"{where} aabb", new[] { b.MinX, b.MinY, b.MaxX, b.MaxY }, aabb, 1e-3, errors, max);

            string Idx(IEnumerable<BoundingBoxPolygon> list) => "[" + string.Join(",", list.Select(p => b.Boxes.IndexOf(p))) + "]";
            string Exp(JsonElement list) => "[" + string.Join(",", list.EnumerateArray().Select(x => x.GetInt32())) + "]";
            void Hits(string kind, List<double[]> qs, JsonElement exp, Func<double[], List<BoundingBoxPolygon>> all, Func<double[], BoundingBoxPolygon> first)
            {
                var list = exp.EnumerateArray().ToList();
                if (list.Count != qs.Count) { errors.Add($"{where}: {qs.Count} {kind}, expected {list.Count}"); return; }
                for (int i = 0; i < qs.Count; i++)
                {
                    var mineAll = all(qs[i]);
                    string mine = Idx(mineAll), want = Exp(list[i]);
                    if (mine != want) errors.Add($"{where}: {kind} {i} ({string.Join(", ", qs[i])}) {mine}, expected {want}");
                    var f = first(qs[i]);
                    var fe = list[i].GetArrayLength() > 0 ? b.Boxes.ElementAtOrDefault(list[i][0].GetInt32()) : null;
                    if (f != fe) errors.Add($"{where}: {kind} {i} first hit {(f == null ? "none" : b.Boxes.IndexOf(f).ToString())}, expected {(fe == null ? "none" : list[i][0].GetInt32().ToString())}");
                }
            }
            Hits("points", q.Points, be.GetProperty("points"), p => b.ContainsPointAll(p[0], p[1]), p => b.ContainsPoint(p[0], p[1]));
            Hits("segments", q.Segments, be.GetProperty("segments"), p => b.IntersectsSegmentAll(p[0], p[1], p[2], p[3]), p => b.IntersectsSegment(p[0], p[1], p[2], p[3]));

            var aabbs = be.GetProperty("aabbs").EnumerateArray().ToList();
            if (aabbs.Count != q.Aabbs.Count) errors.Add($"{where}: {q.Aabbs.Count} aabbs, expected {aabbs.Count}");
            else
                for (int i = 0; i < aabbs.Count; i++)
                {
                    var r = q.Aabbs[i];
                    bool mine = b.AabbIntersects(r[0], r[1], r[2], r[3]);
                    if (mine != aabbs[i].GetBoolean()) errors.Add($"{where}: aabbs {i} ({string.Join(", ", r)}) {mine}, expected {aabbs[i].GetBoolean()}");
                }

            var others = be.GetProperty("others").EnumerateArray().ToList();
            if (others.Count != q.Others.Count) errors.Add($"{where}: {q.Others.Count} others, expected {others.Count}");
            else
                for (int i = 0; i < others.Count; i++)
                {
                    var o = q.Others[i];
                    var p = b.IntersectsBounds(o);
                    string mine = p == null ? "null" : $"[{b.Boxes.IndexOf(p.Value.Mine)},{o.Boxes.IndexOf(p.Value.Theirs)}]";
                    string want = others[i].ValueKind == JsonValueKind.Null ? "null" : Exp(others[i]);
                    if (mine != want) errors.Add($"{where}: others {i} {mine}, expected {want}");
                }
        }

        static void CompareSample(string where, Sample s, JsonElement e, List<string> errors, int max)
        {
            if (!Near(R4(s.T), e.GetProperty("t"), 1e-9)) errors.Add($"{where}: t {s.T}");
            var bones = e.GetProperty("bones").EnumerateArray().ToList();
            if (bones.Count != s.Bones.Count) errors.Add($"{where}: {s.Bones.Count} bones, expected {bones.Count}");
            else
                for (int i = 0; i < bones.Count && errors.Count < max; i++)
                {
                    var b = bones[i].EnumerateArray().Select(x => x.GetDouble()).ToArray();
                    for (int k = 0; k < 6; k++)
                        if (!Near(s.Bones[i][k], b[k], k < 4 ? 1e-4 : 1e-3))
                        {
                            errors.Add($"{where}: bone {i} ({s.Inst?.Skeleton.Bones[i].Name}) [{k}] = {s.Bones[i][k]:R}, expected {b[k]:R}  (mine {string.Join(", ", s.Bones[i].Select(x => R4(x)))} vs {string.Join(", ", b)})");
                            break;
                        }
                }
            var slots = e.GetProperty("slots").EnumerateArray().ToList();
            if (slots.Count != s.Slots.Count) errors.Add($"{where}: {s.Slots.Count} slots, expected {slots.Count}");
            else
                for (int i = 0; i < slots.Count && errors.Count < max; i++)
                {
                    var x = slots[i];
                    string en = x[0].ValueKind == JsonValueKind.Null ? null : x[0].GetString();
                    if (en != s.Slots[i].name) errors.Add($"{where}: slot {i} attachment {s.Slots[i].name ?? "null"}, expected {en ?? "null"}");
                    Nums($"{where}: slot {i} colour", s.Slots[i].color, x[1], 1.0 / 255, errors, max);
                    if (x[2].ValueKind == JsonValueKind.Null) { if (s.Slots[i].dark != null) errors.Add($"{where}: slot {i} has dark, expected none"); }
                    else if (s.Slots[i].dark == null) errors.Add($"{where}: slot {i} has no dark");
                    else Nums($"{where}: slot {i} dark", s.Slots[i].dark.Take(3).ToArray(), x[2], 1.0 / 255, errors, max);
                }
            var draw = e.GetProperty("draw").EnumerateArray().ToList();
            var clips = new List<ClipRegion>();
            if (draw.Count != s.Draw.Count)
                errors.Add($"{where}: {s.Draw.Count} draw items, expected {draw.Count}: mine [{string.Join(", ", s.Draw.Select(d => d.Slot.Name + "/" + d.Attachment.Name))}] vs [{string.Join(", ", draw.Select(d => d.GetProperty("slot").GetString() + "/" + d.GetProperty("attachment").GetString()))}]");
            else
                for (int i = 0; i < draw.Count && errors.Count < max; i++)
                {
                    var x = draw[i];
                    var it = s.Draw[i];
                    string w = $"{where}: draw {i} ({it.Slot.Name}/{it.Attachment.Name})";
                    void Str(string field, string mine)
                    {
                        var ev = x.GetProperty(field);
                        string exp = ev.ValueKind == JsonValueKind.Null ? null : ev.GetString();
                        if (exp != mine) errors.Add($"{w}: {field} {mine ?? "null"}, expected {exp ?? "null"}");
                    }
                    Str("slot", it.Slot.Name);
                    Str("attachment", it.Attachment.Name);
                    Str("type", it.Type);
                    Str("blend", it.Blend);
                    Str("texture", it.Texture?.Id);
                    bool particles = it.Particles != null;
                    Nums($"{w} vertices", D(it.Vertices), x.GetProperty("vertices"), particles ? 1e-2 : 1e-3, errors, max);
                    Nums($"{w} uvs", D(it.Uvs), x.GetProperty("uvs"), 1e-3, errors, max);
                    Nums($"{w} indices", D(it.Indices), x.GetProperty("indices"), 0, errors, max);
                    Nums($"{w} color", it.Color, x.GetProperty("color"), 1.0 / 255, errors, max);
                    if (x.TryGetProperty("dark", out var dk))
                    {
                        if (it.Dark == null) errors.Add($"{w}: no dark");
                        else Nums($"{w} dark", it.Dark.Take(3).ToArray(), dk, 1.0 / 255, errors, max);
                    }
                    else if (it.Dark != null) errors.Add($"{w}: has dark, expected none");
                    if (x.TryGetProperty("colors", out var cs))
                    {
                        if (it.Colors == null) errors.Add($"{w}: no colors");
                        else Nums($"{w} colors", D(it.Colors), cs, 1.0 / 255, errors, max);
                    }
                    else if (it.Colors != null) errors.Add($"{w}: has colors, expected none");
                    int? clip = null;
                    if (it.Clip != null)
                    {
                        if (!clips.Contains(it.Clip)) clips.Add(it.Clip);
                        clip = clips.IndexOf(it.Clip);
                    }
                    int? eclip = x.TryGetProperty("clip", out var ce) ? ce.GetInt32() : (int?)null;
                    if (clip != eclip) errors.Add($"{w}: clip {clip?.ToString() ?? "none"}, expected {eclip?.ToString() ?? "none"}");
                    string etext = x.TryGetProperty("text", out var te) ? te.GetString() : null;
                    if (etext != it.Text?.Content) errors.Add($"{w}: text \"{it.Text?.Content}\", expected \"{etext}\"");
                }
            var events = e.GetProperty("events").EnumerateArray().ToList();
            if (events.Count != s.Events.Count)
                errors.Add($"{where}: {s.Events.Count} events, expected {events.Count}: mine [{string.Join(", ", s.Events.Select(x => x.Name + "@" + x.Time))}] vs {e.GetProperty("events")}");
            else
                for (int i = 0; i < events.Count; i++)
                {
                    var x = events[i];
                    var m = s.Events[i];
                    if (x.GetProperty("name").GetString() != m.Name || !Near(m.Time, x.GetProperty("time"), 1e-4) || !Near(m.Int, x.GetProperty("int"), 0)
                        || !Near(m.Float, x.GetProperty("float"), 1e-4) || x.GetProperty("string").GetString() != m.String)
                        errors.Add($"{where}: event {i} {m.Name}@{m.Time} int {m.Int} float {m.Float} \"{m.String}\", expected {x}");
                }
            var audio = e.GetProperty("audio").EnumerateArray().ToList();
            if (audio.Count != s.Audio.Count)
                errors.Add($"{where}: {s.Audio.Count} audio commands, expected {audio.Count}: mine [{string.Join(", ", s.Audio.Select(a => a["type"] + ":" + a["id"]))}] vs {e.GetProperty("audio")}");
            else
                for (int i = 0; i < audio.Count; i++)
                {
                    var x = audio[i];
                    var m = s.Audio[i];
                    var keys = x.EnumerateObject().Select(p => p.Name).ToList();
                    bool ok = keys.Count == m.Count && keys.All(m.ContainsKey);
                    if (ok)
                        foreach (var p in x.EnumerateObject())
                        {
                            var mv = m[p.Name];
                            switch (p.Value.ValueKind)
                            {
                                case JsonValueKind.Number: ok &= mv is double dv && Near(dv, p.Value, 1e-4); break;
                                case JsonValueKind.String: ok &= mv as string == p.Value.GetString(); break;
                                case JsonValueKind.True: ok &= mv is bool b1 && b1; break;
                                case JsonValueKind.False: ok &= mv is bool b2 && !b2; break;
                                case JsonValueKind.Null: ok &= mv == null; break;
                            }
                        }
                    if (!ok) errors.Add($"{where}: audio {i} {string.Join(", ", m.Select(kv => kv.Key + "=" + kv.Value))}, expected {x}");
                }
            if (e.TryGetProperty("states", out var st))
            {
                var exp = st.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.ValueKind == JsonValueKind.Null ? null : p.Value.GetString());
                var mine = s.States ?? new Dictionary<string, string>();
                if (exp.Count != mine.Count || exp.Any(kv => !mine.TryGetValue(kv.Key, out var v) || v != kv.Value))
                    errors.Add($"{where}: states {string.Join(", ", mine.Select(kv => kv.Key + "=" + kv.Value))}, expected {st}");
            }
        }
    }
}
