import { type BoneData, RAD, animationDuration, apply as applyM, invert, pointInPolygon, textureAssets } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { type Bone, type ScriptHost, Skeleton, StateMachineInstance, applyAnimation, trustedFunctionHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { imageFor, setImageReadyCallback } from "../images.ts";
import { commitBone, commitAttachmentMove } from "../edit.ts";
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
  | { kind: "bone"; op: "rotate" | "translate" | "scale"; bone: Bone; start: [number, number]; base: Partial<BoneData>; cur: Partial<BoneData> }
  | { kind: "attachment"; slotId: string; name: string; start: [number, number]; base: [number, number]; cur: [number, number]; inv: ReturnType<typeof invert>; preview: Skeleton | null }
  | { kind: "create"; parent: Bone | null; start: [number, number]; end: [number, number] }
  | { kind: "vertex"; t: MeshTarget; start: [number, number]; base: Map<number, [number, number]>; moved: Map<number, [number, number]>; preview: Skeleton | null }
  | { kind: "paint"; t: MeshTarget; table: WeightTable; world: number[]; changed: Set<number>; last: [number, number]; carry: number };

/** Mesh tool: when on, moving existing vertices keeps their uvs (the image stretches). */
export const [meshWarp, setMeshWarp] = createSignal(false);
const [hoverVertex, setHoverVertex] = createSignal(-1);

/** Weight colour: blue (0) → green → red (1). */
const heat = (w: number, a = 1) => `hsla(${Math.round((1 - Math.min(1, Math.max(0, w))) * 240)}, 90%, 52%, ${a})`;
const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

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
  let hoverInfo = "";
  let hoverPt: [number, number] | null = null;
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
    setSmInstance(inst);
  }

  function pose(sk: Skeleton, dt: number) {
    const sm = smInstance();
    if (running() && sm) {
      sm.advance(dt);
    } else {
      sk.setToSetupPose();
      const anim = currentAnimation();
      if (mode() === "animate" && anim) {
        if (playing()) {
          const d = animationDuration(anim) || 1;
          setTime((t) => (t + dt) % d);
        }
        applyAnimation(sk, anim, time());
      }
      if (drag?.kind === "bone") Object.assign(drag.bone, drag.cur);
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
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1b1e24";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // artboard
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = d.background ?? "#ffffff";
    ctx.fillRect(view.x, view.y, d.width * view.zoom, d.height * view.zoom);
    ctx.strokeStyle = "#3a3f4b";
    ctx.strokeRect(view.x, view.y, d.width * view.zoom, d.height * view.zoom);
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
    if (drag?.kind === "create") {
      ctx.setTransform(v.zoom, 0, 0, -v.zoom, v.x + d.originX * v.zoom, v.y + d.originY * v.zoom);
      ctx.beginPath();
      ctx.moveTo(...drag.start);
      ctx.lineTo(...drag.end);
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 3 / v.zoom;
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (hoverInfo) {
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillStyle = "#9aa3b2";
      ctx.fillText(hoverInfo, 8 * dpr, canvas.height - 8 * dpr);
    }
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
            drag = { kind: "vertex", t: target, start: [x, y], base: new Map(sel.map((i) => [i, [world[i * 2], world[i * 2 + 1]]])), moved: new Map(), preview: null };
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
    canvas.setPointerCapture(e.pointerId);
    const [mx, my] = local(e);
    if (e.button === 1 || e.button === 2 || e.altKey || spaceDown) {
      drag = { kind: "pan", sx: mx, sy: my, vx: view.x, vy: view.y };
      return;
    }
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
      drag = { kind: "create", parent, start: [x, y], end: [x, y] };
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
      if (att && (att.type === "region" || att.type === "shape" || att.type === "point")) {
        drag = { kind: "attachment", slotId: slot.data.id, name: att.name, start: [x, y], base: [att.x, att.y], cur: [att.x, att.y], inv: invert(slot.bone.world), preview: null };
        return;
      }
    }
    const target = bone ?? slot!.bone;
    const op = t === "translate" ? "translate" : t === "scale" ? "scale" : "rotate";
    const base = { x: target.x, y: target.y, rotation: target.rotation, scaleX: target.scaleX, scaleY: target.scaleY };
    drag = { kind: "bone", op, bone: target, start: [x, y], base, cur: { ...base } };
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
    if (!drag) return;
    if (drag.kind === "pan") {
      view.x = drag.vx + (mx - drag.sx);
      view.y = drag.vy + (my - drag.sy);
    } else if (drag.kind === "create") {
      drag.end = [x, y];
    } else if (drag.kind === "vertex") {
      const dx = x - drag.start[0];
      const dy = y - drag.start[1];
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
      const [lx0, ly0] = applyM(drag.inv, ...drag.start);
      const [lx1, ly1] = applyM(drag.inv, x, y);
      drag.cur = [drag.base[0] + lx1 - lx0, drag.base[1] + ly1 - ly0];
      // Preview on a throwaway copy of the document; the real edit is one op on release.
      drag.preview ??= new Skeleton(structuredClone(store.doc));
      const ps = drag.preview;
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
        const dx = x - drag.start[0];
        const dy = y - drag.start[1];
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
    const [x, y] = toSkeleton(mx, my);
    if (running() && drag?.kind !== "pan") smInstance()?.pointer("up", x, y);
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "create") {
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
    const k = Math.exp(-e.deltaY * 0.0015);
    const z = Math.min(20, Math.max(0.05, view.zoom * k));
    view.x = mx - ((mx - view.x) * z) / view.zoom;
    view.y = my - ((my - view.y) * z) / view.zoom;
    view.zoom = z;
  }

  let spaceDown = false;
  const kd = (e: KeyboardEvent) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) spaceDown = true;
    if (e.key === "f" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) fit();
  };
  const ku = (e: KeyboardEvent) => {
    if (e.code === "Space") spaceDown = false;
  };

  onMount(() => {
    setImageReadyCallback(() => {});
    raf = requestAnimationFrame(frame);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
  });
  onCleanup(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", kd);
    window.removeEventListener("keyup", ku);
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
    <div class="viewport" ref={wrap}>
      <canvas
        ref={canvas}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: running() ? "pointer" : tool() === "bone" || tool() === "weights" ? "crosshair" : "default" }}
      />
      <Show when={meshToolOn()}>
        <MeshPanel />
      </Show>
      <div class="onion-ctl">
        <button classList={{ active: onionSkin() }} disabled={mode() !== "animate"} title="Onion skin: show ghost poses before (red) and after (green) the current frame (Animate mode)" onClick={() => setOnionSkin(!onionSkin())}>
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
      </div>
      <div class="viewport-hint">
        {running()
          ? "▶ Running state machine — interact with the artboard"
          : `${mode() === "animate" ? `ANIMATE${currentAnimation() ? ` · ${currentAnimation()!.name} @ ${time().toFixed(2)}s` : " · no animation"}` : "SETUP"} · wheel: zoom · alt/right-drag: pan · F: fit`}
      </div>
      <button class="fit-btn" onClick={fit} title="Fit artboard (F)">
        ⤢
      </button>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
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
