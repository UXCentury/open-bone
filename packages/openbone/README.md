# openbone

The OpenBone command line, so `npx openbone` works. It is a thin wrapper around [`@openbone/cli`](https://www.npmjs.com/package/@openbone/cli).

Part of [OpenBone](https://github.com/UXCentury/open-bone), open-source 2D skeletal animation with interactive state machines and an MCP server. MIT licensed.

## Use

```bash
npx openbone validate hero.obone
npx openbone render hero.obone --animation walk --time 0.5 --out frame.png
npx openbone export "art/*.obone" --format gif --animation walk --out out/
npx openbone mcp            # the MCP server (stdio)
```

Run `npx openbone` without arguments for every command and option. Needs Node.js 20 or newer.
