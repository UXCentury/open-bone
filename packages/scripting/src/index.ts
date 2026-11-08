import type { ScriptApi, ScriptHandle, ScriptHost } from "@openbone/runtime";
import { type QuickJSWASMModule, getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

export interface QuickJsHostOptions {
  /** Per-call CPU budget in ms (default 16). */
  timeoutMs?: number;
  /** Heap limit per script in bytes (default 8 MB). */
  memoryLimit?: number;
  /** Pre-loaded QuickJS module (otherwise loaded once lazily). */
  module?: QuickJSWASMModule;
}

const API_METHODS = ["time", "input", "setInput", "fire", "emit", "bone", "setBone", "slot", "pointer", "log"] as const;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const PRELUDE = `
const ob = Object.freeze(Object.fromEntries(${JSON.stringify(API_METHODS)}.map(m => [m, (...a) => {
  const r = __ob(m, JSON.stringify(a));
  return r === undefined ? undefined : JSON.parse(r);
}])));
const console = { log: (...a) => ob.log(...a) };
`;

/**
 * Sandboxed script engine: each script gets its own QuickJS runtime with a memory cap and
 * a CPU deadline per call. Scripts only see the `ob` API — no DOM, network or host globals.
 */
export async function createQuickJsHost(opts: QuickJsHostOptions = {}): Promise<ScriptHost> {
  const QuickJS = opts.module ?? (await getQuickJS());
  const timeout = opts.timeoutMs ?? 16;
  return {
    load(script, api: ScriptApi): ScriptHandle {
      const rt = QuickJS.newRuntime();
      rt.setMemoryLimit(opts.memoryLimit ?? 8 * 1024 * 1024);
      rt.setMaxStackSize(512 * 1024);
      const vm = rt.newContext();
      const bridge = vm.newFunction("__ob", (mH, aH) => {
        const method = vm.getString(mH) as (typeof API_METHODS)[number];
        const args = JSON.parse(vm.getString(aH)) as unknown[];
        if (!API_METHODS.includes(method)) return vm.undefined;
        const fn = api[method] as (...a: unknown[]) => unknown;
        const out = fn(...args);
        return out === undefined ? vm.undefined : vm.newString(JSON.stringify(out));
      });
      vm.setProp(vm.global, "__ob", bridge);
      bridge.dispose();
      const run = (code: string, name: string) => {
        rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + Math.max(timeout, 50)));
        const r = vm.evalCode(code, name);
        if (r.error) {
          const err = vm.dump(r.error);
          r.error.dispose();
          throw new Error(`[script ${script.name}] ${typeof err === "object" && err ? `${err.name}: ${err.message}` : String(err)}`);
        }
        const v = vm.dump(r.value);
        r.value.dispose();
        return v;
      };
      run(PRELUDE, "prelude.js");
      run(script.code, `${script.name}.js`);
      const has = (fn: string) => IDENT.test(fn) && run(`typeof ${fn} === "function"`, "has.js") === true;
      const known = new Map<string, boolean>();
      let disposed = false;
      return {
        has(fn) {
          if (disposed) return false;
          if (!known.has(fn)) known.set(fn, has(fn));
          return known.get(fn)!;
        },
        call(fn, ...args) {
          if (disposed || !IDENT.test(fn)) return undefined;
          const argStr = vm.newString(JSON.stringify(args));
          vm.setProp(vm.global, "__args", argStr);
          argStr.dispose();
          rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeout));
          const r = vm.evalCode(`${fn}(...JSON.parse(__args))`, "call.js");
          if (r.error) {
            const err = vm.dump(r.error);
            r.error.dispose();
            throw new Error(`[script ${script.name}.${fn}] ${typeof err === "object" && err ? `${err.name}: ${err.message}` : String(err)}`);
          }
          const v = vm.dump(r.value);
          r.value.dispose();
          return v;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          vm.dispose();
          rt.dispose();
        },
      };
    },
  };
}

export type { ScriptApi, ScriptHandle, ScriptHost };
