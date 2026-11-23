import { describe, expect, it } from "vitest";
import { evalNumberExpr } from "../src/expr.ts";

describe("evalNumberExpr", () => {
  const ev = (s: string, v = 10, vars?: Record<string, number>) => evalNumberExpr(s, v, vars, () => 0.5);

  it("reads plain numbers", () => {
    expect(ev("42")).toBe(42);
    expect(ev("-3.5")).toBe(-3.5);
    expect(ev(".25")).toBe(0.25);
    expect(ev("1e3")).toBe(1000);
  });

  it("follows operator precedence", () => {
    expect(ev("2 + 3 * 4")).toBe(14);
    expect(ev("(2 + 3) * 4")).toBe(20);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("2 ^ -1")).toBe(0.5);
    expect(ev("7 % 4")).toBe(3);
  });

  it("uses the current value", () => {
    expect(ev("v * 2")).toBe(20);
    expect(ev("value / 4")).toBe(2.5);
  });

  it("applies compound prefixes to the current value", () => {
    expect(ev("+=5")).toBe(15);
    expect(ev("-=2*2")).toBe(6);
    expect(ev("*=3")).toBe(30);
    expect(ev("/=4")).toBe(2.5);
  });

  it("calls functions, trig in degrees", () => {
    expect(ev("clamp(v, 0, 1)")).toBe(1);
    expect(ev("max(1, 5, 3)")).toBe(5);
    expect(ev("sin(90)")).toBeCloseTo(1);
    expect(ev("atan2(1, 1)")).toBeCloseTo(45);
    expect(ev("lerp(0, 100, 0.25)")).toBe(25);
    expect(ev("random(10, 20)")).toBe(15);
    expect(ev("round(pi * 100) / 100")).toBe(3.14);
  });

  it("knows caller variables", () => {
    expect(ev("boneLength / 2", 0, { boneLength: 80 })).toBe(40);
  });

  it("rejects junk instead of guessing", () => {
    for (const bad of ["", "2 +", "foo", "alert(1)", "clamp(1, 2)", "1 / 0", "(1", "1 2"]) expect(ev(bad)).toBeNull();
  });
});
