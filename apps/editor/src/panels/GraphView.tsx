import { type AnimationData, type Curve, type Key, type Timeline as TL } from "@openbone/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { apply, doc, setPlaying, setTime, time, transaction } from "../state.ts";

/**
 * Graph view of the Timeline: the real values of every numeric timeline over time, as curves. Keys can be dragged
 * in time and value, the selected key's bezier handles shape the curve in place, and the view pans and zooms.
 * A key's curve (normalised bezier from that key to the next) maps exactly onto an SVG cubic here, because the
 * runtime interpolates numbers linearly between key values.
 */

export type GraphKeyRef = { tl: TL; time: number };
type NumKey = Key<number>;
type View = { tx: number; sx: number; ty: number; sy: number };

const LIST_W = 170;
const RULER_H = 20;
const EPS = 1e-6;
const DEFAULT_CURVE: [number, number, number, number] = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/** Timelines whose keys are plain numbers (others switch values or hold arrays/colours). */
export function isNumericTimeline(tl: TL): boolean {
  if (tl.target === "bone" || tl.target === "sequence") return true;
  if (tl.target === "ik" || tl.target === "transform" || tl.target === "path" || tl.target === "physics") return true;
  return tl.target === "particles" && tl.property === "rate";
}

export const timelineKey = (tl: TL) => `${tl.target}:${tl.id}:${tl.property}:${"attachment" in tl ? tl.attachment : ""}`;

