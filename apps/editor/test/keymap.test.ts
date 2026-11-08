import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  ShortcutRegistry,
  type ShortcutDef,
  type StorageLike,
  canonical,
  comboFromEvent,
  detectPlatform,
  eventCombos,
  formatCombo,
  isTypingTarget,
  parseCombo,
} from "../src/shortcuts/keymap.ts";
import { DEFAULT_SHORTCUTS } from "../src/shortcuts/defaults.ts";

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const ev = (key: string, o: Partial<{ code: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; repeat: boolean }> = {}) => ({
  key,
  code: o.code,
  ctrlKey: !!o.ctrl,
  metaKey: !!o.meta,
  altKey: !!o.alt,
  shiftKey: !!o.shift,
  repeat: !!o.repeat,
});

describe("platform", () => {
  it("detects macOS from platform strings", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })).toBe("mac");
    expect(detectPlatform(undefined)).toBe("other");
  });
});

describe("parse / format", () => {
  it("parses modifiers in any order and case", () => {
    expect(parseCombo("shift+mod+z")).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: "Z" });
    expect(canonical("shift+mod+z")).toBe("Mod+Shift+Z");
    expect(canonical("Ctrl+Alt+1")).toBe("Mod+Alt+1");
    expect(canonical("Ctrl+Alt+1", "mac")).toBe("Ctrl+Alt+1");
    expect(canonical("Cmd+S", "mac")).toBe("Mod+S");
    expect(canonical("esc")).toBe("Escape");
    expect(canonical("Mod++")).toBe("Mod+Plus");
    expect(canonical("?")).toBe("?");
    expect(canonical("Shift+,")).toBe("Shift+,");
  });

  it("rejects garbage", () => {
    expect(() => parseCombo("Mod+")).toThrow();
    expect(() => parseCombo("Hyper+X")).toThrow();
    expect(() => parseCombo("Shift")).toThrow();
    expect(() => parseCombo("NotAKey")).toThrow();
  });

  it("formats per OS", () => {
    expect(formatCombo("Mod+Shift+Z", "mac")).toBe("⇧⌘Z");
    expect(formatCombo("Mod+Shift+Z", "other")).toBe("Ctrl+Shift+Z");
    expect(formatCombo("Mod+S", "mac")).toBe("⌘S");
    expect(formatCombo("Mod+S", "other")).toBe("Ctrl+S");
    expect(formatCombo("Ctrl+Alt+K", "mac")).toBe("⌃⌥K");
    expect(formatCombo("Delete", "mac")).toBe("⌦");
    expect(formatCombo("Delete", "other")).toBe("Del");
    expect(formatCombo("Escape", "other")).toBe("Esc");
    expect(formatCombo("Shift+ArrowLeft", "other")).toBe("Shift+←");
    expect(formatCombo("Mod+Plus", "other")).toBe("Ctrl++");
  });
});

