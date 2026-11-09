using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace OpenBone.Json
{
    public enum JsonKind { Null, Bool, Number, String, Array, Object }

    /// <summary>
    /// Minimal JSON DOM with JavaScript semantics where they matter: object keys keep insertion order (a repeated key
    /// keeps its first position and its last value, like <c>JSON.parse</c>), numbers are doubles. Dependency-free so the
    /// same code runs on .NET and in Unity.
    /// </summary>
    public sealed class JsonValue
    {
        public static readonly JsonValue Null = new JsonValue(JsonKind.Null);
        public static readonly JsonValue True = new JsonValue(JsonKind.Bool) { _bool = true };
        public static readonly JsonValue False = new JsonValue(JsonKind.Bool) { _bool = false };

        public JsonKind Kind { get; }
        bool _bool;
        double _num;
        string _str;
        List<JsonValue> _arr;
        List<string> _keys;
        Dictionary<string, JsonValue> _obj;

        JsonValue(JsonKind k) { Kind = k; }

        public static JsonValue Number(double v) => new JsonValue(JsonKind.Number) { _num = v };
        public static JsonValue String(string v) => v == null ? Null : new JsonValue(JsonKind.String) { _str = v };
        public static JsonValue Bool(bool v) => v ? True : False;
        public static JsonValue NewArray() => new JsonValue(JsonKind.Array) { _arr = new List<JsonValue>() };
        public static JsonValue NewObject() => new JsonValue(JsonKind.Object) { _keys = new List<string>(), _obj = new Dictionary<string, JsonValue>() };

        public bool IsNull => Kind == JsonKind.Null;
        public bool IsNumber => Kind == JsonKind.Number;
        public bool IsString => Kind == JsonKind.String;
        public bool IsBool => Kind == JsonKind.Bool;
        public bool IsArray => Kind == JsonKind.Array;
        public bool IsObject => Kind == JsonKind.Object;

        public double AsNumber => _num;
        public string AsString => _str;
        public bool AsBool => _bool;
        public IReadOnlyList<JsonValue> Items => _arr ?? (IReadOnlyList<JsonValue>)Array.Empty<JsonValue>();
        public IReadOnlyList<string> Keys => _keys ?? (IReadOnlyList<string>)Array.Empty<string>();
        public int Count => Kind == JsonKind.Array ? _arr.Count : Kind == JsonKind.Object ? _keys.Count : 0;

        public void Add(JsonValue v) => _arr.Add(v);

        public void Set(string key, JsonValue v)
        {
            if (!_obj.ContainsKey(key)) _keys.Add(key);
            _obj[key] = v;
        }

        public bool Has(string key) => Kind == JsonKind.Object && _obj.ContainsKey(key);

        /// <summary>Member by key, or null (C#) when absent or when this is not an object.</summary>
        public JsonValue Get(string key)
        {
            if (Kind != JsonKind.Object) return null;
            return _obj.TryGetValue(key, out var v) ? v : null;
        }

        public JsonValue this[string key] => Get(key);
        public JsonValue this[int i] => _arr[i];

        // ---------- typed helpers (missing ⇒ default) ----------
        public double Num(string key, double def = 0)
        {
            var v = Get(key);
            return v != null && v.Kind == JsonKind.Number ? v._num : def;
        }

        public double? NumOpt(string key)
        {
            var v = Get(key);
            return v != null && v.Kind == JsonKind.Number ? v._num : (double?)null;
        }

        public string Str(string key, string def = null)
        {
            var v = Get(key);
            return v != null && v.Kind == JsonKind.String ? v._str : def;
        }

        public bool Bool(string key, bool def = false)
        {
            var v = Get(key);
            if (v == null || v.Kind == JsonKind.Null) return def;
            return v.Truthy;
        }

        public bool? BoolOpt(string key)
        {
            var v = Get(key);
            if (v == null) return null;
            return v.Truthy;
        }

        /// <summary>JavaScript truthiness.</summary>
        public bool Truthy
        {
            get
            {
                switch (Kind)
                {
                    case JsonKind.Null: return false;
                    case JsonKind.Bool: return _bool;
                    case JsonKind.Number: return _num != 0 && !double.IsNaN(_num);
                    case JsonKind.String: return _str.Length > 0;
                    default: return true;
                }
            }
        }

        public double[] NumArray(string key)
        {
            var v = Get(key);
            if (v == null || v.Kind != JsonKind.Array) return null;
            var a = new double[v._arr.Count];
            for (int i = 0; i < a.Length; i++) a[i] = v._arr[i].Kind == JsonKind.Number ? v._arr[i]._num : 0;
            return a;
        }

        public IReadOnlyList<JsonValue> Arr(string key)
        {
            var v = Get(key);
            return v != null && v.Kind == JsonKind.Array ? v._arr : (IReadOnlyList<JsonValue>)Array.Empty<JsonValue>();
        }

        /// <summary>The value as a plain CLR object: null, bool, double, string, List&lt;object&gt;, or an ordered dictionary.</summary>
        public object ToObject()
        {
            switch (Kind)
            {
                case JsonKind.Bool: return _bool;
                case JsonKind.Number: return _num;
                case JsonKind.String: return _str;
                case JsonKind.Array:
                    var l = new List<object>(_arr.Count);
                    foreach (var x in _arr) l.Add(x.ToObject());
                    return l;
                case JsonKind.Object:
                    var d = new JsObject();
                    foreach (var k in _keys) d[k] = _obj[k].ToObject();
                    return d;
                default: return null;
            }
        }

        public static JsonValue FromObject(object o)
        {
            switch (o)
            {
                case null: return Null;
                case JsonValue j: return j;
                case bool b: return Bool(b);
                case double d: return Number(d);
                case float f: return Number(f);
                case int i: return Number(i);
                case long l: return Number(l);
                case string s: return String(s);
                case IJsonWritable w: return w.ToJson();
                case IDictionary<string, object> dict:
                    {
                        var r = NewObject();
                        foreach (var kv in dict) if (!(kv.Value is Undefined)) r.Set(kv.Key, FromObject(kv.Value));
                        return r;
                    }
                case System.Collections.IEnumerable e:
                    {
                        var r = NewArray();
                        foreach (var x in e) r.Add(FromObject(x is Undefined ? null : x));
                        return r;
                    }
                default: return String(o.ToString());
            }
        }

        public override string ToString() => JsonWriter.Write(this);
    }

    /// <summary>Marker for "undefined" in JS-shaped dictionaries (left out when written as JSON).</summary>
    public sealed class Undefined
    {
        public static readonly Undefined Value = new Undefined();
        Undefined() { }
    }

    /// <summary>Insertion-ordered string-keyed dictionary (a JavaScript object).</summary>
    public sealed class JsObject : IDictionary<string, object>
    {
        readonly List<string> _keys = new List<string>();
        readonly Dictionary<string, object> _map = new Dictionary<string, object>();
        public object this[string key]
        {
            get => _map.TryGetValue(key, out var v) ? v : null;
            set { if (!_map.ContainsKey(key)) _keys.Add(key); _map[key] = value; }
        }
        public ICollection<string> Keys => _keys;
        public ICollection<object> Values { get { var l = new List<object>(); foreach (var k in _keys) l.Add(_map[k]); return l; } }
        public int Count => _keys.Count;
        public bool IsReadOnly => false;
        public void Add(string key, object value) => this[key] = value;
        public void Add(KeyValuePair<string, object> item) => this[item.Key] = item.Value;
        public void Clear() { _keys.Clear(); _map.Clear(); }
        public bool Contains(KeyValuePair<string, object> item) => _map.ContainsKey(item.Key);
        public bool ContainsKey(string key) => _map.ContainsKey(key);
        public void CopyTo(KeyValuePair<string, object>[] array, int arrayIndex) { foreach (var k in _keys) array[arrayIndex++] = new KeyValuePair<string, object>(k, _map[k]); }
        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() { foreach (var k in _keys) yield return new KeyValuePair<string, object>(k, _map[k]); }
        public bool Remove(string key) { if (!_map.Remove(key)) return false; _keys.Remove(key); return true; }
        public bool Remove(KeyValuePair<string, object> item) => Remove(item.Key);
        public bool TryGetValue(string key, out object value) => _map.TryGetValue(key, out value);
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public interface IJsonWritable
    {
        JsonValue ToJson();
    }

    public sealed class JsonException : Exception
    {
        public JsonException(string m) : base(m) { }
    }

    /// <summary>Strict JSON parser (RFC 8259).</summary>
    public static class JsonReader
    {
        public static JsonValue Parse(string text)
        {
            int p = 0;
            SkipWs(text, ref p);
            var v = ParseValue(text, ref p, 0);
            SkipWs(text, ref p);
            if (p != text.Length) throw new JsonException($"Unexpected character at {p}");
            return v;
        }

        static void SkipWs(string s, ref int p)
        {
            while (p < s.Length)
            {
                char c = s[p];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p++;
                else break;
            }
        }

        static JsonValue ParseValue(string s, ref int p, int depth)
        {
            if (depth > 512) throw new JsonException("JSON nested too deeply");
            if (p >= s.Length) throw new JsonException("Unexpected end of JSON");
            char c = s[p];
            switch (c)
            {
                case '{':
                    {
                        p++;
                        var o = JsonValue.NewObject();
                        SkipWs(s, ref p);
                        if (p < s.Length && s[p] == '}') { p++; return o; }
                        for (; ; )
                        {
                            SkipWs(s, ref p);
                            if (p >= s.Length || s[p] != '"') throw new JsonException($"Expected key at {p}");
                            var key = ParseString(s, ref p);
                            SkipWs(s, ref p);
                            if (p >= s.Length || s[p] != ':') throw new JsonException($"Expected ':' at {p}");
                            p++;
                            SkipWs(s, ref p);
                            o.Set(key, ParseValue(s, ref p, depth + 1));
                            SkipWs(s, ref p);
                            if (p < s.Length && s[p] == ',') { p++; continue; }
                            if (p < s.Length && s[p] == '}') { p++; return o; }
                            throw new JsonException($"Expected ',' or '}}' at {p}");
                        }
                    }
                case '[':
                    {
                        p++;
                        var a = JsonValue.NewArray();
                        SkipWs(s, ref p);
                        if (p < s.Length && s[p] == ']') { p++; return a; }
                        for (; ; )
                        {
                            SkipWs(s, ref p);
                            a.Add(ParseValue(s, ref p, depth + 1));
                            SkipWs(s, ref p);
                            if (p < s.Length && s[p] == ',') { p++; continue; }
                            if (p < s.Length && s[p] == ']') { p++; return a; }
                            throw new JsonException($"Expected ',' or ']' at {p}");
                        }
                    }
                case '"':
                    return JsonValue.String(ParseString(s, ref p));
                case 't':
                    Expect(s, ref p, "true");
                    return JsonValue.True;
                case 'f':
                    Expect(s, ref p, "false");
                    return JsonValue.False;
                case 'n':
                    Expect(s, ref p, "null");
                    return JsonValue.Null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return JsonValue.Number(ParseNumber(s, ref p));
                    throw new JsonException($"Unexpected character '{c}' at {p}");
            }
        }

        static void Expect(string s, ref int p, string word)
        {
            if (string.CompareOrdinal(s, p, word, 0, word.Length) != 0) throw new JsonException($"Unexpected token at {p}");
            p += word.Length;
        }

        static double ParseNumber(string s, ref int p)
        {
            int start = p;
            if (s[p] == '-') p++;
            if (p >= s.Length) throw new JsonException("Bad number");
            if (s[p] == '0') p++;
            else if (s[p] >= '1' && s[p] <= '9') while (p < s.Length && char.IsDigit(s[p])) p++;
            else throw new JsonException($"Bad number at {start}");
            if (p < s.Length && s[p] == '.')
            {
                p++;
                int d = p;
                while (p < s.Length && s[p] >= '0' && s[p] <= '9') p++;
                if (p == d) throw new JsonException($"Bad number at {start}");
            }
            if (p < s.Length && (s[p] == 'e' || s[p] == 'E'))
            {
                p++;
                if (p < s.Length && (s[p] == '+' || s[p] == '-')) p++;
                int d = p;
                while (p < s.Length && s[p] >= '0' && s[p] <= '9') p++;
                if (p == d) throw new JsonException($"Bad number at {start}");
            }
            return double.Parse(s.Substring(start, p - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static string ParseString(string s, ref int p)
        {
            p++; // opening quote
            StringBuilder sb = null;
            int runStart = p;
            while (p < s.Length)
            {
                char c = s[p];
                if (c == '"')
                {
                    string result;
                    if (sb == null) result = s.Substring(runStart, p - runStart);
                    else { sb.Append(s, runStart, p - runStart); result = sb.ToString(); }
                    p++;
                    return result;
                }
                if (c == '\\')
                {
                    sb ??= new StringBuilder();
                    sb.Append(s, runStart, p - runStart);
                    p++;
                    if (p >= s.Length) break;
                    char e = s[p++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (p + 4 > s.Length) throw new JsonException("Bad \\u escape");
                            sb.Append((char)int.Parse(s.Substring(p, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            p += 4;
                            break;
                        default: throw new JsonException($"Bad escape at {p}");
                    }
                    runStart = p;
                    continue;
                }
                if (c < 0x20) throw new JsonException($"Control character in string at {p}");
                p++;
            }
            throw new JsonException("Unterminated string");
        }
    }

    /// <summary>JSON writer with JavaScript <c>JSON.stringify</c> number formatting (non-finite numbers become null).</summary>
    public static class JsonWriter
    {
        public static string Write(JsonValue v)
        {
            var sb = new StringBuilder();
            Write(sb, v);
            return sb.ToString();
        }

        public static void Write(StringBuilder sb, JsonValue v)
        {
            switch (v.Kind)
            {
                case JsonKind.Null: sb.Append("null"); break;
                case JsonKind.Bool: sb.Append(v.AsBool ? "true" : "false"); break;
                case JsonKind.Number:
                    sb.Append(double.IsNaN(v.AsNumber) || double.IsInfinity(v.AsNumber) ? "null" : Js.NumberToString(v.AsNumber));
                    break;
                case JsonKind.String: WriteString(sb, v.AsString); break;
                case JsonKind.Array:
                    sb.Append('[');
                    for (int i = 0; i < v.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        Write(sb, v[i]);
                    }
                    sb.Append(']');
                    break;
                case JsonKind.Object:
                    sb.Append('{');
                    bool first = true;
                    foreach (var k in v.Keys)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, k);
                        sb.Append(':');
                        Write(sb, v.Get(k));
                    }
                    sb.Append('}');
                    break;
            }
        }

        public static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
