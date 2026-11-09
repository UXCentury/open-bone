package com.openbone.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader/writer. Values: {@code Map<String,Object>} (insertion ordered), {@code List<Object>},
 * {@code Double}, {@code String}, {@code Boolean}, {@code null}. Numbers are written like JavaScript's
 * {@code JSON.stringify} (shortest round-trip form), so values cross to and from scripts unchanged.
 */
public final class Json {
  private final String s;
  private int p;

  private Json(String s) {
    this.s = s;
  }

  public static Object parse(String text) {
    Json j = new Json(text);
    j.ws();
    Object v = j.value();
    j.ws();
    if (j.p != j.s.length()) throw j.err("Unexpected trailing characters");
    return v;
  }

  private RuntimeException err(String msg) {
    return new IllegalArgumentException(msg + " at offset " + p);
  }

  private void ws() {
    while (p < s.length()) {
      char c = s.charAt(p);
      if (c == ' ' || c == '\n' || c == '\r' || c == '\t') p++;
      else break;
    }
  }

  private Object value() {
    if (p >= s.length()) throw err("Unexpected end of JSON");
    char c = s.charAt(p);
    switch (c) {
      case '{': {
        p++;
        Map<String, Object> m = new LinkedHashMap<>();
        ws();
        if (peek() == '}') {
          p++;
          return m;
        }
        for (;;) {
          ws();
          if (peek() != '"') throw err("Expected key");
          String k = string();
          ws();
          expect(':');
          ws();
          m.put(k, value());
          ws();
          char n = next();
          if (n == '}') return m;
          if (n != ',') throw err("Expected , or }");
        }
      }
      case '[': {
        p++;
        List<Object> a = new ArrayList<>();
        ws();
        if (peek() == ']') {
          p++;
          return a;
        }
        for (;;) {
          ws();
          a.add(value());
          ws();
          char n = next();
          if (n == ']') return a;
          if (n != ',') throw err("Expected , or ]");
        }
      }
      case '"':
        return string();
      case 't':
        lit("true");
        return Boolean.TRUE;
      case 'f':
        lit("false");
        return Boolean.FALSE;
      case 'n':
        lit("null");
        return null;
      default:
        return number();
    }
  }

  private char peek() {
    return p < s.length() ? s.charAt(p) : '\0';
  }

  private char next() {
    if (p >= s.length()) throw err("Unexpected end of JSON");
    return s.charAt(p++);
  }

  private void expect(char c) {
    if (next() != c) throw err("Expected " + c);
  }

  private void lit(String w) {
    if (!s.startsWith(w, p)) throw err("Unexpected token");
    p += w.length();
  }

  private Double number() {
    int start = p;
    if (peek() == '-') p++;
    while (p < s.length()) {
      char c = s.charAt(p);
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') p++;
      else break;
    }
    if (start == p) throw err("Unexpected character");
    return Double.parseDouble(s.substring(start, p));
  }

  private String string() {
    expect('"');
    StringBuilder b = null;
    int start = p;
    for (;;) {
      if (p >= s.length()) throw err("Unterminated string");
      char c = s.charAt(p++);
      if (c == '"') return b == null ? s.substring(start, p - 1) : b.toString();
      if (c == '\\') {
        if (b == null) b = new StringBuilder(s.substring(start, p - 1));
        char e = next();
        switch (e) {
          case 'n': b.append('\n'); break;
          case 't': b.append('\t'); break;
          case 'r': b.append('\r'); break;
          case 'b': b.append('\b'); break;
          case 'f': b.append('\f'); break;
          case 'u':
            if (p + 4 > s.length()) throw err("Bad escape");
            b.append((char) Integer.parseInt(s.substring(p, p + 4), 16));
            p += 4;
            break;
          default: b.append(e);
        }
      } else if (b != null) b.append(c);
    }
  }

  // ---------------- Writing ----------------

  /** JSON text of a value (maps, lists, arrays of double/String, numbers, strings, booleans, null). */
  public static String stringify(Object v) {
    StringBuilder b = new StringBuilder();
    write(b, v);
    return b.toString();
  }

  @SuppressWarnings("unchecked")
  private static void write(StringBuilder b, Object v) {
    if (v == null) b.append("null");
    else if (v instanceof String) quote(b, (String) v);
    else if (v instanceof Boolean) b.append(v.toString());
    else if (v instanceof Number) {
      double d = ((Number) v).doubleValue();
      b.append(Double.isFinite(d) ? JsNum.toString(d) : "null");
    } else if (v instanceof Map) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
        if (e.getValue() == Undefined.INSTANCE) continue;
        if (!first) b.append(',');
        first = false;
        quote(b, e.getKey());
        b.append(':');
        write(b, e.getValue());
      }
      b.append('}');
    } else if (v instanceof List) {
      b.append('[');
      List<Object> l = (List<Object>) v;
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) b.append(',');
        Object x = l.get(i);
        write(b, x == Undefined.INSTANCE ? null : x);
      }
      b.append(']');
    } else if (v instanceof double[]) {
      double[] a = (double[]) v;
      b.append('[');
      for (int i = 0; i < a.length; i++) {
        if (i > 0) b.append(',');
        write(b, a[i]);
      }
      b.append(']');
    } else if (v instanceof Object[]) {
      Object[] a = (Object[]) v;
      b.append('[');
      for (int i = 0; i < a.length; i++) {
        if (i > 0) b.append(',');
        write(b, a[i]);
      }
      b.append(']');
    } else if (v == Undefined.INSTANCE) b.append("null");
    else quote(b, v.toString());
  }

  private static void quote(StringBuilder b, String s) {
    b.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        case '\b': b.append("\\b"); break;
        case '\f': b.append("\\f"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    b.append('"');
  }

  /** Marker for a JavaScript {@code undefined} field (left out when written, like JSON.stringify). */
  public static final class Undefined {
    public static final Undefined INSTANCE = new Undefined();

    private Undefined() {}
  }
}
