import { For, Show, onCleanup, onMount } from "solid-js";
import { Toolbar, importImages } from "./panels/Toolbar.tsx";
import { importAudio } from "./audio.ts";
import { Viewport } from "./panels/Viewport.tsx";
import { Dock, DragOverlay, Splitter } from "./panels/Workspace.tsx";
import { ExportDialog } from "./panels/ExportDialog.tsx";
import { PlayStage } from "./panels/PlayMode.tsx";
import { ShortcutsDialog } from "./panels/ShortcutsDialog.tsx";
import { CommandPalette, paletteOpen } from "./panels/CommandPalette.tsx";
import { dismissToast, exportOpen, toasts } from "./state.ts";
import { DialogHost } from "./dialogs.tsx";
import { playActive } from "./play.ts";
import { setupShortcuts, shortcutsOpen } from "./shortcuts/actions.ts";
import { importFiles } from "./sequence-import.ts";
import { MenuHost } from "./menu.tsx";
import { aboutOpen, contextItems, examplesOpen } from "./editor-menus.ts";
import { AboutDialog } from "./panels/AboutDialog.tsx";
import { McpConfigDialog } from "./panels/McpConfig.tsx";
import { scheduleUpdateCheck } from "./updates.ts";
import { ImportDialog, importOpen } from "./panels/ImportDialog.tsx";
import { ExamplesDialog } from "./panels/ExamplesDialog.tsx";

export function App() {
  onMount(() => onCleanup(setupShortcuts()));
  onMount(scheduleUpdateCheck);

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
            if (e.dataTransfer?.files.length) {
              void importFiles(e.dataTransfer.files, importImages);
              void importAudio(e.dataTransfer.files);
            }
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
      <Show when={aboutOpen()}>
        <AboutDialog />
      </Show>
      <McpConfigDialog />
      <Show when={importOpen()}>
        <ImportDialog />
      </Show>
      <Show when={examplesOpen()}>
        <ExamplesDialog />
      </Show>
      <MenuHost contextItems={contextItems} />
      <Show when={shortcutsOpen()}>
        <ShortcutsDialog />
      </Show>
      <Show when={paletteOpen()}>
        <CommandPalette />
      </Show>
      <div class="toasts">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast ${t.kind}`} classList={{ "with-action": !!t.action }}>
              <span>{t.text}</span>
              <Show when={t.action}>
                {(a) => (
                  <button
                    class="toast-action"
                    onClick={() => {
                      void a().run();
                      dismissToast(t.id);
                    }}
                  >
                    {a().label}
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
