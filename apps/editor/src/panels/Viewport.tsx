import { type BoneData, RAD, type SnapLine, type SnapTarget, animationDuration, apply as applyM, artboardTargets, invert, pointInPolygon, pointTargets, snapPoint, textureAssets } from "@openbone/core";
import { applySequencePreview } from "../sequence-import.ts";
import { type Guide, clearGuides, guides, newGuideId, removeGuide, setViewAid, toggleViewAid, upsertGuide, viewAids } from "../guides.ts";
import { CanvasRenderer } from "@openbone/render-canvas";
import { type Bone, type ScriptHost, Skeleton, StateMachineInstance, applyAnimation, trustedFunctionHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { imageFor, setImageReadyCallback } from "../images.ts";
import { playCommand, previewAudioStep, stopPreviewAudio } from "../audio.ts";
import { commitBone, commitAttachmentMove } from "../edit.ts";
import { isTypingTarget, kbd, shortcuts, tip } from "../shortcuts/index.ts";
import {
  type MeshTarget,
  type WeightTable,
  addVertex,
  buildGeometry,
  commitWeights,
  deleteSelectedVertices,
  meshTarget,
  movedWorld,
  moveVertices,
  paintDab,
  setupVertices,
  weightTable,
} from "../mesh-edit.ts";
import {
  activeSkin,
  activeSkinId,
  currentAnimation,
  currentStateMachine,
  mode,
  playing,
  rev,
  running,
  selectedBoneId,
  selection,
  setSelection,
  setTime,
  showBones,
  showMesh,
  store,
  time,
  tool,
  apply,
  setRunning,
  toast,
  doc,
  setMode,
  setPlaying,
  meshSel,
  setMeshSel,
  weightBone,
  setWeightBone,
  brushRadius,
  setBrushRadius,
  brushStrength,
  setBrushStrength,
  brushMode,
  setBrushMode,
  onionSkin,
  setOnionSkin,
  onionCount,
  setOnionCount,
  onionStep,
  setOnionStep,
} from "../state.ts";

export const [smInstance, setSmInstance] = createSignal<StateMachineInstance | null>(null);
export const [eventLog, setEventLog] = createSignal<string[]>([]);
let quickjs: ScriptHost | null = null;
createQuickJsHost({ timeoutMs: 30 })
  .then((h) => (quickjs = h))
  .catch(() => (quickjs = trustedFunctionHost));

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "bone"; op: "rotate" | "translate" | "scale"; bone: Bone; start: [number, number]; startWorld: [number, number]; base: Partial<BoneData>; cur: Partial<BoneData>; axis?: "x" | "y" }
  | { kind: "guide"; guide: Guide; isNew: boolean }
  | { kind: "attachment"; slotId: string; name: string; start: [number, number]; base: [number, number]; cur: [number, number]; inv: ReturnType<typeof invert>; preview: Skeleton | null; startWorld: [number, number] }
  | { kind: "create"; parent: Bone | null; start: [number, number]; end: [number, number] }
  | { kind: "vertex"; t: MeshTarget; start: [number, number]; anchor: number; base: Map<number, [number, number]>; moved: Map<number, [number, number]>; preview: Skeleton | null }
  | { kind: "paint"; t: MeshTarget; table: WeightTable; world: number[]; changed: Set<number>; last: [number, number]; carry: number };

/** Mesh tool: when on, moving existing vertices keeps their uvs (the image stretches). */
export const [meshWarp, setMeshWarp] = createSignal(false);
const [hoverVertex, setHoverVertex] = createSignal(-1);

/** Weight colour: blue (0) → green → red (1). */
const heat = (w: number, a = 1) => `hsla(${Math.round((1 - Math.min(1, Math.max(0, w))) * 240)}, 90%, 52%, ${a})`;
const identity = (n: number) => Array.from({ length: n }, (_, i) => i);
/** Ruler thickness in CSS px. */
const RULER = 18;
const SNAP_COLORS: Record<string, string> = { guide: "#22d3ee", center: "#ff4fa3", origin: "#ff4fa3", edge: "#ff4fa3", grid: "#8b9dff", point: "#ff4fa3" };

