import { type BoneData, RAD, animationDuration, apply as applyM, invert } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { type Bone, type ScriptHost, Skeleton, StateMachineInstance, applyAnimation, trustedFunctionHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { imageFor, setImageReadyCallback } from "../images.ts";
import { commitBone, commitAttachmentMove } from "../edit.ts";
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
  | { kind: "attachment"; slotId: string; name: string; start: [number, number]; base: [number, number]; cur: [number, number]; inv: ReturnType<typeof invert> }
  | { kind: "create"; parent: Bone | null; start: [number, number]; end: [number, number] };

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
    const r = new CanvasRenderer(ctx, (id) => {
      const a = d.images.find((i) => i.id === id);
      return a ? imageFor(a) : null;
    });
    const v = { x: view.x * dpr, y: view.y * dpr, zoom: view.zoom * dpr };
    r.render(s, {
      view: v,
      clear: false,
      bones: showBones() && !running(),
      boundingBoxes: showBones(),
      wireframe: showMesh(),
      selectedBone: selectedBoneId(),
    });
    // selection outline
    const sel = selection();
    if (sel?.kind === "slot" && !running()) {
      const slot = s.slotById_(sel.id);
      const poly = slot && s.hitPolygon(slot);
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
        drag = { kind: "attachment", slotId: slot.data.id, name: att.name, start: [x, y], base: [att.x, att.y], cur: [att.x, att.y], inv: invert(slot.bone.world) };
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
    } else if (drag.kind === "attachment") {
      const [lx0, ly0] = applyM(drag.inv, ...drag.start);
      const [lx1, ly1] = applyM(drag.inv, x, y);
      drag.cur = [drag.base[0] + lx1 - lx0, drag.base[1] + ly1 - ly0];
      const att = sk && sk.getAttachment(sk.slotById_(drag.slotId)!, drag.name);
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
        style={{ cursor: running() ? "pointer" : tool() === "bone" ? "crosshair" : "default" }}
      />
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
