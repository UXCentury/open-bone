using System;
using System.Collections.Generic;
using OpenBone.Json;

namespace OpenBone
{
    /// <summary>
    /// The <c>ob</c> API a script sees (runtime/scripting.ts:ScriptApi). Values cross the script boundary as JSON, so
    /// arguments arrive as <see cref="JsonValue"/> and results are returned as JSON-able objects (null = undefined).
    /// </summary>
    public interface IScriptApi
    {
        double Time();
        /// <summary>Input value (bool, double, string) or null when unknown.</summary>
        object Input(string name);
        void SetInput(string name, object value);
        void Fire(string name);
        void Emit(string evt, JsonValue payload);
        /// <summary>{x, y, rotation, scaleX, scaleY, worldX, worldY, worldRotation} or null.</summary>
        JsonValue Bone(string name);
        void SetBone(string name, JsonValue props);
        void Slot(string name, JsonValue props);
        JsonValue Pointer();
        void Log(IReadOnlyList<JsonValue> args);
    }

    public interface IScriptHandle : IDisposable
    {
        bool Has(string fn);
        /// <summary>Call a global function; args are JSON-able (double, string, bool, <see cref="IJsonWritable"/>, dictionaries).</summary>
        JsonValue Call(string fn, params object[] args);
    }

    /// <summary>Pluggable script engine (e.g. OpenBone.Scripting.Jint's JintScriptHost).</summary>
    public interface IScriptHost
    {
        IScriptHandle Load(ScriptData script, IScriptApi api);
    }

    public sealed class ScriptException : Exception
    {
        public ScriptException(string m, Exception inner = null) : base(m, inner) { }
    }

    /// <summary>
    /// Dispatches the bridge calls a script makes (<c>ob.method(...args)</c>, args as JSON) to an <see cref="IScriptApi"/>.
    /// Hosts share this so every engine exposes exactly the same API.
    /// </summary>
    public static class ScriptBridge
    {
        public static readonly string[] Methods = { "time", "input", "setInput", "fire", "emit", "bone", "setBone", "slot", "pointer", "log" };

        static JsonValue Arg(IReadOnlyList<JsonValue> a, int i) => i < a.Count ? a[i] : null;
        static string ArgStr(IReadOnlyList<JsonValue> a, int i)
        {
            var v = Arg(a, i);
            if (v == null) return "undefined";
            return v.IsString ? v.AsString : Js.ToStr(Js.FromJson(v));
        }

        /// <summary>Run one API method; returns the JSON result, or null for undefined.</summary>
        public static JsonValue Invoke(IScriptApi api, string method, IReadOnlyList<JsonValue> args)
        {
            switch (method)
            {
                case "time": return JsonValue.Number(api.Time());
                case "input":
                    {
                        var v = api.Input(ArgStr(args, 0));
                        return v == null ? null : JsonValue.FromObject(v);
                    }
                case "setInput": api.SetInput(ArgStr(args, 0), Js.FromJson(Arg(args, 1))); return null;
                case "fire": api.Fire(ArgStr(args, 0)); return null;
                case "emit": api.Emit(ArgStr(args, 0), Arg(args, 1)); return null;
                case "bone": return api.Bone(ArgStr(args, 0)) ?? JsonValue.Null;
                case "setBone": api.SetBone(ArgStr(args, 0), Arg(args, 1)); return null;
                case "slot": api.Slot(ArgStr(args, 0), Arg(args, 1)); return null;
                case "pointer": return api.Pointer();
                case "log": api.Log(args); return null;
                default: return null;
            }
        }
    }
}
