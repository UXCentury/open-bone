package com.openbone.runtime;

import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Text templates: {@code {name}}, {@code {name:0.00}}, {@code {{}} / {@code }}} (core/template.ts). */
public final class Template {
  private Template() {}

  private static final Pattern NUMBER = Pattern.compile("^([^#0]*?)(\\+?)([#0,]+)(?:\\.([0#]+))?(%?)(.*)$", Pattern.DOTALL);
  private static final Pattern TOKEN = Pattern.compile("\\{\\{|\\}\\}|\\{([^{}:]+)(?::([^{}]*))?\\}");
  private static final Pattern THOUSANDS = Pattern.compile("\\B(?=(\\d{3})+(?!\\d))");

  /** Format a number with an Excel-like pattern ("0.00", "#,##0", "+0%", "$#,##0.00"). */
  public static String formatNumber(double value, String pattern) {
    Matcher m = NUMBER.matcher(pattern);
    if (!m.matches()) return plain(value) + pattern;
    String prefix = m.group(1), plus = m.group(2), intPart = m.group(3), frac = m.group(4) == null ? "" : m.group(4), pct = m.group(5), suffix = m.group(6);
    double v = !pct.isEmpty() ? value * 100 : value;
    if (!Double.isFinite(v)) return prefix + JsNum.toString(v) + pct + suffix;
    int minFrac = 0;
    while (minFrac < frac.length() && frac.charAt(minFrac) == '0') minFrac++;
    int maxFrac = frac.length();
    boolean neg = v < 0;
    v = Math.abs(v);
    String s = JsNum.toFixed(v, maxFrac);
    if (maxFrac > minFrac) {
      int end = s.length();
      int keep = s.length() - (maxFrac - minFrac);
      while (end > keep && s.charAt(end - 1) == '0') end--;
      s = s.substring(0, end);
      if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
    }
    int dot = s.indexOf('.');
    String ip = dot < 0 ? s : s.substring(0, dot);
    String fp = dot < 0 ? null : s.substring(dot + 1);
    int minInt = 0;
    for (char c : intPart.toCharArray()) if (c == '0') minInt++;
    if (ip.length() < minInt) {
      StringBuilder b = new StringBuilder();
      for (int i = ip.length(); i < minInt; i++) b.append('0');
      ip = b + ip;
    } else if (minInt == 0 && ip.equals("0") && fp != null && !fp.isEmpty()) ip = "";
    if (intPart.contains(",")) ip = THOUSANDS.matcher(ip).replaceAll(",");
    boolean zero = !(ip + (fp == null ? "" : fp)).matches("(?s).*[1-9].*");
    String sign = neg && !zero ? "-" : !plus.isEmpty() && !neg ? "+" : "";
    return prefix + sign + ip + (fp != null && !fp.isEmpty() ? "." + fp : "") + pct + suffix;
  }

  /** Default text for a value: numbers keep up to 6 decimals without trailing zeros. */
  public static String plain(Object v) {
    if (v instanceof Number) {
      double d = ((Number) v).doubleValue();
      return Double.isFinite(d) ? JsNum.toString(Double.parseDouble(JsNum.toFixed(d, 6))) : JsNum.toString(d);
    }
    return JsNum.str(v);
  }

  public static String formatValue(Object v, String pattern) {
    if (v instanceof Number && pattern != null && !pattern.isEmpty()) return formatNumber(((Number) v).doubleValue(), pattern);
    return plain(v);
  }

  /** Fill a template; {@code lookup} returns null for unknown names (left as written). */
  public static String format(String template, Function<String, Object> lookup) {
    if (template.indexOf('{') < 0 && template.indexOf('}') < 0) return template;
    Matcher m = TOKEN.matcher(template);
    StringBuilder out = new StringBuilder();
    int last = 0;
    while (m.find()) {
      out.append(template, last, m.start());
      String whole = m.group();
      String rep;
      if (whole.equals("{{")) rep = "{";
      else if (whole.equals("}}")) rep = "}";
      else {
        Object v = lookup.apply(m.group(1).trim());
        rep = v == null ? whole : formatValue(v, m.group(2));
      }
      out.append(rep);
      last = m.end();
    }
    out.append(template.substring(last));
    return out.toString();
  }

  /** Linear map of v from [inMin, inMax] to [0, 1], clamped. */
  public static double bindingT(double v, double inMin, double inMax) {
    if (inMax == inMin) return v >= inMax ? 1 : 0;
    double t = (v - inMin) / (inMax - inMin);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
}
