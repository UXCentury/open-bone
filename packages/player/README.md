# @openbone/player

A drop-in `<openbone-player>` web component and a `Player` class: WebGL2 or Canvas2D, state machines, pointer listeners, events and Web Audio.

Part of [OpenBone](https://github.com/UXCentury/open-bone), open-source 2D skeletal animation with interactive state machines and an MCP server. MIT licensed.

## Install

```bash
npm install @openbone/player
```

## Use

```html
<script type="module">
  import { definePlayerElement } from "@openbone/player";
  definePlayerElement();
</script>
<openbone-player src="walker.obone" state-machine="character"></openbone-player>
<script>
  const p = document.querySelector("openbone-player");
  p.setInput("speed", 1);
  p.addEventListener("openbone-event", (e) => console.log(e.detail.name));
</script>
```

`@openbone/player/bundle` (Node only) builds the self-contained player scripts used by web and WebView exports; it needs `esbuild` installed.

## Docs

- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Runtime spec](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md)
- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md)
