import info from "virtual:openbone-about";
import { createSignal } from "solid-js";
import { logActivity } from "./activity.ts";
import { toast } from "./state.ts";
import { isDesktop } from "./storage.ts";

/**
 * Update checker: asks GitHub for the latest OpenBone release and compares it with this build. On desktop the
 * Update button downloads the installer for this system (Windows .exe, macOS .dmg, Linux AppImage/.deb/.rpm) in the
 * browser; elsewhere it opens the release page. Checks by itself at most once a day on desktop; ☰ Menu → Check for
 * updates checks now.
 */

const API = "https://api.github.com/repos/UXCentury/open-bone/releases/latest";
const RELEASES = "https://github.com/UXCentury/open-bone/releases/latest";
const LAST_CHECK = "openbone.updates.lastCheck";
const DAY = 24 * 3600 * 1000;

export interface UpdateInfo {
  version: string;
  /** Release page. */
  page: string;
  /** Installer for this system, when the release has one. */
  download: { name: string; url: string } | null;
  notes: string;
}

const [available, setAvailable] = createSignal<UpdateInfo | null>(null);
const [checking, setChecking] = createSignal(false);
export { available as updateAvailable, checking as checkingForUpdates };

export const currentVersion = () => info.version;

/** Compare dotted versions ("0.3.0" < "0.10.0"); a pre-release ("1.0.0-beta") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

type Os = "windows" | "mac" | "linux" | "other";
export function detectOs(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): Os {
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "other";
}

/** The installer asset for a system, by the names the release workflow gives them. */
export function pickInstaller(assets: { name: string; browser_download_url: string }[], os: Os): { name: string; url: string } | null {
  const order: Record<Os, RegExp[]> = {
    windows: [/x64-setup\.exe$/i, /\.msi$/i, /\.exe$/i],
    mac: [/\.dmg$/i],
    linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i],
    other: [],
  };
  for (const re of order[os]) {
    const a = assets.find((x) => re.test(x.name));
    if (a) return { name: a.name, url: a.browser_download_url };
  }
  return null;
}

async function openExternal(url: string) {
  if (isDesktop()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* fall back to a new window */
    }
  }
  window.open(url, "_blank", "noopener");
}

/** Download the new version's installer (or open the release page when there is none for this system). */
export async function installUpdate(u: UpdateInfo | null = available()) {
  if (!u) return openExternal(RELEASES);
  if (u.download && isDesktop()) {
    logActivity("system", `Downloading OpenBone ${u.version} (${u.download.name}): run it when it finishes to update`);
    toast(`Downloading ${u.download.name}: open it when it finishes to install OpenBone ${u.version}`);
    return openExternal(u.download.url);
  }
  return openExternal(u.page);
}

/**
 * Check GitHub for a newer release. `manual` reports "up to date" and errors too; automatic checks stay quiet unless
 * there is an update.
 */
export async function checkForUpdates(manual = false): Promise<UpdateInfo | null> {
  if (checking()) return available();
  setChecking(true);
  try {
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(res.status === 403 ? "GitHub's rate limit was reached; try again in a while" : `GitHub answered ${res.status}`);
    const r = (await res.json()) as { tag_name: string; html_url: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
    try {
      localStorage.setItem(LAST_CHECK, String(Date.now()));
    } catch {
      /* storage unavailable */
    }
    const latest = r.tag_name.replace(/^v/, "");
    if (r.draft || r.prerelease || compareVersions(latest, info.version) <= 0) {
      setAvailable(null);
      if (manual) toast(`OpenBone ${info.version} is the latest version`);
      logActivity("system", `Checked for updates: ${info.version} is the latest`);
      return null;
    }
    const u: UpdateInfo = { version: latest, page: r.html_url || RELEASES, download: pickInstaller(r.assets ?? [], detectOs()), notes: r.body ?? "" };
    setAvailable(u);
    logActivity("system", `OpenBone ${latest} is available (you have ${info.version})`);
    toast(`OpenBone ${latest} is available (you have ${info.version})`, "info", { label: isDesktop() && u.download ? "Update" : "See what's new", run: () => installUpdate(u) });
    return u;
  } catch (e) {
    const msg = `Couldn't check for updates: ${(e as Error).message}`;
    if (manual) toast(msg, "error");
    else logActivity("system", msg);
    return null;
  } finally {
    setChecking(false);
  }
}

/** On desktop, check once a day in the background (a few seconds after start, so it doesn't slow loading). */
export function scheduleUpdateCheck() {
  if (!isDesktop() || info.version.includes("dev")) return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(LAST_CHECK) ?? 0);
  } catch {
    /* storage unavailable */
  }
  if (Date.now() - last < DAY) return;
  setTimeout(() => void checkForUpdates(false), 5000);
}
