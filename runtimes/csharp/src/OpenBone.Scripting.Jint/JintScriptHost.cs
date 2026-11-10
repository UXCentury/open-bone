using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Jint;
using Jint.Native;
using OpenBone.Json;

namespace OpenBone.Scripting
{
    /// <summary>
    /// Script host running OpenBone scripts in Jint (BSD-2-Clause). Mirrors the reference QuickJS host
    /// (packages/scripting): each script gets its own engine with a memory cap and a CPU deadline per call, and only sees
    /// the global <c>ob</c> (plus <c>console.log</c>). Arguments and results cross the boundary as JSON.
    /// </summary>
    public sealed class JintScriptHost : IScriptHost
    {
        /// <summary>Per-call CPU budget (default 16 ms, as in the reference host).</summary>
        public TimeSpan CallTimeout = TimeSpan.FromMilliseconds(16);
        /// <summary>Budget for running a script's top level (default 50 ms).</summary>
        public TimeSpan LoadTimeout = TimeSpan.FromMilliseconds(50);
        /// <summary>Heap limit per script in bytes (default 8 MB; 0 = none).</summary>
        public long MemoryLimit = 8 * 1024 * 1024;
        /// <summary>Maximum call depth (stack guard).</summary>
        public int MaxRecursionDepth = 512;

        internal static readonly Regex Ident = new Regex(@"^[A-Za-z_$][\w$]*$", RegexOptions.CultureInvariant);

        const string Prelude = @"
const ob = Object.freeze(Object.fromEntries(['time','input','setInput','fire','emit','bone','setBone','slot','pointer','log'].map(m => [m, (...a) => {
  const r = __ob(m, JSON.stringify(a));
  return r === undefined ? undefined : JSON.parse(r);
}])));
const console = { log: (...a) => ob.log(...a) };
";

        public IScriptHandle Load(ScriptData script, IScriptApi api) => new Handle(this, script, api);

        /// <summary>CPU deadline checked before each statement; the budget changes between load and calls.</summary>
        sealed class Deadline : Constraint
        {
            readonly Stopwatch _watch = new Stopwatch();
            public TimeSpan Budget;
            public override void Check()
            {
                if (_watch.Elapsed > Budget) throw new TimeoutException("Script timed out");
            }
            public override void Reset() => _watch.Restart();
        }

        sealed class Handle : IScriptHandle
        {
            readonly JintScriptHost _host;
            readonly ScriptData _script;
            readonly IScriptApi _api;
            readonly Engine _engine;
            readonly Deadline _deadline = new Deadline();
            readonly Dictionary<string, bool> _known = new Dictionary<string, bool>();
            readonly HashSet<string> _warm = new HashSet<string>();
            bool _disposed;

            public Handle(JintScriptHost host, ScriptData script, IScriptApi api)
            {
                _host = host;
                _script = script;
                _api = api;
                _engine = new Engine(o =>
                {
                    o.Constraints.Constraints.Add(_deadline);
                    if (host.MemoryLimit > 0) o.LimitMemory(host.MemoryLimit);
                    o.LimitRecursion(host.MaxRecursionDepth);
                    o.Strict = false;
                });
                _engine.SetValue("__ob", new Func<string, string, JsValue>(Bridge));
                _deadline.Budget = host.LoadTimeout > host.CallTimeout ? host.LoadTimeout : host.CallTimeout;
                Run(Prelude, "prelude.js");
                Run(script.Code ?? "", (script.Name ?? "script") + ".js");
            }

            JsValue Bridge(string method, string argsJson)
            {
                if (Array.IndexOf(ScriptBridge.Methods, method) < 0) return JsValue.Undefined;
                var parsed = JsonReader.Parse(argsJson ?? "[]");
                var args = new List<JsonValue>(parsed.Items);
                var r = ScriptBridge.Invoke(_api, method, args);
                return r == null ? JsValue.Undefined : new JsString(JsonWriter.Write(r));
            }

            void Run(string code, string name)
            {
                try
                {
                    _engine.Execute(code, name);
                }
                catch (Exception e)
                {
                    throw new ScriptException($"[script {_script.Name}] {Describe(e)}", e);
                }
            }

            static string Describe(Exception e)
            {
                if (e is Jint.Runtime.JavaScriptException js) return js.Error.IsObject() ? $"{js.Error.Get("name")}: {js.Message}" : js.Message;
                return $"{e.GetType().Name}: {e.Message}";
            }

            public bool Has(string fn)
            {
                if (_disposed || fn == null) return false;
                if (_known.TryGetValue(fn, out var k)) return k;
                bool has = false;
                if (Ident.IsMatch(fn))
                {
                    _deadline.Budget = _host.LoadTimeout;
                    try { has = _engine.Evaluate($"typeof {fn} === \"function\"").AsBoolean(); }
                    catch (Exception e) { throw new ScriptException($"[script {_script.Name}] {Describe(e)}", e); }
                }
                _known[fn] = has;
                return has;
            }

            public JsonValue Call(string fn, params object[] args)
            {
                if (_disposed || fn == null || !Ident.IsMatch(fn)) return null;
                var arr = JsonValue.NewArray();
                foreach (var a in args) arr.Add(JsonValue.FromObject(a));
                _engine.SetValue("__args", JsonWriter.Write(arr));
                // A function's first call also pays for the interpreter warming up (cold JIT on Mono / IL2CPP),
                // so it gets the load budget; later calls get the per-call budget.
                _deadline.Budget = _warm.Add(fn) && _host.LoadTimeout > _host.CallTimeout ? _host.LoadTimeout : _host.CallTimeout;
                try
                {
                    var r = _engine.Evaluate($"{fn}(...JSON.parse(__args))");
                    if (r.IsUndefined()) return null;
                    var json = _engine.Evaluate("(v => { try { return JSON.stringify(v); } catch { return undefined; } })").AsFunctionInstance().Call(JsValue.Undefined, new[] { r });
                    return json.IsString() ? JsonReader.Parse(json.AsString()) : null;
                }
                catch (Exception e)
                {
                    throw new ScriptException($"[script {_script.Name}.{fn}] {Describe(e)}", e);
                }
            }

            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                _engine.Dispose();
            }
        }
    }
}
