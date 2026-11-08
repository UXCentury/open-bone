import { type Curve, EASINGS, type Timeline as TL, animationDuration } from "@openbone/core";
import { For, Show, createSignal } from "solid-js";
import { apply, currentAnimation, doc, mode, playing, setMode, setPlaying, setTime, time, setAnimationId, autoKey, setAutoKey } from "../state.ts";

type KeyRef = { tl: TL; time: number } | { event: string; time: number };

const LABEL_W = 170;

function label(t: TL): string {
  const d = doc();
  if (t.target === "bone") return `${d.skeleton.bones.find((b) => b.id === t.id)?.name ?? t.id} · ${t.property}`;
  if (t.target === "slot") return `${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · ${t.property}`;
  if (t.target === "deform") return `${d.skeleton.slots.find((s) => s.id === t.id)?.name ?? t.id} · deform ${t.attachment}`;
  if (t.target === "ik") return `IK ${d.skeleton.ik.find((c) => c.id === t.id)?.name ?? t.id} · mix`;
  if (t.target === "transform") return `TC ${d.skeleton.transform.find((c) => c.id === t.id)?.name ?? t.id} · mix`;
  return "draw order";
}

const keyArgs = (tl: TL) => ({
  target: tl.target,
  id: tl.id,
  property: tl.property,
  ...(tl.target === "deform" ? { attachment: tl.attachment } : {}),
});

function curveName(c: Curve): string {
  if (typeof c === "string") return c;
  const hit = Object.entries(EASINGS).find(([, v]) => v.every((x, i) => Math.abs(x - c[i]) < 1e-6));
  return hit ? hit[0] : "custom";
}

