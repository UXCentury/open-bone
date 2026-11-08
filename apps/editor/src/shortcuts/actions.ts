import { BONE_PROPERTIES, animationDuration } from "@openbone/core";
import { deleteBoneAsk, deleteSlotAsk } from "../destructive.ts";
import { Skeleton, applyAnimation } from "@openbone/runtime";
import { createSignal } from "solid-js";
import { ensureAnimation } from "../edit.ts";
import { toggleViewAid } from "../guides.ts";
import { type PanelId, showPanel } from "../layout.ts";
import { deleteSelectedVertices, nudgeSelected, selectAllVertices } from "../mesh-edit.ts";
import { playActive, playFullWindow, restartPlay, setPlayFit, setPlayFullWindow, setPlayPaused, playPaused, stepSpeed, stopPlay, togglePlay } from "../play.ts";
import { multiBones,
  apply,
  currentAnimation,
  doc,
  meshSel,
  mode,
  onionSkin,
  playing,
  selection,
  setExportOpen,
  setMeshSel,
  setMode,
  setOnionSkin,
  setPlaying,
  setSelection,
  setShowBones,
  setShowMesh,
  setTime,
  setTool,
  showBones,
  showMesh,
  store,
  time,
  toast,
  tool,
  transaction,
} from "../state.ts";
import { saveProject } from "../storage.ts";
import { reorderSlot } from "../visibility.ts";
import { redo, undo } from "../panels/Toolbar.tsx";
import { type Scope, installShortcuts, shortcuts } from "./index.ts";

/** Keyboard shortcuts dialog visibility. */
export const [shortcutsOpen, setShortcutsOpen] = createSignal(false);

/** Hook for the toolbar's hidden file input (Open…). */
let openFile: (() => void) | null = null;
export const setOpenFileHandler = (fn: () => void) => (openFile = fn);

const fps = () => doc().fps || 30;
const snapTime = (t: number) => Math.round(t * fps()) / fps();

function enterAnimate(): boolean {
  if (!ensureAnimation()) return false;
  if (mode() !== "animate") setMode("animate");
  setPlaying(false);
  return true;
}

function stepFrame(dir: 1 | -1) {
  if (!enterAnimate()) return;
  const a = currentAnimation();
  const d = a ? animationDuration(a) : 0;
  setTime(Math.max(0, Math.min(d || Infinity, snapTime(time() + dir / fps()))));
}

function keyTimes(): number[] {
  const a = currentAnimation();
  if (!a) return [];
  const set = new Set<number>();
  for (const tl of a.timelines) for (const k of tl.keys) set.add(k.time);
  for (const e of a.events) set.add(e.time);
  return [...set].sort((x, y) => x - y);
}

