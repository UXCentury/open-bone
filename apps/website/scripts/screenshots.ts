/**
 * Captures the documentation screenshots from the real editor.
 *
 *   pnpm --filter @openbone/website screenshots              every shot
 *   pnpm --filter @openbone/website screenshots rig-*        shots whose name matches a glob
 *   pnpm --filter @openbone/website screenshots --list       list the shots
 *
 * Starts the editor's Vite dev server on 127.0.0.1:5199 (or uses one already running there, or EDITOR_URL), opens
 * each shot in a fresh headless Chrome context at 1440 × 900 CSS px and 2× device scale, drives the editor through its
 * UI and its own state module, and writes WebP files to src/assets/screenshots/. The shot list is in shots.ts, which
 * also lists the CLI shots: images the `openbone` CLI renders itself.
 *
 * Chrome: CHROME_PATH, else Google Chrome / Chromium from the usual places, else Playwright's own download
 * (`npx playwright-core install chromium`).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium } from "playwright-core";
import sharp from "sharp";
import { CLI_SHOTS, type CliShot, SHOTS, type Shot } from "./shots.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const OUT = process.env.SHOTS_OUT ?? path.join(site, "src/assets/screenshots");
const PORT = 5199;
const EDITOR = process.env.EDITOR_URL ?? `http://127.0.0.1:${PORT}`;

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((c) => fs.existsSync(c));
}

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function startEditor(): Promise<ChildProcess | null> {
  if (await up(EDITOR)) return null;
  if (process.env.EDITOR_URL) throw new Error(`EDITOR_URL ${EDITOR} is not reachable`);
  console.log(`starting the editor on ${EDITOR}`);
  // Vite's own entry run by this Node (not through pnpm), so killing the child stops the server.
  const editorDir = path.join(repo, "apps/editor");
  const viteBin = path.join(editorDir, "node_modules/vite/bin/vite.js");
  const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: editorDir, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    if (await up(EDITOR)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("the editor dev server did not start");
}

/** What a shot's steps get: the page plus helpers that speak the editor's language. */
export interface Ed {
  page: Page;
  /**
   * Run code in the page against the editor's state module (`s`: apps/editor/src/state.ts), the document (`d`), an
   * argument (`arg`) and `m(name)`, which imports any other editor module (`await m("zview")`).
   */
  state<T>(fn: string, arg?: unknown): Promise<T>;
  /** Click a button by (part of) its title or text. */
  click(label: string, opts?: { exact?: boolean; nth?: number }): Promise<void>;
  /** Show a panel tab (Timeline, State Machine, Scripts, Inspector, Preview, Outline, Skeleton). */
  tab(name: string): Promise<void>;
  /** Select a bone or slot by name. */
  select(kind: "bone" | "slot" | "ik" | "physics" | "path" | "transform" | "sound" | "bus", name: string): Promise<void>;
  /** Pick an animation by name and go to a time (seconds). */
  animation(name: string, time?: number): Promise<void>;
  wait(ms: number): Promise<void>;
}

function helpers(page: Page): Ed {
  const ed: Ed = {
    page,
    async state<T>(fn: string, arg?: unknown): Promise<T> {
      // Sent as source text (not a function) so the bundler's helpers never leak into the page.
      // `m("zview")` imports another editor module (apps/editor/src/<name>.ts[x]): the same instance the editor uses.
      const code = `(async () => {
        const s = await import("/src/state.ts");
        const d = s.doc();
        const m = (name) => import("/src/" + name + (/\\.tsx?$/.test(name) ? "" : name.startsWith("panels/") ? ".tsx" : ".ts"));
        const arg = ${JSON.stringify(arg ?? null)};
        ${fn}
      })()`;
      return page.evaluate(code) as Promise<T>;
    },
    async click(label, opts = {}) {
      const byTitle = page.locator(opts.exact ? `button[title="${label}"]` : `button[title*="${label}"]`);
      const loc = (await byTitle.count()) ? byTitle : page.getByRole("button", { name: label, exact: opts.exact ?? false });
      await loc.nth(opts.nth ?? 0).click();
      await page.waitForTimeout(150);
    },
    async tab(name) {
      await page.locator(".dock-tab, [role=tab]", { hasText: new RegExp(`^\\s*${name}\\s*$`, "i") }).first().click();
      await page.waitForTimeout(200);
    },
    async select(kind, name) {
      await ed.state(
        `const k = arg.kind; const n = arg.name;
         const list = k === "bone" ? d.skeleton.bones : k === "slot" ? d.skeleton.slots
           : k === "sound" ? (d.audio?.sounds ?? []) : k === "bus" ? (d.audio?.buses ?? [])
           : (d.skeleton[k] ?? []);
         const hit = list.find((x) => x.name === n);
         if (!hit) throw new Error(k + " " + n + " not found");
         s.setSelection({ kind: k, id: hit.id });`,
        { kind, name },
      );
      await page.waitForTimeout(150);
    },
    async animation(name, time = 0) {
      await ed.state(
        `const a = d.animations.find((a) => a.name === arg.name); if (!a) throw new Error("no animation " + arg.name);
         s.setAnimationId(a.id); s.setTime(arg.time);`,
        { name, time },
      );
      await page.waitForTimeout(250);
    },
    wait: (ms) => page.waitForTimeout(ms),
  };
  return ed;
}