export function Viewport() {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const view = { x: 0, y: 0, zoom: 1 };
  let fitted = false;
  let drag: Drag | null = null;
  let sk: Skeleton | null = null;
  let skRev = -1;
  let raf = 0;
  let last = performance.now();
  let previewWasPlaying = false;
  let hoverInfo = "";
  let hoverPt: [number, number] | null = null;
  let snapLines: SnapLine[] = [];
  const [aidsOpen, setAidsOpen] = createSignal(false);
  const [cursorHint, setCursorHint] = createSignal<string | null>(null);
  let ghost: Skeleton | null = null;
  let ghostRev = -1;
  let ghostCanvas: HTMLCanvasElement | null = null;
  let wtCache: { rev: number; key: string; table: WeightTable } | null = null;
  const meshToolOn = () => (tool() === "mesh" || tool() === "weights") && mode() === "setup" && !running();

  const toSkeleton = (mx: number, my: number): [number, number] => {
    const d = store.doc;
    const ax = (mx - view.x) / view.zoom;
    const ay = (my - view.y) / view.zoom;
    return [ax - d.originX, d.originY - ay];
  };

  const fit = () => {
    const d = store.doc;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    view.zoom = Math.min(w / (d.width + 80), h / (d.height + 80), 2);
    view.x = (w - d.width * view.zoom) / 2;
    view.y = (h - d.height * view.zoom) / 2;
  };

  function ensureSkeleton() {
    if (skRev !== rev() || !sk) {
      sk = new Skeleton(store.doc);
      skRev = rev();
      if (running()) startStateMachine();
    }
    // Cheap lookup, so the viewport follows the active skin without rebuilding the skeleton.
    sk.setSkin(activeSkinId());
    return sk;
  }

  function startStateMachine() {
    const data = currentStateMachine();
    smInstance()?.dispose();
    if (!data || !sk) return setSmInstance(null);
    const inst = new StateMachineInstance(sk, data, { scriptHost: quickjs ?? trustedFunctionHost });
    const logLine = (s: string) => setEventLog((l) => [s, ...l].slice(0, 60));
    inst.on("event", (e) => logLine(`⚡ ${e.name}${e.string ? ` "${e.string}"` : ""}`));
    inst.on("stateChange", (e) => logLine(`→ [${e.layer}] ${e.from ?? "∅"} → ${e.to}`));
    inst.on("log", (a) => logLine(`📝 ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`));
    inst.on("error", (e) => logLine(`⛔ ${e.message}`));
    inst.on("audio", (c) => {
      playCommand(c);
      if (c.type === "play") logLine(`🔊 ${store.doc.audio?.sounds.find((s) => s.id === c.sound)?.name ?? c.sound}${c.loop ? " ⟳" : ""} (${c.source})`);
      else if (c.type === "stop") logLine(`🔇 stop ${c.id}${c.fade ? ` (fade ${c.fade}s)` : ""}`);
    });
    setSmInstance(inst);
  }

  const inputDefault = (name: string) => currentStateMachine()?.inputs.find((i) => i.name === name)?.default;

  function pose(sk: Skeleton, dt: number) {
    const sm = smInstance();
    if (running() && sm) {
      sk.particleClock = "realtime";
      sm.advance(dt);
    } else {
      // Outside Run, text templates show the current state machine's input defaults.
      sk.textValues = inputDefault;
      const anim = currentAnimation();
      if (mode() === "animate" && anim) {
        if (playing()) {
          const d = animationDuration(anim) || 1;
          const t0 = time();
          previewAudioStep(anim, previewWasPlaying ? t0 : t0 - 1e-6, t0 + dt, dt);
          previewWasPlaying = true;
          setTime((t) => (t + dt) % d);
        } else if (previewWasPlaying) {
          previewWasPlaying = false;
          stopPreviewAudio();
        }
        // Particles replay from time 0, so scrubbing shows exactly what an export renders at this time.
        sk.seekParticles(time(), (t) => {
          sk.setToSetupPose();
          applyAnimation(sk, anim, t);
          sk.updateWorldTransform();
        });
        sk.setToSetupPose();
        applyAnimation(sk, anim, time());
      } else {
        if (previewWasPlaying) {
          previewWasPlaying = false;
          stopPreviewAudio();
        }
        // Setup mode: emitters run live.
        sk.particleClock = "realtime";
        sk.setToSetupPose();
      }
      if (drag?.kind === "bone") Object.assign(drag.bone, drag.cur);
      sk.update(dt);
      sk.updateWorldTransform();
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (!fitted && w > 0) {
        fit();
        fitted = true;
      }
    }
    const d = store.doc;
    const s = ensureSkeleton();
    pose(s, dt);
    applySequencePreview(s);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Stage: a dark checkerboard (transparent = nothing drawn there), or plain.
    ctx.fillStyle = viewAids().checker ? checkerPattern(ctx, "#202329", "#1a1d22", 12 * dpr) : "#1b1e24";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // artboard: its background colour, or a light checkerboard when the background is transparent
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = d.background ?? checkerPattern(ctx, "#d6d9df", "#eceef2", 10);
    ctx.fillRect(view.x, view.y, d.width * view.zoom, d.height * view.zoom);
    ctx.strokeStyle = "#3a3f4b";
    ctx.strokeRect(view.x, view.y, d.width * view.zoom, d.height * view.zoom);
    if (viewAids().grid) drawGrid(ctx, w, h);
    if (viewAids().origin) drawOriginLines(ctx, w, h, d.background);
    const resolveImage = (id: string) => {
      // Packed images are drawn from their atlas page (resolved by page id).
      const a = textureAssets(d).find((i) => i.id === id);
      return a ? imageFor(a) : null;
    };
    const r = new CanvasRenderer(ctx, resolveImage);
    const v = { x: view.x * dpr, y: view.y * dpr, zoom: view.zoom * dpr };
    if (onionSkin() && mode() === "animate" && !running()) drawOnionSkins(ctx, v, resolveImage);
    const shown = (drag?.kind === "vertex" || drag?.kind === "attachment") && drag.preview ? drag.preview : s;
    r.render(shown, {
      view: v,
      clear: false,
      bones: showBones() && !running(),
      boundingBoxes: showBones(),
      wireframe: showMesh(),
      selectedBone: selectedBoneId(),
    });
    // selection outline
    const sel = selection();
    if (sel?.kind === "slot" && !running() && !meshToolOn()) {
      const slot = shown.slotById_(sel.id);
      const poly = slot && shown.hitPolygon(slot);
      if (poly) {
        ctx.setTransform(v.zoom, 0, 0, -v.zoom, v.x + d.originX * v.zoom, v.y + d.originY * v.zoom);
        ctx.beginPath();
        for (let i = 0; i < poly.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, poly[i], poly[i + 1]);
        ctx.closePath();
        ctx.strokeStyle = "#ffcc00";
        ctx.lineWidth = 2 / v.zoom;
        ctx.stroke();
      }
    }
    if (meshToolOn()) drawMeshOverlay(ctx, v, shown);
    const gz = gizmoBone(shown);
    if (gz) drawGizmo(ctx, dpr, gz);
    if (drag?.kind === "create") {
      ctx.setTransform(v.zoom, 0, 0, -v.zoom, v.x + d.originX * v.zoom, v.y + d.originY * v.zoom);
      ctx.beginPath();
      ctx.moveTo(...drag.start);
      ctx.lineTo(...drag.end);
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 3 / v.zoom;
      ctx.stroke();
    }
    drawGuidesAndSnaps(ctx, w, h, dpr);
    if (viewAids().rulers) drawRulers(ctx, w, h, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (hoverInfo) {
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillStyle = "#9aa3b2";
      ctx.fillText(hoverInfo, 8 * dpr, canvas.height - 8 * dpr);
    }
  }

  // ---- checkerboard, origin lines, axis gizmo ----
  const patterns = new Map<string, CanvasPattern>();
  function checkerPattern(ctx: CanvasRenderingContext2D, a: string, b: string, cell: number): CanvasPattern | string {
    const key = `${a}${b}${cell}`;
    let p = patterns.get(key);
    if (!p) {
      const c = document.createElement("canvas");
      c.width = c.height = Math.max(2, Math.round(cell * 2));
      const g = c.getContext("2d")!;
      g.fillStyle = a;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = b;
      g.fillRect(0, 0, c.width / 2, c.height / 2);
      g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
      const made = ctx.createPattern(c, "repeat");
      if (!made) return a;
      p = made;
      patterns.set(key, p);
    }
    return p;
  }

  /** Thin lines through the skeleton origin, like Spine's world axes. */
  function drawOriginLines(ctx: CanvasRenderingContext2D, w: number, h: number, background: string | null) {
    const ox = Math.round(skToScreenX(0)) + 0.5;
    const oy = Math.round(skToScreenY(0)) + 0.5;
    ctx.save();
    ctx.lineWidth = 1;
    // Readable on light artboards and on the dark stage.
    ctx.strokeStyle = background && luminance(background) > 0.6 ? "#0000002e" : "#ffffff30";
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, h);
    ctx.moveTo(0, oy);
    ctx.lineTo(w, oy);
    ctx.stroke();
    ctx.restore();
  }
  function luminance(hex: string): number {
    const h = hex.replace("#", "");
    const n = (i: number) => parseInt(h.length < 6 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16) / 255;
    return 0.2126 * n(0) + 0.7152 * n(1) + 0.0722 * n(2);
  }

  const GIZMO_LEN = 46;
  /** The selected bone, when its move arrows should show (and be draggable). */
  function gizmoBone(sk_: Skeleton | null | undefined): Bone | null {
    if (!sk_ || running() || !showBones() || meshToolOn() || tool() === "bone") return null;
    const id = selectedBoneId();
    return (id && sk_.boneById_(id)) || null;
  }
  /** Which part of the gizmo is under a screen point: "x"/"y" arrow, "xy" centre, or null. */
  function gizmoHit(b: Bone, mx: number, my: number): "x" | "y" | "xy" | null {
    const sx = skToScreenX(b.world.x);
    const sy = skToScreenY(b.world.y);
    const dx = mx - sx;
    const dy = my - sy;
    if (Math.abs(dx) <= 7 && Math.abs(dy) <= 7) return "xy";
    if (dx > 7 && dx <= GIZMO_LEN + 6 && Math.abs(dy) <= 6) return "x";
    if (-dy > 7 && -dy <= GIZMO_LEN + 6 && Math.abs(dx) <= 6) return "y";
    return null;
  }
  function drawGizmo(ctx: CanvasRenderingContext2D, dpr: number, b: Bone) {
    const sx = skToScreenX(b.world.x);
    const sy = skToScreenY(b.world.y);
    const active = drag?.kind === "bone" && drag.bone === b && drag.op === "translate" ? (drag.axis ?? "xy") : null;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const arrow = (ex: number, ey: number, color: string, on: boolean) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = on ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const ang = Math.atan2(ey - sy, ex - sx);
      ctx.beginPath();
      ctx.moveTo(ex + Math.cos(ang) * 8, ey + Math.sin(ang) * 8);
      ctx.lineTo(ex + Math.cos(ang + 2.4) * 7, ey + Math.sin(ang + 2.4) * 7);
      ctx.lineTo(ex + Math.cos(ang - 2.4) * 7, ey + Math.sin(ang - 2.4) * 7);
      ctx.closePath();
      ctx.fill();
    };
    arrow(sx + GIZMO_LEN, sy, "#ff5d5d", active === "x");
    arrow(sx, sy - GIZMO_LEN, "#3ddc84", active === "y");
    ctx.fillStyle = active === "xy" ? "#ffcc00" : "#ffcc00cc";
    ctx.strokeStyle = "#000a";
    ctx.lineWidth = 1;
    ctx.fillRect(sx - 4.5, sy - 4.5, 9, 9);
    ctx.strokeRect(sx - 4.5, sy - 4.5, 9, 9);
    ctx.restore();
  }

  /** Ghost poses at ±step·i frames, tinted (past = red, future = green), drawn under the current pose. */
  function drawOnionSkins(ctx: CanvasRenderingContext2D, v: { x: number; y: number; zoom: number }, images: (id: string) => CanvasImageSource | null) {
    const anim = currentAnimation();
    if (!anim) return;
    if (!ghost || ghostRev !== rev()) {
      ghost = new Skeleton(store.doc);
      ghostRev = rev();
    }
    ghostCanvas ??= document.createElement("canvas");
    if (ghostCanvas.width !== canvas.width || ghostCanvas.height !== canvas.height) {
      ghostCanvas.width = canvas.width;
      ghostCanvas.height = canvas.height;
    }
    const gctx = ghostCanvas.getContext("2d")!;
    const gr = new CanvasRenderer(gctx, images);
    const fps = store.doc.fps || 30;
    const dur = animationDuration(anim);
    const count = onionCount();
    // Farthest first so nearer ghosts sit on top.
    for (let i = count; i >= 1; i--)
      for (const dir of [-1, 1]) {
        const t = time() + (dir * i * onionStep()) / fps;
        if (t < -1e-6 || t > dur + 1e-6) continue;
        ghost.setToSetupPose();
        applyAnimation(ghost, anim, t);
        ghost.updateWorldTransform();
        gr.render(ghost, { view: v, clear: true, background: null });
        gctx.setTransform(1, 0, 0, 1, 0, 0);
        gctx.globalCompositeOperation = "source-atop";
        gctx.globalAlpha = 0.55;
        gctx.fillStyle = dir < 0 ? "#ff4a6a" : "#2fd47a";
        gctx.fillRect(0, 0, ghostCanvas.width, ghostCanvas.height);
        gctx.globalAlpha = 1;
        gctx.globalCompositeOperation = "source-over";
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.45 * (1 - (i - 1) / (count + 1));
        ctx.drawImage(ghostCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }
  }

  function currentWeights(t: MeshTarget): WeightTable {
    if (drag?.kind === "paint") return drag.table;
    const key = `${t.slotId}|${t.name}`;
    if (!wtCache || wtCache.rev !== rev() || wtCache.key !== key) wtCache = { rev: rev(), key, table: weightTable(t) };
    return wtCache.table;
  }

  /** Vertices, edges and (weights tool) weight heat map of the selected mesh. */
  function drawMeshOverlay(ctx: CanvasRenderingContext2D, v: { x: number; y: number; zoom: number }, shown: Skeleton) {
    const t = meshTarget();
    if (!t) return;
    const slot = shown.slotById_(t.slotId);
    const att = slot && shown.getAttachment(slot, t.name);
    if (!slot || !att || att.type !== "mesh") return;
    const d = store.doc;
    const wv = shown.attachmentWorldVertices(slot, att);
    const tris = att.triangles;
    const px = 1 / v.zoom;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(v.zoom, 0, 0, -v.zoom, v.x + d.originX * v.zoom, v.y + d.originY * v.zoom);
    const painting = tool() === "weights";
    const bone = weightBone();
    const table = painting ? currentWeights(t) : null;
    const w = (i: number) => (table && bone ? (table[i]?.get(bone) ?? 0) : 0);
    if (table) {
      for (let k = 0; k < tris.length; k += 3) {
        const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]];
        ctx.beginPath();
        ctx.moveTo(wv[a * 2], wv[a * 2 + 1]);
        ctx.lineTo(wv[b * 2], wv[b * 2 + 1]);
        ctx.lineTo(wv[c * 2], wv[c * 2 + 1]);
        ctx.closePath();
        ctx.fillStyle = heat((w(a) + w(b) + w(c)) / 3, 0.5);
        ctx.fill();
      }
    }
    ctx.beginPath();
    for (let k = 0; k < tris.length; k += 3)
      for (let e = 0; e < 3; e++) {
        const a = tris[k + e];
        const b = tris[k + ((e + 1) % 3)];
        ctx.moveTo(wv[a * 2], wv[a * 2 + 1]);
        ctx.lineTo(wv[b * 2], wv[b * 2 + 1]);
      }
    ctx.strokeStyle = "#ffffff66";
    ctx.lineWidth = px * dpr;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < att.hull; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, wv[i * 2], wv[i * 2 + 1]);
    ctx.closePath();
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 2 * px * dpr;
    ctx.stroke();
    const sel = new Set(meshSel());
    const hv = hoverVertex();
    const sz = 3.5 * px * dpr;
    for (let i = 0; i < wv.length / 2; i++) {
      const x = wv[i * 2];
      const y = wv[i * 2 + 1];
      ctx.fillStyle = painting ? heat(w(i)) : sel.has(i) ? "#ffcc00" : i < att.hull ? "#8ad4ff" : "#ffffff";
      ctx.strokeStyle = "#000000aa";
      ctx.lineWidth = px * dpr;
      if (painting) {
        ctx.beginPath();
        ctx.arc(x, y, sz, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2);
        ctx.strokeRect(x - sz, y - sz, sz * 2, sz * 2);
      }
      if (i === hv) {
        ctx.beginPath();
        ctx.arc(x, y, sz * 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffcc00";
        ctx.lineWidth = 1.5 * px * dpr;
        ctx.stroke();
      }
    }
    if (painting && hoverPt) {
      ctx.beginPath();
      ctx.arc(hoverPt[0], hoverPt[1], (brushRadius() / view.zoom), 0, Math.PI * 2);
      ctx.strokeStyle = brushMode() === "add" ? "#ffffffcc" : "#ff8a8acc";
      ctx.setLineDash([4 * px * dpr, 3 * px * dpr]);
      ctx.lineWidth = 1.5 * px * dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Index of the mesh vertex under (x, y) in skeleton space, or -1. */
  function pickVertex(world: ArrayLike<number>, x: number, y: number): number {
    let best = -1;
    let bestD = 8 / view.zoom;
    for (let i = 0; i < world.length / 2; i++) {
      const d = Math.hypot(world[i * 2] - x, world[i * 2 + 1] - y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Mesh / weights tool pointer-down. */
  function meshDown(e: PointerEvent, x: number, y: number) {
    const target = meshTarget();
    if (target) {
      const world = setupVertices(target);
      const hull = world.slice(0, target.att.hull * 2);
      if (tool() === "mesh") {
        const hit = pickVertex(world, x, y);
        if (hit >= 0) {
          let sel = meshSel();
          if (e.shiftKey) sel = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
          else if (!sel.includes(hit)) sel = [hit];
          setMeshSel(sel);
          if (sel.includes(hit))
            drag = { kind: "vertex", t: target, start: [x, y], anchor: hit, base: new Map(sel.map((i) => [i, [world[i * 2], world[i * 2 + 1]]])), moved: new Map(), preview: null };
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          const idx = addVertex(target, x, y, pointInPolygon(x, y, hull));
          if (idx >= 0) setMeshSel([idx]);
          return;
        }
        const slot = pickSlot(x, y);
        if (!slot || slot.data.id === target.slotId) {
          setMeshSel([]);
          return;
        }
      } else {
        if (e.shiftKey) {
          const b = pickBone(x, y);
          if (b) setWeightBone(b.data.id);
          return;
        }
        const r = brushRadius() / view.zoom;
        const near = pointInPolygon(x, y, hull) || world.some((_, i) => i % 2 === 0 && Math.hypot(world[i] - x, world[i + 1] - y) <= r);
        if (near) {
          const bone = weightBone();
          if (!bone) return void toast("Pick a bone to paint in the weights panel", "error");
          const table = weightTable(target);
          const changed = new Set(paintDab(table, world, x, y, r, brushStrength(), bone, brushMode()));
          drag = { kind: "paint", t: target, table, world, changed, last: [x, y], carry: 0 };
          return;
        }
      }
    }
    // No mesh under the cursor: select whatever slot is there.
    const slot = pickSlot(x, y);
    setSelection(slot ? { kind: "slot", id: slot.data.id } : null);
    if (slot && sk?.getAttachment(slot)?.type !== "mesh") toast("Select a mesh attachment to edit its vertices or weights", "info");
  }

  // ---------------- grid, rulers, guides, snapping ----------------

  /** Skeleton-space coordinate of a screen (CSS px) position, per axis. */
  const screenToSkX = (mx: number) => (mx - view.x) / view.zoom - store.doc.originX;
  const screenToSkY = (my: number) => store.doc.originY - (my - view.y) / view.zoom;
  const skToScreenX = (x: number) => view.x + (x + store.doc.originX) * view.zoom;
  const skToScreenY = (y: number) => view.y + (store.doc.originY - y) * view.zoom;

  /** A "nice" spacing (1, 2, 5 × 10^n) so lines are at least `minPx` apart on screen. */
  const niceStep = (minPx: number) => {
    const raw = minPx / view.zoom;
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= raw) ?? 10 * p;
  };

  function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    let step = viewAids().gridSize;
    // Thin out when zoomed far out so the grid never turns into a solid wash.
    while (step * view.zoom < 6) step *= 5;
    const x0 = Math.floor(screenToSkX(0) / step) * step;
    const x1 = screenToSkX(w);
    const y0 = Math.floor(screenToSkY(h) / step) * step;
    const y1 = screenToSkY(0);
    const line = (major: boolean) => {
      ctx.strokeStyle = major ? "rgba(110,140,255,0.32)" : "rgba(110,140,255,0.14)";
    };
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      line(major);
      ctx.beginPath();
      for (let x = x0; x <= x1; x += step) {
        if (Math.abs(Math.round(x / step) % 5) === 0 !== major) continue;
        const sx = Math.round(skToScreenX(x)) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let y = y0; y <= y1; y += step) {
        if (Math.abs(Math.round(y / step) % 5) === 0 !== major) continue;
        const sy = Math.round(skToScreenY(y)) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }
  }

  function drawGuidesAndSnaps(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (viewAids().rulers) {
      const live = drag?.kind === "guide" ? drag.guide : null;
      const list = live ? [...guides().filter((g) => g.id !== live.id), live] : guides();
      ctx.lineWidth = 1;
      for (const g of list) {
        ctx.strokeStyle = g === live ? "#67e8f9" : "rgba(34,211,238,0.85)";
        ctx.beginPath();
        if (g.axis === "x") {
          const sx = Math.round(skToScreenX(g.pos)) + 0.5;
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, h);
        } else {
          const sy = Math.round(skToScreenY(g.pos)) + 0.5;
          ctx.moveTo(0, sy);
          ctx.lineTo(w, sy);
        }
        ctx.stroke();
      }
    }
    if (!snapLines.length) return;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    for (const l of snapLines) {
      ctx.strokeStyle = SNAP_COLORS[l.kind] ?? "#ff4fa3";
      ctx.beginPath();
      if (l.axis === "x") {
        const sx = Math.round(skToScreenX(l.value)) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      } else {
        const sy = Math.round(skToScreenY(l.value)) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
      if (l.kind === "point" && l.other !== undefined) {
        // Mark the point we aligned with.
        const [px, py] = l.axis === "x" ? [skToScreenX(l.value), skToScreenY(l.other)] : [skToScreenX(l.other), skToScreenY(l.value)];
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px - 4, py - 4);
        ctx.lineTo(px + 4, py + 4);
        ctx.moveTo(px + 4, py - 4);
        ctx.lineTo(px - 4, py + 4);
        ctx.stroke();
        ctx.setLineDash([5, 4]);
      }
    }
    ctx.setLineDash([]);
  }

  function drawRulers(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#16181dee";
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillRect(0, 0, RULER, h);
    ctx.strokeStyle = "#2f3440";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER + 0.5);
    ctx.lineTo(w, RULER + 0.5);
    ctx.moveTo(RULER + 0.5, 0);
    ctx.lineTo(RULER + 0.5, h);
    ctx.stroke();
    // Artboard span highlighted on both rulers.
    ctx.fillStyle = "rgba(91,140,255,0.12)";
    ctx.fillRect(view.x, 0, store.doc.width * view.zoom, RULER);
    ctx.fillRect(0, view.y, RULER, store.doc.height * view.zoom);
    const step = niceStep(60);
    const minor = step / 5;
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "#8a93a6";
    ctx.strokeStyle = "#4a5263";
    ctx.beginPath();
    for (let x = Math.floor(screenToSkX(RULER) / minor) * minor; x <= screenToSkX(w); x += minor) {
      const sx = Math.round(skToScreenX(x)) + 0.5;
      if (sx < RULER) continue;
      const major = Math.abs(Math.round(x / minor) % 5) === 0;
      ctx.moveTo(sx, RULER);
      ctx.lineTo(sx, major ? 4 : RULER - 4);
      if (major) ctx.fillText(fmtRuler(x), sx + 3, 10);
    }
    for (let y = Math.floor(screenToSkY(h) / minor) * minor; y <= screenToSkY(RULER); y += minor) {
      const sy = Math.round(skToScreenY(y)) + 0.5;
      if (sy < RULER) continue;
      const major = Math.abs(Math.round(y / minor) % 5) === 0;
      ctx.moveTo(RULER, sy);
      ctx.lineTo(major ? 4 : RULER - 4, sy);
      if (major) {
        ctx.save();
        ctx.translate(11, sy - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(fmtRuler(y), 0, 0);
        ctx.restore();
      }
    }
    ctx.stroke();
    // Guide markers and the live cursor position.
    ctx.fillStyle = "#22d3ee";
    for (const g of guides()) {
      if (g.axis === "x") ctx.fillRect(Math.round(skToScreenX(g.pos)) - 1, 0, 3, RULER);
      else ctx.fillRect(0, Math.round(skToScreenY(g.pos)) - 1, RULER, 3);
    }
    if (hoverPt) {
      ctx.fillStyle = "#ffcc00";
      ctx.fillRect(Math.round(skToScreenX(hoverPt[0])), 0, 1, RULER);
      ctx.fillRect(0, Math.round(skToScreenY(hoverPt[1])), RULER, 1);
    }
    ctx.fillStyle = "#1e2128";
    ctx.fillRect(0, 0, RULER, RULER);
  }

  /** Lines and points a drag can snap to; `movingBones` are excluded from the bone smart guides. */
  function snapTargets(movingBones: Set<string> = new Set(), extraPoints: [number, number][] = []): SnapTarget[] {
    const a = viewAids();
    const out: SnapTarget[] = [];
    if (a.snapArtboard) out.push(...artboardTargets(store.doc));
    if (a.snapGuides && a.rulers) for (const g of guides()) out.push({ axis: g.axis, value: g.pos, kind: "guide" });
    if (a.snapBones && sk) {
      const pts: [number, number][] = [];
      for (const b of sk.bones) {
        if (movingBones.has(b.data.id)) continue;
        pts.push([b.world.x, b.world.y]);
        if (b.data.length > 0) pts.push(applyM(b.world, b.data.length, 0) as [number, number]);
      }
      out.push(...pointTargets([...pts, ...extraPoints]));
    } else if (extraPoints.length) out.push(...pointTargets(extraPoints));
    return out;
  }

  /** Snap a skeleton-space point for a drag (hold Ctrl/⌘ to bypass). Records the lines to draw. */
  function snap(x: number, y: number, e: { ctrlKey: boolean; metaKey: boolean }, targets: () => SnapTarget[]): [number, number] {
    const a = viewAids();
    if (!a.snap || e.ctrlKey || e.metaKey) {
      snapLines = [];
      return [x, y];
    }
    const r = snapPoint(x, y, targets(), 6 / view.zoom, a.grid && a.snapGrid ? a.gridSize : undefined);
    snapLines = r.lines;
    return [r.x, r.y];
  }

  /** The bone and all bones below it (they move together). */
  function subtree(bone: Bone): Set<string> {
    const out = new Set<string>([bone.data.id]);
    const walk = (b: Bone) => b.children.forEach((c) => (out.add(c.data.id), walk(c)));
    walk(bone);
    return out;
  }

  /**
   * Guide under a screen point (within 4px). Only the select/translate/scale tools grab guides, so drawing
   * bones or editing meshes next to a guide snaps to it instead of moving it.
   */
  function guideAt(mx: number, my: number): Guide | null {
    if (!viewAids().rulers || !["select", "translate", "scale"].includes(tool())) return null;
    let best: Guide | null = null;
    let bestD = 4;
    for (const g of guides()) {
      const d = g.axis === "x" ? Math.abs(skToScreenX(g.pos) - mx) : Math.abs(skToScreenY(g.pos) - my);
      if (d <= bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  /** Pointer-down on a ruler (creates a guide) or on a guide (moves it). Returns true when handled. */
  function guideDown(mx: number, my: number): boolean {
    if (!viewAids().rulers) return false;
    if (my < RULER && mx > RULER) {
      drag = { kind: "guide", guide: { id: newGuideId(), axis: "y", pos: screenToSkY(my) }, isNew: true };
      return true;
    }
    if (mx < RULER && my > RULER) {
      drag = { kind: "guide", guide: { id: newGuideId(), axis: "x", pos: screenToSkX(mx) }, isNew: true };
      return true;
    }
    if (mx < RULER && my < RULER) return true; // corner
    const g = guideAt(mx, my);
    if (g) {
      drag = { kind: "guide", guide: { ...g }, isNew: false };
      return true;
    }
    return false;
  }

  function pickBone(x: number, y: number): Bone | null {
    if (!sk) return null;
    let best: Bone | null = null;
    let bestD = 8 / view.zoom;
    for (const b of sk.bones) {
      const [ex, ey] = applyM(b.world, b.data.length, 0);
      const d = segDist(x, y, b.world.x, b.world.y, ex, ey);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  function pickSlot(x: number, y: number) {
    if (!sk) return null;
    for (const it of [...sk.drawList()].reverse()) {
      const poly = sk.hitPolygon(it.slot);
      if (poly && pointIn(x, y, poly)) return it.slot;
    }
    return null;
  }

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  function onDown(e: PointerEvent) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released (or synthetic): dragging still works without capture */
    }
    const [mx, my] = local(e);
    if (e.button === 1 || e.button === 2 || e.altKey || spaceDown) {
      drag = { kind: "pan", sx: mx, sy: my, vx: view.x, vy: view.y };
      return;
    }
    if (!running() && guideDown(mx, my)) return;
    const [x, y] = toSkeleton(mx, my);
    if (running()) {
      smInstance()?.pointer("down", x, y);
      return;
    }
    // Make sure picking sees the latest document even if no frame has been drawn since the last edit.
    pose(ensureSkeleton(), 0);
    const t = tool();
    if (t === "mesh" || t === "weights") {
      if (mode() !== "setup") {
        setMode("setup");
        setPlaying(false);
        toast("Mesh editing works in Setup mode", "info");
        pose(ensureSkeleton(), 0);
      }
      meshDown(e, x, y);
      return;
    }
    if (t === "bone") {
      const parentId = selectedBoneId();
      const parent = (parentId && sk?.boneById_(parentId)) || sk?.bones[0] || null;
      const start = snap(x, y, e, () => snapTargets());
      drag = { kind: "create", parent, start, end: start };
      return;
    }
    // Move arrows of the selected bone: drag the red arrow along X, the green one along Y, the square freely.
    const gz = gizmoBone(sk);
    const gzPart = gz ? gizmoHit(gz, mx, my) : null;
    if (gz && gzPart) {
      const base = { x: gz.x, y: gz.y, rotation: gz.rotation, scaleX: gz.scaleX, scaleY: gz.scaleY };
      drag = { kind: "bone", op: "translate", bone: gz, start: [x, y], startWorld: [gz.world.x, gz.world.y], base, cur: { ...base }, axis: gzPart === "xy" ? undefined : gzPart };
      return;
    }
    const bone = pickBone(x, y);
    const slot = bone ? null : pickSlot(x, y);
    if (bone) setSelection({ kind: "bone", id: bone.data.id });
    else if (slot) setSelection({ kind: "slot", id: slot.data.id });
    else {
      setSelection(null);
      return;
    }
    if (slot && t === "translate" && mode() === "setup") {
      const att = sk!.getAttachment(slot);
      if (att && (att.type === "region" || att.type === "sequence" || att.type === "shape" || att.type === "point" || att.type === "text")) {
        drag = { kind: "attachment", slotId: slot.data.id, name: att.name, start: [x, y], base: [att.x, att.y], cur: [att.x, att.y], inv: invert(slot.bone.world), preview: null, startWorld: applyM(slot.bone.world, att.x, att.y) as [number, number] };
        return;
      }
    }
    const target = bone ?? slot!.bone;
    const op = t === "translate" ? "translate" : t === "scale" ? "scale" : "rotate";
    const base = { x: target.x, y: target.y, rotation: target.rotation, scaleX: target.scaleX, scaleY: target.scaleY };
    drag = { kind: "bone", op, bone: target, start: [x, y], startWorld: [target.world.x, target.world.y], base, cur: { ...base } };
  }

  function onMove(e: PointerEvent) {
    const [mx, my] = local(e);
    const [x, y] = toSkeleton(mx, my);
    hoverInfo = `x ${x.toFixed(1)}  y ${y.toFixed(1)}  zoom ${(view.zoom * 100).toFixed(0)}%`;
    hoverPt = [x, y];
    if (meshToolOn() && drag?.kind !== "vertex") {
      const t = meshTarget();
      const hv = t ? pickVertex(setupVertices(t), x, y) : -1;
      if (hv !== hoverVertex()) setHoverVertex(hv);
    } else if (hoverVertex() !== -1) setHoverVertex(-1);
    if (running()) {
      smInstance()?.pointer("move", x, y);
      if (!drag) return;
    }
    if (!drag) {
      const g = guideAt(mx, my);
      const onRuler = viewAids().rulers && (mx < RULER || my < RULER);
      setCursorHint(g ? (g.axis === "x" ? "ew-resize" : "ns-resize") : onRuler ? (my < RULER ? "ns-resize" : "ew-resize") : null);
      return;
    }
    if (drag.kind === "guide") {
      const a = viewAids();
      let pos = drag.guide.axis === "x" ? screenToSkX(mx) : screenToSkY(my);
      // Guides snap to the grid (when shown) and to whole units.
      if (a.snap && !e.ctrlKey && !e.metaKey && a.grid && a.snapGrid && Math.abs(pos - Math.round(pos / a.gridSize) * a.gridSize) < 6 / view.zoom) pos = Math.round(pos / a.gridSize) * a.gridSize;
      drag.guide = { ...drag.guide, pos: Math.round(pos) };
      hoverInfo = `guide ${drag.guide.axis} = ${drag.guide.pos}${(drag.guide.axis === "x" ? mx < RULER : my < RULER) ? "  (release to remove)" : ""}`;
      return;
    }
    if (drag.kind === "pan") {
      view.x = drag.vx + (mx - drag.sx);
      view.y = drag.vy + (my - drag.sy);
    } else if (drag.kind === "create") {
      drag.end = snap(x, y, e, () => snapTargets());
    } else if (drag.kind === "vertex") {
      // Snap the grabbed vertex; the rest of the selection follows by the same offset.
      const [ax, ay] = drag.base.get(drag.anchor)!;
      const vdrag = drag;
      const [sx, sy] = snap(ax + x - drag.start[0], ay + y - drag.start[1], e, () => {
        const world = setupVertices(vdrag.t);
        const others: [number, number][] = [];
        for (let i = 0; i < world.length / 2; i++) if (!vdrag.base.has(i)) others.push([world[i * 2], world[i * 2 + 1]]);
        return snapTargets(new Set(), others);
      });
      const dx = sx - ax;
      const dy = sy - ay;
      for (const [i, [bx, by]] of drag.base) drag.moved.set(i, [bx + dx, by + dy]);
      const t = drag.t;
      const g = buildGeometry(t, movedWorld(t, drag.moved), t.att.hull, identity(t.att.vertices.length / 2), meshWarp());
      if (typeof g !== "string") {
        // Preview on a throwaway copy of the document; the real edit is one op on release.
        drag.preview ??= new Skeleton(structuredClone(store.doc));
        const ps = drag.preview;
        const slot = ps.slotById_(t.slotId);
        const att = slot && ps.getAttachment(slot, t.name);
        if (att && att.type === "mesh") Object.assign(att, g);
      }
    } else if (drag.kind === "paint") {
      // Dabs at a fixed spacing along the stroke, so the result doesn't depend on mouse speed or event rate.
      const r = brushRadius() / view.zoom;
      const spacing = r * 0.25;
      const [lx, ly] = drag.last;
      const dist = Math.hypot(x - lx, y - ly);
      let s2 = spacing - drag.carry;
      while (s2 <= dist) {
        const f = s2 / dist;
        for (const v of paintDab(drag.table, drag.world, lx + (x - lx) * f, ly + (y - ly) * f, r, brushStrength() * 0.25, weightBone()!, brushMode())) drag.changed.add(v);
        s2 += spacing;
      }
      drag.carry = spacing - (s2 - dist);
      drag.last = [x, y];
    } else if (drag.kind === "attachment") {
      // Snap the attachment's origin, then convert back to slot-bone space.
      const [wx, wy] = snap(drag.startWorld[0] + x - drag.start[0], drag.startWorld[1] + y - drag.start[1], e, () => snapTargets());
      const [lx, ly] = applyM(drag.inv, wx, wy);
      drag.cur = [lx, ly];
      // Preview on a throwaway copy of the document; the real edit is one op on release.
      drag.preview ??= new Skeleton(structuredClone(store.doc));
      const ps = drag.preview;
      ps.textValues = inputDefault;
      const att = ps.getAttachment(ps.slotById_(drag.slotId)!, drag.name);
      if (att && "x" in att) {
        att.x = drag.cur[0];
        att.y = drag.cur[1];
      }
    } else {
      const b = drag.bone;
      const pw = b.parent ? b.parent.world : { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
      const det = Math.sign(pw.a * pw.d - pw.b * pw.c) || 1;
      if (drag.op === "rotate") {
        const a0 = Math.atan2(drag.start[1] - b.world.y, drag.start[0] - b.world.x);
        const a1 = Math.atan2(y - b.world.y, x - b.world.x);
        let delta = (a1 - a0) * RAD;
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        drag.cur = { ...drag.cur, rotation: round2(drag.base.rotation! + delta * det) };
      } else if (drag.op === "translate") {
        const inv = invert(pw);
        const moving = subtree(b);
        // Axis-locked drags (gizmo arrows) keep the other world coordinate fixed.
        const wx = drag.axis === "y" ? drag.startWorld[0] : drag.startWorld[0] + x - drag.start[0];
        const wy = drag.axis === "x" ? drag.startWorld[1] : drag.startWorld[1] + y - drag.start[1];
        let [sx, sy] = snap(wx, wy, e, () => snapTargets(moving));
        if (drag.axis === "x") sy = drag.startWorld[1];
        if (drag.axis === "y") sx = drag.startWorld[0];
        const dx = sx - drag.startWorld[0];
        const dy = sy - drag.startWorld[1];
        drag.cur = { ...drag.cur, x: round2(drag.base.x! + inv.a * dx + inv.b * dy), y: round2(drag.base.y! + inv.c * dx + inv.d * dy) };
      } else {
        const d0 = Math.hypot(drag.start[0] - b.world.x, drag.start[1] - b.world.y) || 1;
        const d1 = Math.hypot(x - b.world.x, y - b.world.y);
        const k = d1 / d0;
        drag.cur = e.shiftKey ? { ...drag.cur, scaleX: round2(drag.base.scaleX! * k), scaleY: round2(drag.base.scaleY! * k) } : { ...drag.cur, scaleX: round2(drag.base.scaleX! * k) };
      }
    }
  }

  function onUp(e: PointerEvent) {
    const [mx, my] = local(e);
    let [x, y] = toSkeleton(mx, my);
    if (running() && drag?.kind !== "pan") smInstance()?.pointer("up", x, y);
    const d = drag;
    drag = null;
    snapLines = [];
    if (!d) return;
    if (d.kind === "guide") {
      const overRuler = d.guide.axis === "x" ? mx < RULER : my < RULER;
      if (overRuler) {
        if (!d.isNew) removeGuide(d.guide.id);
      } else upsertGuide(d.guide);
      return;
    }
    if (d.kind === "create") {
      [x, y] = d.end;
      const [sx, sy] = d.start;
      const len = Math.hypot(x - sx, y - sy);
      const pw = d.parent?.world ?? { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
      const [lx, ly] = applyM(invert(pw), sx, sy);
      const parentRot = Math.atan2(pw.c, pw.a) * RAD;
      const worldRot = len > 2 ? Math.atan2(y - sy, x - sx) * RAD : 0;
      const res = apply("addBone", {
        parent: d.parent?.data.id ?? null,
        x: round2(lx),
        y: round2(ly),
        rotation: round2(worldRot - parentRot),
        length: round2(len > 2 ? len / Math.hypot(pw.a, pw.c) : 0),
      }) as { id: string } | undefined;
      if (res) setSelection({ kind: "bone", id: res.id });
    } else if (d.kind === "bone") {
      const changed: Partial<BoneData> = {};
      for (const k of Object.keys(d.cur) as (keyof BoneData)[]) if (d.cur[k] !== d.base[k]) (changed as Record<string, unknown>)[k] = d.cur[k];
      if (Object.keys(changed).length) commitBone(d.bone.data.id, changed as Record<string, number>);
    } else if (d.kind === "vertex") {
      if ([...d.moved].some(([i, [mx2, my2]]) => mx2 !== d.base.get(i)![0] || my2 !== d.base.get(i)![1])) moveVertices(d.t, d.moved, meshWarp());
    } else if (d.kind === "paint") {
      commitWeights(d.t, d.table, d.changed);
    } else if (d.kind === "attachment") {
      if (d.cur[0] !== d.base[0] || d.cur[1] !== d.base[1]) commitAttachmentMove(d.slotId, d.name, round2(d.cur[0]), round2(d.cur[1]));
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const [mx, my] = local(e);
    zoomBy(Math.exp(-e.deltaY * 0.0015), mx, my);
  }

  /** Zoom by `k` around a point in canvas px (default: the centre). */
  const zoomBy = (k: number, mx = wrap.clientWidth / 2, my = wrap.clientHeight / 2) => {
    const z = Math.min(20, Math.max(0.05, view.zoom * k));
    view.x = mx - ((mx - view.x) * z) / view.zoom;
    view.y = my - ((my - view.y) * z) / view.zoom;
    view.zoom = z;
  };
  /** Centre the view on the selected bone (or the selected slot's bone). */
  const focusSelection = () => {
    const id = selectedBoneId();
    const b = id && ensureSkeleton().boneById_(id);
    if (!b) {
      fit();
      return;
    }
    pose(sk!, 0);
    const d = store.doc;
    const zoom = Math.max(view.zoom, 1);
    view.zoom = zoom;
    view.x = wrap.clientWidth / 2 - (b.world.x + d.originX) * zoom;
    view.y = wrap.clientHeight / 2 - (d.originY - b.world.y) * zoom;
  };

  // Space held = pan with the mouse (a gesture, not a registry shortcut; Space alone still plays the timeline).
  let spaceDown = false;
  const kd = (e: KeyboardEvent) => {
    if (e.code === "Space" && !isTypingTarget(e.target as HTMLElement)) spaceDown = true;
  };
  const ku = (e: KeyboardEvent) => {
    if (e.code === "Space") spaceDown = false;
  };
  const blur = () => (spaceDown = false);

  onMount(() => {
    setImageReadyCallback(() => {});
    raf = requestAnimationFrame(frame);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    const off = [
      shortcuts.bind("view.fit", fit),
      shortcuts.bind("view.focus", focusSelection),
      shortcuts.bind("view.zoomIn", () => zoomBy(1.25)),
      shortcuts.bind("view.zoomOut", () => zoomBy(1 / 1.25)),
      shortcuts.bind("view.zoom100", () => zoomBy(1 / view.zoom)),
    ];
    onCleanup(() => off.forEach((f) => f()));
  });
  onCleanup(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", kd);
    window.removeEventListener("keyup", ku);
    window.removeEventListener("blur", blur);
  });

  createEffect(on(selection, () => setMeshSel([]), { defer: true }));
  createEffect(
    on([tool, () => meshTarget()?.slotBone], ([t, slotBone]) => {
      if (t !== "mesh" && t !== "weights") return;
      if (mode() !== "setup") {
        setMode("setup");
        setPlaying(false);
      }
      const wb = weightBone();
      if (slotBone && (!wb || !store.doc.skeleton.bones.some((b) => b.id === wb))) setWeightBone(slotBone);
    }),
  );

  // (Re)start the state machine when "running" toggles on or the chosen machine changes.
  createEffect(
    on([running, () => currentStateMachine()?.id], ([isRunning]) => {
      if (isRunning) {
        ensureSkeleton();
        setEventLog([]);
        if (!currentStateMachine()) {
          toast("Create a state machine first", "error");
          setRunning(false);
        } else startStateMachine();
      } else {
        smInstance()?.dispose();
        setSmInstance(null);
      }
    }),
  );

  return (
    <div class="viewport" classList={{ "with-rulers": viewAids().rulers }} ref={wrap}>
      <canvas
        ref={canvas}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: running() ? "pointer" : (cursorHint() ?? (tool() === "bone" || tool() === "weights" ? "crosshair" : "default")) }}
      />
      <Show when={meshToolOn()}>
        <MeshPanel />
      </Show>
      <div class="view-bar" onPointerDown={(e) => e.stopPropagation()}>
        <div class="seg">
          <button classList={{ active: viewAids().grid }} aria-pressed={viewAids().grid} title={tip("Grid", "view.grid")} onClick={() => toggleViewAid("grid")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 5.5h14M1 10.5h14M5.5 1v14M10.5 1v14" /></svg>
          </button>
          <button classList={{ active: viewAids().rulers }} aria-pressed={viewAids().rulers} title={`${tip("Rulers and guides", "view.rulers")}. Drag from a ruler to add a guide; drag it back to remove.`} onClick={() => toggleViewAid("rulers")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 11.5l10-10 3 3-10 10z M4 9l1.5 1.5M6 7l2 2M8 5l1.5 1.5M10 3l2 2" /></svg>
          </button>
          <button classList={{ active: viewAids().snap }} aria-pressed={viewAids().snap} title="Snapping (hold Ctrl/⌘ while dragging to bypass)" onClick={() => toggleViewAid("snap")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v6a4 4 0 0 0 8 0V2M4 5h3M9 5h3" /></svg>
          </button>
          <button classList={{ active: aidsOpen() }} aria-expanded={aidsOpen()} title="Grid and snapping options" onClick={() => setAidsOpen(!aidsOpen())}>
            ▾
          </button>
        </div>
        <Show when={aidsOpen()}>
          <div class="aids-pop" role="dialog" aria-label="Grid and snapping options">
            <label class="field">
              <span>Grid size</span>
              <input type="number" min="1" max="1000" value={viewAids().gridSize} onChange={(e) => setViewAid("gridSize", Number(e.currentTarget.value))} />
            </label>
            <div class="muted small">Show</div>
            <label class="check" title="Shows what is transparent: the stage, and the artboard when its background is transparent">
              <input type="checkbox" checked={viewAids().checker} onChange={(e) => setViewAid("checker", e.currentTarget.checked)} /> Checkerboard
            </label>
            <label class="check" title="Lines through the skeleton origin (x = 0, y = 0)">
              <input type="checkbox" checked={viewAids().origin} onChange={(e) => setViewAid("origin", e.currentTarget.checked)} /> Origin lines
            </label>
            <div class="muted small">Snap to</div>
            <label class="check"><input type="checkbox" checked={viewAids().snapArtboard} onChange={(e) => setViewAid("snapArtboard", e.currentTarget.checked)} /> Artboard centre, edges, origin</label>
            <label class="check"><input type="checkbox" checked={viewAids().snapGuides} onChange={(e) => setViewAid("snapGuides", e.currentTarget.checked)} /> Guides</label>
            <label class="check"><input type="checkbox" checked={viewAids().snapGrid} onChange={(e) => setViewAid("snapGrid", e.currentTarget.checked)} /> Grid (when shown)</label>
            <label class="check"><input type="checkbox" checked={viewAids().snapBones} onChange={(e) => setViewAid("snapBones", e.currentTarget.checked)} /> Bone joints and vertices</label>
            <div class="btn-row">
              <button disabled={!guides().length} onClick={() => clearGuides()}>
                Clear {guides().length || ""} guide{guides().length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </Show>
        <span class="bar-sep" />
        <button classList={{ active: onionSkin() }} disabled={mode() !== "animate"} title={tip("Onion skin: show ghost poses before (red) and after (green) the current frame (Animate mode)", "view.onion")} onClick={() => setOnionSkin(!onionSkin())}>
          Onion
        </button>
        <Show when={onionSkin() && mode() === "animate"}>
          <label class="check" title="Ghosts on each side">
            ±
            <input class="tiny" type="number" min="1" max="6" value={onionCount()} onChange={(e) => setOnionCount(clampInt(e.currentTarget.value, 1, 6))} />
          </label>
          <label class="check" title="Frames between ghosts">
            every
            <input class="tiny" type="number" min="1" max="30" value={onionStep()} onChange={(e) => setOnionStep(clampInt(e.currentTarget.value, 1, 30))} />
            fr
          </label>
        </Show>
        <button onClick={fit} title={tip("Fit artboard", "view.fit")}>
          ⤢
        </button>
      </div>
      <div class="viewport-hint">
        {running()
          ? "▶ Running state machine — interact with the artboard"
          : `${mode() === "animate" ? `ANIMATE${currentAnimation() ? ` · ${currentAnimation()!.name} @ ${time().toFixed(2)}s` : " · no animation"}` : "SETUP"}${activeSkin() ? ` · SKIN ${activeSkin()!.name}` : ""} · wheel: zoom · alt/right-drag: pan · ${kbd("view.fit")}: fit · ${kbd("help.shortcuts")}: shortcuts`}
      </div>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtRuler = (n: number) => String(Math.round(n * 100) / 100);
const clampInt = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

/** Floating panel for the mesh and weights tools. */
function MeshPanel() {
  const target = () => (doc(), meshTarget());
  const influences = () => {
    const t = target();
    const v = hoverVertex();
    if (!t || v < 0 || v >= t.att.vertices.length / 2) return null;
    const list = t.att.weights ? t.att.weights[v].map((i) => [i.bone, i.weight] as const) : [[t.slotBone, 1] as const];
    const name = (id: string) => doc().skeleton.bones.find((b) => b.id === id)?.name ?? id;
    return { v, list: [...list].sort((a, b) => b[1] - a[1]).map(([b, w]) => ({ bone: name(b), w })) };
  };
  return (
    <div class="mesh-panel" onPointerDown={(e) => e.stopPropagation()}>
      <Show when={target()} fallback={<div class="muted">Click a mesh attachment to edit it.</div>}>
        {(t) => (
          <>
            <div class="mesh-title">
              {tool() === "mesh" ? "Mesh" : "Weights"} · <b>{t().name}</b> · {t().att.vertices.length / 2} vertices ({t().att.hull} hull)
              {t().att.weights ? " · weighted" : ""}
            </div>
            <Show when={tool() === "mesh"}>
              <div class="hint">Click a vertex to select (shift: add, Ctrl/⌘+A: all), drag or arrow keys to move, Ctrl/⌘-click to add (outside the hull extends the outline), Delete removes, Esc deselects.</div>
              <div class="btn-row">
                <label class="check" title="Moving vertices keeps their image coordinates, so the image stretches">
                  <input type="checkbox" checked={meshWarp()} onChange={(e) => setMeshWarp(e.currentTarget.checked)} /> Warp image
                </label>
                <button class="danger" disabled={!meshSel().length} onClick={() => deleteSelectedVertices()}>
                  Delete {meshSel().length || ""}
                </button>
              </div>
            </Show>
            <Show when={tool() === "weights"}>
              <label class="field">
                <span>Bone</span>
                <select value={weightBone() ?? ""} onChange={(e) => setWeightBone(e.currentTarget.value || null)}>
                  <For each={doc().skeleton.bones}>{(b) => <option value={b.id} selected={b.id === (weightBone() ?? "")}>{b.name}</option>}</For>
                </select>
              </label>
              <div class="field">
                <span>Brush</span>
                <div class="segmented group">
                  <button classList={{ active: brushMode() === "add" }} onClick={() => setBrushMode("add")}>Add</button>
                  <button classList={{ active: brushMode() === "subtract" }} onClick={() => setBrushMode("subtract")}>Remove</button>
                </div>
              </div>
              <label class="field">
                <span>Radius</span>
                <input type="range" min="5" max="150" value={brushRadius()} onInput={(e) => setBrushRadius(Number(e.currentTarget.value))} />
                <span class="num">{brushRadius()}px</span>
              </label>
              <label class="field">
                <span>Strength</span>
                <input type="range" min="0.05" max="1" step="0.05" value={brushStrength()} onInput={(e) => setBrushStrength(Number(e.currentTarget.value))} />
                <span class="num">{Math.round(brushStrength() * 100)}%</span>
              </label>
              <div class="weight-legend">
                <span>0</span>
                <div class="ramp" />
                <span>1</span>
              </div>
              <div class="hint">Drag over the mesh to paint. Shift-click a bone to paint it.</div>
            </Show>
            <Show when={influences()}>
              {(inf) => (
                <div class="vertex-info">
                  <div class="muted">vertex {inf().v}</div>
                  <For each={inf().list}>
                    {(i) => (
                      <div class="inf-row">
                        <span>{i.bone}</span>
                        <div class="bar">
                          <div style={{ width: `${i.w * 100}%`, background: heat(i.w) }} />
                        </div>
                        <span class="num">{(i.w * 100).toFixed(0)}%</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function pointIn(x: number, y: number, poly: ArrayLike<number>) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
