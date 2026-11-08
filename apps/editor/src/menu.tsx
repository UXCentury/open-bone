import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { shortcuts, kbd, isTypingTarget } from "./shortcuts/index.ts";

/**
 * Editor menus: the toolbar's Menu button and the right-click context menu share this popup (items, separators,
 * submenus, check marks and shortcut hints). The browser's own context menu stays only in text fields.
 */

export type MenuItem =
  | "sep"
  | {
      label: string;
      /** Shortcut id: its key is shown on the right, and it runs that action when no `action` is given. */
      shortcut?: string;
      action?: () => unknown;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      submenu?: MenuItem[];
    };

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  /** Element the menu belongs to (the Menu button): clicking it again closes the menu. */
  owner?: HTMLElement;
}

const [menu, setMenu] = createSignal<OpenMenu | null>(null);
export const menuOpen = () => menu() !== null;
export const closeMenu = () => setMenu(null);
export const menuOwner = () => menu()?.owner;

export function openMenu(x: number, y: number, items: MenuItem[], owner?: HTMLElement) {
  const list = trimSeparators(items);
  if (list.length) setMenu({ x, y, items: list, owner });
}

/** Run a registered shortcut's action as if its key were pressed. */
export function runShortcut(id: string) {
  shortcuts.get(id)?.action?.({ key: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false } as never);
}

function trimSeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it === "sep" && (out.length === 0 || out[out.length - 1] === "sep")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "sep") out.pop();
  return out;
}

function MenuList(p: { items: MenuItem[]; x: number; y: number; sub?: boolean }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: p.x, y: p.y });
  const [openSub, setOpenSub] = createSignal<number | null>(null);
  const [subAt, setSubAt] = createSignal({ x: 0, y: 0 });
  onMount(() => {
    // Keep the popup on screen: flip left of the parent for submenus, shift up/left near the edges.
    const r = el.getBoundingClientRect();
    let { x, y } = pos();
    if (x + r.width > innerWidth - 4) x = p.sub ? Math.max(4, x - r.width - (el.parentElement?.getBoundingClientRect().width ?? 0)) : Math.max(4, innerWidth - r.width - 4);
    if (y + r.height > innerHeight - 4) y = Math.max(4, innerHeight - r.height - 4);
    setPos({ x, y });
  });
  return (
    <div ref={el} class="menu-popup" role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <For each={p.items}>
        {(it, i) =>
          it === "sep" ? (
            <div class="menu-sep" role="separator" />
          ) : (
            <button
              class="menu-item"
              role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked}
              classList={{ danger: it.danger, "has-sub": !!it.submenu, open: openSub() === i() }}
              disabled={it.disabled}
              onPointerEnter={(e) => {
                if (!it.submenu) return setOpenSub(null);
                const r = e.currentTarget.getBoundingClientRect();
                setSubAt({ x: r.right - 2, y: r.top - 4 });
                setOpenSub(i());
              }}
              onClick={(e) => {
                if (it.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSubAt({ x: r.right - 2, y: r.top - 4 });
                  setOpenSub(openSub() === i() ? null : i());
                  return;
                }
                closeMenu();
                if (it.action) it.action();
                else if (it.shortcut) runShortcut(it.shortcut);
              }}
            >
              <span class="menu-check">{it.checked ? "✓" : ""}</span>
              <span class="menu-label">{it.label}</span>
              <span class="menu-kbd">{it.submenu ? "▸" : it.shortcut ? kbd(it.shortcut) : ""}</span>
              <Show when={it.submenu && openSub() === i()}>
                <MenuList items={trimSeparators(it.submenu!)} x={subAt().x} y={subAt().y} sub />
              </Show>
            </button>
          )
        }
      </For>
    </div>
  );
}

/** Mount once at the app root: renders the open menu and turns right-clicks into editor context menus. */
export function MenuHost(p: { contextItems: (target: HTMLElement) => MenuItem[] | null }) {
  onMount(() => {
    // Right-drag pans the viewport, so a menu only opens when the right button was released close to where it went
    // down. Linux and macOS fire contextmenu on press, Windows on release: handle both.
    let down: { x: number; y: number; target: HTMLElement } | null = null;
    let pending: HTMLElement | null = null;
    const show = (target: HTMLElement, x: number, y: number) => {
      const items = p.contextItems(target);
      if (items) openMenu(x, y, items);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (menu() && !t.closest?.(".menu-popup") && !(menu()!.owner && menu()!.owner!.contains(t))) closeMenu();
      if (e.button === 2) {
        down = { x: e.clientX, y: e.clientY, target: t };
        pending = null;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 2 || !down) return;
      const near = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      if (pending && near) show(pending, e.clientX, e.clientY);
      pending = null;
      down = null;
    };
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (isTypingTarget(t) || t.closest?.("[contenteditable='true']")) return; // copy / paste stay native
      e.preventDefault();
      if (t.closest?.(".menu-popup")) return;
      if (down && e.buttons & 2) pending = t; // still pressed: decide on release
      else if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) show(t, e.clientX, e.clientY);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu()) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    };
    const onBlur = () => closeMenu();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    });
  });
  return (
    <Show when={menu()} keyed>
      {(m) => (
        <Portal>
          <div class="menu-layer">
            <MenuList items={m.items} x={m.x} y={m.y} />
          </div>
        </Portal>
      )}
    </Show>
  );
}
