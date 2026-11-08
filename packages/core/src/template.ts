import type { InputValue } from "./types.ts";

/**
 * Format a number with a small Excel-like pattern:
 * - `0` digits are always shown, `#` digits only when needed: `0.00` → "2.35", `0.0#` → "2.3" / "2.35";
 * - `,` in the integer part adds thousands separators: `#,##0` → "12,345";
 * - a leading `+` always shows the sign, a trailing `%` multiplies by 100;
 * - anything before or after the number pattern is copied as is: `$#,##0.00` → "$1,234.50", `0.00x` → "2.35x".
 * A pattern without digits just appends itself to the plain number.
 */
export function formatNumber(value: number, pattern: string): string {
  const m = /^([^#0]*?)(\+?)([#0,]+)(?:\.([0#]+))?(%?)(.*)$/s.exec(pattern);
  if (!m) return plain(value) + pattern;
  const [, prefix, plus, int, frac = "", pct, suffix] = m;
  let v = pct ? value * 100 : value;
  if (!Number.isFinite(v)) return prefix + String(v) + pct + suffix;
  const minFrac = (frac.match(/^0*/) ?? [""])[0].length;
  const maxFrac = frac.length;
  const neg = v < 0;
  v = Math.abs(v);
  let s = v.toFixed(maxFrac);
  if (maxFrac > minFrac) {
    // Drop optional (#) trailing zeros.
    let end = s.length;
    const keep = s.length - (maxFrac - minFrac);
    while (end > keep && s[end - 1] === "0") end--;
    s = s.slice(0, end);
    if (s.endsWith(".")) s = s.slice(0, -1);
  }
  let [ip, fp] = s.split(".");
  const minInt = (int.replace(/,/g, "").match(/0/g) ?? []).length;
  if (ip.length < minInt) ip = ip.padStart(minInt, "0");
  else if (minInt === 0 && ip === "0" && fp) ip = "";
  if (int.includes(",")) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const zero = !/[1-9]/.test(ip + (fp ?? ""));
  const sign = neg && !zero ? "-" : plus && !neg ? "+" : "";
  return prefix + sign + ip + (fp ? `.${fp}` : "") + pct + suffix;
}

/** Default text for a value: numbers keep up to 6 decimals without trailing zeros. */
function plain(v: InputValue): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(Number(v.toFixed(6))) : String(v);
  return String(v);
}

/** Format one input value; `pattern` applies to numbers (see formatNumber). */
export function formatValue(v: InputValue, pattern?: string): string {
  if (typeof v === "number" && pattern) return formatNumber(v, pattern);
  return plain(v);
}

/**
 * Fill a text template: `{name}` or `{name:pattern}` is replaced by the value `lookup(name)` returns
 * (unknown names are left as written), `{{` and `}}` are literal braces.
 * Example: `formatTemplate("{multiplier:0.00}x", n => 2.349)` → "2.35x".
 */
export function formatTemplate(template: string, lookup: (name: string) => InputValue | undefined): string {
  if (!template.includes("{") && !template.includes("}")) return template;
  return template.replace(/\{\{|\}\}|\{([^{}:]+)(?::([^{}]*))?\}/g, (whole, name: string | undefined, pattern: string | undefined) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const v = lookup(name!.trim());
    return v === undefined ? whole : formatValue(v, pattern);
  });
}

/** Input names a template refers to, in order of first use. */
export function templateInputs(template: string): string[] {
  const out: string[] = [];
  for (const m of template.replace(/\{\{|\}\}/g, "").matchAll(/\{([^{}:]+)(?::[^{}]*)?\}/g)) {
    const n = m[1].trim();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Linear map of `v` from [inMin, inMax] to [0, 1], clamped (0 when the input range is empty). */
export function bindingT(v: number, inMin: number, inMax: number): number {
  if (inMax === inMin) return v >= inMax ? 1 : 0;
  const t = (v - inMin) / (inMax - inMin);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
