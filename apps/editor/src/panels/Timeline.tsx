import { type Curve, EASINGS, type Key, type Timeline as TL, animationDuration } from "@openbone/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { isMac, tip } from "../shortcuts/index.ts";
import { apply, currentAnimation, doc, mode, playing, setMode, setPlaying, setTime, time, setAnimationId, autoKey, setAutoKey, toast, transaction } from "../state.ts";
import { askForm, askText, confirmDelete } from "../dialogs.tsx";
import { AudioTrack, addSoundKey } from "./AudioPanel.tsx";
import { GraphView, timelineColor, timelineKey } from "./GraphView.tsx";
import { lipSyncDialog } from "../lipsync-ui.ts";
import { scrubAudio, scrubSound, setScrubSound } from "../audio.ts";

/** Dopesheet (keys per row) or Graph (value curves); remembered while the editor is open. */
const [timelineView, setTimelineView] = createSignal<"dopesheet" | "graph">("dopesheet");

type KeyRef = { tl: TL; time: number } | { event: string; time: number };

/** Identity of a key in the dopesheet selection: timeline + time, or event + time. */
const refId = (r: KeyRef) => ("tl" in r ? `${timelineKey(r.tl)}@${r.time.toFixed(6)}` : `ev:${r.event}@${r.time.toFixed(6)}`);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Copied keys, with times relative to the earliest one. Kept while the editor is open, so keys paste into other animations. */
type CopiedKey = { target: TL["target"]; id: string; property: string; attachment?: string; time: number; value: unknown; curve: Curve };
type CopiedEvent = { event: string; time: number; int?: number; float?: number; string?: string };
const [keyClipboard, setKeyClipboard] = createSignal<{ keys: CopiedKey[]; events: CopiedEvent[] } | null>(null);

const LABEL_W = 170;

function label(t: TL): string {
  const d = doc();
  if (t.target === "bone") return `${d.skeleton.bones.find((b) => b.id === t.id)?.name ?? t.id} · ${t.property}`;
  if (t.target === "slot") return `${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · ${t.property}`;
  if (t.target === "particles") return `✺ ${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · ${t.property}`;
  if (t.target === "deform") return `${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · deform ${t.attachment}`;
  if (t.target === "sequence") return `${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · frame ${t.attachment}`;
  if (t.target === "ik" || t.target === "transform" || t.target === "path" || t.target === "physics") {
    const prefix = { ik: "IK", transform: "TC", path: "Path", physics: "Phys" }[t.target];
    const list: { id: string; name: string }[] = d.skeleton[t.target];
    return `${prefix} ${list.find((c) => c.id === t.id)?.name ?? t.id} · ${t.property}`;
  }
  return "draw order";
}

const keyArgs = (tl: TL) => ({
  target: tl.target,
  id: tl.id,
  property: tl.property,
  ...(tl.target === "deform" || tl.target === "sequence" ? { attachment: tl.attachment } : {}),
});

/** The live timeline matching a (possibly stale, e.g. after undo) timeline reference. */
function liveTimeline(tl: TL): TL | undefined {
  return currentAnimation()?.timelines.find(
    (t) => t.target === tl.target && t.id === tl.id && t.property === tl.property && (!("attachment" in t) || !("attachment" in tl) || t.attachment === tl.attachment),
  );
}

function curveName(c: Curve): string {
  if (typeof c === "string") return c;
  const hit = Object.entries(EASINGS).find(([, v]) => v.every((x, i) => Math.abs(x - c[i]) < 1e-6));
  return hit ? hit[0] : "custom";
}

type Group = { key: string; name: string; icon: string; timelines: TL[] };

const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set());
function toggleGroup(key: string) {
  const s = new Set(collapsedGroups());
  if (s.has(key)) s.delete(key);
  else s.add(key);
  setCollapsedGroups(s);
}

/** Which header a timeline sits under: its bone, its slot, its constraint, or draw order. */
function groupInfo(tl: TL): { key: string; name: string; icon: string } {
  const d = doc();
  if (tl.target === "bone") return { key: `bone:${tl.id}`, name: d.skeleton.bones.find((b) => b.id === tl.id)?.name ?? tl.id, icon: "🦴" };
  if (tl.target === "slot" || tl.target === "particles" || tl.target === "deform" || tl.target === "sequence")
    return { key: `slot:${tl.id}`, name: d.skeleton.slots.find((s) => s.id === tl.id)?.name ?? tl.id, icon: "▣" };
  if (tl.target === "ik" || tl.target === "transform" || tl.target === "path" || tl.target === "physics") {
    const prefix = { ik: "IK", transform: "Transform", path: "Path", physics: "Physics" }[tl.target];
    const list: { id: string; name: string }[] = d.skeleton[tl.target];
    return { key: `${tl.target}:${tl.id}`, name: `${prefix} ${list.find((c) => c.id === tl.id)?.name ?? tl.id}`, icon: "⛓" };
  }
  return { key: "drawOrder", name: "Draw order", icon: "☰" };
}
function propName(tl: TL): string {
  if (tl.target === "deform") return `deform ${tl.attachment}`;
  if (tl.target === "sequence") return `frame ${tl.attachment}`;
  if (tl.target === "drawOrder") return "order";
  return tl.property;
}
const PROP_ICONS: Record<string, string> = { inherit: "⇊", rotation: "↻", x: "↔", y: "↕", scaleX: "⤢", scaleY: "⤢", shearX: "▱", shearY: "▱", color: "●", dark: "◐", attachment: "▣", emitting: "✺", rate: "✺" };
function propIcon(tl: TL): string {
  if (tl.target === "deform") return "◇";
  if (tl.target === "sequence") return "🎞";
  if (tl.target === "drawOrder") return "☰";
  if (tl.target === "ik" || tl.target === "transform" || tl.target === "path" || tl.target === "physics") return "⛓";
  return PROP_ICONS[tl.property] ?? "•";
}
/** Spans between neighbouring keys with the same value (the value holds there). */
function holds(tl: TL): [number, number][] {
  const ks = tl.keys as { time: number; value: unknown }[];
  const out: [number, number][] = [];
  for (let i = 0; i < ks.length - 1; i++) if (JSON.stringify(ks[i].value) === JSON.stringify(ks[i + 1].value)) out.push([ks[i].time, ks[i + 1].time]);
  return out;
}

