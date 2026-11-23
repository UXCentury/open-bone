import { type Issue, findProblems } from "@openbone/core";
import { For, Show, createMemo, createRoot, createSignal } from "solid-js";
import { showPanel } from "../layout.ts";
import { doc, setAnimationId, setMode, setSelection, store, toast } from "../state.ts";

type Problem = Issue & { hint?: boolean };

/** Every problem of the open document, kept up to date for the panel and the tab badge. */
const all = createRoot(() => createMemo<Problem[]>(() => findProblems(doc())));
/** Error count for the tab badge. */
export const problemErrors = () => all().filter((p) => p.level === "error").length;

const ICON = { error: "⛔", warning: "⚠", hint: "💡" } as const;
const levelOf = (p: Problem) => (p.hint ? "hint" : p.level);

/** Select what a problem is about, and show where it is edited. */
function reveal(p: Problem) {
  const r = p.ref;
  if (!r) return;
  if (r.kind === "animation") {
    setAnimationId(r.id);
    setMode("animate");
    showPanel("timeline");
    return;
  }
  setSelection({ kind: r.kind, id: r.id } as Parameters<typeof setSelection>[0] & object);
  showPanel("inspector");
}

function fix(p: Problem) {
  if (!p.fix) return;
  try {
    store.transaction(p.fix.label, (s) => s.apply(p.fix!.op, p.fix!.args));
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** Apply every available fix in one undo step, re-checking after each (a fix can make another one moot). */
function fixAll() {
  let applied = 0;
  try {
    store.transaction("Fix all problems", (s) => {
      const tried = new Set<string>();
      for (let guard = 0; guard < 500; guard++) {
        const next = findProblems(s.doc).find((p) => p.fix && !tried.has(`${p.path}|${p.message}|${p.fix.label}`));
        if (!next) break;
        tried.add(`${next.path}|${next.message}|${next.fix!.label}`);
        try {
          s.apply(next.fix!.op, next.fix!.args);
          applied++;
        } catch {
          // Stale fix (its target went away with an earlier one): skip it.
        }
      }
    });
  } catch (e) {
    toast((e as Error).message, "error");
  }
  toast(applied ? `Applied ${applied} fix${applied === 1 ? "" : "es"}` : "Nothing to fix automatically");
}

/** Bottom-dock panel: broken references, warnings and hints for the whole project, with one-click fixes. */
export function ProblemsPanel() {
  const [filter, setFilter] = createSignal<"all" | "error" | "warning" | "hint">("all");
  const shown = createMemo(() => (filter() === "all" ? all() : all().filter((p) => levelOf(p) === filter())));
  const count = (l: "error" | "warning" | "hint") => all().filter((p) => levelOf(p) === l).length;
  const fixable = () => all().filter((p) => p.fix).length;
  return (
    <div class="problems-panel">
      <div class="problems-head">
        <For each={["all", "error", "warning", "hint"] as const}>
          {(f) => (
            <button classList={{ active: filter() === f }} onClick={() => setFilter(f)}>
              {f === "all" ? `All ${all().length}` : `${ICON[f]} ${count(f)}`}
            </button>
          )}
        </For>
        <span class="spacer" />
        <button disabled={!fixable()} title="Apply every one-click fix (one undo step)" onClick={fixAll}>
          Fix all ({fixable()})
        </button>
      </div>
      <Show when={shown().length} fallback={<div class="muted pad">{all().length ? "Nothing in this filter." : "No problems found."}</div>}>
        <div class="problems-list" role="list">
          <For each={shown()}>
            {(p) => (
              <div
                class="problem-row"
                role="listitem"
                classList={{ clickable: !!p.ref, [levelOf(p)]: true }}
                title={p.ref ? "Click to select it" : undefined}
                onClick={() => reveal(p)}
              >
                <span class="problem-icon" aria-label={levelOf(p)}>{ICON[levelOf(p)]}</span>
                <span class="problem-where">{p.path}</span>
                <span class="problem-msg">{p.message}</span>
                <Show when={p.fix}>
                  <button
                    class="problem-fix"
                    onClick={(e) => {
                      e.stopPropagation();
                      fix(p);
                    }}
                  >
                    {p.fix!.label}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
