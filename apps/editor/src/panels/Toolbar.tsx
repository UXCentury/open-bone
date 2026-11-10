import { setShowImages, showImages } from "../visibility.ts";
import { setView3d, setZView, view3d, zView } from "../zview.ts";
import { parseDocument } from "@openbone/core";
import { confirmDiscard } from "../destructive.ts";
import { For, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { bridgeStatus, connectBridge, disconnectBridge, bridgeUndo, bridgeRedo } from "../bridge.ts";
import { imageSize, readFileAsDataUrl } from "../images.ts";
import { closeMenu, menuOpen, menuOwner, openMenu } from "../menu.tsx";
import { mainMenu } from "../editor-menus.ts";
import { openProject } from "../storage.ts";
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
  compensate,
  setCompensate,
  grabTarget,
  setGrabTarget,
  pickBones,
  pickParts,
  setPick,
} from "../state.ts";
import { playActive, togglePlay } from "../play.ts";
import { tip } from "../shortcuts/index.ts";
import { setOpenFileHandler, setShortcutsOpen } from "../shortcuts/actions.ts";
import { MuteButton, pickAudio } from "./AudioPanel.tsx";
import { importFiles } from "../sequence-import.ts";

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: "select", label: "⟲", title: "Select / rotate bones" },
  { id: "translate", label: "✥", title: "Translate bones / move attachments" },
  { id: "scale", label: "⤡", title: "Scale bones, shift = uniform" },
  { id: "pose", label: "IK", title: "Pose: drag a bone and its parents bend to follow (inverse kinematics). Shift: only that bone" },
  { id: "bone", label: "🦴", title: "Create bone: drag from parent" },
  { id: "mesh", label: "◇", title: "Edit mesh vertices: select, drag, Ctrl/⌘-click to add, Delete to remove" },
  { id: "weights", label: "◐", title: "Paint mesh weights for a bone" },
  { id: "pen", label: "✒", title: "Pen: draw paths (click knots, drag for handles), edit path knots and bounding-box points" },
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

/** A compact toolbar button that opens a small panel of options below it (closes on an outside click or Escape). */
function Dropdown(p: { label: () => string; title: string; warn?: () => boolean; disabled?: () => boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  const away = (e: PointerEvent) => !root.contains(e.target as Node) && setOpen(false);
  const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
  createEffect(() => {
    if (!open()) return;
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    });
  });
  return (
    <div class="group tb-dropdown" ref={root}>
      <button disabled={p.disabled?.()} classList={{ active: open(), warn: !!p.warn?.() }} aria-expanded={open()} title={p.title} onClick={() => setOpen(!open())}>
        {p.label()} ▾
      </button>
      <Show when={open()}>
        <div class="tb-pop" role="dialog" aria-label={p.title}>
          {p.children}
        </div>
      </Show>
    </div>
  );
}

