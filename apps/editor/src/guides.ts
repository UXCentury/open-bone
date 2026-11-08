import { createSignal } from "solid-js";
import { doc } from "./state.ts";

/**
 * Viewport layout aids: grid, rulers, guides and snapping. Editor-only (not part of the document);
 * settings are saved per browser and guides per project name.
 */

export interface Guide {
  id: string;
  /** "x": vertical line at x = pos; "y": horizontal line at y = pos (skeleton space, y-up). */
  axis: "x" | "y";
  pos: number;
}

interface Settings {
  grid: boolean;
  gridSize: number;
  rulers: boolean;
  snap: boolean;
  snapGrid: boolean;
  snapGuides: boolean;
  snapArtboard: boolean;
  snapBones: boolean;
}

const SETTINGS_KEY = "openbone.viewaids.v1";
const GUIDES_KEY = "openbone.guides.v1";
const DEFAULTS: Settings = { grid: false, gridSize: 25, rulers: true, snap: true, snapGrid: true, snapGuides: true, snapArtboard: true, snapBones: true };

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings still apply for this session */
  }
}

const [settings, setSettingsRaw] = createSignal<Settings>(read(SETTINGS_KEY, DEFAULTS));
export { settings as viewAids };
export function setViewAid<K extends keyof Settings>(key: K, value: Settings[K]) {
  const next = { ...settings(), [key]: value };
  if (key === "gridSize") next.gridSize = Math.max(1, Math.min(1000, Number(value) || DEFAULTS.gridSize));
  setSettingsRaw(next);
  write(SETTINGS_KEY, next);
}
export const toggleViewAid = (key: "grid" | "rulers" | "snap") => setViewAid(key, !settings()[key]);

// ---- guides, per project ----
const [allGuides, setAllGuides] = createSignal<Record<string, Guide[]>>(read(GUIDES_KEY, {}));
const projectKey = () => doc().name || "Untitled";
export const guides = (): Guide[] => allGuides()[projectKey()] ?? [];

function setGuides(list: Guide[]) {
  const next = { ...allGuides(), [projectKey()]: list };
  if (!list.length) delete next[projectKey()];
  setAllGuides(next);
  write(GUIDES_KEY, next);
}

export function upsertGuide(g: Guide) {
  const list = guides().filter((x) => x.id !== g.id);
  setGuides([...list, { ...g, pos: Math.round(g.pos * 100) / 100 }]);
}
export const removeGuide = (id: string) => setGuides(guides().filter((g) => g.id !== id));
export const clearGuides = () => setGuides([]);
export const newGuideId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
