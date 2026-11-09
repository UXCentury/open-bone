package com.openbone.scripting

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import com.openbone.runtime.Json
import com.openbone.runtime.ScriptApi
import com.openbone.runtime.ScriptHandle
import com.openbone.runtime.ScriptHost
import com.openbone.runtime.data.ScriptData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Sandboxed script engine for state machine scripts: each script gets its own QuickJS runtime (the engine the
 * TypeScript reference uses) with a memory cap and a CPU deadline per call. Scripts see only the `ob` API and
 * `console.log`. Arguments and results cross the boundary as JSON, exactly like `@openbone/scripting`.
 *
 * Runs on desktop JVMs (bundled natives for Linux, macOS and Windows) and on Android.
 */
class QuickJsScriptHost @JvmOverloads constructor(
  /** Per-call CPU budget in ms (default 16). */
  private val timeoutMs: Long = 16,
  /** Heap limit per script in bytes (default 8 MB). */
  private val memoryLimit: Long = 8L * 1024 * 1024,
) : ScriptHost {

  override fun load(script: ScriptData, api: ScriptApi): ScriptHandle {
    val js = QuickJs.create(Dispatchers.Unconfined)
    js.memoryLimit = memoryLimit
    js.maxStackSize = 512L * 1024
    var args = "[]"
    js.function("__ob") { a ->
      val method = a.getOrNull(0) as? String ?: return@function null
      if (method !in ScriptApi.METHODS) return@function null
      @Suppress("UNCHECKED_CAST")
      val list = Json.parse(a.getOrNull(1) as? String ?: "[]") as List<Any?>
      val out = api.call(method, list)
      if (out === Json.Undefined.INSTANCE) null else Json.stringify(out)
    }
    js.function("__args") { args }
    fun run(code: String, name: String, timeout: Long): Any? = try {
      js.evaluationTimeoutMillis = timeout
      runBlocking { js.evaluate<Any?>(code, name) }
    } catch (e: Exception) {
      throw RuntimeException("[script ${script.name}] ${e.message}", e)
    }
    try {
      run(ScriptHost.PRELUDE, "prelude.js", maxOf(timeoutMs, 50))
      run(script.code, "${script.name}.js", maxOf(timeoutMs, 50))
    } catch (e: Exception) {
      js.close()
      throw e
    }
    val known = HashMap<String, Boolean>()
    var disposed = false
    return object : ScriptHandle {
      override fun has(fn: String): Boolean {
        if (disposed) return false
        return known.getOrPut(fn) { IDENT.matches(fn) && run("typeof $fn === \"function\"", "has.js", maxOf(timeoutMs, 50)) == true }
      }

      override fun call(fn: String, vararg a: Any?): Any? {
        if (disposed || !IDENT.matches(fn)) return null
        args = Json.stringify(a.toList())
        val r = try {
          run("(() => { const r = $fn(...JSON.parse(__args())); return r === undefined ? undefined : JSON.stringify(r); })()", "call.js", timeoutMs)
        } catch (e: RuntimeException) {
          throw RuntimeException("[script ${script.name}.$fn] ${e.cause?.message ?: e.message}", e)
        }
        return (r as? String)?.let { Json.parse(it) }
      }

      override fun dispose() {
        if (disposed) return
        disposed = true
        js.close()
      }
    }
  }

  private companion object {
    val IDENT = Regex("^[A-Za-z_$][\\w$]*$")
  }
}
