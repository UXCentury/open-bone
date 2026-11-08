import { For, Show, onCleanup, onMount } from "solid-js";
import { Toolbar, importImages, redo, undo } from "./panels/Toolbar.tsx";
import { Viewport } from "./panels/Viewport.tsx";
import { Dock, DragOverlay, Splitter } from "./panels/Workspace.tsx";
import { ExportDialog } from "./panels/ExportDialog.tsx";
import { saveProject } from "./storage.ts";
import { deleteSelectedVertices, nudgeSelected, selectAllVertices } from "./mesh-edit.ts";
import { apply, exportOpen, setExportOpen, mode, playing, selection, setPlaying, setSelection, setTool, toasts, tool, meshSel, setMeshSel } from "./state.ts";
import { DialogHost } from "./dialogs.tsx";
import { toggleViewAid } from "./guides.ts";

export function App() {
  const key = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a" && tool() === "mesh") {
      e.preventDefault();
      selectAllVertices();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === "e") {
      e.preventDefault();
      setExportOpen(true);
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject(e.shiftKey);
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (!mod) {
      const k = e.key.toLowerCase();
      if (k === "r" && e.shiftKey) toggleViewAid("rulers");
      else if (k === "g") toggleViewAid("grid");
      else if (k === "v" || k === "r") setTool("select");
      else if (k === "t") setTool("translate");
      else if (k === "s") setTool("scale");
      else if (k === "b") setTool("bone");
      else if (k === "m") setTool("mesh");
      else if (k === "w") setTool("weights");
      else if (e.code === "Space" && mode() === "animate") {
        e.preventDefault();
        setPlaying(!playing());
      } else if (k === "delete" || k === "backspace") {
        if (tool() === "mesh") {
          deleteSelectedVertices();
          return;
        }
        const s = selection();
        if (s?.kind === "bone") apply("deleteBone", { bone: s.id }) !== undefined && setSelection(null);
        else if (s?.kind === "slot") apply("deleteSlot", { slot: s.id }) !== undefined && setSelection(null);
      } else if (k === "escape") {
        if (tool() === "mesh" && meshSel().length) setMeshSel([]);
        else setSelection(null);
      } else if (tool() === "mesh" && k.startsWith("arrow") && meshSel().length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudgeSelected(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? step : k === "arrowdown" ? -step : 0);
      }
    }
  };
  onMount(() => window.addEventListener("keydown", key));
  onCleanup(() => window.removeEventListener("keydown", key));

  return (
    <div class="app">
      <Toolbar />
      <div class="main">
        <Dock id="left" />
        <Splitter dock="left" />
        <div
          class="center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer?.files.length) importImages(e.dataTransfer.files);
          }}
        >
          <Viewport />
          <Splitter dock="bottom" />
          <Dock id="bottom" />
        </div>
        <Splitter dock="right" />
        <Dock id="right" />
      </div>
      <DragOverlay />
      <DialogHost />
      <Show when={exportOpen()}>
        <ExportDialog />
      </Show>
      <div class="toasts">
        <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
      </div>
    </div>
  );
}
