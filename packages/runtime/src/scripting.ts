import type { ScriptData } from "@openbone/core";

/** Functions a script can call (exposed as the global `ob`). */
export interface ScriptApi {
  time(): number;
  input(name: string): boolean | number | undefined;
  setInput(name: string, value: boolean | number): void;
  fire(name: string): void;
  emit(event: string, payload?: { int?: number; float?: number; string?: string }): void;
  bone(name: string): { x: number; y: number; rotation: number; scaleX: number; scaleY: number; worldX: number; worldY: number; worldRotation: number } | null;
  setBone(name: string, props: Partial<Record<"x" | "y" | "rotation" | "scaleX" | "scaleY" | "shearX" | "shearY", number>>): void;
  slot(name: string, props: { color?: string; attachment?: string | null }): void;
  pointer(): { x: number; y: number; down: boolean };
  log(...args: unknown[]): void;
}

export interface ScriptHandle {
  has(fn: string): boolean;
  call(fn: string, ...args: unknown[]): unknown;
  dispose(): void;
}

/** Pluggable script engine. Use the QuickJS host from @openbone/scripting for untrusted content. */
export interface ScriptHost {
  load(script: ScriptData, api: ScriptApi): ScriptHandle;
}

/**
 * Runs scripts with `new Function` in the host realm. NOT sandboxed: only for trusted content
 * (your own projects, tests). Prefer `createQuickJsHost()` from @openbone/scripting.
 */
export const trustedFunctionHost: ScriptHost = {
  load(script, api) {
    const factory = new Function(
      "ob",
      `"use strict";\n${script.code}\n;return {onStart: typeof onStart==="function"?onStart:undefined,onUpdate: typeof onUpdate==="function"?onUpdate:undefined,onEvent: typeof onEvent==="function"?onEvent:undefined,onPointer: typeof onPointer==="function"?onPointer:undefined,__get:(n)=>{try{return eval(n)}catch{return undefined}}};`,
    );
    const exports = factory(api) as Record<string, unknown> & { __get(n: string): unknown };
    const lookup = (fn: string) => {
      const f = exports[fn] ?? exports.__get(fn);
      return typeof f === "function" ? (f as (...a: unknown[]) => unknown) : null;
    };
    return {
      has: (fn) => !!lookup(fn),
      call: (fn, ...args) => lookup(fn)?.(...args),
      dispose() {},
    };
  },
};