async function capture(browser: Browser, shot: Shot) {
  const cleanup = shot.before ? await shot.before() : null;
  try {
    await captureIn(browser, shot);
  } finally {
    cleanup?.();
  }
}

async function captureIn(browser: Browser, shot: Shot) {
  const context = await browser.newContext({ viewport: shot.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.SHOTS_SCALE ?? 2), colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(shot.url ?? `${EDITOR}/?example=${shot.example ?? "walker"}`, { waitUntil: "networkidle" });
  // The example loads asynchronously: wait for its name in the Inspector's document section.
  await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0);
  await page.waitForTimeout(1200);
  const ed = helpers(page);
  if (shot.steps) await shot.steps(ed);
  await page.waitForTimeout(shot.settle ?? 600);
  let clip = shot.clip;
  if (shot.clipTo) {
    const box = await page.locator(shot.clipTo).first().boundingBox();
    if (!box) throw new Error(`${shot.name}: ${shot.clipTo} not found`);
    const pad = shot.clipPad ?? 0;
    clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 };
  }
  const png = await page.screenshot({ clip, animations: "allow" });
  const file = path.join(OUT, `${shot.name}.webp`);
  await sharp(png).webp({ quality: 84, effort: 6 }).toFile(file);
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${shot.name}.webp  ${kb} KB${errors.length ? `  (page errors: ${errors.join(" | ")})` : ""}`);
  await context.close();
}

function globToRe(g: string) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** Run the `openbone` CLI from this checkout and turn what it writes into WebP (animated for GIFs). */
function captureCli(shot: CliShot) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openbone-cli-"));
  try {
    const out = path.join(tmp, `out.${shot.ext}`);
    const args = shot.args.map((a) => a.replace("{out}", out));
    execFileSync(process.execPath, ["--import", "tsx", "packages/cli/src/bin.ts", ...args], { cwd: repo, stdio: "pipe" });
    const file = path.join(OUT, `${shot.name}.webp`);
    return sharp(out, { animated: shot.ext === "gif" })
      .webp({ quality: 84, effort: 6 })
      .toFile(file)
      .then(() => console.log(`  ${shot.name}.webp  ${Math.round(fs.statSync(file).size / 1024)} KB  (openbone ${shot.args[0]})`));
  } finally {
    setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 2000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const s of SHOTS) console.log(`${s.name.padEnd(28)} ${(s.example ?? "walker").padEnd(10)} ${s.about}`);
    for (const s of CLI_SHOTS) console.log(`${s.name.padEnd(28)} ${"cli".padEnd(10)} ${s.about}`);
    return;
  }
  const filters = args.filter((a) => !a.startsWith("--")).map(globToRe);
  const pick = <T extends { name: string }>(list: T[]) => (filters.length ? list.filter((s) => filters.some((re) => re.test(s.name))) : list);
  const shots = pick(SHOTS);
  const cliShots = pick(CLI_SHOTS);
  if (!shots.length && !cliShots.length) throw new Error("no shot matches");
  fs.mkdirSync(OUT, { recursive: true });
  let failed = 0;
  for (const shot of cliShots) {
    try {
      await captureCli(shot);
    } catch (e) {
      failed++;
      console.error(`  ${shot.name}: ${(e as Error).message}`);
    }
  }
  if (shots.length) {
    const server = await startEditor();
    const browser = await chromium.launch({
      executablePath: findChrome(),
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    });
    console.log(`capturing ${shots.length} screenshot(s) from ${EDITOR} into ${path.relative(repo, OUT)}`);
    try {
      for (const shot of shots) {
        try {
          await capture(browser, shot);
        } catch (e) {
          failed++;
          console.error(`  ${shot.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      await browser.close();
      server?.kill();
    }
  }
  if (failed) {
    console.error(`${failed} shot(s) failed`);
    process.exitCode = 1;
  }
}

await main();
