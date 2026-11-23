/**
 * Maths in number fields: `12*4`, `v/2`, `+=10`, `clamp(v, 0, 1)`. A small recursive-descent parser (no `eval`).
 *
 * - Numbers, `+ - * / %`, `^` (power, right-associative), parentheses, unary minus.
 * - `v` / `value`: the field's current value. `pi`, `e`, and any extra `vars` the caller passes.
 * - Prefixes `+=`, `-=`, `*=`, `/=` apply the rest to the current value (`*=2` doubles it).
 * - Functions: min, max, clamp(x, lo, hi), abs, round, floor, ceil, sqrt, pow, lerp(a, b, t), random(), random(hi),
 *   random(lo, hi), and sin/cos/tan/asin/acos/atan/atan2 in degrees (the editor's angle unit).
 *
 * Returns null when the text is not a valid expression or the result is not a finite number.
 */
export function evalNumberExpr(text: string, current: number, vars: Record<string, number> = {}, random = Math.random): number | null {
  let src = text.trim();
  if (!src) return null;
  let op: string | null = null;
  const m = /^([+\-*/])=/.exec(src);
  if (m) {
    op = m[1];
    src = src.slice(2);
  }
  let r: number;
  try {
    r = new Parser(src, { pi: Math.PI, e: Math.E, ...vars, v: current, value: current }, random).parse();
  } catch {
    return null;
  }
  if (op === "+") r = current + r;
  else if (op === "-") r = current - r;
  else if (op === "*") r = current * r;
  else if (op === "/") r = current / r;
  return Number.isFinite(r) ? r : null;
}

const DEG = Math.PI / 180;
const FUNCS: Record<string, (args: number[], random: () => number) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  clamp: ([x, lo, hi]) => Math.min(hi, Math.max(lo, x)),
  abs: ([x]) => Math.abs(x),
  round: ([x]) => Math.round(x),
  floor: ([x]) => Math.floor(x),
  ceil: ([x]) => Math.ceil(x),
  sqrt: ([x]) => Math.sqrt(x),
  pow: ([x, y]) => x ** y,
  lerp: ([a, b, t]) => a + (b - a) * t,
  random: (a, random) => (a.length === 0 ? random() : a.length === 1 ? random() * a[0] : a[0] + random() * (a[1] - a[0])),
  sin: ([x]) => Math.sin(x * DEG),
  cos: ([x]) => Math.cos(x * DEG),
  tan: ([x]) => Math.tan(x * DEG),
  asin: ([x]) => Math.asin(x) / DEG,
  acos: ([x]) => Math.acos(x) / DEG,
  atan: ([x]) => Math.atan(x) / DEG,
  atan2: ([y, x]) => Math.atan2(y, x) / DEG,
};
const ARITY: Record<string, [number, number]> = { clamp: [3, 3], pow: [2, 2], lerp: [3, 3], atan2: [2, 2], random: [0, 2], min: [1, 99], max: [1, 99] };

class Parser {
  private i = 0;
  constructor(
    private s: string,
    private vars: Record<string, number>,
    private random: () => number,
  ) {}

  parse(): number {
    const v = this.sum();
    this.ws();
    if (this.i < this.s.length) throw new Error(`Unexpected '${this.s[this.i]}'`);
    return v;
  }
  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  private eat(c: string): boolean {
    this.ws();
    if (this.s[this.i] === c) {
      this.i++;
      return true;
    }
    return false;
  }
  private sum(): number {
    let v = this.product();
    for (;;) {
      if (this.eat("+")) v += this.product();
      else if (this.eat("-")) v -= this.product();
      else return v;
    }
  }
  private product(): number {
    let v = this.unary();
    for (;;) {
      if (this.eat("*")) v *= this.unary();
      else if (this.eat("/")) v /= this.unary();
      else if (this.eat("%")) v %= this.unary();
      else return v;
    }
  }
  private unary(): number {
    if (this.eat("-")) return -this.unary();
    if (this.eat("+")) return this.unary();
    return this.power();
  }
  private power(): number {
    const base = this.atom();
    // Right-associative, and binds tighter than unary minus on its left: -2^2 = -4, 2^-1 = 0.5.
    if (this.eat("^")) return base ** this.unary();
    return base;
  }
  private atom(): number {
    this.ws();
    if (this.eat("(")) {
      const v = this.sum();
      if (!this.eat(")")) throw new Error("Missing )");
      return v;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(this.s.slice(this.i));
    if (!id) throw new Error("Expected a number");
    this.i += id[0].length;
    const name = id[0];
    if (this.eat("(")) {
      const f = FUNCS[name.toLowerCase()];
      if (!f) throw new Error(`Unknown function ${name}`);
      const args: number[] = [];
      if (!this.eat(")")) {
        do args.push(this.sum());
        while (this.eat(","));
        if (!this.eat(")")) throw new Error("Missing )");
      }
      const [lo, hi] = ARITY[name.toLowerCase()] ?? [1, 1];
      if (args.length < lo || args.length > hi) throw new Error(`${name} takes ${lo === hi ? lo : `${lo}-${hi}`} arguments`);
      return f(args, this.random);
    }
    if (name in this.vars) return this.vars[name];
    const lower = name.toLowerCase();
    if (lower in this.vars) return this.vars[lower];
    throw new Error(`Unknown name ${name}`);
  }
}