function stepKey(dir: 1 | -1) {
  if (!enterAnimate()) return;
  const ts = keyTimes();
  const t = time();
  const next = dir > 0 ? ts.find((k) => k > t + 1e-4) : [...ts].reverse().find((k) => k < t - 1e-4);
  if (next === undefined) toast(dir > 0 ? "No later key" : "No earlier key");
  else setTime(next);
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");

/** Key every property of the selected bone (or the colour and attachment of the selected slot) at the current time. */
function setKey() {
  const s = selection();
  if (s?.kind !== "bone" && s?.kind !== "slot") return toast("Select a bone or slot to key it", "info");
  const anim = ensureAnimation();
  if (!anim) return;
  if (mode() !== "animate") setMode("animate");
  // Key the pose currently shown (setup pose + animation at this time).
  const sk = new Skeleton(store.doc);
  const a = store.doc.animations.find((x) => x.id === anim);
  sk.setToSetupPose();
  if (a) applyAnimation(sk, a, time());
  const t = Math.round(time() * 1000) / 1000;
  transaction("set key", () => {
    if (s.kind === "bone") {
      // Every bone of a multi-selection gets keyed together.
      const ids = multiBones().length > 1 ? multiBones() : [s.id];
      for (const id of ids) {
        const b = sk.boneById_(id);
        if (!b) continue;
        for (const property of BONE_PROPERTIES)
          store.apply("setKeys", { animation: anim, target: "bone", id, property, keys: [{ time: t, value: Math.round((b as unknown as Record<string, number>)[property] * 1000) / 1000 }] });
      }
    } else {
      const slot = sk.slotById_(s.id);
      if (!slot) return;
      const [r, g, bl, al] = slot.color;
      store.apply("setKeys", { animation: anim, target: "slot", id: s.id, property: "color", keys: [{ time: t, value: `#${hex2(r)}${hex2(g)}${hex2(bl)}${hex2(al)}` }] });
      store.apply("setKeys", { animation: anim, target: "slot", id: s.id, property: "attachment", keys: [{ time: t, value: slot.attachmentName, curve: "stepped" }] });
    }
  });
  toast(`Keyed ${s.kind} at ${t.toFixed(2)}s`);
}

/** Duplicate the selected bone (setup pose, same parent) or slot (with its attachments in every skin). */
function duplicate() {
  const s = selection();
  const d = store.doc;
  if (s?.kind === "bone") {
    const b = d.skeleton.bones.find((x) => x.id === s.id);
    if (!b) return;
    if (!b.parent) return toast("The root bone can't be duplicated", "info");
    const { id: _id, name, ...props } = b;
    const res = apply("addBone", { ...props, name: `${name} copy` }) as { id: string } | undefined;
    if (res) setSelection({ kind: "bone", id: res.id });
  } else if (s?.kind === "slot") {
    const slot = d.skeleton.slots.find((x) => x.id === s.id);
    if (!slot) return;
    let newId: string | null = null;
    transaction("duplicate slot", () => {
      const index = d.skeleton.slots.indexOf(slot) + 1;
      const res = store.apply("addSlot", { bone: slot.bone, name: `${slot.name} copy`, color: slot.color, blend: slot.blend, index }) as { id: string };
      newId = res.id;
      for (const skin of d.skeleton.skins)
        for (const att of Object.keys(skin.attachments[slot.id] ?? {}))
          store.apply("copyAttachment", { slot: slot.id, attachment: att, fromSkin: skin.id, toSkin: skin.id, toSlot: res.id });
      if (slot.attachment) store.apply("updateSlot", { slot: res.id, attachment: slot.attachment });
    });
    if (newId) setSelection({ kind: "slot", id: newId });
  } else toast("Select a bone or slot to duplicate", "info");
}

function deleteSelection() {
  if (tool() === "mesh" && meshSel().length) {
    deleteSelectedVertices();
    return;
  }
  const s = selection();
  if (s?.kind === "bone") void deleteBoneAsk(s.id);
  else if (s?.kind === "slot") void deleteSlotAsk(s.id);
  else return false;
}

const nudge = (dx: number, dy: number) => (e: { shiftKey: boolean }) => {
  if (tool() !== "mesh" || !meshSel().length) return false;
  const k = e.shiftKey ? 10 : 1;
  nudgeSelected(dx * k, dy * k);
};

const PANEL_KEYS: PanelId[] = ["hierarchy", "inspector", "timeline", "statemachine", "scripts"];

/** Attach actions to the registry and start listening. Returns a disposer. */
export function setupShortcuts(): () => void {
  const b = (id: string, fn: (e: KeyboardEvent) => unknown) => shortcuts.bind(id, fn as never);
  const off = [
    b("file.save", () => void saveProject()),
    b("file.saveAs", () => void saveProject(true)),
    b("file.open", () => openFile?.()),
    b("file.export", () => setExportOpen(true)),
    b("edit.undo", undo),
    b("edit.redo", redo),
    b("edit.delete", deleteSelection),
    b("edit.duplicate", duplicate),
    ...([["edit.bringForward", "forward"], ["edit.sendBackward", "backward"], ["edit.bringToFront", "front"], ["edit.sendToBack", "back"]] as const).map(([id, where]) =>
      b(id, () => {
        const sl = selection();
        if (sl?.kind !== "slot") return toast("Select a slot (an image or shape) to change its draw order", "info");
        reorderSlot(sl.id, where);
      }),
    ),
    b("edit.deselect", () => {
      if (tool() === "mesh" && meshSel().length) setMeshSel([]);
      else if (selection()) setSelection(null);
      else return false;
    }),
    b("edit.selectAllVertices", () => {
      if (tool() !== "mesh") return false;
      selectAllVertices();
    }),
    b("edit.nudgeLeft", nudge(-1, 0)),
    b("edit.nudgeRight", nudge(1, 0)),
    b("edit.nudgeUp", nudge(0, 1)),
    b("edit.nudgeDown", nudge(0, -1)),
    b("tool.select", () => setTool("select")),
    b("tool.translate", () => setTool("translate")),
    b("tool.scale", () => setTool("scale")),
    b("tool.pose", () => setTool("pose")),
    b("tool.bone", () => setTool("bone")),
    b("tool.mesh", () => setTool("mesh")),
    b("tool.weights", () => setTool("weights")),
    b("view.grid", () => toggleViewAid("grid")),
    b("view.rulers", () => toggleViewAid("rulers")),
    b("view.bones", () => setShowBones(!showBones())),
    b("view.mesh", () => setShowMesh(!showMesh())),
    b("view.onion", () => {
      if (!enterAnimate()) return;
      setOnionSkin(!onionSkin());
    }),
    b("anim.playPause", () => {
      if (mode() !== "animate") {
        if (!ensureAnimation()) return;
        setMode("animate");
      }
      setPlaying(!playing());
    }),
    b("anim.prevFrame", () => stepFrame(-1)),
    b("anim.nextFrame", () => stepFrame(1)),
    b("anim.prevKey", () => stepKey(-1)),
    b("anim.nextKey", () => stepKey(1)),
    b("anim.first", () => void (enterAnimate() && setTime(0))),
    b("anim.last", () => {
      if (!enterAnimate()) return;
      const a = currentAnimation();
      setTime(a ? animationDuration(a) : 0);
    }),
    b("anim.setKey", setKey),
    b("mode.toggle", () => {
      if (mode() === "animate") {
        setMode("setup");
        setPlaying(false);
      } else setMode("animate");
    }),
    ...PANEL_KEYS.map((p) => b(`panel.${p}`, () => showPanel(p))),
    b("play.toggle", togglePlay),
    b("play.stop", () => {
      if (playFullWindow()) setPlayFullWindow(false);
      else stopPlay();
    }),
    b("play.restart", restartPlay),
    b("play.pause", () => setPlayPaused(!playPaused())),
    b("play.slower", () => stepSpeed(-1)),
    b("play.faster", () => stepSpeed(1)),
    b("play.fit", () => setPlayFit("contain")),
    b("play.actual", () => setPlayFit("none")),
    b("play.fullWindow", () => setPlayFullWindow(!playFullWindow())),
    b("help.shortcuts", () => setShortcutsOpen(true)),
  ];
  const scopes = (): Scope[] => (playActive() ? ["global", "play"] : ["global", "editor"]);
  const uninstall = installShortcuts(scopes);
  return () => {
    uninstall();
    off.forEach((f) => f());
  };
}
