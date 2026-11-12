import type { PackFile } from "./engines.ts";
import { toBase64 } from "./webview.ts";
import { createZip } from "./zip.ts";

/**
 * Web export: everything a website needs to show an OpenBone animation with `<openbone-player>`:
 * the player library (classic script or ES module, minified or readable), the animation file, a demo page and a
 * README with embed snippets. Or one self-contained HTML file with the player and the animation inlined.
 */

export type WebPlayerFormat = "iife" | "esm";

export interface WebPackOptions {
  /** Page title and README heading. */
  title: string;
  /** File-name stem for the animation and the single-file page (already safe for file names). */
  baseName: string;
  /** Player library source (from the web bundle build). */
  playerCode: string;
  format: WebPlayerFormat;
  minified: boolean;
  /** Scripts can run: the bundle includes the QuickJS sandbox, or loads it from `scriptsAddon`'s files. */
  scripts: boolean;
  /**
   * The sandbox as separate files (`openbone-scripts.js` + `quickjs.wasm`) that the player loads only when an
   * animation has scripts. ZIP packs only; single-file pages inline the sandbox in the player instead.
   */
  scriptsAddon?: { code: string; wasm: Uint8Array };
  /** Animation file bytes and extension. */
  doc: Uint8Array;
  docExt: "obone" | "obonb";
  /** One HTML file with the player and animation inlined (works from file://, no server needed). */
  singleFile: boolean;
  /** Demo page gets buttons/inputs for the state machine's inputs and an event log. */
  demoControls: boolean;
  stateMachine?: string;
  animation?: string;
  /** Artboard size: the page keeps its aspect ratio. */
  width: number;
  height: number;
  /** Player background ("transparent" or a colour); undefined = the document's background. */
  background?: string;
  inputs: { name: string; type: "bool" | "number" | "trigger" | "string" }[];
  hasScripts: boolean;
  hasAudio: boolean;
  /** Names of the sound buses ("music", "sfx"…): the demo page gets a mute button for each. */
  buses?: string[];
}