export function Timeline() {
  const [pps, setPps] = createSignal(220); // pixels per second
  // Selected keys (Shift/Ctrl-click and Shift-drag a box to pick more); the last one picked is the "primary" key
  // whose curve the ease editor and the Curve menu show.
  const [sel, setSel] = createSignal<KeyRef[]>([]);
  const selKey = () => sel()[sel().length - 1] ?? null;
  const setSelKey = (r: KeyRef | null) => setSel(r ? [r] : []);
  const isSel = (r: KeyRef) => {
    const id = refId(r);
    return sel().some((x) => refId(x) === id);
  };
  const toggleSel = (r: KeyRef) => (isSel(r) ? setSel(sel().filter((x) => refId(x) !== refId(r))) : setSel([...sel(), r]));
  /** Seconds the selection is being dragged by (keys draw shifted until the drop). */
  const [dragDt, setDragDt] = createSignal(0);
  const [showGraph, setShowGraph] = createSignal(true);
  const anim = currentAnimation;
  // Scrub audio: while the playhead moves without playback (dragging it, stepping frames), sound the audio under it.
  let lastT = time();
  createEffect(() => {
    const t = time();
    const a = anim();
    const prev = lastT;
    lastT = t;
    if (!a || playing() || mode() !== "animate" || t === prev) return;
    scrubAudio(a, prev, t);
  });
  // Forget a selected key that no longer exists (undo, another animation, deleted timeline) instead of showing
  // "Key not found".
  createEffect(() => {
    const keys = sel();
    const a = anim();
    if (!keys.length) return;
    if (!a) return setSel([]);
    const live = keys.flatMap((k): KeyRef[] => {
      if ("tl" in k) {
        const tl = liveTimeline(k.tl);
        return tl && (tl.keys as { time: number }[]).some((x) => same(x.time, k.time)) ? [{ tl, time: k.time }] : [];
      }
      return a.events.some((x) => x.event === k.event && same(x.time, k.time)) ? [k] : [];
    });
    if (live.length !== keys.length || live.some((k, i) => "tl" in k && "tl" in keys[i] && k.tl !== keys[i].tl)) setSel(live);
  });
  const duration = () => {
    const a = anim();
    return a ? Math.max(animationDuration(a), 0.001) : 1;
  };
  // The timeline fills its panel (and a bit past the end), like Spine's: no empty band after the last second.
  const [areaWidth, setAreaWidth] = createSignal(0);
  const span = () => Math.max(duration() + 0.5, 2.5, (areaWidth() - LABEL_W - 4) / pps());
  const fps = () => doc().fps;
  const snap = (t: number) => Math.max(0, Math.round(t * fps()) / fps());

  let area!: HTMLDivElement;
  const timeAt = (clientX: number) => {
    const r = area.getBoundingClientRect();
    return snap((clientX - r.left - LABEL_W + area.scrollLeft) / pps());
  };

  const scrub = (e: PointerEvent) => {
    setPlaying(false);
    if (mode() !== "animate") setMode("animate");
    setTime(timeAt(e.clientX));
    const move = (m: PointerEvent) => setTime(timeAt(m.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The selection as transformKeys / deleteKeys arguments. */
  const picks = (refs: KeyRef[] = sel()) => {
    const byTl = new Map<string, { tl: TL; times: number[] }>();
    const events: { event: string; time: number }[] = [];
    for (const r of refs) {
      if (!("tl" in r)) {
        events.push({ event: r.event, time: r.time });
        continue;
      }
      const k = timelineKey(r.tl);
      const e = byTl.get(k) ?? { tl: r.tl, times: [] };
      e.times.push(r.time);
      byTl.set(k, e);
    }
    return { keys: [...byTl.values()].map((e) => ({ ...keyArgs(e.tl), times: e.times })), events };
  };
  const shiftedSel = (dt: number, scale = 1, pivot = 0) =>
    sel().map((r) => ({ ...r, time: Math.round(Math.max(0, pivot + (r.time - pivot) * scale + dt) * fps()) / fps() }));

  /** Shift every selected key by `dt` seconds (one undo step). */
  const moveSelection = (dt: number) => {
    const a = anim();
    if (!a || !sel().length || Math.abs(dt) < 1e-9) return;
    const next = shiftedSel(dt);
    apply("transformKeys", { animation: a.id, ...picks(), offset: dt, fps: fps() });
    setSel(next);
  };

  /**
   * Press on a key: plain click selects just it (or keeps a multi-selection it belongs to, to drag it), Shift or
   * Ctrl/⌘ toggles it. Dragging moves every selected key together, snapped to frames.
   */
  const dragKey = (e: PointerEvent, ref: KeyRef, group?: KeyRef[]) => {
    e.stopPropagation();
    const refs = group ?? [ref];
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (group) {
        const all = refs.every(isSel);
        setSel(all ? sel().filter((x) => !refs.some((r) => refId(r) === refId(x))) : [...sel().filter((x) => !refs.some((r) => refId(r) === refId(x))), ...refs]);
      } else toggleSel(ref);
      return;
    }
    if (!refs.every(isSel)) setSel(refs);
    else if (!group) setSel([...sel().filter((x) => refId(x) !== refId(ref)), ref]); // make it the primary key
    setPlaying(false);
    setTime(ref.time);
    const startX = e.clientX;
    const minT = Math.min(...sel().map((r) => r.time));
    let dt = 0;
    const move = (m: PointerEvent) => {
      dt = Math.max(-minT, Math.round(((m.clientX - startX) / pps()) * fps()) / fps());
      setDragDt(dt);
      setTime(ref.time + dt);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragDt(0);
      moveSelection(dt);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const deleteSelected = () => {
    const a = anim();
    if (!a || !sel().length) return;
    apply("deleteKeys", { animation: a.id, ...picks() });
    setSel([]);
  };

  // ---- copy / paste ----
  const copySelection = (cut = false) => {
    const a = anim();
    if (!a || !sel().length) return;
    const t0 = Math.min(...sel().map((r) => r.time));
    const keys: CopiedKey[] = [];
    const events: CopiedEvent[] = [];
    for (const r of sel()) {
      if ("tl" in r) {
        const k = (liveTimeline(r.tl)?.keys as Key<unknown>[] | undefined)?.find((x) => same(x.time, r.time));
        if (k) keys.push({ ...keyArgs(r.tl), time: r.time - t0, value: structuredClone(k.value), curve: k.curve } as CopiedKey);
      } else {
        const k = a.events.find((x) => x.event === r.event && same(x.time, r.time));
        if (k) events.push({ event: k.event, time: r.time - t0, int: k.int, float: k.float, string: k.string });
      }
    }
    setKeyClipboard({ keys, events });
    if (cut) deleteSelected();
    toast(`${cut ? "Cut" : "Copied"} ${keys.length + events.length} key${keys.length + events.length === 1 ? "" : "s"}. Move the playhead and press ${isMac ? "⌘V" : "Ctrl+V"} to paste.`);
  };
  const paste = () => {
    const a = anim();
    const c = keyClipboard();
    if (!a || !c) return;
    const at = snap(time());
    // Timelines whose bone/slot/constraint is gone (another project) are skipped instead of failing the paste.
    const exists = (k: CopiedKey) => {
      const sk = doc().skeleton;
      if (k.target === "bone") return sk.bones.some((b) => b.id === k.id);
      if (k.target === "drawOrder") return true;
      if (k.target === "ik" || k.target === "transform" || k.target === "path" || k.target === "physics") return (sk[k.target] as { id: string }[]).some((x) => x.id === k.id);
      return sk.slots.some((x) => x.id === k.id);
    };
    const keys = c.keys.filter(exists);
    const events = c.events.filter((e) => doc().events.some((x) => x.id === e.event));
    if (!keys.length && !events.length) return toast("Nothing to paste here: the copied keys belong to bones or slots this project doesn't have", "error");
    const r = apply("pasteKeys", { animation: a.id, at, keys, events });
    if (r === undefined) return;
    const live = currentAnimation();
    setSel([
      ...keys.flatMap((k): KeyRef[] => {
        const tl = live?.timelines.find((t) => timelineKey(t) === timelineKey(k as unknown as TL));
        return tl ? [{ tl, time: Math.round((at + k.time) * 1e6) / 1e6 }] : [];
      }),
      ...events.map((e) => ({ event: e.event, time: Math.round((at + e.time) * 1e6) / 1e6 })),
    ]);
  };
  const selectAll = () => {
    const a = anim();
    if (!a) return;
    setSel([...a.timelines.flatMap((tl) => (tl.keys as { time: number }[]).map((k) => ({ tl, time: k.time }))), ...a.events.map((e) => ({ event: e.event, time: e.time }))]);
  };
  const scaleSelection = async () => {
    const a = anim();
    if (!a || sel().length < 2) return;
    const t0 = Math.min(...sel().map((r) => r.time));
    const r = await askForm({
      title: `Scale ${sel().length} keys in time`,
      message: "Below 100% the keys move closer together (faster), above 100% further apart (slower). Keys snap to frames.",
      confirmLabel: "Scale",
      fields: [
        { key: "pct", type: "text", label: "Scale (%)", value: "50", validate: (v) => (Number(v) > 0 ? null : "Enter a number above 0") },
        { key: "pivot", type: "choice", label: "Around", options: [{ value: "first", label: `First selected key (${t0.toFixed(2)}s)` }, { value: "playhead", label: `Playhead (${time().toFixed(2)}s)` }, { value: "zero", label: "Start (0s)" }] },
      ],
    });
    if (!r) return;
    const scale = Number(r.pct) / 100;
    const pivot = r.pivot === "playhead" ? snap(time()) : r.pivot === "zero" ? 0 : t0;
    const next = shiftedSel(0, scale, pivot);
    apply("transformKeys", { animation: a.id, ...picks(), scale, pivot, fps: fps() });
    setSel(next);
  };

  // ---- box selection: Shift- or Ctrl-drag on empty dopesheet space ----
  const [box, setBox] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const trackDown = (e: PointerEvent) => {
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) {
      setSel([]);
      return scrub(e);
    }
    e.preventDefault();
    const r = area.getBoundingClientRect();
    const at = (ev: PointerEvent) => ({ x: ev.clientX - r.left + area.scrollLeft, y: ev.clientY - r.top + area.scrollTop });
    const p0 = at(e);
    const base = sel();
    setBox({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
    const move = (m: PointerEvent) => {
      const p = at(m);
      setBox({ x0: p0.x, y0: p0.y, x1: p.x, y1: p.y });
    };
    const up = (m: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBox(null);
      const p = at(m);
      const [left, right] = [Math.min(p0.x, p.x), Math.max(p0.x, p.x)].map((x) => x + r.left - area.scrollLeft);
      const [top, bottom] = [Math.min(p0.y, p.y), Math.max(p0.y, p.y)].map((y) => y + r.top - area.scrollTop);
      const a = anim();
      if (!a) return;
      const hit: KeyRef[] = [];
      for (const el of area.querySelectorAll<HTMLElement>("[data-kid]")) {
        const b = el.getBoundingClientRect();
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        if (cx < left || cx > right || cy < top || cy > bottom) continue;
        const t = Number(el.dataset.time);
        if (el.dataset.event) hit.push({ event: el.dataset.event, time: t });
        else {
          const tl = a.timelines.find((x) => timelineKey(x) === el.dataset.tl);
          if (tl) hit.push({ tl, time: t });
        }
      }
      // Ctrl/⌘ removes from the selection, Shift adds.
      const ids = new Set(hit.map(refId));
      setSel(e.ctrlKey || e.metaKey ? base.filter((x) => !ids.has(refId(x))) : [...base.filter((x) => !ids.has(refId(x))), ...hit]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const timelineKeys = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.key === "Delete" || e.key === "Backspace") && sel().length) return take(), deleteSelected();
    if (mod && k === "c" && sel().length) return take(), copySelection();
    if (mod && k === "x" && sel().length) return take(), copySelection(true);
    if (mod && k === "v" && keyClipboard()) return take(), paste();
    if (mod && k === "a" && anim()) return take(), selectAll();
    if (e.key === "Escape" && sel().length) return take(), setSel([]);
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && sel().length && !mod) {
      take();
      const step = (e.shiftKey ? 10 : 1) / fps();
      const minT = Math.min(...sel().map((r) => r.time));
      moveSelection(e.key === "ArrowLeft" ? -Math.min(step, minT) : step);
    }
  };

  const selectedCurve = () => {
    const k = selKey();
    if (!k || !("tl" in k)) return null;
    const key = (liveTimeline(k.tl)?.keys as { time: number; curve: Curve }[] | undefined)?.find((x) => Math.abs(x.time - k.time) < 1e-6);
    return key ? curveName(key.curve) : null;
  };

  // ---- grouped dopesheet: one collapsible header per bone / slot / constraint ----
  const groups = createMemo(() => {
    const a = anim();
    if (!a) return [] as Group[];
    const map = new Map<string, Group>();
    for (const tl of a.timelines) {
      const info = groupInfo(tl);
      let g = map.get(info.key);
      if (!g) map.set(info.key, (g = { ...info, timelines: [] }));
      g.timelines.push(tl);
    }
    return [...map.values()];
  });
  const rowCount = () => groups().reduce((n, g) => n + 1 + (collapsedGroups().has(g.key) ? 0 : g.timelines.length), 0);
  const summaryTimes = (g: Group) => {
    const times: number[] = [];
    for (const tl of g.timelines) for (const k of tl.keys as { time: number }[]) if (!times.some((t) => Math.abs(t - k.time) < 1e-6)) times.push(k.time);
    return times.sort((x, y) => x - y);
  };
  /** Every key of a group at time t (what its summary key stands for). */
  const groupRefs = (g: Group, t: number): KeyRef[] =>
    g.timelines.filter((tl) => (tl.keys as { time: number }[]).some((k) => same(k.time, t))).map((tl) => ({ tl, time: t }));
  const summarySelected = (g: Group, t: number) => {
    const refs = groupRefs(g, t);
    return refs.length > 0 && refs.every(isSel);
  };

  const ticks = () => {
    const out: number[] = [];
    const step = pps() > 300 ? 0.1 : pps() > 120 ? 0.25 : 0.5;
    for (let t = 0; t <= span() + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  };

  return (
    // Selected keys win over the global shortcuts (Delete deletes the selected bone, arrows nudge vertices…).
    <div class="timeline" onKeyDown={timelineKeys} tabIndex={0}>
      <div class="timeline-bar">
        <select value={anim()?.id ?? ""} onChange={(e) => setAnimationId(e.currentTarget.value || null)}>
          <option value="" selected={!(anim()?.id ?? "")}>— animation —</option>
          <For each={doc().animations}>{(a) => <option value={a.id} selected={a.id === (anim()?.id ?? "")}>{a.name}</option>}</For>
        </select>
        <button onClick={() => setTime(0)} title={tip("To start", "anim.first")}>⏮</button>
        <button
          class="play"
          onClick={() => {
            if (mode() !== "animate") setMode("animate");
            setPlaying(!playing());
          }}
          title={tip("Play/pause", "anim.playPause")}
        >
          {playing() ? "⏸" : "▶"}
        </button>
        <span class="time">
          {time().toFixed(2)}s / {duration().toFixed(2)}s · frame {Math.round(time() * fps())}
        </span>
        <Show when={anim()}>
          <label class="check">
            Length
            <input
              type="number"
              step="0.1"
              min="0"
              value={anim()!.duration}
              title="0 = until last key"
              onChange={(e) => apply("updateAnimation", { animation: anim()!.id, duration: Number(e.currentTarget.value) })}
            />
          </label>
          <input
            type="color"
            class="anim-color"
            title="Animation colour (shown in the lists)"
            value={anim()!.color?.slice(0, 7) ?? "#8a93a6"}
            onChange={(e) => apply("updateAnimation", { animation: anim()!.id, color: e.currentTarget.value })}
          />
          <label class="check" title="Export this animation (untick for helper or work-in-progress animations; they can still be picked in the export dialog)">
            <input type="checkbox" checked={anim()!.export !== false} onChange={(e) => apply("updateAnimation", { animation: anim()!.id, export: e.currentTarget.checked })} /> Export
          </label>
        </Show>
        <button
            class="rec"
            classList={{ on: autoKey() }}
            aria-pressed={autoKey()}
            title={autoKey() ? "Recording: dragging bones in Animate mode sets keys (keys past the end extend the animation). Click to stop." : "Not recording: click so dragging bones in Animate mode sets keys"}
            onClick={() => setAutoKey(!autoKey())}
          >
            ● Rec
          </button>
          <button
            class="scrub-btn"
            classList={{ on: scrubSound() }}
            aria-pressed={scrubSound()}
            title={scrubSound() ? "Scrub sound on: dragging the playhead plays the audio under it. Click to scrub silently." : "Scrub sound off: dragging the playhead is silent. Click to hear the audio while scrubbing."}
            onClick={() => setScrubSound(!scrubSound())}
          >
            {scrubSound() ? "🔊" : "🔇"} Scrub
          </button>
        
        <Show when={sel().length || keyClipboard()}>
          <span class="sep" />
          <Show when={sel().length > 1}>
            <span class="muted small" title="Shift/Ctrl-click keys or Shift-drag a box to change the selection; ← → nudge by a frame">
              {sel().length} keys
            </span>
          </Show>
          <Show when={sel().length}>
            <button title={`Copy the selected keys (${isMac ? "⌘C" : "Ctrl+C"}); paste them at the playhead, in this or another animation`} onClick={() => copySelection()}>
              Copy
            </button>
          </Show>
          <Show when={keyClipboard()}>
            <button title={`Paste ${keyClipboard()!.keys.length + keyClipboard()!.events.length} copied keys at the playhead (${isMac ? "⌘V" : "Ctrl+V"})`} onClick={paste} disabled={!anim()}>
              Paste
            </button>
          </Show>
          <Show when={sel().length > 1}>
            <button title="Spread the selected keys out or squeeze them together in time" onClick={() => void scaleSelection()}>
              Scale…
            </button>
          </Show>
        </Show>
        <Show when={selKey()}>
          <Show when={selectedCurve()}>
            <label class="check">
              Curve
              <select
                value={selectedCurve()!}
                onChange={(e) => {
                  const a = anim();
                  const curve = e.currentTarget.value;
                  // Every selected key gets the curve (one undo step).
                  if (a)
                    transaction("Set curve", () => {
                      for (const k of sel()) if ("tl" in k) apply("moveKey", { animation: a.id, ...keyArgs(k.tl), time: k.time, curve });
                    });
                }}
              >
                <For each={["linear", "stepped", ...Object.keys(EASINGS)]}>{(c) => <option value={c} selected={c === (selectedCurve()!)}>{c}</option>}</For>
                <option value="custom" disabled selected={selectedCurve() === "custom"}>
                  custom
                </option>
              </select>
            </label>
          </Show>
          <button class="danger" onClick={deleteSelected}>
            {sel().length > 1 ? `Delete ${sel().length} keys` : "Delete key"}
          </button>
        </Show>
        <span class="spacer" />
        <div class="seg" role="tablist" title="Dopesheet: keys per property. Graph: the values over time as curves, with draggable keys and bezier handles">
          <button classList={{ on: timelineView() === "dopesheet" }} onClick={() => setTimelineView("dopesheet")}>
            Dopesheet
          </button>
          <button classList={{ on: timelineView() === "graph" }} onClick={() => setTimelineView("graph")}>
            Graph
          </button>
        </div>
        <Show when={timelineView() === "dopesheet"}>
          <label class="check" title="Show the ease editor for the selected key beside the dopesheet">
            <input type="checkbox" checked={showGraph()} onChange={(e) => setShowGraph(e.currentTarget.checked)} /> Key curve
          </label>
        </Show>
        <button
          title="Add an event key at the current time"
          disabled={!anim()}
          onClick={async () => {
            const at = snap(time());
            const name = await askText({
              title: "Add event key",
              message: `At ${at}s. Use an existing event name or type a new one.`,
              label: "Event",
              value: doc().events[0]?.name ?? "event",
              confirmLabel: "Add",
            });
            if (name && anim()) apply("addEventKey", { animation: anim()!.id, event: name, time: at });
          }}
        >
          + Event
        </button>
        <button title="Add a sound key at the current time" disabled={!anim()} onClick={() => anim() && void addSoundKey(anim()!, snap(time()))}>
          + Sound
        </button>
        <button title="Lip sync: key a mouth slot's images to the speech in a sound, from the current time" onClick={() => void lipSyncDialog(anim()?.id ?? null)}>
          Lip sync…
        </button>
        <label class="check" title="Zoom">
          🔍
          <input type="range" min="60" max="800" value={pps()} onInput={(e) => setPps(Number(e.currentTarget.value))} />
        </label>
      </div>
      <Show
        when={anim()}
        fallback={
          <div class="empty">
            No animation selected. Create one in the left panel (Animations +), switch to <b>Animate</b>, and drag bones to set keys.
          </div>
        }
      >
        <div class="timeline-body">
        <Show when={timelineView() === "graph"}>
          <GraphView
            anim={anim()!}
            label={label}
            keyArgs={keyArgs}
            snap={snap}
            duration={duration()}
            selKey={(() => {
              const k = selKey();
              return k && "tl" in k ? k : null;
            })()}
            onSelect={(k) => setSelKey(k)}
          />
        </Show>
        <Show when={timelineView() === "dopesheet"}>
        <div
          class="timeline-area"
          ref={(el) => {
            area = el;
            const ro = new ResizeObserver(() => setAreaWidth(el.clientWidth));
            ro.observe(el);
            setAreaWidth(el.clientWidth);
            onCleanup(() => ro.disconnect());
          }}
        >
          <div class="ruler-row" style={{ width: `${LABEL_W + span() * pps()}px` }}>
            <div class="row-label" />
            <div class="ruler" onPointerDown={scrub}>
              <For each={ticks()}>
                {(t) => (
                  <div class="tick" style={{ left: `${t * pps()}px` }}>
                    {Math.abs(t - Math.round(t)) < 1e-6 || pps() > 200 ? `${t}` : ""}
                  </div>
                )}
              </For>
              <div class="end-marker" style={{ left: `${duration() * pps()}px` }} />
            </div>
          </div>
          <Show when={anim()!.events.length}>
            <div class="track-row" style={{ width: `${LABEL_W + span() * pps()}px` }}>
              <div class="row-label">⚡ events</div>
              <div class="track" onPointerDown={trackDown}>
                <For each={anim()!.events}>
                  {(k) => {
                    const ev = () => doc().events.find((e) => e.id === k.event);
                    const on = () => isSel({ event: k.event, time: k.time });
                    return (
                      <div
                        class="event-key"
                        classList={{ selected: on() }}
                        data-kid=""
                        data-event={k.event}
                        data-time={k.time}
                        style={{ left: `${(k.time + (on() ? dragDt() : 0)) * pps()}px` }}
                        title={ev()?.name}
                        onPointerDown={(e) => dragKey(e, { event: k.event, time: k.time })}
                      >
                        {ev()?.name}
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
          <Show when={anim()!.audio?.length}>
            <AudioTrack anim={anim()!} pps={pps()} width={LABEL_W + span() * pps()} labelWidth={LABEL_W} snap={snap} onScrub={scrub} />
          </Show>
          <For each={groups()}>
            {(g) => {
              const open = () => !collapsedGroups().has(g.key);
              const width = () => `${LABEL_W + span() * pps()}px`;
              return (
                <>
                  <div class="track-row group-row" style={{ width: width() }}>
                    <div class="row-label group-label" title={g.name}>
                      <span
                        class="twisty"
                        title={open() ? "Collapse" : "Expand"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(g.key);
                        }}
                      >
                        {open() ? "▾" : "▸"}
                      </span>
                      <span class="group-icon">{g.icon}</span>
                      <span class="group-name">{g.name}</span>
                      <span class="muted group-count">{g.timelines.length}</span>
                    </div>
                    <div class="track" onPointerDown={trackDown}>
                      <For each={summaryTimes(g)}>
                        {(t) => (
                          <div
                            class="key summary"
                            classList={{ selected: summarySelected(g, t) }}
                            style={{ left: `${(t + (summarySelected(g, t) ? dragDt() : 0)) * pps()}px` }}
                            title={`${t}s: every key of ${g.name} at this time. Click selects them, drag moves them together.`}
                            onPointerDown={(e) => dragKey(e, groupRefs(g, t)[0] ?? { event: "", time: t }, groupRefs(g, t))}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                  <Show when={open()}>
                    <For each={g.timelines}>
                      {(tl) => (
                        <div class="track-row" style={{ width: width() }}>
                          <div class="row-label prop-label" title={label(tl)}>
                            <span class="prop-icon" style={{ color: timelineColor(tl) }}>
                              {propIcon(tl)}
                            </span>
                            {propName(tl)}
                            <button class="row-del" title="Delete timeline" onClick={() => void confirmDelete(`all ${tl.keys.length} keys of ${propName(tl)}`, `The whole “${label(tl)}” timeline is removed from this animation.`, () => apply("deleteTimeline", { animation: anim()!.id, ...keyArgs(tl) }))}>
                              ×
                            </button>
                          </div>
                          <div class="track" onPointerDown={trackDown} style={{ "--key-color": timelineColor(tl) }}>
                            <For each={holds(tl)}>{(h) => <div class="hold" style={{ left: `${h[0] * pps()}px`, width: `${(h[1] - h[0]) * pps()}px` }} title="Same value: holds" />}</For>
                            <For each={tl.keys as { time: number; curve: Curve; value: unknown }[]}>
                              {(k) => {
                                const on = () => isSel({ tl, time: k.time });
                                return (
                                  <div
                                    class="key"
                                    classList={{ selected: on(), stepped: k.curve === "stepped", eased: Array.isArray(k.curve) }}
                                    data-kid=""
                                    data-tl={timelineKey(tl)}
                                    data-time={k.time}
                                    style={{ left: `${(k.time + (on() ? dragDt() : 0)) * pps()}px` }}
                                    title={`${k.time}s = ${JSON.stringify(k.value)} (${curveName(k.curve)})`}
                                    onPointerDown={(e) => dragKey(e, { tl, time: k.time })}
                                  />
                                );
                              }}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </>
              );
            }}
          </For>
          <Show when={box()}>
            {(b) => (
              <div
                class="key-box"
                style={{ left: `${Math.min(b().x0, b().x1)}px`, top: `${Math.min(b().y0, b().y1)}px`, width: `${Math.abs(b().x1 - b().x0)}px`, height: `${Math.abs(b().y1 - b().y0)}px` }}
              />
            )}
          </Show>
          <div class="playhead" style={{ left: `${LABEL_W + time() * pps()}px`, height: `${(rowCount() + (anim()!.events.length ? 2 : 1)) * 24 + (anim()!.audio?.length ? 44 : 0)}px` }} />
        </div>
        <Show when={showGraph()}>
          <Show
            when={(() => {
              const k = selKey();
              return k && "tl" in k ? k : null;
            })()}
            keyed
            fallback={
              <div class="curve-editor">
                <div class="curve-head">
                  <span>Key curve</span>
                </div>
                <div class="muted pad">
                  Click a key to shape how it eases into the next key. Shift/Ctrl-click or Shift-drag a box to select several, then drag, copy ({isMac ? "⌘C" : "Ctrl+C"}), paste at the playhead ({isMac ? "⌘V" : "Ctrl+V"}), scale or delete them.
                </div>
              </div>
            }
          >
            {(k) => <CurveEditor tl={k.tl} time={k.time} />}
          </Show>
        </Show>
        </Show>
        </div>
      </Show>
    </div>
  );
}

// ---------------- curve graph editor ----------------

const GW = 260;
const GH = 180;
const PAD = 14;
/** Visible value range of the normalised graph (handles may overshoot for back/elastic eases). */
const Y_MIN = -0.5;
const Y_MAX = 1.5;
const gx = (x: number) => PAD + x * (GW - 2 * PAD);
const gy = (y: number) => PAD + ((Y_MAX - y) / (Y_MAX - Y_MIN)) * (GH - 2 * PAD);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Bezier handle editor for the segment that starts at the selected key. Saves through `moveKey`. */
function CurveEditor(props: { tl: TL; time: number }) {
  const [draft, setDraft] = createSignal<[number, number, number, number] | null>(null);
  let svg!: SVGSVGElement;
  const keys = () => (liveTimeline(props.tl)?.keys ?? []) as Key<unknown>[];
  const index = () => keys().findIndex((k) => Math.abs(k.time - props.time) < 1e-6);
  const key = () => keys()[index()];
  const next = () => keys()[index() + 1];
  const discrete = () =>
    props.tl.target === "drawOrder" || (props.tl.target === "slot" && props.tl.property === "attachment") || (props.tl.target === "particles" && props.tl.property === "emitting");
  const handles = (): [number, number, number, number] => {
    const d = draft();
    if (d) return d;
    const c = key()?.curve;
    return Array.isArray(c) ? c : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  };
  const stepped = () => !draft() && key()?.curve === "stepped";
  const fmt = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100) / 100}` : typeof v === "string" ? v : Array.isArray(v) ? `[${v.length}]` : String(v));

  const startDrag = (e: PointerEvent, which: 0 | 1) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    const start = handles();
    setDraft([...start]);
    const move = (m: PointerEvent) => {
      // Client → SVG user space (the graph scales with the panel).
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const p = new DOMPoint(m.clientX, m.clientY).matrixTransform(ctm.inverse());
      const x = Math.min(1, Math.max(0, (p.x - PAD) / (GW - 2 * PAD)));
      let y = Y_MAX - ((p.y - PAD) / (GH - 2 * PAD)) * (Y_MAX - Y_MIN);
      if (m.shiftKey) y = Math.abs(y) < 0.06 ? 0 : Math.abs(y - 1) < 0.06 ? 1 : y;
      const c = [...draft()!] as [number, number, number, number];
      c[which * 2] = r3(x);
      c[which * 2 + 1] = r3(y);
      setDraft(c);
    };
    const up = () => {
      el.removeEventListener("pointermove", move as EventListener);
      el.removeEventListener("pointerup", up);
      const c = draft();
      setDraft(null);
      const a = currentAnimation();
      if (!a || !c || c.every((v, i) => v === start[i])) return;
      apply("moveKey", { animation: a.id, ...keyArgs(props.tl), time: props.time, curve: c });
    };
    el.addEventListener("pointermove", move as EventListener);
    el.addEventListener("pointerup", up);
  };

  const preset = (c: Curve | string) => {
    const a = currentAnimation();
    if (a) apply("moveKey", { animation: a.id, ...keyArgs(props.tl), time: props.time, curve: c });
  };

  return (
    <div class="curve-editor" onKeyDown={(e) => e.stopPropagation()}>
      <Show when={key()} fallback={<div class="muted pad">Key not found.</div>}>
        <div class="curve-head">
          <span>
            {label(props.tl)} <span class="muted">@ {props.time}s</span>
          </span>
          <span class="muted">{curveName(key()!.curve)}</span>
        </div>
        <Show
          when={next() && !discrete()}
          fallback={
            <div class="muted pad">
              {discrete() ? "This property switches values and has no curve." : "Last key: its curve shapes the motion to the next key. Add a later key to edit it."}
            </div>
          }
        >
          <svg ref={svg} viewBox={`0 0 ${GW} ${GH}`} class="curve-graph">
            <rect x={gx(0)} y={gy(1)} width={gx(1) - gx(0)} height={gy(0) - gy(1)} class="curve-box" />
            <For each={[0.25, 0.5, 0.75]}>
              {(f) => (
                <>
                  <line x1={gx(f)} x2={gx(f)} y1={gy(Y_MAX)} y2={gy(Y_MIN)} class="curve-grid" />
                  <line x1={gx(0)} x2={gx(1)} y1={gy(f)} y2={gy(f)} class="curve-grid" />
                </>
              )}
            </For>
            <text x={gx(0) + 3} y={gy(0) - 4} class="curve-label">{fmt(key()!.value)}</text>
            <text x={gx(1) - 3} y={gy(1) + 12} class="curve-label end">{fmt(next()!.value)}</text>
            <Show
              when={!stepped()}
              fallback={<path d={`M${gx(0)},${gy(0)} H${gx(1)} V${gy(1)}`} class="curve-path" />}
            >
              <path
                d={`M${gx(0)},${gy(0)} C${gx(handles()[0])},${gy(handles()[1])} ${gx(handles()[2])},${gy(handles()[3])} ${gx(1)},${gy(1)}`}
                class="curve-path"
              />
            </Show>
            <line x1={gx(0)} y1={gy(0)} x2={gx(handles()[0])} y2={gy(handles()[1])} class="curve-arm" />
            <line x1={gx(1)} y1={gy(1)} x2={gx(handles()[2])} y2={gy(handles()[3])} class="curve-arm" />
            <circle cx={gx(0)} cy={gy(0)} r={3} class="curve-end" />
            <circle cx={gx(1)} cy={gy(1)} r={3} class="curve-end" />
            <circle cx={gx(handles()[0])} cy={gy(handles()[1])} r={6} class="curve-handle" data-handle="1" onPointerDown={(e) => startDrag(e, 0)}>
              <title>Out handle of this key (shift snaps to 0/1)</title>
            </circle>
            <circle cx={gx(handles()[2])} cy={gy(handles()[3])} r={6} class="curve-handle" data-handle="2" onPointerDown={(e) => startDrag(e, 1)}>
              <title>In handle of the next key (shift snaps to 0/1)</title>
            </circle>
          </svg>
          <div class="curve-foot">
            <span class="muted mono">[{handles().map((v) => v.toFixed(2)).join(", ")}]</span>
            <span class="spacer" />
            <button onClick={() => preset("linear")}>Linear</button>
            <button onClick={() => preset("stepped")}>Step</button>
            <button onClick={() => preset("easeInOut")}>Ease</button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
