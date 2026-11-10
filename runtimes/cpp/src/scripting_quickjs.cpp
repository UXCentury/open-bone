// Script host on embedded QuickJS (quickjs-ng, MIT): the same sandbox as packages/scripting (one runtime per script,
// memory cap, CPU deadline per call, JSON across the boundary, only the `ob` global).
// SPDX-License-Identifier: MIT
#include <chrono>
#include <stdexcept>

#include "internal.hpp"

#if OPENBONE_WITH_SCRIPTS
extern "C" {
// QuickJS's header trips conversion warnings (MSVC C4244, Clang -Wshorten-64-to-32 on Apple builds); they are
// upstream's, so hide every warning for this include only.
#if defined(_MSC_VER)
#pragma warning(push, 0)
#elif defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif
#include "quickjs.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#elif defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
}
#endif

namespace openbone {

#if OPENBONE_WITH_SCRIPTS

namespace {

const char* PRELUDE = R"JS(
const ob = Object.freeze(Object.fromEntries(["time","input","setInput","fire","emit","bone","setBone","slot","pointer","log"].map(m => [m, (...a) => {
  const r = __ob(m, JSON.stringify(a));
  return r === undefined ? undefined : JSON.parse(r);
}])));
const console = { log: (...a) => ob.log(...a) };
)JS";

bool isIdent(const std::string& s) {
  if (s.empty()) return false;
  auto start = [](unsigned char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$'; };
  if (!start(s[0])) return false;
  for (unsigned char c : s)
    if (!(start(c) || (c >= '0' && c <= '9'))) return false;
  return true;
}

using Clock = std::chrono::steady_clock;

class QuickJsHandle final : public ScriptHandle {
 public:
  QuickJsHandle(const ScriptData& script, ScriptApi api, double timeoutMs, size_t memoryLimit) : name(script.name), api(std::move(api)), timeout(timeoutMs) {
    rt = JS_NewRuntime();
    if (!rt) throw std::runtime_error("QuickJS: out of memory");
    JS_SetMemoryLimit(rt, memoryLimit);
    JS_SetMaxStackSize(rt, 512 * 1024);
    JS_SetInterruptHandler(rt, &QuickJsHandle::interrupt, this);
    ctx = JS_NewContext(rt);
    if (!ctx) {
      JS_FreeRuntime(rt);
      throw std::runtime_error("QuickJS: out of memory");
    }
    JS_SetContextOpaque(ctx, this);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__ob", JS_NewCFunction(ctx, &QuickJsHandle::bridge, "__ob", 2));
    JS_FreeValue(ctx, global);
    try {
      run(PRELUDE, "prelude.js", std::max(timeout, 50.0), "");
      run(script.code, name + ".js", std::max(timeout, 50.0), "");
    } catch (...) {
      destroy();
      throw;
    }
  }
  ~QuickJsHandle() override { destroy(); }

  bool has(const std::string& fn) override {
    if (!ctx || !isIdent(fn)) return false;
    auto it = known.find(fn);
    if (it != known.end()) return it->second;
    bool r = false;
    JSValue v = eval("typeof " + fn + " === \"function\"", "has.js", std::max(timeout, 50.0));
    if (JS_IsException(v)) {
      JS_FreeValue(ctx, JS_GetException(ctx));
    } else
      r = JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    known[fn] = r;
    return r;
  }

  void call(const std::string& fn, const std::string& argsJson) override {
    if (!ctx || !isIdent(fn)) return;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__args", JS_NewStringLen(ctx, argsJson.data(), argsJson.size()));
    JS_FreeValue(ctx, global);
    run(fn + "(...JSON.parse(__args))", "call.js", timeout, "." + fn);
  }

 private:
  std::string name;
  ScriptApi api;
  double timeout;
  JSRuntime* rt = nullptr;
  JSContext* ctx = nullptr;
  Clock::time_point deadline;
  std::unordered_map<std::string, bool> known;

  void destroy() {
    if (ctx) JS_FreeContext(ctx);
    if (rt) JS_FreeRuntime(rt);
    ctx = nullptr;
    rt = nullptr;
  }

  static int interrupt(JSRuntime*, void* opaque) {
    auto* self = static_cast<QuickJsHandle*>(opaque);
    return Clock::now() > self->deadline ? 1 : 0;
  }

  JSValue eval(const std::string& code, const std::string& file, double ms) {
    deadline = Clock::now() + std::chrono::microseconds((long long)(ms * 1000));
    return JS_Eval(ctx, code.c_str(), code.size(), file.c_str(), JS_EVAL_TYPE_GLOBAL);
  }

  std::string describe(JSValue exc) {
    std::string msg;
    if (JS_IsError(ctx, exc)) {
      JSValue n = JS_GetPropertyStr(ctx, exc, "name");
      JSValue m = JS_GetPropertyStr(ctx, exc, "message");
      const char* ns = JS_ToCString(ctx, n);
      const char* ms = JS_ToCString(ctx, m);
      msg = std::string(ns ? ns : "Error") + ": " + (ms ? ms : "");
      if (ns) JS_FreeCString(ctx, ns);
      if (ms) JS_FreeCString(ctx, ms);
      JS_FreeValue(ctx, n);
      JS_FreeValue(ctx, m);
    } else {
      const char* s = JS_ToCString(ctx, exc);
      msg = s ? s : "error";
      if (s) JS_FreeCString(ctx, s);
    }
    return msg;
  }

  void run(const std::string& code, const std::string& file, double ms, const std::string& what) {
    JSValue v = eval(code, file, ms);
    if (JS_IsException(v)) {
      JSValue exc = JS_GetException(ctx);
      const std::string msg = describe(exc);
      JS_FreeValue(ctx, exc);
      JS_FreeValue(ctx, v);
      throw std::runtime_error("[script " + name + what + "] " + msg);
    }
    JS_FreeValue(ctx, v);
  }

  static JSValue bridge(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    auto* self = static_cast<QuickJsHandle*>(JS_GetContextOpaque(ctx));
    if (argc < 2) return JS_UNDEFINED;
    const char* m = JS_ToCString(ctx, argv[0]);
    const char* a = JS_ToCString(ctx, argv[1]);
    std::string method = m ? m : "", args = a ? a : "[]";
    if (m) JS_FreeCString(ctx, m);
    if (a) JS_FreeCString(ctx, a);
    try {
      const std::optional<std::string> r = self->api(method, args);
      if (!r) return JS_UNDEFINED;
      return JS_NewStringLen(ctx, r->data(), r->size());
    } catch (const std::exception& e) {
      return JS_ThrowInternalError(ctx, "%s", e.what());
    }
  }
};

class QuickJsHost final : public ScriptHost {
 public:
  QuickJsHost(double t, size_t m) : timeout(t), memory(m) {}
  std::unique_ptr<ScriptHandle> load(const ScriptData& script, ScriptApi api) override {
    return std::make_unique<QuickJsHandle>(script, std::move(api), timeout, memory);
  }

 private:
  double timeout;
  size_t memory;
};

}  // namespace

std::shared_ptr<ScriptHost> createQuickJsHost(double timeoutMs, size_t memoryLimit) { return std::make_shared<QuickJsHost>(timeoutMs, memoryLimit); }

#else

std::shared_ptr<ScriptHost> createQuickJsHost(double, size_t) { return nullptr; }

#endif

}  // namespace openbone
