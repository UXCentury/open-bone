import { createDocument, parseDocument } from "@openbone/core";
import { For, Show } from "solid-js";
import { bridgeStatus, connectBridge, disconnectBridge, bridgeUndo, bridgeRedo } from "../bridge.ts";
import { imageSize, readFileAsDataUrl } from "../images.ts";
import { resetLayout, swapSides } from "../layout.ts";
import { openProject, saveProject } from "../storage.ts";
import {
  apply,
  fileName,
  loadDocument,
  mode,
  openExample,
  selectedBoneId,
  setMode,
  setSelection,
  setShowBones,
  setShowMesh,
  setTool,
  showBones,
  showMesh,
  store,
  toast,
  tool,
  type Tool,
  transaction,
  setPlaying,
  setExportOpen,
  skinArg,
} from "../state.ts";
import { askConfirm } from "../dialogs.tsx";
import { playActive, togglePlay } from "../play.ts";
import { tip } from "../shortcuts/index.ts";
import { setOpenFileHandler, setShortcutsOpen } from "../shortcuts/actions.ts";
import { MuteButton, pickAudio } from "./AudioPanel.tsx";
import { importFiles } from "../sequence-import.ts";

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: "select", label: "⟲", title: "Select / rotate bones" },
  { id: "translate", label: "✥", title: "Translate bones / move attachments" },
  { id: "scale", label: "⤡", title: "Scale bones, shift = uniform" },
  { id: "bone", label: "🦴", title: "Create bone: drag from parent" },
  { id: "mesh", label: "◇", title: "Edit mesh vertices: select, drag, Ctrl/⌘-click to add, Delete to remove" },
  { id: "weights", label: "◐", title: "Paint mesh weights for a bone" },
];

export function undo() {
  if (bridgeStatus() === "connected") bridgeUndo();
  else store.undo();
}
export function redo() {
  if (bridgeStatus() === "connected") bridgeRedo();
  else store.redo();
}

export async function importImages(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const src = await readFileAsDataUrl(file);
    const { width, height } = await imageSize(src);
    const name = file.name.replace(/\.[^.]+$/, "");
    transaction(`import ${name}`, () => {
      const img = store.apply("addImage", { name, src, width, height }) as { id: string };
      const bone = selectedBoneId() ?? store.doc.skeleton.bones[0].id;
      const slot = store.apply("addSlot", { bone, name }) as { id: string };
      store.apply("addRegion", { slot: slot.id, image: img.id, ...skinArg() });
      setSelection({ kind: "slot", id: slot.id });
    });
  }
}