export function Toolbar() {
  // Window width decides how compact the toolbar is (so it stays on one row).
  const [width, setWidth] = createSignal(typeof window === "undefined" ? 1920 : window.innerWidth);
  const onResize = () => setWidth(window.innerWidth);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));
  const narrow = () => width() < 1680;
  // Narrower still: the file name, the ⌨ button (? and Ctrl/⌘+K still work) and the "Comp" label go.
  const veryNarrow = () => width() < 1400;
  let fileInput!: HTMLInputElement;
  let menuBtn!: HTMLButtonElement;
  let imageInput!: HTMLInputElement;
  setOpenFileHandler(() => openProject(() => fileInput.click()));
  const locked = playActive;
  let sequenceInput!: HTMLInputElement;

  const open = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (!(await confirmDiscard(`Opening “${f.name}”`))) return;
    try {
      loadDocument(parseDocument(new Uint8Array(await f.arrayBuffer())), f.name.replace(/\.obonb$/i, ".obone"));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <header class="toolbar">
      <div class="brand">
        <img class="logo" src={`${import.meta.env.BASE_URL}logo-mark.svg`} alt="" width="14" height="18" /> OpenBone
      </div>
      <div class="group">
        <button
          class="menu-btn"
          classList={{ open: menuOpen() && menuOwner() === menuBtn }}
          ref={menuBtn}
          aria-haspopup="menu"
          title="Menu: new, open, save, export, examples, layout"
          onClick={() => {
            if (menuOpen() && menuOwner() === menuBtn) return closeMenu();
            const r = menuBtn.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4, mainMenu(), menuBtn);
          }}
        >
          ☰ Menu
        </button>
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
        <button
          disabled={locked()}
          classList={{ active: compensate() }}
          aria-pressed={compensate()}
          title={tip(compensate() ? "Compensate is on: moving, rotating or scaling a bone leaves its child bones where they are. Click to turn off." : "Compensate: move, rotate or scale a bone without moving its child bones", "tool.compensate")}
          onClick={() => setCompensate(!compensate())}
        >
          {veryNarrow() ? "⇲" : "⇲ Comp"}
        </button>
      </div>
      <div class="group seg-toggle" role="group" aria-label="What dragging a picture transforms">
        <button
          disabled={locked()}
          classList={{ active: grabTarget() === "bone" }}
          aria-pressed={grabTarget() === "bone"}
          title={tip("Transform bones: dragging a picture moves, rotates or scales its bone (Setup mode)", "tool.grab")}
          onClick={() => setGrabTarget("bone")}
        >
          Bone
        </button>
        <button
          disabled={locked()}
          classList={{ active: grabTarget() === "part" }}
          aria-pressed={grabTarget() === "part"}
          title={tip("Transform parts: dragging a picture moves, rotates or scales the picture itself, not its bone (Setup mode)", "tool.grab")}
          onClick={() => setGrabTarget("part")}
        >
          Part
        </button>
      </div>
      <Dropdown
        label={() => (pickBones() && pickParts() ? "Pick: All" : pickBones() ? "Pick: Bones" : pickParts() ? "Pick: Parts" : "Pick: None")}
        title="What viewport clicks can pick: bones, parts (pictures), or both"
        warn={() => !pickBones() || !pickParts()}
        disabled={locked}
      >
        <label class="check" title="Bones can be clicked in the viewport. Untick to click through them to the pictures">
          <input type="checkbox" checked={pickBones()} onChange={(e) => setPick("bones", e.currentTarget.checked)} /> Bones
        </label>
        <label class="check" title="Pictures can be clicked in the viewport. Untick to click only bones">
          <input type="checkbox" checked={pickParts()} onChange={(e) => setPick("parts", e.currentTarget.checked)} /> Parts
        </label>
      </Dropdown>
      {/* Below ~1680 px the add buttons fold into one drop-down so the toolbar stays on one row. */}
      <Show
        when={narrow()}
        fallback={
          <div class="group">
        <button disabled={locked()} onClick={() => imageInput.click()} title="Import PNG/JPG as a new slot on the selected bone, or a Photoshop PSD (each layer becomes a slot, groups can become bones)">+ Image</button>
        <button disabled={locked()} onClick={() => sequenceInput.click()} title="Import a frame sequence: numbered images (fire_0001.png …), a sprite sheet (grid or TexturePacker/Aseprite JSON + image), or a ZIP of frames">+ Sequence</button>
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
          </div>
        }
      >
        <Dropdown label={() => "+ Add"} title="Add an image, a frame sequence, a shape or a sound" disabled={locked}>
          <div class="tb-pop-buttons">
        <button disabled={locked()} onClick={() => imageInput.click()} title="Import PNG/JPG as a new slot on the selected bone, or a Photoshop PSD (each layer becomes a slot, groups can become bones)">+ Image</button>
        <button disabled={locked()} onClick={() => sequenceInput.click()} title="Import a frame sequence: numbered images (fire_0001.png …), a sprite sheet (grid or TexturePacker/Aseprite JSON + image), or a ZIP of frames">+ Sequence</button>
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
          </div>
        </Dropdown>
      </Show>
      <div class="group">
        <input ref={imageInput} type="file" accept="image/*,.psd" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f) void importFiles(Array.from(f), importImages); e.currentTarget.value = ""; }} />
        <input ref={sequenceInput} type="file" accept="image/*,.json,.zip,application/json,application/zip" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f) void importFiles(Array.from(f), importImages, { sheet: true }); e.currentTarget.value = ""; }} />
        <MuteButton />
      </div>
      <Dropdown
        label={() => (view3d() ? "View: 3D" : zView() ? "View: Order" : !showImages() ? "View: Bones only" : "View")}
        title="What the viewport shows: bones, mesh wireframes, attachments, the order view or the 3D view"
        warn={() => view3d() || zView() || !showImages()}
        disabled={locked}
      >
        <label class="check" title={tip("Show bones", "view.bones")}><input type="checkbox" checked={showBones()} onChange={(e) => setShowBones(e.currentTarget.checked)} /> Bones</label>
        <label class="check" title={tip("Show mesh wireframes", "view.mesh")}><input type="checkbox" checked={showMesh()} onChange={(e) => setShowMesh(e.currentTarget.checked)} /> Mesh</label>
        <label class="check" title={tip("Show attachments (untick to see only the bones)", "view.attachments")}><input type="checkbox" checked={showImages()} onChange={(e) => setShowImages(e.currentTarget.checked)} /> Attachments</label>
        <label class="check" title={tip("Order view: the draw order from back to front, side by side; drag a part to reorder", "view.z")}><input type="checkbox" checked={zView()} onChange={(e) => setZView(e.currentTarget.checked)} /> Order</label>
        <label class="check" title={tip("3D view: every part on its own plane in depth, with the bones; drag to orbit", "view.3d")}><input type="checkbox" checked={view3d()} onChange={(e) => setView3d(e.currentTarget.checked)} /> 3D</label>
      </Dropdown>
      <div class="spacer" />
      <Show when={!veryNarrow()}>
        <div class="group">
          <button class="help-btn" title={tip("Keyboard shortcuts", "help.shortcuts")} aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
            ⌨
          </button>
        </div>
      </Show>
      <div class="group">
        <Show
          when={bridgeStatus() === "connected"}
          fallback={
            <button title="Connect to a running OpenBone MCP server (live agent editing)" onClick={() => connectBridge()}>
              {bridgeStatus() === "connecting" ? "Connecting…" : narrow() ? "⚡ MCP" : "⚡ Connect MCP"}
            </button>
          }
        >
          <button class="live" onClick={disconnectBridge} title="Live-synced with the MCP server. Click to disconnect.">● Live MCP</button>
        </Show>
      </div>
      <Show when={!veryNarrow()}>
        <span class="filename" title={fileName()}>{fileName()}</span>
      </Show>
    </header>
  );
  void apply;
}