const PROPERTY_COLORS: Record<string, string> = {
  rotation: "#5fd38d",
  x: "#ff6b6b",
  y: "#5aa9ff",
  scaleX: "#ffa94d",
  scaleY: "#c084fc",
  shearX: "#f472b6",
  shearY: "#2dd4bf",
};
const PALETTE = ["#facc15", "#38bdf8", "#a3e635", "#fb7185", "#818cf8", "#34d399", "#fdba74", "#e879f9"];
export function timelineColor(tl: TL): string {
  if (tl.target === "bone" && PROPERTY_COLORS[tl.property]) return PROPERTY_COLORS[tl.property];
  let h = 0;
  for (const ch of timelineKey(tl)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Kept across remounts: hidden curves, normalise toggle and the view per animation.
const [hidden, setHidden] = createSignal<Set<string>>(new Set());
const [normalize, setNormalize] = createSignal(false);
const views = new Map<string, View>();

/** A "nice" grid step (1, 2, 5 × 10^n) so labels land `minPx` or more apart. */
function niceStep(pxPerUnit: number, minPx: number): number {
  const raw = minPx / Math.max(pxPerUnit, 1e-9);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : `${Math.round(v * 100) / 100}`);

export function GraphView(props: {
  anim: AnimationData;
  label: (tl: TL) => string;
  keyArgs: (tl: TL) => Record<string, unknown>;
  snap: (t: number) => number;
  duration: number;
  selKey: GraphKeyRef | null;
  onSelect: (k: GraphKeyRef | null) => void;
}) {
  let svg!: SVGSVGElement;
  const [size, setSize] = createSignal({ w: 600, h: 200 });
  const [view, setViewRaw] = createSignal<View>(views.get(props.anim.id) ?? { tx: 20, sx: 200, ty: 120, sy: 1 });
  const setView = (v: View) => {
    setViewRaw(v);
    views.set(props.anim.id, v);
  };
  /** Live key / handle drags, drawn before they are saved. */
  const [keyDraft, setKeyDraft] = createSignal<{ id: string; from: number; time: number; value: number } | null>(null);
  const [curveDraft, setCurveDraft] = createSignal<{ id: string; time: number; c: [number, number, number, number] } | null>(null);
  const [frozenRanges, setFrozenRanges] = createSignal<Map<string, [number, number]> | null>(null);
  const [panning, setPanning] = createSignal(false);

  const numeric = createMemo(() => props.anim.timelines.filter(isNumericTimeline));
  const visible = () => numeric().filter((tl) => !hidden().has(timelineKey(tl)));

  /** Keys of a timeline with any live drag applied, sorted by time. */
  const keysOf = (tl: TL): NumKey[] => {
    const id = timelineKey(tl);
    let ks = (tl.keys as NumKey[]).map((k) => ({ ...k }));
    const kd = keyDraft();
    if (kd && kd.id === id) {
      ks = ks.filter((k) => Math.abs(k.time - kd.from) > EPS || false);
      const orig = (tl.keys as NumKey[]).find((k) => Math.abs(k.time - kd.from) < EPS);
      ks = ks.filter((k) => Math.abs(k.time - kd.time) > EPS);
      ks.push({ time: kd.time, value: kd.value, curve: orig?.curve ?? "linear" });
      ks.sort((a, b) => a.time - b.time);
    }
    const cd = curveDraft();
    if (cd && cd.id === id) {
      const k = ks.find((x) => Math.abs(x.time - cd.time) < EPS);
      if (k) k.curve = cd.c;
    }
    return ks;
  };

  // ---- value space: absolute, or each curve normalised to 0..1 by its own range ----
  const rangeOf = (tl: TL): [number, number] => {
    const frozen = frozenRanges()?.get(timelineKey(tl));
    if (frozen) return frozen;
    const vs = (tl.keys as NumKey[]).map((k) => k.value);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return hi - lo < EPS ? [lo - 1, hi + 1] : [lo, hi];
  };
  const toDisplay = (tl: TL, v: number) => {
    if (!normalize()) return v;
    const [lo, hi] = rangeOf(tl);
    return (v - lo) / (hi - lo);
  };
  const fromDisplay = (tl: TL, d: number) => {
    if (!normalize()) return d;
    const [lo, hi] = rangeOf(tl);
    return lo + d * (hi - lo);
  };

  const X = (t: number) => view().tx + t * view().sx;
  const Y = (d: number) => view().ty - d * view().sy;
  const tAt = (sx: number) => (sx - view().tx) / view().sx;
  const dAt = (sy: number) => (view().ty - sy) / view().sy;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Read the real size (ResizeObserver callbacks can lag, e.g. in background tabs). */
  const measure = () => {
    if (!svg) return size();
    const r = svg.getBoundingClientRect();
    const s = { w: r.width, h: r.height };
    if (s.w !== size().w || s.h !== size().h) setSize(s);
    return s;
  };

  // ---- fit / zoom / pan ----
  const fit = () => {
    const { w, h } = measure();
    if (w < 20 || h < 40) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const tl of visible()) {
      const ks = tl.keys as NumKey[];
      for (let i = 0; i < ks.length; i++) {
        const a = toDisplay(tl, ks[i].value);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
        const b = ks[i + 1];
        const c = ks[i].curve;
        if (b && Array.isArray(c)) {
          // bezier overshoot (back / elastic eases)
          const db = toDisplay(tl, b.value) - a;
          for (const cy of [c[1], c[3]]) {
            lo = Math.min(lo, a + cy * db);
            hi = Math.max(hi, a + cy * db);
          }
        }
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < EPS) {
      lo -= 1;
      hi += 1;
    }
    const padT = 16;
    const padV = 18;
    const t1 = Math.max(props.duration, 0.1);
    const sx = (w - padT * 2) / t1;
    const sy = (h - RULER_H - padV * 2) / (hi - lo);
    setView({ tx: padT, sx, ty: RULER_H + padV + hi * sy, sy });
  };
  const zoom = (fx: number, fy: number, px: number, py: number) => {
    const v = view();
    const sx = Math.min(5000, Math.max(5, v.sx * fx));
    const sy = Math.min(1e6, Math.max(1e-4, v.sy * fy));
    setView({ sx, sy, tx: px - ((px - v.tx) * sx) / v.sx, ty: py - ((py - v.ty) * sy) / v.sy });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    measure();
    const p = local(e);
    const trackpadPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0;
    if (trackpadPan) {
      const v = view();
      setView({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY });
      return;
    }
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoom(e.altKey ? 1 : f, e.shiftKey ? 1 : f, p.x, p.y);
  };
  const bgDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    measure();
    const p0 = local(e);
    if (p0.y < RULER_H) return scrub(e);
    const v0 = view();
    let moved = false;
    const move = (m: PointerEvent) => {
      const p = local(m);
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 3) return;
      moved = true;
      setPanning(true);
      setView({ ...v0, tx: v0.tx + p.x - p0.x, ty: v0.ty + p.y - p0.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanning(false);
      if (!moved) props.onSelect(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const scrub = (e: PointerEvent) => {
    setPlaying(false);
    const set = (ev: PointerEvent) => setTime(props.snap(Math.max(0, tAt(local(ev).x))));
    set(e);
    const up = () => {
      window.removeEventListener("pointermove", set);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", set);
    window.addEventListener("pointerup", up);
  };

  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    ro.observe(svg);
    onCleanup(() => ro.disconnect());
    setTimeout(() => {
      measure();
      if (!views.has(props.anim.id)) fit();
    });
  });
  createEffect(
    on(
      () => props.anim.id,
      (id) => {
        const v = views.get(id);
        if (v) setViewRaw(v);
        else setTimeout(fit);
      },
      { defer: true },
    ),
  );
  createEffect(on(normalize, () => setTimeout(fit), { defer: true }));

  // ---- drawing ----
  const pathOf = (tl: TL) => {
    const ks = keysOf(tl);
    if (!ks.length) return { line: "", holds: "" };
    const d = (k: NumKey) => toDisplay(tl, k.value);
    let line = `M${X(ks[0].time)},${Y(d(ks[0]))}`;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      const ya = d(a);
      const yb = d(b);
      if (a.curve === "stepped") line += ` H${X(b.time)} V${Y(yb)}`;
      else if (a.curve === "linear") line += ` L${X(b.time)},${Y(yb)}`;
      else {
        const [c0, c1, c2, c3] = a.curve;
        const dt = b.time - a.time;
        line += ` C${X(a.time + c0 * dt)},${Y(ya + c1 * (yb - ya))} ${X(a.time + c2 * dt)},${Y(ya + c3 * (yb - ya))} ${X(b.time)},${Y(yb)}`;
      }
    }
    // Before the first key and after the last the value holds.
    const first = ks[0];
    const last = ks[ks.length - 1];
    const holds = `M0,${Y(d(first))} H${X(first.time)} M${X(last.time)},${Y(d(last))} H${size().w}`;
    return { line, holds };
  };

  const isSel = (tl: TL, t: number) => {
    const s = props.selKey;
    return !!s && timelineKey(s.tl) === timelineKey(tl) && Math.abs(s.time - t) < EPS;
  };

  const timeTicks = () => {
    const step = niceStep(view().sx, 60);
    const t0 = Math.max(0, Math.floor(tAt(0) / step) * step);
    const out: number[] = [];
    for (let t = t0; X(t) <= size().w && out.length < 200; t += step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
  };
  const valueTicks = () => {
    const step = niceStep(view().sy, 28);
    const out: number[] = [];
    const top = dAt(RULER_H);
    const bottom = dAt(size().h);
    for (let v = Math.ceil(bottom / step) * step; v <= top && out.length < 200; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  };

  // ---- editing ----
  const keyDown = (e: PointerEvent, tl: TL, k: NumKey) => {
    e.stopPropagation();
    e.preventDefault();
    props.onSelect({ tl, time: k.time });
    setTime(k.time);
    setPlaying(false);
    const id = timelineKey(tl);
    const p0 = local(e);
    const d0 = toDisplay(tl, k.value);
    setFrozenRanges(new Map(numeric().map((t) => [timelineKey(t), rangeOf(t)])));
    let moved = false;
    const move = (m: PointerEvent) => {
      const p = local(m);
      let dx = p.x - p0.x;
      let dy = p.y - p0.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (m.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const t = props.snap(Math.max(0, k.time + dx / view().sx));
      const v = Math.round(fromDisplay(tl, d0 - dy / view().sy) * 1000) / 1000;
      setKeyDraft({ id, from: k.time, time: t, value: v });
      setTime(t);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const kd = keyDraft();
      setKeyDraft(null);
      setFrozenRanges(null);
      if (!kd) return;
      const timeChanged = Math.abs(kd.time - k.time) > EPS;
      const valueChanged = Math.abs(kd.value - k.value) > EPS;
      if (!timeChanged && !valueChanged) return;
      const base = { animation: props.anim.id, ...props.keyArgs(tl) };
      transaction("Edit key", () => {
        if (timeChanged) apply("moveKey", { ...base, time: k.time, newTime: kd.time });
        if (valueChanged) apply("setKeys", { ...base, keys: [{ time: kd.time, value: kd.value, curve: k.curve }] });
      });
      props.onSelect({ tl, time: kd.time });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Handles of the selected key: out = first control point of its segment, in = second of the previous one. */
  const handles = () => {
    const s = props.selKey;
    if (!s) return [];
    const tl = visible().find((t) => timelineKey(t) === timelineKey(s.tl));
    if (!tl) return [];
    const ks = keysOf(tl);
    const i = ks.findIndex((k) => Math.abs(k.time - s.time) < EPS);
    if (i < 0) return [];
    const out: { tl: TL; seg: number; which: 0 | 1; ax: number; ay: number; hx: number; hy: number }[] = [];
    const seg = (j: number, which: 0 | 1) => {
      const a = ks[j];
      const b = ks[j + 1];
      if (!a || !b || a.curve === "stepped") return;
      const c = Array.isArray(a.curve) ? a.curve : DEFAULT_CURVE;
      const ya = toDisplay(tl, a.value);
      const yb = toDisplay(tl, b.value);
      const dt = b.time - a.time;
      const anchor = which === 0 ? a : b;
      out.push({
        tl,
        seg: j,
        which,
        ax: X(anchor.time),
        ay: Y(which === 0 ? ya : yb),
        hx: X(a.time + c[which * 2] * dt),
        hy: Y(ya + c[which * 2 + 1] * (yb - ya)),
      });
    };
    seg(i, 0);
    seg(i - 1, 1);
    return out;
  };

  const handleDown = (e: PointerEvent, h: { tl: TL; seg: number; which: 0 | 1 }) => {
    e.stopPropagation();
    e.preventDefault();
    const tl = h.tl;
    const ks = keysOf(tl);
    const a = ks[h.seg];
    const b = ks[h.seg + 1];
    if (!a || !b) return;
    const start = Array.isArray(a.curve) ? ([...a.curve] as [number, number, number, number]) : ([...DEFAULT_CURVE] as [number, number, number, number]);
    const ya = toDisplay(tl, a.value);
    const yb = toDisplay(tl, b.value);
    const id = timelineKey(tl);
    const move = (m: PointerEvent) => {
      const p = local(m);
      const c = [...(curveDraft()?.c ?? start)] as [number, number, number, number];
      c[h.which * 2] = Math.round(Math.min(1, Math.max(0, (tAt(p.x) - a.time) / (b.time - a.time))) * 1000) / 1000;
      // A flat segment has no value scale for its handles: keep their height.
      if (Math.abs(yb - ya) > EPS) c[h.which * 2 + 1] = Math.round(((dAt(p.y) - ya) / (yb - ya)) * 1000) / 1000;
      setCurveDraft({ id, time: a.time, c });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const cd = curveDraft();
      setCurveDraft(null);
      if (!cd || cd.c.every((v, i) => v === start[i])) return;
      apply("moveKey", { animation: props.anim.id, ...props.keyArgs(tl), time: a.time, curve: cd.c as Curve });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const keyDownOnGraph = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      e.stopPropagation();
      fit();
    }
  };

  const toggle = (tl: TL) => {
    const s = new Set(hidden());
    const k = timelineKey(tl);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    setHidden(s);
  };
  const setAll = (show: boolean) => setHidden(show ? new Set<string>() : new Set<string>(numeric().map(timelineKey)));

  return (
    <div class="graph-view" onKeyDown={keyDownOnGraph}>
      <div class="graph-list" style={{ width: `${LIST_W}px` }}>
        <div class="graph-list-head">
          <button title="Show every curve" onClick={() => setAll(true)}>All</button>
          <button title="Hide every curve" onClick={() => setAll(false)}>None</button>
          <label class="check" title="Scale each curve to its own range so different properties (degrees, pixels, scale) fit together">
            <input type="checkbox" checked={normalize()} onChange={(e) => setNormalize(e.currentTarget.checked)} /> Normalize
          </label>
        </div>
        <For each={numeric()} fallback={<div class="muted pad">No numeric timelines. Colours, attachments and draw order switch values and have no curves.</div>}>
          {(tl) => (
            <label class="graph-row" classList={{ off: hidden().has(timelineKey(tl)), sel: !!props.selKey && timelineKey(props.selKey.tl) === timelineKey(tl) }} title={props.label(tl)}>
              <input type="checkbox" checked={!hidden().has(timelineKey(tl))} onChange={() => toggle(tl)} />
              <span class="swatch" style={{ background: timelineColor(tl) }} />
              <span class="name">{props.label(tl)}</span>
            </label>
          )}
        </For>
      </div>
      <div class="graph-canvas" classList={{ panning: panning() }} tabIndex={0}>
        <svg ref={svg} onPointerDown={bgDown} onWheel={onWheel} onDblClick={(e) => e.target === svg && fit()}>
          <For each={valueTicks()}>
            {(v) => (
              <>
                <line class="graph-grid" classList={{ zero: Math.abs(v) < EPS }} x1={0} x2={size().w} y1={Y(v)} y2={Y(v)} />
                <text class="graph-vlabel" x={4} y={Y(v) - 3}>
                  {normalize() ? `${Math.round(v * 100)}%` : fmt(v)}
                </text>
              </>
            )}
          </For>
          <For each={timeTicks()}>{(t) => <line class="graph-grid t" x1={X(t)} x2={X(t)} y1={RULER_H} y2={size().h} />}</For>
          <rect class="graph-out" x={X(props.duration)} y={RULER_H} width={Math.max(0, size().w - X(props.duration))} height={Math.max(0, size().h - RULER_H)} />
          <For each={visible()}>
            {(tl) => {
              const p = () => pathOf(tl);
              const sel = () => !!props.selKey && timelineKey(props.selKey.tl) === timelineKey(tl);
              return (
                <g class="graph-curve" classList={{ sel: sel() }} style={{ color: timelineColor(tl) }}>
                  <path class="hold" d={p().holds} />
                  <path class="line" d={p().line} />
                  <For each={keysOf(tl)}>
                    {(k) => (
                      <rect
                        class="graph-key"
                        classList={{ selected: isSel(tl, k.time) }}
                        x={X(k.time) - 4}
                        y={Y(toDisplay(tl, k.value)) - 4}
                        width={8}
                        height={8}
                        onPointerDown={(e) => keyDown(e, tl, k)}
                      >
                        <title>{`${props.label(tl)}\n${k.time}s = ${fmt(k.value)}\nDrag to move (shift: one axis)`}</title>
                      </rect>
                    )}
                  </For>
                </g>
              );
            }}
          </For>
          <For each={handles()}>
            {(h) => (
              <g class="graph-handle">
                <line x1={h.ax} y1={h.ay} x2={h.hx} y2={h.hy} />
                <circle cx={h.hx} cy={h.hy} r={5} onPointerDown={(e) => handleDown(e, h)}>
                  <title>{h.which === 0 ? "Out handle: shapes the motion to the next key" : "In handle: shapes the motion from the previous key"}</title>
                </circle>
              </g>
            )}
          </For>
          <rect class="graph-ruler" x={0} y={0} width={size().w} height={RULER_H} />
          <For each={timeTicks()}>
            {(t) => (
              <text class="graph-tlabel" x={X(t) + 3} y={13}>
                {fmt(t)}
              </text>
            )}
          </For>
          <line class="graph-end" x1={X(props.duration)} x2={X(props.duration)} y1={0} y2={size().h} />
          <line class="graph-playhead" x1={X(time())} x2={X(time())} y1={0} y2={size().h} />
        </svg>
        <div class="graph-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Zoom out" onClick={() => zoom(1 / 1.25, 1 / 1.25, size().w / 2, size().h / 2)}>−</button>
          <button title="Zoom in" onClick={() => zoom(1.25, 1.25, size().w / 2, size().h / 2)}>+</button>
          <button title="Fit curves (F, or double-click empty space)" onClick={fit}>⛶</button>
        </div>
      </div>
    </div>
  );
}
