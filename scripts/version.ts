/**
 * One version for the whole repo. The root package.json is the source; this keeps every workspace package, the
 * Tauri config and the desktop crate on the same number.
 *
 *   pnpm version:check            fail if anything is out of sync
 *   pnpm version:set 0.2.0        set an exact version
 *   pnpm version:set minor        bump major | minor | patch
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p: string) => path.join(root, p);

/** Every file that carries the version, with how to read and write it. */
export function versionFiles(): { file: string; get: (s: string) => string | null; set: (s: string, v: string) => string }[] {
  const pkgs = ["package.json", ...["packages", "apps"].flatMap((d) => fs.readdirSync(rel(d)).map((n) => `${d}/${n}/package.json`))].filter((f) => fs.existsSync(rel(f)));
  const json = (file: string) => ({
    file,
    get: (s: string) => (JSON.parse(s) as { version?: string }).version ?? null,
    set: (s: string, v: string) => s.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`),
  });
  const cargoToml = {
    file: "apps/desktop/src-tauri/Cargo.toml",
    get: (s: string) => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(s)?.[1] ?? null,
    set: (s: string, v: string) => s.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/ms, `$1${v}$2`),
  };
  // The lock file records the crate's own version too; keep it from going stale.
  const crate = /^name\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(rel(cargoToml.file), "utf8"))?.[1] ?? "";
  const lockRe = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")`);
  const cargoLock = {
    file: "apps/desktop/src-tauri/Cargo.lock",
    get: (s: string) => new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`).exec(s)?.[1] ?? null,
    set: (s: string, v: string) => s.replace(lockRe, `$1${v}$2`),
  };
  return [...pkgs.map(json), json("apps/desktop/src-tauri/tauri.conf.json"), cargoToml, ...(fs.existsSync(rel(cargoLock.file)) ? [cargoLock] : [])];
}

export const currentVersion = () => (JSON.parse(fs.readFileSync(rel("package.json"), "utf8")) as { version: string }).version;

/** Files whose version differs from the root's: [file, version]. */
export function mismatches(): [string, string | null][] {
  const v = currentVersion();
  return versionFiles()
    .map((f) => [f.file, f.get(fs.readFileSync(rel(f.file), "utf8"))] as [string, string | null])
    .filter(([, got]) => got !== v);
}

function bump(v: string, part: string): string {
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(part)) return part;
  const [maj, min, pat] = v.split("-")[0].split(".").map(Number);
  if (part === "major") return `${maj + 1}.0.0`;
  if (part === "minor") return `${maj}.${min + 1}.0`;
  if (part === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Expected major, minor, patch or a version like 1.2.3, got "${part}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "check") {
    const bad = mismatches();
    if (bad.length) {
      console.error(`Version ${currentVersion()} expected in:\n${bad.map(([f, v]) => `  ${f}: ${v}`).join("\n")}\nRun: pnpm version:set ${currentVersion()}`);
      process.exit(1);
    }
    console.log(`All ${versionFiles().length} files are at ${currentVersion()}`);
  } else if (cmd === "set" && arg) {
    const next = bump(currentVersion(), arg);
    for (const f of versionFiles()) {
      const p = rel(f.file);
      const s = fs.readFileSync(p, "utf8");
      const out = f.set(s, next);
      if (out !== s) fs.writeFileSync(p, out);
    }
    console.log(`Version ${next} (${versionFiles().length} files). Add a section to CHANGELOG.md, then commit and tag v${next}.`);
  } else {
    console.error("Usage: pnpm version:check | pnpm version:set <major|minor|patch|x.y.z>");
    process.exit(1);
  }
}
