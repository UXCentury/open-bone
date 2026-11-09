package com.openbone.runtime;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

/** JavaScript number semantics the runtime depends on (string forms, toFixed, Number(), truthiness). */
public final class JsNum {
  private JsNum() {}

  /** {@code String(n)}: shortest round-trip form, "1e21" style exponents, no trailing ".0". */
  public static String toString(double v) {
    if (Double.isNaN(v)) return "NaN";
    if (v == Double.POSITIVE_INFINITY) return "Infinity";
    if (v == Double.NEGATIVE_INFINITY) return "-Infinity";
    if (v == 0) return "0";
    if (v < 0) return "-" + toString(-v);
    // Shortest digits that round-trip (JS picks the closest such string; %e rounds to nearest).
    String digits = null;
    int exp = 0;
    for (int prec = 1; prec <= 17; prec++) {
      String e = String.format(java.util.Locale.ROOT, "%." + (prec - 1) + "e", v);
      if (Double.parseDouble(e) == v) {
        int ei = e.indexOf('e');
        digits = e.substring(0, ei).replace(".", "");
        exp = Integer.parseInt(e.substring(ei + 1));
        break;
      }
    }
    if (digits == null) {
      String e = String.format(java.util.Locale.ROOT, "%.16e", v);
      int ei = e.indexOf('e');
      digits = e.substring(0, ei).replace(".", "");
      exp = Integer.parseInt(e.substring(ei + 1));
    }
    // strip trailing zeros
    int end = digits.length();
    while (end > 1 && digits.charAt(end - 1) == '0') end--;
    digits = digits.substring(0, end);
    int k = digits.length();
    int n = exp + 1; // position of the decimal point
    StringBuilder b = new StringBuilder();
    if (k <= n && n <= 21) {
      b.append(digits);
      for (int i = 0; i < n - k; i++) b.append('0');
    } else if (0 < n && n <= 21) {
      b.append(digits, 0, n).append('.').append(digits, n, k);
    } else if (-6 < n && n <= 0) {
      b.append("0.");
      for (int i = 0; i < -n; i++) b.append('0');
      b.append(digits);
    } else {
      b.append(digits.charAt(0));
      if (k > 1) b.append('.').append(digits, 1, k);
      b.append('e').append(n - 1 >= 0 ? "+" : "-").append(Math.abs(n - 1));
    }
    return b.toString();
  }

  /** {@code n.toFixed(digits)}: exact decimal value, ties rounded up (away from zero). */
  public static String toFixed(double v, int digits) {
    if (!Double.isFinite(v)) return toString(v);
    if (Math.abs(v) >= 1e21) return toString(v);
    boolean neg = v < 0;
    BigDecimal d = new BigDecimal(Math.abs(v)).setScale(digits, RoundingMode.HALF_UP);
    String s = d.toPlainString();
    // JS keeps "-" for negative values even when the result is zero (e.g. (-0.0001).toFixed(2) is "-0.00")
    return neg ? "-" + s : s;
  }

  /** {@code Number(n.toPrecision(p))}. */
  public static double roundPrecision(double v, int precision) {
    if (!Double.isFinite(v) || v == 0) return v;
    BigDecimal d = new BigDecimal(v).round(new MathContext(precision, RoundingMode.HALF_UP));
    return Double.parseDouble(d.toString());
  }

  /** {@code Number(string)}. */
  public static double parse(String s) {
    String t = s.trim();
    if (t.isEmpty()) return 0;
    if (t.equals("Infinity") || t.equals("+Infinity")) return Double.POSITIVE_INFINITY;
    if (t.equals("-Infinity")) return Double.NEGATIVE_INFINITY;
    try {
      if (t.length() > 2 && t.charAt(0) == '0') {
        char x = Character.toLowerCase(t.charAt(1));
        if (x == 'x') return new java.math.BigInteger(t.substring(2), 16).doubleValue();
        if (x == 'o') return new java.math.BigInteger(t.substring(2), 8).doubleValue();
        if (x == 'b') return new java.math.BigInteger(t.substring(2), 2).doubleValue();
      }
      for (int i = 0; i < t.length(); i++) {
        char c = t.charAt(i);
        if (!((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')) return Double.NaN;
      }
      return Double.parseDouble(t);
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }

  /** {@code Number(value)} for an input value (Double, Boolean, String, null = undefined). */
  public static double toNumber(Object v) {
    if (v == null) return Double.NaN;
    if (v instanceof Number) return ((Number) v).doubleValue();
    if (v instanceof Boolean) return ((Boolean) v) ? 1 : 0;
    if (v instanceof String) return parse((String) v);
    return Double.NaN;
  }

  /** {@code String(value)}. */
  public static String str(Object v) {
    if (v == null) return "undefined";
    if (v instanceof Number) return toString(((Number) v).doubleValue());
    return v.toString();
  }

  /** JavaScript truthiness. */
  public static boolean truthy(Object v) {
    if (v == null) return false;
    if (v instanceof Boolean) return (Boolean) v;
    if (v instanceof Number) {
      double d = ((Number) v).doubleValue();
      return d != 0 && !Double.isNaN(d);
    }
    if (v instanceof String) return !((String) v).isEmpty();
    return true;
  }

  /** Strict equality ({@code ===}) of two input values. */
  public static boolean strictEquals(Object a, Object b) {
    if (a == null || b == null) return a == b;
    if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
    if (a instanceof Number || b instanceof Number) return false;
    return a.getClass() == b.getClass() && a.equals(b);
  }

  /** {@code Math.round}: halves round up. */
  public static double round(double v) {
    if (!Double.isFinite(v)) return v;
    double r = Math.floor(v);
    return v - r >= 0.5 ? r + 1 : r;
  }

  /** Round to float32 ({@code Math.fround}). */
  public static double f32(double v) {
    return (double) (float) v;
  }
}
