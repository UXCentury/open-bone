import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { askConfirm } from "../dialogs.tsx";
import { type Conflict, type Platform, type ShortcutDef, comboFromEvent, formatCombo, isDesktop, platform, shortcuts, shortcutsRev } from "../shortcuts/index.ts";
import { setShortcutsOpen } from "../shortcuts/actions.ts";

const SCOPE_NOTE: Record<ShortcutDef["scope"], string> = { global: "", editor: "", play: "in Play mode" };

const VIEW_KEY = "openbone.shortcutsView";
/** Which keyboard the reference shows: this computer's by default, remembered per browser. */
function readView(): Platform {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "mac" || v === "other") return v;
  } catch {
    /* private mode */
  }
  return platform;
}

/** Mouse-gesture text for a keyboard: "Alt + drag" is "⌥ Option + drag" on a Mac. */
const fixedFor = (text: string, view: Platform) => (view === "mac" ? text.replace(/\bAlt\b/g, "⌥ Option") : text);

/** Searchable reference of every shortcut, with rebinding (conflict-checked) saved to this browser. */
export function ShortcutsDialog() {
  const [query, setQuery] = createSignal("");
  const [view, setViewSignal] = createSignal<Platform>(readView());
  const setView = (v: Platform) => {
    setViewSignal(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode: just this session */
    }
  };
  /** A binding in the keys picked above (bindings are portable: Mod is ⌘ on a Mac, Ctrl elsewhere). */
  const fmt = (combo: string) => formatCombo(combo, view());
  /** Shortcut id waiting for a key press. */
  const [capturing, setCapturing] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<{ id: string; combo: string; conflicts: Conflict[] } | null>(null);
  let search!: HTMLInputElement;
  let box!: HTMLDivElement;
  const previousFocus = document.activeElement as HTMLElement | null;

  const close = () => setShortcutsOpen(false);

  // Search matches both keyboards, so "ctrl+s" and "⌘S" find the same shortcut.
  const keysText = (d: ShortcutDef) =>
    d.fixed ? `${d.fixed} ${fixedFor(d.fixed, "mac")}` : shortcuts.keysOf(d.id).flatMap((k) => [formatCombo(k, "mac"), formatCombo(k, "other")]).join(" ");
  const groups = createMemo(() => {
    shortcutsRev();
    const q = query().trim().toLowerCase();
    view();
    return shortcuts
      .groups()
      .map((g) => ({
        group: g.group,
        items: g.items.filter((d) => !q || `${d.label} ${g.group} ${keysText(d)} ${shortcuts.keysOf(d.id).join(" ")}`.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length);
  });
  const conflicts = createMemo(() => (shortcutsRev(), shortcuts.allConflicts()));
  const customized = createMemo(() => (shortcutsRev(), shortcuts.all().some((d) => shortcuts.isCustomized(d.id))));
  const labelOf = (id: string) => shortcuts.get(id)?.label ?? id;

  const commit = (id: string, combo: string, steal: boolean) => {
    try {
      shortcuts.addKey(id, combo, { steal });
    } catch (e) {
      console.warn(e);
    }
    setPending(null);
  };

  const key = (e: KeyboardEvent) => {
    // An in-app confirm dialog on top owns the keyboard.
    if (document.querySelector(".dialog-backdrop")) return;
    const cap = capturing();
    if (cap) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setCapturing(null);
      const combo = comboFromEvent(e, platform);
      if (!combo) return; // bare modifier: keep waiting
      setCapturing(null);
      const d = shortcuts.get(cap)!;
      if (shortcuts.keysOf(cap).includes(combo)) return;
      const c = shortcuts.conflicts(combo, d.scope, cap);
      if (c.length) setPending({ id: cap, combo, conflicts: c });
      else commit(cap, combo, false);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (pending()) setPending(null);
      else if (query()) setQuery("");
      else close();
    } else if (e.key === "Tab") {
      const items = [...box.querySelectorAll<HTMLElement>("input, button")].filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      if (e.shiftKey && document.activeElement === items[0]) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === items[items.length - 1]) {
        e.preventDefault();
        items[0].focus();
      }
    }
  };
  onMount(() => {
    window.addEventListener("keydown", key, true);
    search.focus();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", key, true);
    previousFocus?.focus?.();
  });

  const resetAll = async () => {
    const ok = await askConfirm({
      title: "Reset all shortcuts?",
      message: "Every shortcut goes back to its default keys. Your custom bindings will be removed.",
      confirmLabel: "Reset all",
      danger: true,
    });
    if (ok) shortcuts.resetAll();
  };

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} class="modal shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-title">
        <header class="modal-head">
          <h2 id="sc-title">Keyboard shortcuts</h2>
          <div class="seg-choice sc-os" role="group" aria-label="Show keys for">
            <button classList={{ active: view() === "other" }} aria-pressed={view() === "other"} onClick={() => setView("other")}>
              Windows / Linux
            </button>
            <button classList={{ active: view() === "mac" }} aria-pressed={view() === "mac"} onClick={() => setView("mac")}>
              macOS
            </button>
          </div>
          <span class="muted small">
            {view() === "mac" ? "⌘ Command, ⌥ Option, ⇧ Shift, ⌃ Control" : "Ctrl, Alt, Shift"}
            {view() !== platform ? ` · this computer uses ${platform === "mac" ? "macOS" : "Windows / Linux"} keys` : ""}
            {isDesktop ? " · desktop app" : ""}
          </span>
          <span class="spacer" />
          <button class="icon-btn" title="Close (Esc)" onClick={close}>
            ✕
          </button>
        </header>
        <div class="sc-search">
          <input ref={search} type="search" placeholder="Search shortcuts or keys…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} aria-label="Search shortcuts" />
        </div>
        <Show when={conflicts().length}>
          <div class="sc-warn" role="alert">
            <For each={conflicts()}>
              {(c) => (
                <div>
                  ⚠ <b>{fmt(c.key)}</b> is bound to both “{labelOf(c.a)}” and “{labelOf(c.b)}”. Only the first will run.
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="sc-body">
          <For each={groups()} fallback={<div class="muted sc-empty">No shortcuts match “{query()}”.</div>}>
            {(g) => (
              <section class="sc-group">
                <h3>{g.group}</h3>
                <For each={g.items}>
                  {(d) => (
                    <div class="sc-row" classList={{ customized: (shortcutsRev(), shortcuts.isCustomized(d.id)) }}>
                      <span class="sc-label">
                        {d.label}
                        <Show when={SCOPE_NOTE[d.scope]}>
                          <small class="muted"> · {SCOPE_NOTE[d.scope]}</small>
                        </Show>
                      </span>
                      <span class="sc-keys">
                        <Show
                          when={!d.fixed}
                          fallback={<span class="muted small">{fixedFor(d.fixed ?? "", view())}</span>}
                        >
                          <For each={(shortcutsRev(), shortcuts.keysOf(d.id))}>
                            {(k) => (
                              <span class="kbd-chip">
                                <kbd>{fmt(k)}</kbd>
                                <button class="chip-x" title={`Remove ${fmt(k)}`} aria-label={`Remove ${fmt(k)} from ${d.label}`} onClick={() => shortcuts.removeKey(d.id, k)}>
                                  ×
                                </button>
                              </span>
                            )}
                          </For>
                          <Show when={capturing() === d.id} fallback={
                            <button class="sc-add" title="Add a key" onClick={() => { setPending(null); setCapturing(d.id); }}>
                              +
                            </button>
                          }>
                            <span class="sc-capture" aria-live="polite">Press keys… (Esc cancels)</span>
                          </Show>
                          <Show when={(shortcutsRev(), shortcuts.isCustomized(d.id))}>
                            <button class="sc-reset" title="Reset to default" onClick={() => shortcuts.reset(d.id)}>
                              ↺
                            </button>
                          </Show>
                        </Show>
                      </span>
                      <Show when={pending()?.id === d.id && pending()}>
                        {(p) => (
                          <div class="sc-conflict" role="alert">
                            <b>{fmt(p().combo)}</b> is already used by {p().conflicts.map((c) => `“${c.label}”`).join(", ")}.
                            <button class="danger-btn" onClick={() => commit(d.id, p().combo, true)}>
                              Reassign
                            </button>
                            <button onClick={() => setPending(null)}>Cancel</button>
                          </div>
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
        <footer class="modal-foot">
          <span class="muted small">
            Click + and press a key to add a binding. Saved in this browser. Shortcuts don't fire while you type in a field.
          </span>
          <span class="spacer" />
          <button disabled={!customized()} onClick={resetAll}>
            Reset all to defaults
          </button>
          <button class="primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