describe("event mapping", () => {
  it("uses ⌘ as Mod on macOS and Ctrl elsewhere", () => {
    expect(eventCombos(ev("z", { meta: true, code: "KeyZ" }), "mac")[0]).toBe("Mod+Z");
    expect(eventCombos(ev("z", { ctrl: true, code: "KeyZ" }), "mac")[0]).toBe("Ctrl+Z");
    expect(eventCombos(ev("z", { ctrl: true, code: "KeyZ" }), "other")[0]).toBe("Mod+Z");
    expect(eventCombos(ev("Z", { ctrl: true, shift: true, code: "KeyZ" }), "other")[0]).toBe("Mod+Shift+Z");
  });

  it("matches symbols by character and by physical key", () => {
    // "?" is Shift+/ on US layouts; the symbol candidate drops Shift.
    expect(eventCombos(ev("?", { shift: true, code: "Slash" }), "other")).toEqual(["?", "Shift+/"]);
    expect(eventCombos(ev("<", { shift: true, code: "Comma" }), "other")).toEqual(["<", "Shift+,"]);
    expect(eventCombos(ev(" ", { code: "Space" }), "other")).toEqual(["Space"]);
    expect(eventCombos(ev("Shift", { shift: true, code: "ShiftLeft" }), "other")).toEqual([]);
  });

  it("falls back to the physical key for macOS Option characters", () => {
    expect(eventCombos(ev("¡", { alt: true, code: "Digit1" }), "mac")).toEqual(["Alt+1"]);
    expect(eventCombos(ev("å", { alt: true, code: "KeyA" }), "mac")).toEqual(["Alt+A"]);
  });

  it("captures a combo from an event", () => {
    expect(comboFromEvent(ev("k", { meta: true, shift: true, code: "KeyK" }), "mac")).toBe("Mod+Shift+K");
    expect(comboFromEvent(ev("Meta", { meta: true }), "mac")).toBeNull();
  });

  it("recognises typing targets", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

const defs = (): ShortcutDef[] => [
  { id: "undo", label: "Undo", group: "Edit", keys: ["Mod+Z"], scope: "editor" },
  { id: "redo", label: "Redo", group: "Edit", keys: ["Mod+Shift+Z", "Mod+Y"], scope: "editor" },
  { id: "tool.select", label: "Select tool", group: "Tools", keys: ["V"], scope: "editor" },
  { id: "play.stop", label: "Stop", group: "Play", keys: ["Escape"], scope: "play" },
  { id: "deselect", label: "Deselect", group: "Edit", keys: ["Escape"], scope: "editor" },
  { id: "play.toggle", label: "Play / stop", group: "Play", keys: ["P"], scope: "global" },
];

describe("registry", () => {
  it("lists groups in registration order", () => {
    const r = new ShortcutRegistry("other");
    r.register(defs());
    expect(r.groups().map((g) => g.group)).toEqual(["Edit", "Tools", "Play"]);
    expect(() => r.register(defs()[0])).toThrow(/twice/);
  });

  it("labels and titles per OS", () => {
    const mac = new ShortcutRegistry("mac");
    mac.register(defs());
    expect(mac.label("redo")).toBe("⇧⌘Z");
    expect(mac.title("Redo", "redo")).toBe("Redo (⇧⌘Z)");
    const pc = new ShortcutRegistry("other");
    pc.register(defs());
    expect(pc.title("Redo", "redo")).toBe("Redo (Ctrl+Shift+Z)");
  });

  it("detects conflicts only in overlapping scopes", () => {
    const r = new ShortcutRegistry("other");
    r.register(defs());
    // Escape is shared by an editor and a play shortcut: never active together.
    expect(r.allConflicts()).toEqual([]);
    expect(r.conflicts("Escape", "editor").map((c) => c.id)).toEqual(["deselect"]);
    expect(r.conflicts("Escape", "play").map((c) => c.id)).toEqual(["play.stop"]);
    // Global overlaps everything.
    expect(r.conflicts("Escape", "global").map((c) => c.id).sort()).toEqual(["deselect", "play.stop"]);
    expect(r.conflicts("ctrl+z", "editor", "undo")).toEqual([]);
  });

  it("rebinds with conflict detection, steal and reset", () => {
    const r = new ShortcutRegistry("other");
    r.register(defs());
    expect(() => r.setKeys("tool.select", ["Mod+Z"])).toThrow(/Undo/);
    r.setKeys("tool.select", ["Mod+Z"], { steal: true });
    expect(r.keysOf("tool.select")).toEqual(["Mod+Z"]);
    expect(r.keysOf("undo")).toEqual([]);
    expect(r.isCustomized("undo")).toBe(true);
    r.reset("undo");
    expect(r.keysOf("undo")).toEqual(["Mod+Z"]);
    expect(r.allConflicts()).toEqual([{ a: "undo", b: "tool.select", key: "Mod+Z" }]);
    r.resetAll();
    expect(r.allConflicts()).toEqual([]);
    expect(r.isCustomized("tool.select")).toBe(false);
  });

  it("setting the defaults again clears the override", () => {
    const r = new ShortcutRegistry("other");
    r.register(defs());
    r.setKeys("undo", ["U"]);
    r.setKeys("undo", ["ctrl+z"]);
    expect(r.isCustomized("undo")).toBe(false);
    r.addKey("undo", "Alt+Backspace");
    expect(r.keysOf("undo")).toEqual(["Mod+Z", "Alt+Backspace"]);
    r.removeKey("undo", "Alt+Backspace");
    expect(r.isCustomized("undo")).toBe(false);
  });

  it("persists rebinding to storage and reloads it", () => {
    const s = new MemStorage();
    const a = new ShortcutRegistry("other", s);
    a.register(defs());
    a.setKeys("tool.select", ["Q"]);
    a.setKeys("undo", []);
    expect(JSON.parse(s.getItem(STORAGE_KEY)!)).toEqual({ "tool.select": ["Q"], undo: [] });
    const b = new ShortcutRegistry("other", s);
    b.register(defs());
    expect(b.keysOf("tool.select")).toEqual(["Q"]);
    expect(b.keysOf("undo")).toEqual([]);
    b.resetAll();
    expect(s.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores corrupt storage and invalid stored keys", () => {
    const s = new MemStorage();
    s.setItem(STORAGE_KEY, "{not json");
    const a = new ShortcutRegistry("other", s);
    a.register(defs());
    expect(a.keysOf("undo")).toEqual(["Mod+Z"]);
    s.setItem(STORAGE_KEY, JSON.stringify({ undo: ["Bogus+Q", "U", 5], redo: "nope" }));
    const b = new ShortcutRegistry("other", s);
    b.register(defs());
    expect(b.keysOf("undo")).toEqual(["U"]);
    expect(b.keysOf("redo")).toEqual(["Mod+Shift+Z", "Mod+Y"]);
  });

  it("dispatches by scope, skips typing and swallows repeats", () => {
    const r = new ShortcutRegistry("mac");
    const ran: string[] = [];
    r.register(defs().map((d) => ({ ...d, action: () => void ran.push(d.id) })));
    expect(r.dispatch(ev("z", { meta: true, code: "KeyZ" }), ["global", "editor"])).toBe("undo");
    expect(r.dispatch(ev("Z", { meta: true, shift: true, code: "KeyZ" }), ["global", "editor"])).toBe("redo");
    expect(r.dispatch(ev("Escape", { code: "Escape" }), ["global", "play"])).toBe("play.stop");
    expect(r.dispatch(ev("Escape", { code: "Escape" }), ["global", "editor"])).toBe("deselect");
    expect(r.dispatch(ev("v", { code: "KeyV" }), ["global", "play"])).toBeNull();
    expect(r.dispatch(ev("v", { code: "KeyV" }), ["global", "editor"], true)).toBeNull();
    expect(r.dispatch(ev("v", { code: "KeyV", repeat: true }), ["global", "editor"])).toBe("tool.select");
    expect(ran).toEqual(["undo", "redo", "play.stop", "deselect"]);
  });

  it("falls through when an action returns false", () => {
    const r = new ShortcutRegistry("other");
    r.register([
      { id: "a", label: "A", group: "g", keys: ["X"], scope: "editor", action: () => false },
      { id: "b", label: "B", group: "g", keys: ["X"], scope: "play", action: () => true },
    ]);
    expect(r.dispatch(ev("x"), ["editor"])).toBeNull();
    expect(r.dispatch(ev("x"), ["editor", "play"])).toBe("b");
  });
});

describe("editor defaults", () => {
  for (const platform of ["mac", "other"] as const)
    it(`have no conflicts on ${platform}`, () => {
      const r = new ShortcutRegistry(platform);
      r.register(DEFAULT_SHORTCUTS.map((d) => ({ ...d })));
      expect(r.allConflicts()).toEqual([]);
    });

  it("keep the established shortcuts", () => {
    const r = new ShortcutRegistry("other");
    r.register(DEFAULT_SHORTCUTS.map((d) => ({ ...d })));
    const bound = new Set(r.all().flatMap((d) => r.keysOf(d.id)));
    for (const k of ["V", "T", "S", "B", "M", "W", "G", "Shift+R", "F", "Space", "Delete", "Escape", "Mod+Z", "Mod+Shift+Z", "Mod+Y", "Mod+S", "Mod+E", "Mod+A", "ArrowLeft", "?"])
      expect(bound, k).toContain(canonical(k));
  });

  it("avoid shortcuts the browser or OS will not give up", () => {
    const reserved = ["Mod+W", "Mod+T", "Mod+N", "Mod+Q", "Mod+R", "Mod+L", "Mod+Shift+T", "Mod+Shift+N", "Mod+Shift+W", "Mod+Tab", "Alt+F4", "Mod+H", "Mod+M", "Mod+1", "Mod+P", "Mod+Shift+Q"];
    for (const d of DEFAULT_SHORTCUTS) for (const k of d.keys) expect(reserved, `${d.id}: ${k}`).not.toContain(canonical(k));
  });
});