export function Timeline() {
  const [pps, setPps] = createSignal(220); // pixels per second
  const [selKey, setSelKey] = createSignal<KeyRef | null>(null);
  const anim = currentAnimation;
  const duration = () => {
    const a = anim();
    return a ? Math.max(animationDuration(a), 0.001) : 1;
  };
  const span = () => Math.max(duration(), 2) + 0.5;
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

  const dragKey = (e: PointerEvent, ref: KeyRef) => {
    e.stopPropagation();
    setSelKey(ref);
    setTime(ref.time);
    const startX = e.clientX;
    let newTime = ref.time;
    const el = e.currentTarget as HTMLElement;
    const move = (m: PointerEvent) => {
      newTime = snap(ref.time + (m.clientX - startX) / pps());
      el.style.left = `${newTime * pps()}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const a = anim();
      if (!a || Math.abs(newTime - ref.time) < 1e-6) return;
      if ("tl" in ref) apply("moveKey", { animation: a.id, ...keyArgs(ref.tl), time: ref.time, newTime });
      else {
        const k = a.events.find((x) => x.event === ref.event && Math.abs(x.time - ref.time) < 1e-6);
        apply("deleteEventKey", { animation: a.id, event: ref.event, time: ref.time });
        apply("addEventKey", { animation: a.id, event: ref.event, time: newTime, int: k?.int, float: k?.float, string: k?.string });
      }
      setSelKey({ ...ref, time: newTime });
      setTime(newTime);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const deleteSelected = () => {
    const k = selKey();
    const a = anim();
    if (!k || !a) return;
    if ("tl" in k) apply("deleteKey", { animation: a.id, ...keyArgs(k.tl), time: k.time });
    else apply("deleteEventKey", { animation: a.id, event: k.event, time: k.time });
    setSelKey(null);
  };

  const selectedCurve = () => {
    const k = selKey();
    if (!k || !("tl" in k)) return null;
    const key = (k.tl.keys as { time: number; curve: Curve }[]).find((x) => Math.abs(x.time - k.time) < 1e-6);
    return key ? curveName(key.curve) : null;
  };

  const ticks = () => {
    const out: number[] = [];
    const step = pps() > 300 ? 0.1 : pps() > 120 ? 0.25 : 0.5;
    for (let t = 0; t <= span() + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  };

  return (
    <div class="timeline" onKeyDown={(e) => (e.key === "Delete" || e.key === "Backspace") && deleteSelected()} tabIndex={0}>
      <div class="timeline-bar">
        <select value={anim()?.id ?? ""} onChange={(e) => setAnimationId(e.currentTarget.value || null)}>
          <option value="">— animation —</option>
          <For each={doc().animations}>{(a) => <option value={a.id}>{a.name}</option>}</For>
        </select>
        <button onClick={() => setTime(0)} title="To start">⏮</button>
        <button
          class="play"
          onClick={() => {
            if (mode() !== "animate") setMode("animate");
            setPlaying(!playing());
          }}
          title="Play/pause (Space)"
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
        </Show>
        <label class="check" title="Dragging bones in Animate mode creates keys">
          <input type="checkbox" checked={autoKey()} onChange={(e) => setAutoKey(e.currentTarget.checked)} /> Auto-key
        </label>
        <Show when={selKey()}>
          <span class="sep" />
          <Show when={selectedCurve()}>
            <label class="check">
              Curve
              <select
                value={selectedCurve()!}
                onChange={(e) => {
                  const k = selKey();
                  const a = anim();
                  if (k && a && "tl" in k) apply("moveKey", { animation: a.id, ...keyArgs(k.tl), time: k.time, curve: e.currentTarget.value });
                }}
              >
                <For each={["linear", "stepped", ...Object.keys(EASINGS)]}>{(c) => <option value={c}>{c}</option>}</For>
                <option value="custom" disabled>
                  custom
                </option>
              </select>
            </label>
          </Show>
          <button class="danger" onClick={deleteSelected}>
            Delete key
          </button>
        </Show>
        <span class="spacer" />
        <button
          title="Add an event key at the current time"
          disabled={!anim()}
          onClick={() => {
            const name = prompt("Event name", doc().events[0]?.name ?? "event");
            if (name && anim()) apply("addEventKey", { animation: anim()!.id, event: name, time: snap(time()) });
          }}
        >
          + Event
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
        <div class="timeline-area" ref={area}>
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
              <div class="track" onPointerDown={scrub}>
                <For each={anim()!.events}>
                  {(k) => {
                    const ev = () => doc().events.find((e) => e.id === k.event);
                    const sel = () => {
                      const s = selKey();
                      return !!s && "event" in s && s.event === k.event && Math.abs(s.time - k.time) < 1e-6;
                    };
                    return (
                      <div class="event-key" classList={{ selected: sel() }} style={{ left: `${k.time * pps()}px` }} title={ev()?.name} onPointerDown={(e) => dragKey(e, { event: k.event, time: k.time })}>
                        {ev()?.name}
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
          <For each={anim()!.timelines}>
            {(tl) => (
              <div class="track-row" style={{ width: `${LABEL_W + span() * pps()}px` }}>
                <div class="row-label" title={label(tl)}>
                  {label(tl)}
                  <button class="row-del" title="Delete timeline" onClick={() => apply("deleteTimeline", { animation: anim()!.id, ...keyArgs(tl) })}>
                    ×
                  </button>
                </div>
                <div class="track" onPointerDown={scrub}>
                  <For each={tl.keys as { time: number; curve: Curve; value: unknown }[]}>
                    {(k) => {
                      const sel = () => {
                        const s = selKey();
                        return !!s && "tl" in s && s.tl.target === tl.target && s.tl.id === tl.id && s.tl.property === tl.property && Math.abs(s.time - k.time) < 1e-6;
                      };
                      return (
                        <div
                          class="key"
                          classList={{ selected: sel(), stepped: k.curve === "stepped", eased: Array.isArray(k.curve) }}
                          style={{ left: `${k.time * pps()}px` }}
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
          <div class="playhead" style={{ left: `${LABEL_W + time() * pps()}px`, height: `${(anim()!.timelines.length + (anim()!.events.length ? 2 : 1)) * 24}px` }} />
        </div>
      </Show>
    </div>
  );
}
