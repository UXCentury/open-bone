import { describe, expect, it } from "vitest";
import { type WebPackOptions, playerFileName, webIndexHtml, webPackFiles, webPackZip, webReadme } from "../src/index.ts";

const base: WebPackOptions = {
  title: "Crash",
  baseName: "crash",
  playerCode: "/*! player */ var OpenBone={}; // </script> must not close the tag",
  format: "iife",
  minified: true,
  scripts: false,
  doc: new TextEncoder().encode('{"format":"openbone"}'),
  docExt: "obone",
  singleFile: false,
  demoControls: true,
  stateMachine: "game",
  width: 800,
  height: 500,
  inputs: [
    { name: "start", type: "trigger" },
    { name: "multiplier", type: "number" },
    { name: "status", type: "string" },
  ],
  hasScripts: false,
  hasAudio: false,
};
const names = (o: WebPackOptions) => webPackFiles(o).map((f) => f.name);

describe("web pack", () => {
  it("names the player file by format and minification", () => {
    expect(playerFileName({ format: "iife", minified: true })).toBe("openbone-player.min.js");
    expect(playerFileName({ format: "iife", minified: false })).toBe("openbone-player.js");
    expect(playerFileName({ format: "esm", minified: true })).toBe("openbone-player.min.mjs");
  });

  it("separate files: page, player, animation, readme", () => {
    expect(names(base)).toEqual(["index.html", "openbone-player.min.js", "crash.obone", "README.md"]);
    const html = webIndexHtml(base);
    expect(html).toContain('<script src="./openbone-player.min.js"></script>');
    expect(html).toContain('src="crash.obone"');
    expect(html).toContain('state-machine="game"');
    expect(html).toContain("aspect-ratio: 800 / 500");
    expect(html).toContain('"name":"multiplier"');
  });

  it("ES module pages load the player as a module", () => {
    const o = { ...base, format: "esm" as const, minified: false };
    expect(names(o)).toContain("openbone-player.mjs");
    expect(webIndexHtml(o)).toContain('<script type="module" src="./openbone-player.mjs"></script>');
  });

  it("single file inlines the player safely and embeds the animation as a data URL", () => {
    const o = { ...base, singleFile: true };
    expect(names(o)).toEqual(["index.html", "README.md"]);
    const html = webIndexHtml(o);
    expect(html).toContain("<\\/script> must not close the tag");
    expect(html.match(/<\/script>/g)!.length).toBe(2); // the player tag and the controls tag only
    expect(html).toContain(`src="data:application/octet-stream;base64,${btoa('{"format":"openbone"}')}"`);
  });

  it("adds third-party notices with the sandbox and warns when scripts are skipped", () => {
    expect(names({ ...base, scripts: true })).toContain("THIRD-PARTY-NOTICES.txt");
    const readme = webReadme({ ...base, hasScripts: true, scripts: false });
    expect(readme).toContain("no script sandbox");
    expect(webIndexHtml({ ...base, hasScripts: true, scripts: false })).toContain('scripts="none"');
    expect(readme).toContain('player.fire("start")');
    expect(readme).toContain("Serve this folder over http");
  });

  it("zips everything under one folder", () => {
    const zip = webPackZip(base);
    const v = new DataView(zip.buffer, zip.byteOffset);
    expect(v.getUint16(zip.length - 12, true)).toBe(4);
    const nameLen = v.getUint16(26, true);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe("crash-web/index.html");
  });
});
