# @openbone/mcp

An MCP server that lets AI agents build, rig, animate and wire up interactive OpenBone animations, and check their work.

[![npm](https://img.shields.io/npm/v/@openbone/mcp)](https://www.npmjs.com/package/@openbone/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging, Rive-style
interactive state machines and native runtimes for many engines. This package exposes the editor's own editing
operations as [Model Context Protocol](https://modelcontextprotocol.io) tools. An agent can create a project, add
bones, art, constraints, animations, state machines and sound, then render frames, simulate input and export the
result. Every edit op in `@openbone/core` becomes a tool automatically, so the agent can do what the editor can.

## Install

Needs Node.js 20 or newer. MCP clients usually start the server with `npx`, so there is nothing to install:

```bash
npx -y @openbone/mcp
```

To keep a copy around: `npm install -g @openbone/mcp`, which installs the `openbone-mcp` command.

## Quick start

Claude Code:

```bash
claude mcp add openbone -- npx -y @openbone/mcp
```

Claude Desktop, Cursor and other clients that use an `mcpServers` JSON file:

```json
{
  "mcpServers": {
    "openbone": { "command": "npx", "args": ["-y", "@openbone/mcp"] }
  }
}
```

Then ask, for example: *"Create a project at ~/anim/robot.obone: a robot with IK arms, an idle and a wave animation,
and a state machine that waves when clicked. Check it with render_frame."*

To watch the agent work, open the OpenBone editor and click **⚡ Connect MCP** in the toolbar (see
[Transports](#transports)).

## What an agent can do

- Create or open `.obone` projects. A project with a file path is saved after every edit.
- Build a rig: bones, slots, skins, regions, meshes (with automatic weights), shapes, paths, clipping masks, bounding
  boxes, IK, transform, path and physics constraints, sliders.
- Animate: keys on any property, curves, events, sprite sequences, particles, text, lip sync from a WAV file.
- Make it interactive: state machines with inputs, layers, blend states, transitions, pointer listeners, bindings and
  JavaScript scripts.
- Add sound: audio assets, sounds, buses, audio keys, sounds on events and states.
- Check the work: render a PNG (bones and hit boxes drawn on top), render a GIF, run a state machine headlessly and read
  the log of states, events, inputs and audio commands, read bone world positions, get size and draw-call statistics.
- Export everything the editor's Export dialog makes (see [Tools](#tools)).

## Options

| Flag | Default | What it does |
|---|---|---|
| `--project <file.obone>` | none | Open this file at startup. If it does not exist, a new empty project is created and saved there. |
| `--http <port>` | off (stdio) | Serve MCP over Streamable HTTP at `http://127.0.0.1:<port>/mcp` instead of stdio. |
| `--no-bridge` | bridge on | Do not start the WebSocket bridge for the editor. |
| `--bridge-port <port>` | `7717` | Port of the WebSocket bridge. The `OPENBONE_BRIDGE_PORT` environment variable does the same. |

Pass options after the package name, for example `npx -y @openbone/mcp --project ~/anim/hero.obone --no-bridge`. In a
JSON config, add them to `args`.

If the `--project` file exists but can't be read as an OpenBone document, the server stops with the reason and leaves
the file unchanged. The `new_project` tool likewise refuses to replace an existing file unless it is called with
`overwrite: true`.

## Transports

| Transport | Address | Notes |
|---|---|---|
| stdio | standard input and output | The default. Logs go to standard error. |
| Streamable HTTP | `http://127.0.0.1:<port>/mcp` | With `--http <port>`. Stateless: every request gets a fresh MCP server, and all requests share one open project. Other paths return 404. |
| WebSocket bridge | `ws://127.0.0.1:7717` | For the editor, not for MCP clients. Starts with either transport unless you pass `--no-bridge`. |

The bridge keeps the editor and the server in sync. When the editor connects (**⚡ Connect MCP**), the server sends its
document. After that, the agent's edits appear in the editor as they happen, and your edits in the editor are applied on
the server, so the agent sees them. Undo and redo in the editor are forwarded to the server. The server is the source of
truth: if an op from the editor fails, the editor is reloaded from the server's document.

The editor connects to `ws://127.0.0.1:7717`. If that port is taken (for example by a second server), the new server
logs a bridge error and keeps running without the bridge.

## Tools

| Group | Tools |
|---|---|
| Project | `new_project`, `open_project`, `save_project`, `get_summary`, `get_document`, `validate`, `undo`, `redo`, `get_guide`, `import_image` (PNG, JPEG, WebP), `import_audio` (WAV, MP3, OGG), plus the project ops: `set_document`, `add_image`, `set_atlas`, `import_data`, … |
| Rig | `add_bone`, `update_bone`, `add_slot`, `add_skin`, `duplicate_skin`, `add_to_skin`, … |
| Attachments | `add_region`, `add_mesh`, `add_linked_mesh`, `add_shape`, `add_path`, `add_clipping`, `add_bounding_box`, `add_point`, `add_text`, `add_sequence`, `add_particles`, `auto_weights`, `set_weights`, `smooth_weights`, `prune_weights`, … |
| Constraints | `add_ik_constraint`, `add_transform_constraint`, `add_path_constraint`, `add_physics_constraint`, `set_constraint_order`, `add_slider`, … |
| Animation | `create_animation`, `set_keys`, `move_key`, `transform_keys`, `paste_keys`, `add_event`, `add_event_key`, … |
| Interactivity | `create_state_machine`, `add_layer`, `add_input`, `add_state`, `add_transition`, `add_listener`, `add_binding`, `add_script`, `attach_script`, `set_state_emitter`, … |
| Audio | `add_sound`, `add_bus`, `set_audio_mix`, `add_audio_key`, `set_event_sound`, `set_state_sound`, … |
| Rigging helpers | `trace_mesh` (replace a region with a mesh traced from its image), `pose_bones` (bend a chain so a bone's tip reaches a point), `lip_sync` (key a mouth slot to a WAV sound) |
| Atlas and export | `pack_atlas` (pack images into atlas pages), `export_file` (formats `obone`, `json`, `obonb`, `atlas`, `png`, `jpeg`, `apng`, `gif`, `psd`, `avi`, `mov`, `spritesheet`, `web`) |
| Checking the work | `render_frame` (PNG), `render_gif`, `simulate_state_machine`, `inspect_pose`, `get_stats` |

The edit tools are generated from the core ops, so the list grows with the editor. To list every op with its group and
description, run `npx openbone ops`. Tool names are the op names in snake case (`addBone` becomes `add_bone`).

The server also has three resources, `openbone://guide` (the authoring guide), `openbone://document` and
`openbone://summary`, and two prompts, `rig_character` and `interactive_button`.

## Security

- The server is meant for your own machine. Both the HTTP transport and the bridge listen on `127.0.0.1` only, so
  other machines can't reach them.
- Web pages can't use them either: both refuse browser requests unless they come from the OpenBone editor (a page on
  `localhost`, `127.0.0.1` or `[::1]`, or the desktop app) and are addressed to a loopback name, which also blocks DNS
  rebinding. MCP clients and scripts, which send no `Origin` header, are allowed. There is no other authentication, so
  any program running as your user can connect; use `--no-bridge` when you don't need the editor link.
- Tools can read and write any file your user account can. There is no folder sandbox:
  - `open_project`, `import_image` and `import_audio` read the path they are given (relative paths resolve against the
    server's working directory).
  - `new_project` and `save_project` write the `.obone` file at the path they are given.
  - `render_gif` and `export_file` write their output to `out`, relative to the project's folder (next to the project
    by default).
  - Rendering reads the project's images from disk relative to the project file. Image sources that are `http(s)` URLs
    are loaded from the network.
- State-machine scripts (in `render_frame`, `render_gif`, `simulate_state_machine` and exports) run in a QuickJS
  sandbox with a memory cap and a time limit per call. They only see the `ob` API, not the file system or the network.

## Documentation

- [MCP guide](https://github.com/UXCentury/open-bone/blob/main/docs/mcp.md)
- [OpenBone README](https://github.com/UXCentury/open-bone/blob/main/README.md)
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Command line (`@openbone/cli`)](https://github.com/UXCentury/open-bone/blob/main/packages/cli/README.md)
- [Changelog](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/UXCentury/open-bone/blob/main/SECURITY.md)

## License

[MIT](https://github.com/UXCentury/open-bone/blob/main/LICENSE) © UX Century and OpenBone contributors
