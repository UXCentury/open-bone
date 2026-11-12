/**
 * Brings the repository into the site at build (and dev) time, so nothing is copied by hand:
 *
 *  - the reference docs (docs/*.md), the native runtime READMEs and the package READMEs become pages under
 *    src/content/docs/{reference,runtimes,packages}/ (generated, git-ignored), with their links rewritten to site
 *    routes or to GitHub;
 *  - the example projects (examples/*.obone and their art and sound) are copied to public/projects/;
 *  - the real web player (packages/player, the same build the editor's Web export ships) is bundled to
 *    public/player/, with its lazily loaded script sandbox.
 *
 * Run by the integration in astro.config.ts; `pnpm --filter @openbone/website sync` runs it on its own.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildScriptsAddon, buildWebBundle, quickJsWasmBytes } from "../../../packages/player/src/bundle/build.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const site = path.resolve(here, "..");
export const repo = path.resolve(site, "../..");
const GITHUB = "https://github.com/UXCentury/open-bone";

export interface DocSource {
  /** Repo-relative source file. */
  src: string;
  /** Site route (no leading or trailing slash). */
  slug: string;
  /** Sidebar label; the page title stays the document's own H1. */
  label?: string;
  title?: string;
  description?: string;
}

/** Every repository document that becomes a page. The single list of what the site imports. */
export const DOCS: DocSource[] = [
  { src: "docs/architecture.md", slug: "reference/architecture", description: "How the editor, the op registry, the runtime, rendering, audio and scripts fit together." },
  { src: "docs/format.md", slug: "reference/format", label: "File format", description: "The .obone (JSON) and .obonb (binary) document format." },
  { src: "docs/runtime-spec.md", slug: "reference/runtime-spec", label: "Runtime specification", description: "Exactly how a pose, a draw list or a state machine is computed, for porting the runtime." },
  { src: "docs/mcp.md", slug: "reference/mcp", label: "MCP server", description: "The MCP server, its transports, the live bridge and its tools." },
  { src: "docs/engine-exports.md", slug: "reference/engine-exports", label: "Engine exports", description: "Sprite-sheet and WebView engine packs from the Export dialog." },
  { src: "conformance/README.md", slug: "reference/conformance", label: "Conformance suite", description: "The reference results every runtime is tested against." },
  { src: "docs/releasing.md", slug: "reference/releasing", label: "Releasing", description: "Desktop installers, releases, package publishing and code signing." },
  { src: "CHANGELOG.md", slug: "reference/changelog", label: "Changelog", title: "Changelog", description: "What changed in each version of OpenBone." },
  { src: "CONTRIBUTING.md", slug: "community/contributing", label: "Contributing", title: "Contributing to OpenBone", description: "How to contribute to OpenBone: the rules, best practices, checks and pull requests." },
  { src: "SECURITY.md", slug: "reference/security", label: "Security", description: "Security fixes, the latest audit and how to report a vulnerability." },

  { src: "runtimes/cpp/README.md", slug: "runtimes/cpp", label: "C / C++", description: "The C++17 runtime, its C API and the Godot, Cocos2d-x, SDL2, SFML, OpenGL and Unreal integrations." },
  { src: "runtimes/cpp/engines/godot/addon/README.md", slug: "runtimes/godot", label: "Godot addon", description: "The OpenBone GDExtension for Godot 4.4+." },
  { src: "runtimes/csharp/README.md", slug: "runtimes/csharp", label: "C# (.NET)", description: "The C# runtime for .NET, Unity and MonoGame." },
  { src: "runtimes/csharp/unity/com.openbone.runtime/README.md", slug: "runtimes/unity", label: "Unity package", description: "The com.openbone.runtime Unity package: importer, components, mesh and audio." },
  { src: "runtimes/csharp/monogame/src/OpenBone.MonoGame/README.md", slug: "runtimes/monogame", label: "MonoGame", description: "OpenBone.MonoGame: renderer, player and SoundEffect bridge." },
  { src: "runtimes/csharp/src/OpenBone.Runtime/README.md", slug: "runtimes/dotnet-runtime", label: "OpenBone.Runtime (NuGet)", description: "The OpenBone.Runtime NuGet package." },
  { src: "runtimes/csharp/src/OpenBone.Scripting.Jint/README.md", slug: "runtimes/dotnet-scripting", label: "OpenBone.Scripting.Jint", description: "Document scripts for the C# runtime, in Jint." },
  { src: "runtimes/java/README.md", slug: "runtimes/java", label: "Java, libGDX, Android", description: "The pure Java runtime, the libGDX renderer and the Android OpenBoneView." },
  { src: "runtimes/swift/README.md", slug: "runtimes/swift", label: "Swift", description: "The Swift API, the Metal OpenBoneView and the SwiftUI OpenBonePlayer." },
  { src: "runtimes/flutter/openbone/README.md", slug: "runtimes/flutter", label: "Flutter", description: "The dart:ffi Flutter plugin and OpenBoneWidget." },
  { src: "runtimes/haxe/README.md", slug: "runtimes/haxe", label: "Haxe", description: "The pure Haxe runtime." },

  ...["runtime", "player", "core", "render-webgl", "render-canvas", "pixi", "phaser", "three", "canvaskit", "engine-kit", "scripting", "export", "mcp", "cli", "openbone"].map(
    (p): DocSource => ({ src: `packages/${p}/README.md`, slug: `packages/${p}`, label: p === "openbone" ? "openbone" : `@openbone/${p}` }),
  ),
];