const text = (s: string) => new TextEncoder().encode(s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Keep inlined code from closing its <script> early. */
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

/** Name of the player file in the pack. */
export function playerFileName(o: Pick<WebPackOptions, "format" | "minified">): string {
  return `openbone-player${o.minified ? ".min" : ""}.${o.format === "esm" ? "mjs" : "js"}`;
}

function playerAttrs(o: WebPackOptions, src: string): string {
  const attrs: [string, string | undefined][] = [
    ["id", "player"],
    ["src", src],
    ["state-machine", o.stateMachine],
    ["animation", o.stateMachine ? undefined : o.animation],
    ["background", o.background],
    ["scripts", o.hasScripts && !o.scripts ? "none" : undefined],
  ];
  return attrs
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${esc(v!)}"`)
    .join(" ");
}

function controlsScript(o: WebPackOptions): string {
  if (!o.demoControls) return "";
  return `
    // Demo controls: one control per state machine input, plus a log of events and state changes.
    const player = document.getElementById("player");
    const controls = document.getElementById("controls");
    const log = document.getElementById("log");
    const inputs = ${JSON.stringify(o.inputs)};
    const add = (el) => controls.append(el);
    // Sound: mute buttons for everything and for each bus, the same as player.setMuted / player.toggleBus in your page.
    const buses = ${JSON.stringify(o.hasAudio ? (o.buses ?? []) : []).replace(/</g, "\\u003c")};
    if (${o.hasAudio ? "true" : "false"}) {
      const muteButton = (label, isMuted, toggle) => {
        const b = document.createElement("button");
        const show = () => { const m = isMuted(); b.textContent = (m ? "🔇 " : "🔊 ") + label; b.setAttribute("aria-pressed", String(!!m)); };
        b.onclick = () => { toggle(); show(); };
        player.addEventListener("openbone-load", show);
        show();
        add(b);
      };
      let allMuted = player.hasAttribute("muted");
      muteButton("All sound", () => allMuted, () => { allMuted = !allMuted; player.setMuted(allMuted); });
      for (const bus of buses) muteButton(bus, () => player.isBusMuted(bus), () => player.toggleBus(bus));
    }
    for (const i of inputs) {
      const label = document.createElement("label");
      label.textContent = i.name + " ";
      if (i.type === "trigger") {
        const b = document.createElement("button");
        b.textContent = "Fire " + i.name;
        b.onclick = () => player.fire(i.name);
        add(b);
        continue;
      }
      const input = document.createElement("input");
      if (i.type === "bool") {
        input.type = "checkbox";
        input.onchange = () => player.setInput(i.name, input.checked);
      } else if (i.type === "number") {
        input.type = "number";
        input.step = "0.01";
        input.value = "0";
        input.oninput = () => player.setInput(i.name, Number(input.value));
      } else {
        input.type = "text";
        input.oninput = () => player.setInput(i.name, input.value);
      }
      label.append(input);
      add(label);
    }
    const line = (s) => {
      const div = document.createElement("div");
      div.textContent = s;
      log.prepend(div);
      while (log.children.length > 50) log.lastChild.remove();
    };
    player.addEventListener("openbone-event", (e) => line("event " + e.detail.name));
    player.addEventListener("openbone-state", (e) => line("state " + (e.detail.from ?? "-") + " -> " + e.detail.to));
    player.addEventListener("openbone-load", () => line("loaded"));`;
}

/** The demo / embed page. */
export function webIndexHtml(o: WebPackOptions): string {
  const playerFile = playerFileName(o);
  const docSrc = o.singleFile ? `data:application/octet-stream;base64,${toBase64(o.doc)}` : `${o.baseName}.${o.docExt}`;
  const loader = o.singleFile
    ? o.format === "esm"
      ? `<script type="module">\n${inlineScript(o.playerCode)}\n</script>`
      : `<script>\n${inlineScript(o.playerCode)}\n</script>`
    : o.format === "esm"
      ? `<script type="module" src="./${playerFile}"></script>`
      : `<script src="./${playerFile}"></script>`;
  const ratio = `${o.width} / ${o.height}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(o.title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; gap: 16px; padding: 16px; box-sizing: border-box;
      font: 14px/1.4 system-ui, sans-serif; background: #f4f5f7; color: #1f2430; }
    openbone-player { width: min(100%, ${o.width}px); height: auto; aspect-ratio: ${ratio}; }
${o.demoControls ? `    #controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; }
    #controls label { display: inline-flex; gap: 6px; align-items: center; }
    #log { font: 12px ui-monospace, monospace; max-height: 140px; overflow: auto; width: min(100%, 520px); color: #59607a; }
` : ""}  </style>
  ${loader}
</head>
<body>
  <openbone-player ${playerAttrs(o, docSrc)}></openbone-player>
${o.demoControls ? `  <div id="controls"></div>\n  <div id="log"></div>\n` : ""}${o.demoControls ? `  <script${o.format === "esm" ? ' type="module"' : ""}>${controlsScript(o)}\n  </script>\n` : ""}</body>
</html>
`;
}

/** README for the pack: what is inside and how to embed it. */
export function webReadme(o: WebPackOptions): string {
  const playerFile = playerFileName(o);
  const sm = o.stateMachine ? ` state-machine="${o.stateMachine}"` : o.animation ? ` animation="${o.animation}"` : "";
  const docFile = `${o.baseName}.${o.docExt}`;
  const tag = `<openbone-player src="${docFile}"${sm} style="width:${o.width}px;height:${o.height}px"></openbone-player>`;
  const firstTrigger = o.inputs.find((i) => i.type === "trigger");
  const firstValue = o.inputs.find((i) => i.type !== "trigger");
  const exampleValue = firstValue ? (firstValue.type === "bool" ? "true" : firstValue.type === "number" ? "1" : '"Hello"') : "";
  return `# ${o.title}: web export

Made with [OpenBone](https://github.com/UXCentury/open-bone). Open \`index.html\` to try it.
${o.singleFile ? "" : "\n> Serve this folder over http(s) (for example `npx serve .` or `python3 -m http.server`). Browsers block loading the animation file from `file://`. Need a page that works by double-clicking? Export again with **Single HTML file**.\n"}
## What's inside

| File | What it is |
|---|---|
| \`index.html\` | Demo page${o.demoControls ? " with controls for the inputs and an event log" : ""}${o.singleFile ? ", with the player and the animation inlined" : ""} |
${o.singleFile ? "" : `| \`${playerFile}\` | The player library, ${o.format === "esm" ? "ES module" : "classic script"}, ${o.minified ? "minified" : "readable (not minified)"}${o.scripts && !o.scriptsAddon ? ", with the script sandbox (QuickJS)" : ""} |\n${o.scriptsAddon ? "| `openbone-scripts.js`, `quickjs.wasm` | The script sandbox. The player loads them from its own folder, and only for animations with scripts |\n" : ""}| \`${docFile}\` | The animation (${o.docExt === "obonb" ? "binary" : "JSON"}) |\n`}| \`README.md\` | This file |
${o.scripts ? "| `THIRD-PARTY-NOTICES.txt` | Licences of bundled code |\n" : ""}
## Embed it in your site

${o.format === "esm" ? `\`\`\`html\n<script type="module" src="${playerFile}"></script>\n${tag}\n\`\`\`\n\nOr import it in your own module (the import also defines the element):\n\n\`\`\`js\nimport { Player, parseDocument } from "./${playerFile}";\n\`\`\`` : `\`\`\`html\n<script src="${playerFile}"></script>\n${tag}\n\`\`\`\n\nThe script defines \`<openbone-player>\` and a global \`OpenBone\` (\`OpenBone.Player\`, \`OpenBone.parseDocument\`, \`OpenBone.version\`).`}

