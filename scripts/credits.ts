/**
 * Credits for the About dialog: every third-party package the workspace depends on directly, read from the
 * installed packages (name, version, licence, homepage), plus the Rust crates of the desktop app.
 * Used by the editor's Vite config at build time; a test checks that every licence stays permissive.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Credit {
  name: string;
  version: string;
  license: string;
  url: string;
  description: string;
  /** "app": runs in the editor, player or runtimes; "tool": builds or tests them; "desktop": the native shell. */
  kind: "app" | "tool" | "desktop";
}

type Pkg = {
  name: string;
  version: string;
  license?: string | { type: string };
  homepage?: string;
  repository?: string | { url?: string };
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;

/** A browsable URL from a package's homepage or repository field. */
function urlOf(p: Pkg): string {
  const repo = typeof p.repository === "string" ? p.repository : p.repository?.url;
  const raw = p.homepage || repo || `https://www.npmjs.com/package/${p.name}`;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/#readme$/, "")
    .replace(/\.git(#.*)?$/, "")
    .replace(/^([\w-]+\/[\w.-]+)$/, "https://github.com/$1");
}

/** The desktop app's Rust crates, with their licences (all MIT OR Apache-2.0). */
const RUST: Omit<Credit, "kind">[] = [
  { name: "tauri", version: "2", license: "MIT OR Apache-2.0", url: "https://tauri.app", description: "Desktop app shell" },
  { name: "tauri-plugin-dialog", version: "2", license: "MIT OR Apache-2.0", url: "https://github.com/tauri-apps/plugins-workspace", description: "Native open and save dialogs" },
  { name: "tauri-plugin-fs", version: "2", license: "MIT OR Apache-2.0", url: "https://github.com/tauri-apps/plugins-workspace", description: "File access for projects and assets" },
  { name: "tauri-plugin-opener", version: "2", license: "MIT OR Apache-2.0", url: "https://github.com/tauri-apps/plugins-workspace", description: "Open folder after export" },
  { name: "serde", version: "1", license: "MIT OR Apache-2.0", url: "https://serde.rs", description: "Rust serialization" },
];

export function collectCredits(): Credit[] {
  const dirs = [".", ...["packages", "apps"].flatMap((d) => fs.readdirSync(path.join(root, d)).map((n) => `${d}/${n}`))].filter((d) => fs.existsSync(path.join(root, d, "package.json")));
  const found = new Map<string, Credit>();
  for (const dir of dirs) {
    const pkg = readJson<Pkg>(path.join(root, dir, "package.json"));
    const groups: [Record<string, string> | undefined, Credit["kind"]][] = [
      [pkg.dependencies, dir === "apps/desktop" ? "desktop" : "app"],
      [pkg.peerDependencies, "app"],
      [pkg.devDependencies, dir === "apps/desktop" ? "desktop" : "tool"],
    ];
    for (const [deps, kind] of groups)
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (spec.startsWith("workspace:") || name.startsWith("@openbone/") || name.startsWith("@types/")) continue;
        const file = path.join(root, dir, "node_modules", name, "package.json");
        if (!fs.existsSync(file)) continue; // optional peer not installed
        const p = readJson<Pkg>(file);
        const prev = found.get(name);
        // A package used by the app and by tools counts as app.
        if (prev && (prev.kind === "app" || kind !== "app")) continue;
        found.set(name, {
          name,
          version: p.version,
          license: typeof p.license === "string" ? p.license : (p.license?.type ?? "UNKNOWN"),
          url: urlOf(p),
          description: (p.description ?? "").replace(/\s+/g, " ").trim(),
          kind,
        });
      }
  }
  const npm = [...found.values()];
  const rust = RUST.map((r) => ({ ...r, kind: "desktop" as const }));
  const order = { app: 0, desktop: 1, tool: 2 };
  return [...npm, ...rust].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** Licences OpenBone accepts for its dependencies (permissive only; see CONTRIBUTING / project goals). */
export const PERMISSIVE = /^\(?(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|Zlib|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|Python-2\.0)(\s+(OR|AND)\s+(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|Zlib|Unlicense|CC0-1\.0|CC-BY-4\.0))*\)?$/;