const bySource = new Map(DOCS.map((d) => [d.src, d]));

/** The page a repo path (file or folder) maps to, if any. */
function routeOf(repoPath: string): string | null {
  const p = repoPath.replace(/\/+$/, "");
  const doc = bySource.get(p) ?? bySource.get(`${p}/README.md`);
  return doc ? `/${doc.slug}/` : null;
}

/** Rewrite one link target found in `fromFile` (repo-relative). */
export function rewriteLink(target: string, fromFile: string): string {
  if (/^(mailto:|#)/.test(target)) return target;
  let repoPath: string | null = null;
  let hash = "";
  const gh = /^https:\/\/github\.com\/UXCentury\/open-bone\/(?:blob|tree)\/main\/([^#?]*)(#.*)?$/.exec(target);
  if (gh) {
    repoPath = decodeURIComponent(gh[1]);
    hash = gh[2] ?? "";
  } else if (target === `${GITHUB}#quick-start` || target === `${GITHUB}/blob/main/README.md#quick-start`) {
    return "/getting-started/quick-start/";
  } else if (!/^[a-z]+:/i.test(target) && !target.startsWith("/")) {
    const [p, h] = target.split("#");
    hash = h !== undefined ? `#${h}` : "";
    repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decodeURIComponent(p)));
  }
  if (repoPath === null) return target;
  const route = routeOf(repoPath);
  if (route) return route + hash;
  if (repoPath === "README.md" || repoPath === ".") return `${GITHUB}${hash}`;
  const abs = path.join(repo, repoPath);
  const kind = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${repoPath}${hash}`;
}

/** A line made only of badge images (shields.io and friends), which the site shows elsewhere. */
const badgeLine = (l: string) => /^\s*(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/.test(l);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ALERT: Record<string, string> = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "caution", CAUTION: "danger" };

/** GitHub alerts (`> [!NOTE]` blockquotes) become Starlight asides (`:::note`). */
export function githubAlerts(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    out.push(`:::${ALERT[m[1]]}`);
    while (i + 1 < lines.length && lines[i + 1].startsWith(">")) out.push(lines[++i].replace(/^>\s?/, ""));
    out.push(":::");
  }
  return out.join("\n");
}

const changed = new Map<string, string | null>();

/** When a repository file last changed in git (ISO date), or null outside a git checkout. */
function lastChanged(src: string): string | null {
  if (!changed.has(src)) {
    let date: string | null = null;
    try {
      date = execFileSync("git", ["log", "-1", "--format=%cI", "--", src], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
    } catch {
      date = null;
    }
    changed.set(src, date);
  }
  return changed.get(src) ?? null;
}

/** The first prose paragraph of a Markdown body as plain text, cut at a sentence end near 160 characters. */
export function firstParagraph(md: string, fallback: string): string {
  const prose = md
    .replace(/^```[\s\S]*?^```/gm, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|<|\||>|-\s|\*\s|\d+\.\s|!\[|:::)/.test(p) && p.length > 40);
  if (!prose) return fallback;
  const text = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 160) return text;
  const cut = text.slice(0, 160);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(": "));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Turn one repo markdown file into a Starlight page. */
export function toPage(doc: DocSource, md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = doc.title;
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const h1 = /^#\s+(.+)$/.exec(lines[i] ?? "");
  if (h1) {
    title ??= h1[1].replace(/`/g, "").trim();
    lines.splice(i, 1);
  }
  title ??= doc.slug;
  let body = lines.filter((l) => !badgeLine(l)).join("\n");
  // A "back to the README" line makes no sense on the site.
  body = body.replace(/^←.*README.*$/m, "");
  // Links and images: [text](target "title"), and src="" / href="" in inline HTML. Code blocks are left alone.
  const parts = body.split(/(^```[\s\S]*?^```)/m);
  body = parts
    .map((part, k) => {
      if (k % 2 === 1) {
        // Mermaid diagrams render in the browser (see src/components/Footer.astro).
        const mm = /^```mermaid\n([\s\S]*?)^```/m.exec(part);
        return mm ? `<pre class="mermaid not-content">${escapeHtml(mm[1])}</pre>` : part;
      }
      return githubAlerts(part)
        // Bare dev-server URLs (http://localhost:5190/pixi/) are addresses to type, not links that work from the site.
        .replace(/(^|[\s(])(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s)<>`]*)/g, (_m, pre: string, u: string) => `${pre}\`${u.replace(/[.,;:]$/, "")}\`${/[.,;:]$/.test(u) ? u.slice(-1) : ""}`)
        .replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_m, a: string, t: string, b: string) => a + rewriteLink(t, doc.src) + b)
        .replace(/(\s(?:href|src)=")([^"]+)(")/g, (_m, a: string, t: string, b: string) => a + rewriteLink(t, doc.src) + b);
    })
    .join("");
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    // Every page gets its own description (search snippets, social cards): the given one, else the README's first paragraph.
    `description: ${JSON.stringify(doc.description ?? firstParagraph(body, title))}`,
    ...(doc.label ? [`sidebar:\n  label: ${JSON.stringify(doc.label)}`] : []),
    `editUrl: ${JSON.stringify(`${GITHUB}/edit/main/${doc.src}`)}`,
    // The generated file is not in git; the date its source last changed is.
    ...(lastChanged(doc.src) ? [`lastUpdated: ${lastChanged(doc.src)}`] : []),
    "---",
    "",
    `:::note[Imported from the repository]`,
    `This page is generated from [\`${doc.src}\`](${GITHUB}/blob/main/${doc.src}). Edit it there.`,
    ":::",
    "",
  ];
  return fm.join("\n") + body.trimStart();
}

