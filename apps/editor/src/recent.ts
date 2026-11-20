/**
 * Desktop: the projects opened or saved most recently, newest first, for ☰ Menu → Open recent. Kept in localStorage
 * (paths only; the files stay where they are). The browser editor can't reopen a file by path, so it has none.
 */
import { createSignal } from "solid-js";

export interface RecentProject {
  path: string;
  /** When it was last opened or saved (ms). */
  time: number;
}

const KEY = "openbone.recent";
export const MAX_RECENT = 10;

/** Keep only well-formed entries, newest first, without duplicates, at most MAX_RECENT. */
export function sanitizeRecent(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { path, time } = r as Partial<RecentProject>;
    if (typeof path !== "string" || !path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, time: typeof time === "number" ? time : 0 });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, MAX_RECENT);
}

function read(): RecentProject[] {
  try {
    return sanitizeRecent(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

const [recent, setRecentSignal] = createSignal<RecentProject[]>(read());
export const recentProjects = recent;

function write(list: RecentProject[]) {
  setRecentSignal(list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the list still works until the app closes */
  }
}

/** A project was opened or saved at `path`: move it to the top. */
export function addRecent(path: string, now = Date.now()) {
  write(sanitizeRecent([{ path, time: now }, ...recent().filter((r) => r.path !== path)]));
}

/** A recent project that can't be opened any more (moved or deleted). */
export const removeRecent = (path: string) => write(recent().filter((r) => r.path !== path));

export const clearRecent = () => write([]);

/** "walker.obone — examples": the file, then the folder it's in, for a menu row. */
export function recentLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.pop() ?? path;
  const folder = parts.pop();
  return folder ? `${file} — ${folder}` : file;
}
