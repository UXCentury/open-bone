import { createSignal } from "solid-js";
import { DEFAULT_SHORTCUTS } from "./defaults.ts";
import { type Scope, ShortcutRegistry, type StorageLike, detectPlatform, formatCombo, isTypingTarget } from "./keymap.ts";

export * from "./keymap.ts";

function safeStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    s.getItem("openbone.probe");
    return s;
  } catch {
    return null;
  }
}

export const platform = detectPlatform();
export const isMac = platform === "mac";
/** Running inside the Tauri desktop shell (apps/desktop). */
export const isDesktop = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** The editor's shortcut registry (bindings persist in localStorage). */
export const shortcuts = new ShortcutRegistry(platform, safeStorage());
shortcuts.register(DEFAULT_SHORTCUTS.map((d) => ({ ...d })));

const [rev, setRev] = createSignal(0);
shortcuts.subscribe(() => setRev((r) => r + 1));
/** Reactive version counter: changes whenever a binding changes. */
export const shortcutsRev = rev;

/** Reactive label of a shortcut's primary key ("⌘S" / "Ctrl+S"), empty when unbound. */
export const kbd = (id: string) => (rev(), shortcuts.label(id));
/** Reactive tooltip: "Save (⌘S)". */
export const tip = (text: string, id: string) => (rev(), shortcuts.title(text, id));
/** Format a portable binding for this OS. */
export const fmt = (combo: string) => formatCombo(combo, platform);

/** True while a modal dialog is open: global shortcuts stay quiet so the dialog owns the keyboard. */
export const modalOpen = () => !!document.querySelector(".modal-backdrop, [aria-modal='true']");

/**
 * Install the global keydown dispatcher. `scopes()` returns the scopes active right now (e.g. editor vs play).
 * Returns a disposer.
 */
export function installShortcuts(scopes: () => Scope[]): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (modalOpen()) return;
    const target = (e.target as HTMLElement | null) ?? null;
    const active = document.activeElement as HTMLElement | null;
    const typing = isTypingTarget(target) || isTypingTarget(active);
    // A focused button handles Space/Enter itself.
    if ((e.key === " " || e.key === "Enter") && !e.ctrlKey && !e.metaKey && target?.closest?.("button, a[href], [role='button'], summary")) return;
    const id = shortcuts.dispatch(e, scopes(), typing);
    if (id) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