function writeIfChanged(file: string, data: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file);
    if (Buffer.compare(old, Buffer.from(data)) === 0) return;
  }
  fs.writeFileSync(file, data);
}

export function syncDocs() {
  const out = path.join(site, "src/content/docs");
  for (const doc of DOCS) {
    const src = path.join(repo, doc.src);
    if (!fs.existsSync(src)) throw new Error(`sync: ${doc.src} is missing`);
    writeIfChanged(path.join(out, `${doc.slug}.md`), toPage(doc, fs.readFileSync(src, "utf8")));
  }
}

function copyTree(from: string, to: string) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (!fs.existsSync(b) || fs.statSync(b).size !== fs.statSync(a).size || fs.statSync(b).mtimeMs < fs.statSync(a).mtimeMs) {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(a, b);
    }
  }
}

export function syncExamples() {
  const ex = path.join(repo, "examples");
  const out = path.join(site, "public/projects");
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(ex).filter((f) => f.endsWith(".obone"))) writeIfChanged(path.join(out, f), fs.readFileSync(path.join(ex, f)));
  copyTree(path.join(ex, "assets"), path.join(out, "assets"));
}

export async function syncPlayer() {
  const out = path.join(site, "public/player");
  // Imported statically above: a dynamic import here would go through Astro's short-lived config loader.
  writeIfChanged(path.join(out, "openbone-player.js"), await buildWebBundle({ format: "iife", minify: true, scripts: "lazy" }));
  writeIfChanged(path.join(out, "openbone-scripts.js"), await buildScriptsAddon({ minify: true }));
  writeIfChanged(path.join(out, "quickjs.wasm"), quickJsWasmBytes());
}

/**
 * public/posters/<example>.webp: each example's first state-machine frame, rendered by the repository's own CLI. Live
 * players show it until someone presses play, so nothing else loads before that. Re-rendered when the file changes.
 */
export async function syncPosters() {
  const ex = path.join(repo, "examples");
  const out = path.join(site, "public/posters");
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(ex).filter((f) => f.endsWith(".obone"))) {
    const id = f.replace(/\.obone$/, "");
    const src = path.join(ex, f);
    const poster = path.join(out, `${id}.webp`);
    if (fs.existsSync(poster) && fs.statSync(poster).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    const doc = JSON.parse(fs.readFileSync(src, "utf8")) as { width: number; stateMachines?: { name: string }[] };
    const sm = doc.stateMachines?.[0]?.name;
    const png = path.join(out, `${id}.png`);
    execFileSync(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/bin.ts", "render", `examples/${f}`, ...(sm ? ["--state-machine", sm] : []), "--scale", String(Math.min(1, 1280 / doc.width)), "--out", png],
      { cwd: repo, stdio: "ignore" },
    );
    await sharp(png).webp({ quality: 80 }).toFile(poster);
    fs.rmSync(png);
  }
}

export async function syncAll() {
  syncDocs();
  syncExamples();
  await syncPlayer();
  await syncPosters();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncAll();
  console.log("synced docs, examples and the web player");
}
