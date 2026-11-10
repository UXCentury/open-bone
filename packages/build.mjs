// Build one package for npm: compile src/ to dist/ (JavaScript + .d.ts) with tsc, then make the result usable outside
// the monorepo. Run from the package folder (each package's "build" script is `node ../build.mjs`).
//
// - Relative `.ts` imports become `.js` (tsc's rewriteRelativeImportExtensions in .js; a rewrite here in .d.ts, so
//   consumers on any TypeScript version resolve them).
// - Every bin in publishConfig.bin gets a `#!/usr/bin/env node` shebang and the executable bit.
//
// In the monorepo, package.json `exports` point at src/*.ts; `publishConfig` swaps in dist/ when packing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const dir = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const dist = path.join(dir, "dist");

fs.rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: dir, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const relTs = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']*?)\.(m|c)?ts(["'])/g;
for (const f of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
  const s = fs.readFileSync(f, "utf8");
  const out = s.replace(relTs, (_m, pre, spec, mc, q) => `${pre}${spec}.${mc ?? ""}js${q}`);
  if (out !== s) fs.writeFileSync(f, out);
}

for (const bin of Object.values(pkg.publishConfig?.bin ?? {})) {
  const f = path.join(dir, bin);
  const s = fs.readFileSync(f, "utf8").replace(/^#!.*\n/, "");
  fs.writeFileSync(f, `#!/usr/bin/env node\n${s}`);
  fs.chmodSync(f, 0o755);
}

console.log(`${pkg.name}: built ${path.relative(dir, dist)}/`);
