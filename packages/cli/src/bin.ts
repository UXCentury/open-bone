#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from "node:fs/promises";
import { DocumentStore, deserialize, registry, serialize, summarize, validate } from "@openbone/core";
import { ProjectSession, pose, renderGif, renderPng } from "@openbone/mcp";
import { createQuickJsHost } from "@openbone/scripting";

const HELP = `openbone — OpenBone command line

Usage:
  openbone validate <file.obone>
  openbone summary  <file.obone>
  openbone render   <file.obone> [--animation walk] [--time 0.5] [--scale 1] [--bones] --out frame.png
  openbone gif      <file.obone> (--animation walk | --state-machine ui) [--duration 2] [--fps 20] [--scale 0.5] --out out.gif
  openbone simulate <file.obone> --steps '[{"setInputs":{"speed":1},"advance":1},{"fire":["jump"],"advance":1}]' [--state-machine name]
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

async function main() {
  switch (cmd) {
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
