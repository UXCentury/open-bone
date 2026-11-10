# @openbone/cli

The OpenBone command line: validate, summarize, render, export and edit `.obone` files, and start the MCP server. Also published as [`openbone`](https://www.npmjs.com/package/openbone), so `npx openbone` works.

Part of [OpenBone](https://github.com/UXCentury/open-bone), open-source 2D skeletal animation with interactive state machines and an MCP server. MIT licensed.

## Use

```bash
npx openbone validate hero.obone
npx openbone render hero.obone --animation walk --time 0.5 --out frame.png
npx openbone export "art/*.obone" --format gif --animation walk --out out/
npx openbone mcp
```

Run `openbone` without arguments for every command and option. Needs Node.js 20 or newer.
