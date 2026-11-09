#!/usr/bin/env -S npx tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentStore, deserialize, registry, serialize, summarize, validate } from "@openbone/core";
import { EXPORT_FORMATS, type ExportFormat, ProjectSession, exportBaseName, exportFile, pose, renderGif, renderPng } from "@openbone/mcp";
import { expandGlob } from "./glob.ts";
import { createQuickJsHost } from "@openbone/scripting";

const HELP = `openbone — OpenBone command line

Usage:
  openbone validate <file.obone>
  openbone summary  <file.obone>
  openbone render   <file.obone> [--animation walk] [--time 0.5] [--scale 1] [--bones] --out frame.png
  openbone gif      <file.obone> (--animation walk | --state-machine ui) [--duration 2] [--fps 20] [--scale 0.5] --out out.gif
  openbone simulate <file.obone> --steps '[{"setInputs":{"speed":1},"advance":1},{"fire":["jump"],"advance":1}]' [--state-machine name]
  openbone export   <file or glob>... --format <format> --out <dir> [options]
      formats: ${EXPORT_FORMATS.join(" | ")}
      options: --animation walk  --skin name  --scale 1  --fps 30  --duration 2  --time 0
               --state-machine ui  --transparent  --sequence (png/jpeg: every frame, ZIP)
               --engine unity|godot|flutter|generic (spritesheet)  --single-file (web)  --binary
               --pack (json/obonb/web: embed an atlas)  atlas: --padding 2 --max-size 2048 --no-pot
               --rotate --atlas-scale 0.5|auto --strip-whitespace --polygons --premultiplied
  openbone apply    <file.obone> <op> '<json args>'     (edit a file with any op, e.g. addBone)
  openbone ops                                          (list every edit op with its description)
  openbone mcp [--project file.obone] [--http 7718]     (start the MCP server)
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const file = argv[1];
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string, d?: number) => (opt(name) !== undefined ? Number(opt(name)) : d);

async function session(): Promise<ProjectSession> {
  if (!file) throw new Error("Missing <file.obone>");
  const s = new ProjectSession();
  await s.open(file);
  s.autosave = false;
  return s;
}

/** Flags that take no value (everything else starting with -- takes the next argument). */
const SWITCHES = new Set(["bones", "transparent", "sequence", "single-file", "binary", "pack", "no-pot", "rotate", "strip-whitespace", "polygons", "premultiplied", "no-minify"]);

/** Positional arguments after the command (files and globs), skipping option values. */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!SWITCHES.has(a.slice(2))) i++;
    } else out.push(a);
  }
  return out;
}

/** A path relative to the working folder when it is inside it, else absolute. */
const shortPath = (p: string) => {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};

async function exportCommand() {
  const format = opt("format") as ExportFormat | undefined;
  if (!format || !EXPORT_FORMATS.includes(format)) throw new Error(`--format must be one of: ${EXPORT_FORMATS.join(", ")}`);
  const patterns = positionals();
  if (!patterns.length) throw new Error("Usage: openbone export <file or glob>... --format <format> --out <dir>");
  const files = [...new Set((await Promise.all(patterns.map((p) => expandGlob(p)))).flat())].filter((f) => /\.(obone|obonb)$/i.test(f));
  if (!files.length) throw new Error(`No .obone files match ${patterns.join(" ")}`);
  const outDir = path.resolve(opt("out") ?? ".");
  await mkdir(outDir, { recursive: true });
  const flag = (n: string) => argv.includes(`--${n}`);
  const atlasScale = opt("atlas-scale");
  const host = (() => {
    let h: ReturnType<typeof createQuickJsHost> | null = null;
    return () => (h ??= createQuickJsHost());
  })();
  let failed = 0;
  for (const file of files) {
    try {
      const s = new ProjectSession();
      await s.open(file);
      s.autosave = false;
      const r = await exportFile(
        s,
        {
          format,
          animation: opt("animation"),
          animations: opt("animations")?.split(","),
          stateMachine: opt("state-machine"),
          steps: opt("steps") ? JSON.parse(opt("steps")!) : undefined,
          skin: opt("skin"),
          scale: num("scale"),
          fps: num("fps"),
          duration: num("duration"),
          time: num("time"),
          transparent: flag("transparent"),
          sequence: flag("sequence"),
          engine: opt("engine") as never,
          singleFile: flag("single-file"),
          minify: !flag("no-minify"),
          binary: flag("binary") ? true : undefined,
          pack: flag("pack"),
          atlas: {
            padding: num("padding"),
            maxSize: num("max-size"),
            powerOfTwo: !flag("no-pot"),
            rotate: flag("rotate"),
            scale: atlasScale === "auto" ? "auto" : atlasScale ? Number(atlasScale) : undefined,
            stripWhitespace: flag("strip-whitespace"),
            polygons: flag("polygons"),
            premultipliedAlpha: flag("premultiplied"),
          },
        },
        host,
      );
      const out = path.join(outDir, `${exportBaseName(s)}${r.suffix}.${r.ext}`);
      await writeFile(out, r.bytes);
      console.log(`wrote ${shortPath(out)} (${(r.bytes.length / 1024).toFixed(1)} KB)${r.note}`);
    } catch (e) {
      failed++;
      console.error(`error: ${shortPath(file)}: ${(e as Error).message}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${files.length} file(s) failed`);
    process.exitCode = 1;
  }
}

async function main() {
  switch (cmd) {
    case "export":
      await exportCommand();
      break;
    case "validate": {
      const s = await session();
      const issues = validate(s.doc);
      for (const i of issues) console.log(`${i.level.toUpperCase()} ${i.path}: ${i.message}`);
      console.log(issues.length ? `${issues.length} issue(s)` : "OK");
      process.exitCode = issues.some((i) => i.level === "error") ? 1 : 0;
      break;
    }
    case "summary":
      console.log(summarize((await session()).doc));
      break;
    case "render": {
      const s = await session();
      const { png } = await renderPng(s, { animation: opt("animation"), time: num("time"), scale: num("scale", 1), showBones: argv.includes("--bones"), stateMachine: opt("state-machine") }, await createQuickJsHost());
      const out = opt("out") ?? "frame.png";
      await writeFile(out, png);
      console.log(`wrote ${out}`);
      break;
    }
    case "gif": {
      const s = await session();
      const gif = await renderGif(
        s,
        { animation: opt("animation"), stateMachine: opt("state-machine"), duration: num("duration", 2)!, fps: num("fps", 20)!, scale: num("scale", 0.5), steps: opt("steps") ? JSON.parse(opt("steps")!) : undefined },
        await createQuickJsHost(),
      );
      const out = opt("out") ?? "out.gif";
      await writeFile(out, gif);
      console.log(`wrote ${out} (${(gif.length / 1024).toFixed(0)} KB)`);
      break;
    }
    case "simulate": {
      const s = await session();
      const { log } = pose(s.doc, { stateMachine: opt("state-machine") ?? "", steps: JSON.parse(opt("steps") ?? "[{}]") }, await createQuickJsHost());
      console.log(log.join("\n"));
      break;
    }
    case "apply": {
      if (!file || !argv[2]) throw new Error("Usage: openbone apply <file> <op> '<json>'");
      const store = new DocumentStore(deserialize(await readFile(file, "utf8")));
      const result = store.apply(argv[2], JSON.parse(argv[3] ?? "{}"));
      await writeFile(file, serialize(store.doc));
      console.log(JSON.stringify(result));
      break;
    }
    case "ops":
      for (const d of registry.values()) console.log(`${d.name.padEnd(24)} [${d.group}] ${d.description}`);
      break;
    case "mcp": {
      process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];
      await import("@openbone/mcp/bin");
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