export function Toolbar() {
  let fileInput!: HTMLInputElement;
  let imageInput!: HTMLInputElement;
  setOpenFileHandler(() => openProject(() => fileInput.click()));
  const locked = playActive;
  let sequenceInput!: HTMLInputElement;

  const open = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      loadDocument(parseDocument(new Uint8Array(await f.arrayBuffer())), f.name.replace(/\.obonb$/i, ".obone"));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <header class="toolbar">
      <div class="brand">
        <span class="logo">●━</span> OpenBone
      </div>
      <div class="group">
        <button
          disabled={locked()}
          onClick={async () => {
            const ok = await askConfirm({
              title: "Start a new project?",
              message: "Unsaved changes to the current project will be lost. Save first if you want to keep them.",
              confirmLabel: "Discard and start new",
              danger: true,
            });
            if (ok) loadDocument(createDocument("Untitled", { background: "#eef2f7" }), "untitled.obone");
          }}
        >
          New
        </button>
        <button disabled={locked()} title={tip("Open a project", "file.open")} onClick={() => openProject(() => fileInput.click())}>Open</button>
        <button onClick={() => saveProject()} title={tip("Save", "file.save")}>Save</button>
        <button disabled={locked()} onClick={() => setExportOpen(true)} title={tip("Export a file with the parts you choose, with a live preview", "file.export")}>
          Export…
        </button>
        <select
          disabled={locked()}
          onChange={(e) => {
            if (e.currentTarget.value) openExample(e.currentTarget.value);
            e.currentTarget.value = "";
          }}
        >
          <option value="">Examples…</option>
          <option value="walker">Walker (IK, mesh, blend, script)</option>
          <option value="button">Interactive button</option>
          <option value="campfire">Campfire (sprite sequences)</option>
          <option value="tail">Tail (path constraint, physics)</option>
        </select>
        <input ref={fileInput} type="file" accept=".obone,.obonb,.json,application/json,application/octet-stream" hidden onChange={(e) => open(e.currentTarget.files)} />
      </div>
      <div class="group">
        <button disabled={locked()} title={tip("Undo", "edit.undo")} onClick={undo}>↶</button>
        <button disabled={locked()} title={tip("Redo", "edit.redo")} onClick={redo}>↷</button>
      </div>
      <div class="group">
        <button
          class="play-btn"
          classList={{ stop: playActive() }}
          aria-pressed={playActive()}
          title={tip(playActive() ? "Stop and return to editing" : "Play: try the finished result with its inputs, scripts and pointer interaction", "play.toggle")}
          onClick={togglePlay}
        >
          {playActive() ? "■ Stop" : "▶ Play"}
        </button>
      </div>
      <div class="group segmented">
        <button disabled={locked()} title={tip("Setup mode", "mode.toggle")} classList={{ active: mode() === "setup" }} onClick={() => { setMode("setup"); setPlaying(false); }}>Setup</button>
        <button disabled={locked()} title={tip("Animate mode", "mode.toggle")} classList={{ active: mode() === "animate" }} onClick={() => setMode("animate")}>Animate</button>
      </div>
      <div class="group segmented">
        <For each={TOOLS}>
          {(t) => (
            <button disabled={locked()} title={tip(t.title, `tool.${t.id}`)} classList={{ active: tool() === t.id }} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          )}
        </For>
      </div>
      <div class="group">
        <button disabled={locked()} onClick={() => imageInput.click()} title="Import PNG/JPG as a new slot on the selected bone">+ Image</button>
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f) void importFiles(Array.from(f), importImages); e.currentTarget.value = ""; }} />
        <button disabled={locked()} onClick={() => sequenceInput.click()} title="Import a frame sequence: numbered images (fire_0001.png …), a sprite sheet (grid or TexturePacker/Aseprite JSON + image), or a ZIP of frames">+ Sequence</button>
        <input ref={sequenceInput} type="file" accept="image/*,.json,.zip,application/json,application/zip" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f) void importFiles(Array.from(f), importImages, { sheet: true }); e.currentTarget.value = ""; }} />
        <button
          disabled={locked()}
          title="Add a vector shape slot on the selected bone"
          onClick={() =>
            transaction("add shape", () => {
              const bone = selectedBoneId() ?? store.doc.skeleton.bones[0].id;
              const slot = store.apply("addSlot", { bone, name: "shape" }) as { id: string };
              store.apply("addShape", { slot: slot.id, shape: "rect", width: 80, height: 40, radius: 8, fill: "#7c9cff", ...skinArg() });
              setSelection({ kind: "slot", id: slot.id });
            })
          }
        >
          + Shape
        </button>
        <button onClick={pickAudio} title="Import WAV / MP3 / OGG sounds (or drop them on the viewport)">+ Audio</button>
        <MuteButton />
      </div>
      <div class="group">
        <label class="check" title={tip("Show bones", "view.bones")}><input type="checkbox" disabled={locked()} checked={showBones()} onChange={(e) => setShowBones(e.currentTarget.checked)} /> Bones</label>
        <label class="check" title={tip("Show mesh wireframes", "view.mesh")}><input type="checkbox" disabled={locked()} checked={showMesh()} onChange={(e) => setShowMesh(e.currentTarget.checked)} /> Mesh</label>
      </div>
      <div class="group">
        <select
          disabled={locked()}
          title="Panel layout: drag panel tabs to move them, drag the dividers to resize"
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "reset") resetLayout();
            else if (v === "swap") swapSides();
            e.currentTarget.value = "";
          }}
        >
          <option value="">Layout…</option>
          <option value="swap">Swap left and right panels</option>
          <option value="reset">Reset to default layout</option>
        </select>
      </div>
      <div class="spacer" />
      <div class="group">
        <button class="help-btn" title={tip("Keyboard shortcuts", "help.shortcuts")} aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
          ⌨
        </button>
      </div>
      <div class="group">
        <Show
          when={bridgeStatus() === "connected"}
          fallback={
            <button title="Connect to a running OpenBone MCP server (live agent editing)" onClick={() => connectBridge()}>
              {bridgeStatus() === "connecting" ? "Connecting…" : "⚡ Connect MCP"}
            </button>
          }
        >
          <button class="live" onClick={disconnectBridge} title="Live-synced with the MCP server. Click to disconnect.">● Live MCP</button>
        </Show>
      </div>
      <span class="filename">{fileName()}</span>
    </header>
  );
  void apply;
}
