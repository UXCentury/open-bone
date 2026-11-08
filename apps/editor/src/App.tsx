import { For, Show, onCleanup, onMount } from "solid-js";
import { Toolbar, importImages } from "./panels/Toolbar.tsx";
import { Viewport } from "./panels/Viewport.tsx";
import { Dock, DragOverlay, Splitter } from "./panels/Workspace.tsx";
import { ExportDialog } from "./panels/ExportDialog.tsx";
import { PlayStage } from "./panels/PlayMode.tsx";
import { ShortcutsDialog } from "./panels/ShortcutsDialog.tsx";
import { exportOpen, toasts } from "./state.ts";
import { DialogHost } from "./dialogs.tsx";
import { playActive } from "./play.ts";
import { setupShortcuts, shortcutsOpen } from "./shortcuts/actions.ts";

export function App() {
  onMount(() => onCleanup(setupShortcuts()));

  return (
    <div class="app" classList={{ playing: playActive() }}>
      <Toolbar />
      <div class="main">
        <div class="lockable" inert={playActive() || undefined}>
          <Dock id="left" />
          <Splitter dock="left" />
        </div>
        <div
          class="center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer?.files.length) importImages(e.dataTransfer.files);
          }}
        >
          <div class="lockable column" inert={playActive() || undefined}>
            <Viewport />
            <Splitter dock="bottom" />
            <Dock id="bottom" />
          </div>
          <Show when={playActive()}>
            <PlayStage />
          </Show>
        </div>
        <div class="lockable" inert={playActive() || undefined}>
          <Splitter dock="right" />
          <Dock id="right" />
        </div>
      </div>
      <DragOverlay />
      <DialogHost />
      <Show when={exportOpen()}>
        <ExportDialog />
      </Show>
      <Show when={shortcutsOpen()}>
        <ShortcutsDialog />
      </Show>
      <div class="toasts">
        <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
      </div>
    </div>
  );
}
