import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { selectionItems } from "../editor-menus.ts";
import { type MenuItem, runShortcut } from "../menu.tsx";
import { DEFAULT_SHORTCUTS } from "../shortcuts/defaults.ts";
import { kbd, shortcuts } from "../shortcuts/index.ts";

/**
 * Command palette (Ctrl/⌘+K): search every editor action by name and run it. Lists the registered shortcuts (with
 * their keys) and the right-click actions for the current selection, so things that live in menus or the Inspector
 * can be found by typing what you want ("trace", "flip", "lock", "export").
 */
export const [paletteOpen, setPaletteOpen] = createSignal(false);

interface Command {
  label: string;
  group: string;
  keys: string;
  run: () => void;
}

function selectionCommands(): Command[] {
  const out: Command[] = [];
  const walk = (items: MenuItem[], path: string[]) => {
    for (const it of items) {
      if (it === "sep" || it.disabled) continue;
      if (it.submenu) walk(it.submenu, [...path, it.label]);
      else if (it.action || it.shortcut) {
        const sc = it.shortcut;
        const act = it.action;
        out.push({ label: [...path, it.label].join(" › "), group: "Selection", keys: sc ? kbd(sc) : "", run: () => (act ? void act() : runShortcut(sc!)) });
      }
    }
  };
  walk(selectionItems(), []);
  return out;
}

function allCommands(): Command[] {
  const registry = DEFAULT_SHORTCUTS.filter((d) => shortcuts.get(d.id)?.action && d.scope !== "play" && d.id !== "help.palette").map((d) => ({
    label: d.label,
    group: d.group,
    keys: kbd(d.id),
    run: () => runShortcut(d.id),
  }));
  return [...selectionCommands(), ...registry];
}

export function CommandPalette() {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const commands = allCommands();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const results = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands;
    const hits = commands.filter((c) => {
      const hay = `${c.label} ${c.group}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // Names that start with what was typed first.
    return hits.sort((a, b) => Number(!a.label.toLowerCase().startsWith(words[0])) - Number(!b.label.toLowerCase().startsWith(words[0])));
  });
  const close = () => setPaletteOpen(false);
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    // After the palette has closed, so actions that open dialogs or need the viewport focus work as usual.
    queueMicrotask(c.run);
  };
  const move = (by: number) => {
    const n = results().length;
    if (!n) return;
    const i = (active() + by + n) % n;
    setActive(i);
    list.querySelectorAll<HTMLElement>(".palette-item")[i]?.scrollIntoView({ block: "nearest" });
  };
  onMount(() => input.focus());
  return (
    <div class="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          class="palette-input"
          placeholder="Search actions… (e.g. trace, flip, lock, export)"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), move(1));
            else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
            else if (e.key === "Enter") (e.preventDefault(), run(results()[active()]));
            else if (e.key === "Escape") (e.preventDefault(), close());
            e.stopPropagation();
          }}
        />
        <div class="palette-list" ref={list}>
          <For each={results()} fallback={<div class="muted small palette-empty">No action matches “{query()}”</div>}>
            {(c, i) => (
              <div class="palette-item" classList={{ active: i() === active() }} onPointerEnter={() => setActive(i())} onClick={() => run(c)}>
                <span class="palette-label">{c.label}</span>
                <span class="palette-group">{c.group}</span>
                <Show when={c.keys}>
                  <kbd class="palette-keys">{c.keys}</kbd>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
