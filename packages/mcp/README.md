# @openbone/mcp

An MCP server that lets AI agents create, rig, animate and wire up interactive OpenBone animations, then check their work with rendered frames, GIFs and state-machine simulations.

Part of [OpenBone](https://github.com/UXCentury/open-bone), open-source 2D skeletal animation with interactive state machines and an MCP server. MIT licensed.

## Use

Add it to your MCP client (Claude Desktop, Claude Code, Cursor, …):

```json
{ "mcpServers": { "openbone": { "command": "npx", "args": ["-y", "@openbone/mcp"] } } }
```

Or run it yourself: `npx @openbone/mcp [--project file.obone] [--http 7718] [--no-bridge]` (stdio by default). Needs Node.js 20 or newer.

See the [MCP guide](https://github.com/UXCentury/open-bone/blob/main/docs/mcp.md) for the tools and the editor bridge.
