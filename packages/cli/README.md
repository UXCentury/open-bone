# @openbone/cli

The OpenBone command line: validate, inspect, render, simulate, export and edit `.obone` files, and start the MCP server.

[![npm](https://img.shields.io/npm/v/@openbone/cli)](https://www.npmjs.com/package/@openbone/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging, Rive-style
interactive state machines and native runtimes for many engines. This package installs the `openbone` command. It runs
the same code as the editor's Export dialog and the MCP server, so all three produce the same files. Use it in build
scripts and CI, or to check an animation without opening the editor.

It is also published unscoped as [`openbone`](https://www.npmjs.com/package/openbone), so `npx openbone` works.

## Install

Needs Node.js 20 or newer.

```bash
npm install -g @openbone/cli      # then: openbone <command>
npm install -D @openbone/cli      # per project, for npm scripts
npx openbone <command>            # no install
```

## Quick start

```bash
openbone validate hero.obone
openbone render hero.obone --animation walk --time 0.5 --out frame.png
openbone export "art/*.obone" --format gif --animation walk --out build/
```

Run `openbone --help` for the full usage text, or `openbone <command> --help` for one command.

## Commands

| Command | What it does |
|---|---|
| `validate <file>` | Check for broken references and other problems. Prints each issue, or `OK`. Exits with 1 if there is an error. |
| `summary <file>` | Print an outline: artboard, bones, slots, images, events, animations, state machines (inputs, states, transitions, listeners), audio and scripts. |
| `render <file>` | Render one frame to a PNG. |
| `gif <file>` | Render an animation, or a state machine run, to an animated GIF. |
| `simulate <file>` | Run a state machine headlessly and print a log of state changes, inputs, events and audio commands. |
| `export <files or globs>...` | Export one or more files in any [export format](#export-formats). |
| `apply <file> <op> '<json>'` | Apply one edit op to a file and save it in place. Prints the op's result. |
| `ops` | List every edit op with its group and description. |
| `mcp` | Start the MCP server (see [`@openbone/mcp`](https://www.npmjs.com/package/@openbone/mcp)). |

### validate, summary

```bash
openbone validate hero.obone
openbone summary hero.obone
```

### render

```bash
openbone render hero.obone --out setup.png                               # setup pose
openbone render hero.obone --animation walk --time 0.5 --out frame.png
openbone render hero.obone --bones --scale 0.5 --out rig.png             # draw bones on top
openbone render hero.obone --state-machine main --out sm.png             # state machine's first frame
```

Options: `--animation`, `--time` (seconds), `--scale` (default 1), `--bones`, `--state-machine`, `--out` (default
`frame.png`).

### gif

```bash
openbone gif hero.obone --animation walk --duration 1 --fps 15 --out walk.gif
openbone gif button.obone --state-machine ui \
  --steps '[{"setInputs":{"hover":true},"advance":1},{"fire":["press"],"advance":1}]' --out button.gif
```

Options: `--animation` or `--state-machine`, `--steps`, `--duration` (default 2 s), `--fps` (default 20), `--scale`
(default 0.5), `--out` (default `out.gif`).

### simulate

```bash
openbone simulate walker.obone --state-machine character \
  --steps '[{"setInputs":{"walk":true,"speed":1},"advance":1},{"fire":["jump"],"advance":1}]'
```

`--steps` is a JSON array. Each step can set inputs (`setInputs`), fire triggers (`fire`), send a pointer event
(`pointer: {"type":"down","x":200,"y":100}`, in artboard pixels, y down) and then advance time (`advance`, in seconds).
Without `--state-machine`, the first state machine runs. The output ends with the final states and input values:

```text
t=0.000 [Layer 1] ∅ → locomotion
t=0.000 input walk = true
t=0.017 event footstep (from walk) int=0 float=0 "front"
t=1.000 [Layer 1] locomotion → jump
...
final states: {"Layer 1":"jump"}; inputs: {"walk":true,"speed":1,"jump":false}
```

### export

```bash
openbone export hero.obone --format obonb --out build/
openbone export "art/*.obone" --format gif --animation idle --out previews/
openbone export button.obone --format web --single-file --state-machine ui --out site/
openbone export hero.obone --format spritesheet --engine godot --animations walk,idle --scale 0.5 --out sheets/
openbone export hero.obone --format atlas --binary --atlas-scale auto --max-size 1024 --out build/
```

Quote globs so the shell does not expand them. Each output is named after its source file and written to `--out`
(default: the current folder). ZIPs carry the format in their name (`hero-atlas.zip`, `hero-web.zip`,
`hero-png.zip`, `hero-spritesheet-godot.zip`), so several formats can share one folder. If some files fail, the others are still written, and the
command exits with 1.

### apply, ops

```bash
openbone ops                                                   # every op, e.g. addBone [rig] ...
openbone apply hero.obone addBone '{"name":"tail","parent":"root"}'
```

`apply` takes op names in camel case (`addBone`), as `ops` lists them. The MCP server exposes the same ops as tools in
snake case (`add_bone`).

### mcp

```bash
openbone mcp                                  # stdio, plus the editor bridge on ws://127.0.0.1:7717
openbone mcp --project hero.obone --no-bridge
openbone mcp --http 7718                      # Streamable HTTP at http://127.0.0.1:7718/mcp
```

The options are those of [`@openbone/mcp`](https://github.com/UXCentury/open-bone/blob/main/packages/mcp/README.md).

## Export formats

| Format | Output |
|---|---|
| `obone` | The whole project as an `.obone` file |
| `json` | Runtime data as JSON: the animations and state machines marked for export (`--pack` embeds a texture atlas) |
| `obonb` | The same runtime data in the binary format (`--pack` embeds a texture atlas) |
| `atlas` | ZIP: runtime data (JSON, or `.obonb` with `--binary`) plus the atlas pages as PNG files |
| `png`, `jpeg` | One frame (`--time`), or every frame in a ZIP with `--sequence` |
| `apng` | Animated PNG (`<name>.apng.png`) |
| `gif` | Animated GIF |
| `psd` | Photoshop file, one layer per frame |
| `avi`, `mov` | Motion-JPEG video |
| `spritesheet` | ZIP of sprite sheets for `--engine unity`, `godot`, `flutter` or `generic` (the default), one clip per animation |
| `web` | ZIP with the `<openbone-player>` web player, the animation and a demo page, or one self-contained HTML file with `--single-file` |

Frames come from `--animation` (default: the first animation) or from a state machine run (`--state-machine` and
`--steps`).

| Option | Applies to |
|---|---|
| `--animation <name>`, `--state-machine <name>`, `--steps '<json>'` | frame formats (`png`, `jpeg`, `apng`, `gif`, `psd`, `avi`, `mov`) |
| `--animation <name>`, `--state-machine <name>` | `web`: what the demo page plays (default: the first state machine) |
| `--animations a,b` | `json`, `obonb`, `atlas` (animations to keep), `spritesheet` (clips; default: all marked for export) |
| `--skin <name>` | frame formats, `spritesheet` |
| `--scale`, `--fps`, `--duration`, `--time` | frame formats, `spritesheet` |
| `--transparent` | `png`, `apng`, `gif`, `psd`, `spritesheet`, `web` (`jpeg`, `avi` and `mov` are always opaque) |
| `--sequence` | `png`, `jpeg` |
| `--engine unity\|godot\|flutter\|generic` | `spritesheet` |
| `--single-file`, `--no-minify` | `web` |
| `--binary` | `atlas` |
| `--pack` | `json`, `obonb`, `web` |
| `--padding 2`, `--max-size 2048`, `--no-pot`, `--rotate`, `--atlas-scale 0.5\|auto`, `--strip-whitespace`, `--polygons`, `--premultiplied` | atlas packing (`atlas`, and `--pack`) |

## Documentation

- [OpenBone README](https://github.com/UXCentury/open-bone/blob/main/README.md)
- [MCP guide](https://github.com/UXCentury/open-bone/blob/main/docs/mcp.md)
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Engine and platform exports](https://github.com/UXCentury/open-bone/blob/main/docs/engine-exports.md)
- [Changelog](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md)

## License

[MIT](https://github.com/UXCentury/open-bone/blob/main/LICENSE) © UX Century and OpenBone contributors
