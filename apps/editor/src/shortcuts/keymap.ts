/**
 * Keyboard shortcut registry: pure logic (no DOM, no Solid) so it can be unit-tested.
 *
 * Bindings are written in a portable form: `Mod+Shift+Z`. `Mod` means ⌘ on macOS and Ctrl on Windows/Linux, so
 * one default works everywhere. `Ctrl` is the Control key on every OS (on Windows/Linux it is the same as Mod).
 * Keys: letters A–Z, digits, punctuation as typed (`,` `.` `/` `?` `[` `=` `-`), `Plus` for `+`, and named keys
 * (`Space`, `Enter`, `Escape`, `Delete`, `Backspace`, `Tab`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowLeft`…,
 * `F1`–`F12`).
 */

export type Platform = "mac" | "other";

export interface Combo {
  mod: boolean;
  /** The Control key as a separate modifier (macOS only; folded into `mod` elsewhere). */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** Where a shortcut is active. `global` works everywhere, `editor` only while editing, `play` only in Play mode. */
export type Scope = "global" | "editor" | "play";

export interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  /** Default bindings in portable form; the first is the one shown in tooltips. */
  keys: string[];
  scope: Scope;
  /** Extra help text in the reference. */
  description?: string;
  /** Runs the shortcut. Return `false` to let the key fall through (e.g. not applicable right now). */
  action?: (e: KeyEventLike) => unknown;
  /** Fire on auto-repeat while the key is held (default false, except arrows / frame stepping). */
  repeat?: boolean;
  /** Fires even when focus is in a text field (only for modifier shortcuts like Save). */
  inInputs?: boolean;
  /** Mouse gestures and other fixed bindings: shown in the reference, not rebindable (keys must be empty). */
  fixed?: string;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

// ---------------------------------------------------------------- platform

export function detectPlatform(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined = globalThis.navigator): Platform {
  const p = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(p) ? "mac" : "other";
}

// ---------------------------------------------------------------- keys

const NAMED: Record<string, string> = {
  space: "Space",
  " ": "Space",
  spacebar: "Space",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  tab: "Tab",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  plus: "Plus",
  "+": "Plus",
};

/** Canonical key name, or null if the key is not bindable (bare modifiers, dead keys, unknown). */
export function normalizeKey(k: string): string | null {
  if (!k) return null;
  const named = NAMED[k.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  if (k.length === 1) {
    if (/[a-z]/i.test(k)) return k.toUpperCase();
    if (/[0-9`~!@#$%^&*()\-_=[\]{};:'",.<>/?\\|]/.test(k)) return k;
  }
  return null;
}

const CODE_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "Plus",
  NumpadSubtract: "-",
  NumpadDecimal: ".",
  NumpadEnter: "Enter",
  Space: "Space",
};

function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1];
  return CODE_KEYS[code] ?? null;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn", "Hyper", "Super"]);

// ---------------------------------------------------------------- parse / serialize / format

/** Parse a portable binding (`Mod+Shift+Z`, `Ctrl+Alt+1`, `?`, `Shift+,`). Throws on garbage. */
export function parseCombo(s: string, platform: Platform = "other"): Combo {
  const parts = s.trim().split("+");
  // A trailing "+" (e.g. "Mod++") means the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "Plus");
  const c: Combo = { mod: false, ctrl: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const l = p.toLowerCase();
    const last = i === parts.length - 1;
    if (!last && (l === "mod" || l === "cmdorctrl" || l === "commandorcontrol")) c.mod = true;
    else if (!last && (l === "cmd" || l === "command" || l === "meta" || l === "⌘")) {
      // ⌘ only exists on macOS; on other systems treat it as the platform's main modifier.
      c.mod = true;
    } else if (!last && (l === "ctrl" || l === "control" || l === "⌃")) {
      if (platform === "mac") c.ctrl = true;
      else c.mod = true;
    } else if (!last && (l === "alt" || l === "option" || l === "opt" || l === "⌥")) c.alt = true;
    else if (!last && (l === "shift" || l === "⇧")) c.shift = true;
    else if (last) {
      const k = normalizeKey(p);
      if (!k) throw new Error(`Unknown key "${p}" in "${s}"`);
      c.key = k;
    } else throw new Error(`Unknown modifier "${p}" in "${s}"`);
  }
  if (!c.key) throw new Error(`No key in "${s}"`);
  return c;
}

/** Canonical portable string for a combo: modifiers in a fixed order (Mod, Ctrl, Alt, Shift). */
export function comboToString(c: Combo): string {
  return [c.mod && "Mod", c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("+");
}

/** Canonical form of a binding string for this platform (so "ctrl+z" and "Mod+Z" compare equal off macOS). */
export const canonical = (s: string, platform: Platform = "other") => comboToString(parseCombo(s, platform));

const MAC_KEY: Record<string, string> = {
  Enter: "↩",
  Escape: "⎋",
  Delete: "⌦",
  Backspace: "⌫",
  Tab: "⇥",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Space: "Space",
  Plus: "+",
};
const PC_KEY: Record<string, string> = {
  Escape: "Esc",
  Delete: "Del",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Plus: "+",
};

/** Human label: `⌘⇧Z` on macOS, `Ctrl+Shift+Z` elsewhere. */
export function formatCombo(s: string | Combo, platform: Platform): string {
  const c = typeof s === "string" ? parseCombo(s, platform) : s;
  if (platform === "mac") return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}${MAC_KEY[c.key] ?? c.key}`;
  return [c.mod && "Ctrl", c.alt && "Alt", c.shift && "Shift", PC_KEY[c.key] ?? c.key].filter(Boolean).join("+");
}

/**
 * Bindings a key event can match, best first. The first comes from the produced character (layout-aware: "?" on
 * any keyboard, Shift dropped for symbols since the symbol already says it); the second from the physical key
 * (`Shift+,`, and letters when Option on macOS turns them into other characters).
 */
export function eventCombos(e: KeyEventLike, platform: Platform): string[] {
  if (MODIFIER_KEYS.has(e.key)) return [];
  const mods = {
    mod: platform === "mac" ? e.metaKey : e.ctrlKey || e.metaKey,
    ctrl: platform === "mac" ? e.ctrlKey : false,
    alt: e.altKey,
  };
  const out: string[] = [];
  const add = (c: Combo) => {
    const s = comboToString(c);
    if (!out.includes(s)) out.push(s);
  };
  const k = normalizeKey(e.key);
  if (k) {
    const symbol = k.length === 1 && !/[A-Z0-9]/.test(k);
    // With Alt (Option) held, macOS produces special characters ("å", "¬"): rely on the physical key instead.
    if (!(e.altKey && symbol && platform === "mac")) add({ ...mods, shift: symbol ? false : e.shiftKey, key: k });
  }
  const pk = keyFromCode(e.code);
  if (pk) add({ ...mods, shift: e.shiftKey, key: pk });
  return out;
}

// ---------------------------------------------------------------- registry

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const STORAGE_KEY = "openbone.shortcuts.v1";

/** Scopes that can be active at the same time (and so must not share a key). */
export const scopesOverlap = (a: Scope, b: Scope) => a === b || a === "global" || b === "global";

export interface Conflict {
  id: string;
  label: string;
  key: string;
}

export class ShortcutRegistry {
  private defs = new Map<string, ShortcutDef>();
  /** User rebinding: id → bindings (empty = disabled). Only differences from the defaults are stored. */
  private overrides = new Map<string, string[]>();
  private listeners = new Set<() => void>();

  constructor(
    public platform: Platform = "other",
    private storage: StorageLike | null = null,
  ) {
    this.load();
  }

  register(def: ShortcutDef | ShortcutDef[]) {
    for (const d of Array.isArray(def) ? def : [def]) {
      if (this.defs.has(d.id)) throw new Error(`Shortcut "${d.id}" registered twice`);
      // Validate defaults early so typos fail loudly.
      d.keys.forEach((k) => parseCombo(k, this.platform));
      this.defs.set(d.id, d);
    }
    this.emit();
  }

  /** Replace the action of an already registered shortcut (components register handlers on mount). */
  bind(id: string, action: ShortcutDef["action"]): () => void {
    const d = this.defs.get(id);
    if (!d) throw new Error(`Unknown shortcut "${id}"`);
    const prev = d.action;
    d.action = action;
    return () => {
      if (d.action === action) d.action = prev;
    };
  }

  get(id: string) {
    return this.defs.get(id);
  }

  all(): ShortcutDef[] {
    return [...this.defs.values()];
  }

  groups(): { group: string; items: ShortcutDef[] }[] {
    const out: { group: string; items: ShortcutDef[] }[] = [];
    for (const d of this.defs.values()) {
      let g = out.find((x) => x.group === d.group);
      if (!g) out.push((g = { group: d.group, items: [] }));
      g.items.push(d);
    }
    return out;
  }

  /** Current bindings (canonical), after user overrides. */
  keysOf(id: string): string[] {
    const o = this.overrides.get(id);
    const d = this.defs.get(id);
    return (o ?? d?.keys ?? []).map((k) => canonical(k, this.platform));
  }

  isCustomized(id: string) {
    return this.overrides.has(id);
  }

  /** Label of the primary binding for tooltips, e.g. "⌘S" / "Ctrl+S"; empty when unbound. */
  label(id: string): string {
    const k = this.keysOf(id)[0];
    return k ? formatCombo(k, this.platform) : "";
  }

  /** "Save (⌘S)" style tooltip helper. */
  title(text: string, id: string): string {
    const l = this.label(id);
    return l ? `${text} (${l})` : text;
  }

  /** Other shortcuts that would fire for `key` in an overlapping scope. */
  conflicts(key: string, scope: Scope, exceptId?: string): Conflict[] {
    const k = canonical(key, this.platform);
    const out: Conflict[] = [];
    for (const d of this.defs.values()) {
      if (d.id === exceptId || !scopesOverlap(d.scope, scope)) continue;
      if (this.keysOf(d.id).includes(k)) out.push({ id: d.id, label: d.label, key: k });
    }
    return out;
  }

  /** Every pair of shortcuts sharing a key in overlapping scopes. */
  allConflicts(): { a: string; b: string; key: string }[] {
    const out: { a: string; b: string; key: string }[] = [];
    const list = this.all();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (!scopesOverlap(list[i].scope, list[j].scope)) continue;
        const kb = this.keysOf(list[j].id);
        for (const k of this.keysOf(list[i].id)) if (kb.includes(k)) out.push({ a: list[i].id, b: list[j].id, key: k });
      }
    return out;
  }

  /**
   * Set the bindings of a shortcut. With `steal`, the keys are removed from conflicting shortcuts; otherwise a
   * conflict throws. Persists to storage.
   */
  setKeys(id: string, keys: string[], opts: { steal?: boolean } = {}) {
    const d = this.defs.get(id);
    if (!d) throw new Error(`Unknown shortcut "${id}"`);
    const canon = [...new Set(keys.map((k) => canonical(k, this.platform)))];
    for (const k of canon) {
      const c = this.conflicts(k, d.scope, id);
      if (!c.length) continue;
      if (!opts.steal) throw new Error(`${formatCombo(k, this.platform)} is already used by "${c[0].label}"`);
      for (const other of c) this.writeKeys(other.id, this.keysOf(other.id).filter((x) => x !== k));
    }
    this.writeKeys(id, canon);
    this.save();
    this.emit();
  }

  addKey(id: string, key: string, opts: { steal?: boolean } = {}) {
    this.setKeys(id, [...this.keysOf(id), key], opts);
  }

  removeKey(id: string, key: string) {
    const k = canonical(key, this.platform);
    this.setKeys(id, this.keysOf(id).filter((x) => x !== k));
  }

  reset(id: string) {
    this.overrides.delete(id);
    this.save();
    this.emit();
  }

  resetAll() {
    this.overrides.clear();
    this.save();
    this.emit();
  }

  private writeKeys(id: string, keys: string[]) {
    const d = this.defs.get(id)!;
    const defaults = d.keys.map((k) => canonical(k, this.platform));
    if (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])) this.overrides.delete(id);
    else this.overrides.set(id, keys);
  }

  // ---- matching ----

  /** Shortcut ids bound to this event, in priority order (layout-aware candidate first). */
  match(e: KeyEventLike, activeScopes: Scope[]): ShortcutDef[] {
    const out: ShortcutDef[] = [];
    for (const combo of eventCombos(e, this.platform))
      for (const d of this.defs.values())
        if (activeScopes.includes(d.scope) && !out.includes(d) && this.keysOf(d.id).includes(combo)) out.push(d);
    return out;
  }

  /**
   * Run the first matching shortcut whose action accepts the event. Returns the id that ran, or null.
   * `typing` = focus is in a text field: only `inInputs` shortcuts fire.
   */
  dispatch(e: KeyEventLike, activeScopes: Scope[], typing = false): string | null {
    for (const d of this.match(e, activeScopes)) {
      if (!d.action) continue;
      if (typing && !d.inInputs) continue;
      if (e.repeat && !d.repeat) return d.id; // swallow held-key repeats of one-shot shortcuts
      if (d.action(e) !== false) return d.id;
    }
    return null;
  }

  // ---- persistence ----

  private load() {
    if (!this.storage) return;
    try {
      const raw = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "null") as unknown;
      if (!raw || typeof raw !== "object") return;
      for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(keys)) continue;
        const valid = keys.filter((k): k is string => {
          if (typeof k !== "string") return false;
          try {
            parseCombo(k, this.platform);
            return true;
          } catch {
            return false;
          }
        });
        this.overrides.set(id, valid);
      }
    } catch {
      /* corrupt or unavailable storage: use the defaults */
    }
  }

  /** Overrides for ids registered later stay in memory and apply when they register. */
  private save() {
    if (!this.storage) return;
    try {
      if (!this.overrides.size) this.storage.removeItem(STORAGE_KEY);
      else this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.overrides)));
    } catch {
      /* storage full or blocked: bindings still apply for this session */
    }
  }

  /** Overrides as stored (for export / tests). */
  exportOverrides(): Record<string, string[]> {
    return Object.fromEntries(this.overrides);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Build a binding string from a key event (for "press a key" capture in the rebinding UI). Null for bare modifiers. */
export function comboFromEvent(e: KeyEventLike, platform: Platform): string | null {
  return eventCombos(e, platform)[0] ?? null;
}

/** True when the element is a text-entry control where typed letters belong to the field. */
export function isTypingTarget(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const t = (el.type ?? "text").toLowerCase();
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"].includes(t);
}
