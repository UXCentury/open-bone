# openbone

The OpenBone command line under a short name, so `npx openbone` works.

[![npm](https://img.shields.io/npm/v/openbone)](https://www.npmjs.com/package/openbone)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging, Rive-style
interactive state machines and native runtimes for many engines. This package is a thin wrapper: it installs the
`openbone` command and runs [`@openbone/cli`](https://www.npmjs.com/package/@openbone/cli). The commands and options
are the same, and they are documented there.

## Install

Needs Node.js 20 or newer.

```bash
npx openbone <command>         # no install
npm install -g openbone        # or install the command globally
```

## Quick start

```bash
npx openbone validate hero.obone
npx openbone render hero.obone --animation walk --time 0.5 --out frame.png
npx openbone simulate hero.obone --steps '[{"setInputs":{"speed":1},"advance":1}]'
npx openbone export "art/*.obone" --format gif --animation walk --out build/
npx openbone mcp               # the MCP server on stdio
```

Run `npx openbone` with no arguments for the full usage text. Commands: `validate`, `summary`, `render`, `gif`,
`simulate`, `export`, `apply`, `ops` and `mcp`.

To add the MCP server to an AI client, use [`@openbone/mcp`](https://www.npmjs.com/package/@openbone/mcp) directly
(`npx -y @openbone/mcp`).

## Documentation

- [Command line reference (`@openbone/cli`)](https://github.com/UXCentury/open-bone/blob/main/packages/cli/README.md)
- [MCP server (`@openbone/mcp`)](https://github.com/UXCentury/open-bone/blob/main/packages/mcp/README.md)
- [OpenBone README](https://github.com/UXCentury/open-bone/blob/main/README.md)

## License

[MIT](https://github.com/UXCentury/open-bone/blob/main/LICENSE) © UX Century and OpenBone contributors