### Attributes

| Attribute | Meaning |
|---|---|
| \`src\` | URL of the \`.obone\` / \`.obonb\` file |
| \`state-machine\` | State machine to run (default: the first) |
| \`animation\` | Play an animation instead of a state machine |
| \`skin\` | Skin (outfit) to show; change it any time |
| \`fit\` | \`contain\` (default), \`cover\`, \`auto\` (cover unless it would crop more than 15%) or \`none\` |
| \`clip\` | \`false\` to draw past the artboard's edges (by default only the artboard shows) |
| \`fullscreen-fit\` | Fit while full screen: \`auto\` (default: fills the screen unless that crops more than 15%), \`cover\`, \`contain\`, \`none\` or \`same\` (keep \`fit\`) |
| \`renderer\` | \`webgl\` (default, falls back to canvas) or \`canvas\` |
| \`background\` | A colour, or omit for the file's background |
| \`autoplay\` | \`false\` to start paused |
| \`muted\` / \`audio="off"\` | Start muted / disable audio (audio starts after the first click or key press) |
| \`scripts\` | \`none\` to skip document scripts |

### JavaScript

\`\`\`js
const player = document.querySelector("openbone-player");
${firstValue ? `player.setInput("${firstValue.name}", ${exampleValue});\n` : 'player.setInput("speed", 1);\n'}${firstTrigger ? `player.fire("${firstTrigger.name}");\n` : ""}player.setText("slotName", "Hello"); // override a text attachment
${o.hasAudio ? `player.setMuted(true); // mute everything
player.toggleBus(${JSON.stringify(o.buses?.find((b) => b === "music") ?? o.buses?.[0] ?? "music")}); // mute or unmute one sound bus (also setBusMuted(bus, true | false))
` : ""}
player.addEventListener("openbone-event", (e) => console.log("event", e.detail.name));
player.addEventListener("openbone-state", (e) => console.log("state", e.detail.to));
\`\`\`
${o.inputs.length ? `\nInputs of this animation: ${o.inputs.map((i) => `\`${i.name}\` (${i.type})`).join(", ")}.\n` : ""}${o.scriptsAddon ? "\n> Keep `openbone-scripts.js` and `quickjs.wasm` next to the player (or set `window.OPENBONE_SCRIPTS_BASE` to their folder before the player loads an animation). Pages whose animations have no scripts never download them.\n" : ""}${o.hasScripts && !o.scripts ? "\n> This animation has scripts, but this player build has no script sandbox, so they are skipped. Export with **Include script sandbox** to run them.\n" : ""}
## License

The player is MIT licensed (OpenBone).${o.scripts ? " It includes quickjs-emscripten (MIT); see THIRD-PARTY-NOTICES.txt." : ""}
`;
}

const NOTICES = `OpenBone web player: MIT License, https://github.com/UXCentury/open-bone

This build includes:

quickjs-emscripten (MIT License), https://github.com/justjake/quickjs-emscripten
  Copyright (c) 2019 Jake Teton-Landis
QuickJS (MIT License), https://bellard.org/quickjs/
  Copyright (c) 2017-2021 Fabrice Bellard, Charlie Gordon
`;

/** Files of the web pack. Single-file packs contain just the HTML page (and the README). */
export function webPackFiles(o: WebPackOptions): PackFile[] {
  const files: PackFile[] = [{ name: "index.html", data: text(webIndexHtml(o)) }];
  if (!o.singleFile) {
    files.push({ name: playerFileName(o), data: text(o.playerCode) });
    files.push({ name: `${o.baseName}.${o.docExt}`, data: o.doc });
    if (o.scriptsAddon) {
      files.push({ name: "openbone-scripts.js", data: text(o.scriptsAddon.code) });
      files.push({ name: "quickjs.wasm", data: o.scriptsAddon.wasm });
    }
  }
  files.push({ name: "README.md", data: text(webReadme(o)) });
  if (o.scripts) files.push({ name: "THIRD-PARTY-NOTICES.txt", data: text(NOTICES) });
  return files;
}

/** The web pack as a ZIP, with everything inside a folder named after the animation. */
export function webPackZip(o: WebPackOptions): Uint8Array {
  return createZip(webPackFiles(o).map((f) => ({ name: `${o.baseName}-web/${f.name}`, data: f.data })));
}
