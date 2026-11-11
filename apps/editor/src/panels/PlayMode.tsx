import type { ImageAsset, InputData } from "@openbone/core";
import { Player } from "@openbone/player";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { resolveImageUrl } from "../images.ts";
import {
  SPEEDS,
  playEpoch,
  playFit,
  playFullWindow,
  playPaused,
  playSkin,
  playSpeed,
  playTarget,
  restartPlay,
  setPlayFit,
  setPlayFullWindow,
  setPlayPaused,
  setPlaySkin,
  setPlaySpeed,
  setPlayTarget,
  stopPlay,
} from "../play.ts";
import { tip } from "../shortcuts/index.ts";
import { baseUrl, doc, store } from "../state.ts";
import { audio, resolveAudioUrl } from "../audio.ts";

type Value = boolean | number | string;
/** A number for the inputs panel and the log: at most 4 decimals, never in exponent form (4.5e-13 shows as 0). */
const shortNumber = (v: number) => String(Math.round(v * 1e4) / 1e4 || 0);

interface LogLine {
  id: number;
  kind: "state" | "event" | "input" | "log" | "error";
  text: string;
  /** For input lines: which input, so a run of changes to it (a script easing it every frame) updates one line. */
  input?: string;
}

/**
 * Play mode stage: the document running in the shipping `Player` (state machine + scripts + pointer listeners, or an
 * animation), with a floating inputs panel and an event/state log. Mounted over the viewport while Play is on.
 */
export function PlayStage() {
  let host!: HTMLDivElement;
  let player: Player | null = null;
  const [values, setValues] = createSignal<Record<string, Value>>({});
  const [states, setStates] = createSignal<Record<string, string | null>>({});
  const [log, setLog] = createSignal<LogLine[]>([]);
  const [flash, setFlash] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  const [panelOpen, setPanelOpen] = createSignal(true);
  /** Sound buses as the running player has them (mute buttons inside the artboard change them too). */
  const [buses, setBuses] = createSignal<{ id: string | null; name: string; muted: boolean }[]>([]);
  const readBuses = () => {
    const p = player;
    const a = store.doc.audio;
    if (!p?.instance || !a?.assets.length) return setBuses([]);
    setBuses([
      { id: null, name: "master", muted: !!p.isBusMuted(null) },
      ...a.buses.map((b) => ({ id: b.id, name: b.name, muted: !!p.isBusMuted(b.id) })),
    ]);
  };
  const toggleBus = (id: string | null, name: string) => {
    const m = player?.setBusMuted(id, "toggle");
    if (m === null || m === undefined) return;
    push("input", `${m ? "🔇" : "🔊"} ${name} ${m ? "muted" : "unmuted"}`);
    readBuses();
  };
  let logId = 0;
  const push = (kind: LogLine["kind"], text: string, input?: string) =>
    setLog((l) => {
      // The newest line is a change to the same input: update it in place instead of adding a line per frame.
      if (input && l[0]?.input === input) return [{ ...l[0], text }, ...l.slice(1)];
      return [{ id: ++logId, kind, text, ...(input ? { input } : {}) }, ...l].slice(0, 200);
    });

  const sm = () => {
    const t = playTarget();
    return t?.kind === "sm" ? (doc().stateMachines.find((s) => s.id === t.id) ?? null) : null;
  };
  const anim = () => {
    const t = playTarget();
    return t?.kind === "anim" ? (doc().animations.find((a) => a.id === t.id) ?? null) : null;
  };
  const inputs = (): InputData[] => sm()?.inputs ?? [];

  const dispose = () => {
    if (!player) return;
    const canvas = host.querySelector("canvas");
    player.dispose();
    player = null;
    (canvas?.getContext("webgl2") as WebGL2RenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas?.remove();
  };

  const syncValues = () => {
    const inst = player?.stateMachine;
    if (!inst) return setValues({});
    const out: Record<string, Value> = {};
    for (const i of inst.data.inputs) {
      const v = inst.getInput(i.id) as Value | undefined;
      if (v !== undefined) out[i.id] = v;
    }
    // Only publish real changes, so a number field being typed into isn't rewritten by the poll.
    if (!sameRecord(out, values())) setValues(out);
    const st = inst.activeStates;
    if (!sameRecord(st, states())) setStates({ ...st });
  };

  const build = () => {
    dispose();
    setLog([]);
    const d = structuredClone(store.doc);
    // Play loads images from where the editor has them; the document's own srcs stay untouched.
    for (const img of d.images) if (img.src) img.src = resolveImageUrl(img);
    for (const page of d.atlas?.pages ?? []) page.src = resolveImageUrl(page);
    const canvas = document.createElement("canvas");
    canvas.className = "play-canvas";
    host.prepend(canvas);
    const s = sm();
    const a = anim();
    const skin = playSkin() ? d.skeleton.skins.find((k) => k.id === playSkin())?.name : undefined;
    setStatus("Loading…");
    const p = new Player({
      canvas,
      src: d,
      ...(s ? { stateMachine: s.id } : a ? { animation: a.name } : {}),
      ...(skin ? { skin } : {}),
      fit: playFit(),
      // Resolve relative image/audio paths like the editor does (examples live under /examples/, desktop files are
      // read from disk), and share the editor's audio context: the Play click already unlocked it.
      baseUrl: baseUrl(),
      resolveImageUrl: (src) => resolveImageUrl({ src } as ImageAsset),
      resolveAudioUrl,
      // Started right after the Play click: still a user activation, so the shared context can start now.
      ...(audio.activate() ? { audioContext: audio.activate()! } : {}),
      onEvent: (e) => push("event", `⚡ ${e.name}${e.string ? ` "${e.string}"` : ""}${e.int ? ` int ${e.int}` : ""}${e.float ? ` float ${e.float}` : ""}`),
      onStateChange: (e) => {
        push("state", `→ [${e.layer}] ${e.from ?? "∅"} → ${e.to}`);
        setStates((x) => ({ ...x, [e.layer]: e.to }));
      },
    });
    player = p;
    p.speed = playSpeed();
    p.ready
      .then(() => {
        if (player !== p) return;
        setStatus(s ? "Interactive: hover, click and drag the artboard" : a ? `Looping “${a.name}”` : "Setup pose (nothing animated)");
        readBuses();
        p.instance.on("audio", (c) => c.type === "mix" && readBuses());
        const inst = p.stateMachine;
        if (inst) {
          inst.on("inputChange", (c) => {
            const def = inst.data.inputs.find((i) => i.name === c.name);
            if (def?.type === "trigger") {
              setFlash(def.id);
              setTimeout(() => flash() === def.id && setFlash(null), 250);
            }
            push("input", `✎ ${c.name} = ${typeof c.value === "number" ? shortNumber(c.value) : JSON.stringify(c.value)}`, c.name);
            syncValues();
          });
          inst.on("log", (args) => push("log", `📝 ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`));
          inst.on("error", (e) => push("error", `⛔ ${e.message}`));
        }
        syncValues();
        if (playPaused()) p.pause();
      })
      .catch((e) => {
        setStatus("");
        push("error", `⛔ ${(e as Error).message}`);
      });
  };

  onMount(() => {
    build();
    createEffect(on([playTarget, playEpoch], build, { defer: true }));
    createEffect(on(playSkin, (id) => player?.setSkin(id ? (store.doc.skeleton.skins.find((k) => k.id === id)?.name ?? null) : null), { defer: true }));
    createEffect(on(playSpeed, (v) => player && (player.speed = v)));
    createEffect(on(playFit, (f) => player?.setFit(f), { defer: true }));
    createEffect(on(playPaused, (paused) => (paused ? player?.pause() : player?.play()), { defer: true }));
    // Polling keeps script-driven input/state values fresh without per-frame signals.
    const poll = window.setInterval(() => player?.stateMachine && syncValues(), 250);
    onCleanup(() => clearInterval(poll));
  });
  onCleanup(dispose);

  const set = (i: InputData, v: Value) => {
    const inst = player?.stateMachine;
    if (!inst) return;
    try {
      inst.setInput(i.id, v as boolean | number);
    } catch (e) {
      push("error", `⛔ ${(e as Error).message}`);
    }
    syncValues();
  };
  const fire = (i: InputData) => {
    try {
      player?.stateMachine?.fire(i.id);
    } catch (e) {
      push("error", `⛔ ${(e as Error).message}`);
    }
  };

  const targetValue = () => {
    const t = playTarget();
    return t ? `${t.kind}:${t.id}` : "";
  };

  return (
    <div class="play-stage" classList={{ "full-window": playFullWindow() }} role="region" aria-label="Play mode">
      <div class="play-banner" role="toolbar" aria-label="Play controls">
        <span class="play-badge" aria-live="polite">
          <span class="play-dot" /> Playing
        </span>
        <span class="muted small play-locked">Editing is locked</span>
        <select
          title="What to run"
          value={targetValue()}
          onChange={(e) => {
            const [kind, id] = e.currentTarget.value.split(":") as ["sm" | "anim", string];
            setPlayTarget(id ? { kind, id } : null);
          }}
        >
          <Show when={doc().stateMachines.length}>
            <optgroup label="State machines">
              <For each={doc().stateMachines}>{(s) => <option value={`sm:${s.id}`} selected={targetValue() === `sm:${s.id}`}>{s.name}</option>}</For>
            </optgroup>
          </Show>
          <Show when={doc().animations.length}>
            <optgroup label="Animations">
              <For each={doc().animations}>{(a) => <option value={`anim:${a.id}`} selected={targetValue() === `anim:${a.id}`}>{a.name}</option>}</For>
            </optgroup>
          </Show>
          <option value="" selected={!targetValue()}>Setup pose</option>
        </select>
        <Show when={doc().skeleton.skins.length > 1}>
          <select title="Skin" value={playSkin() ?? ""} onChange={(e) => setPlaySkin(e.currentTarget.value || null)}>
            <option value="">Default skin</option>
            <For each={doc().skeleton.skins.slice(1)}>{(k) => <option value={k.id} selected={playSkin() === k.id}>{k.name}</option>}</For>
          </select>
        </Show>
        <select title={tip("Speed", "play.faster")} value={String(playSpeed())} onChange={(e) => setPlaySpeed(Number(e.currentTarget.value))}>
          <For each={SPEEDS}>{(s) => <option value={String(s)} selected={playSpeed() === s}>{s}×</option>}</For>
        </select>
        <button title={tip(playPaused() ? "Resume" : "Pause", "play.pause")} onClick={() => setPlayPaused(!playPaused())}>
          {playPaused() ? "▶" : "⏸"}
        </button>
        <button title={tip("Restart from the beginning", "play.restart")} onClick={restartPlay}>
          ↻ Restart
        </button>
        <div class="segmented group">
          <button classList={{ active: playFit() === "contain" }} title={tip("Fit to view", "play.fit")} onClick={() => setPlayFit("contain")}>
            Fit
          </button>
          <button classList={{ active: playFit() === "none" }} title={tip("Actual size", "play.actual")} onClick={() => setPlayFit("none")}>
            1:1
          </button>
        </div>
        <button classList={{ active: playFullWindow() }} title={tip(playFullWindow() ? "Exit full window" : "Play in full window", "play.fullWindow")} onClick={() => setPlayFullWindow(!playFullWindow())}>
          ⛶
        </button>
        <span class="spacer" />
        <span class="muted small play-status">{status()}</span>
        <button class="play-stop" title={tip("Stop and return to editing", "play.stop")} onClick={stopPlay}>
          ■ Stop
        </button>
      </div>
      <div class="play-canvas-host" ref={host}>
      <div class="play-panel" classList={{ collapsed: !panelOpen() }}>
        <button class="play-panel-head" aria-expanded={panelOpen()} onClick={() => setPanelOpen(!panelOpen())}>
          <span>{sm() ? `Inputs · ${sm()!.name}` : "Playback"}</span>
          <span>{panelOpen() ? "▾" : "▸"}</span>
        </button>
        <Show when={panelOpen()}>
          <Show when={sm()} fallback={<div class="muted small play-empty">{anim() ? `Animation “${anim()!.name}” loops. Pick a state machine to get inputs.` : "Nothing animated."}</div>}>
            <Show when={inputs().length} fallback={<div class="muted small play-empty">This state machine has no inputs. Pointer listeners still work on the artboard.</div>}>
              <div class="play-inputs">
                <For each={inputs()}>
                  {(i) => <InputControl input={i} value={values()[i.id]} flash={flash() === i.id} onSet={(v) => set(i, v)} onFire={() => fire(i)} />}
                </For>
              </div>
            </Show>
            <div class="play-states">
              <For each={Object.entries(states())}>
                {([layer, st]) => (
                  <div>
                    <span class="muted">{layer}</span> <b>{st ?? "∅"}</b>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={buses().length}>
            <div class="play-sound" role="group" aria-label="Sound">
              <span class="muted small">Sound</span>
              <For each={buses()}>
                {(b) => (
                  <button
                    classList={{ active: b.muted }}
                    aria-pressed={b.muted}
                    title={`${b.muted ? "Unmute" : "Mute"} ${b.id === null ? "all sound" : `the “${b.name}” bus`} (like player.toggleBus(${JSON.stringify(b.id === null ? "master" : b.name)}) in a page)`}
                    onClick={() => toggleBus(b.id, b.name)}
                  >
                    {b.muted ? "🔇" : "🔊"} {b.id === null ? "All" : b.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="play-log-head">
            <span>Log</span>
            <button class="link" disabled={!log().length} onClick={() => setLog([])}>
              Clear
            </button>
          </div>
          <div class="play-log" aria-live="polite">
            <For each={log()} fallback={<div class="muted small">Events, state changes, input changes and script logs appear here.</div>}>
              {(l) => <div class={`log-${l.kind}`}>{l.text}</div>}
            </For>
          </div>
        </Show>
      </div>
      </div>
    </div>
  );
}

/** One state machine input: bool toggle, draggable number, trigger button or text field. */
function InputControl(p: { input: InputData; value: Value | undefined; flash: boolean; onSet: (v: Value) => void; onFire: () => void }) {
  const type = () => p.input.type as string;
  let scrub: { x: number; v: number } | null = null;
  return (
    <div class="play-input">
      <span
        class="play-input-name"
        classList={{ scrub: type() === "number" }}
        title={type() === "number" ? "Drag left/right to change (Shift: ×10, Alt: ×0.1)" : undefined}
        onPointerDown={(e) => {
          if (type() !== "number") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub = { x: e.clientX, v: Number(p.value ?? 0) };
        }}
        onPointerMove={(e) => {
          if (!scrub) return;
          const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          p.onSet(Math.round((scrub.v + (e.clientX - scrub.x) * 0.1 * k) * 100) / 100);
        }}
        onPointerUp={() => (scrub = null)}
      >
        {p.input.name}
        <small class="muted"> {type()}</small>
      </span>
      {type() === "bool" ? (
        <label class="switch">
          <input type="checkbox" checked={!!p.value} onChange={(e) => p.onSet(e.currentTarget.checked)} />
          <span>{p.value ? "true" : "false"}</span>
        </label>
      ) : type() === "number" ? (
        <input class="num" type="number" step="0.1" value={shortNumber(Number(p.value ?? 0))} onInput={(e) => e.currentTarget.value !== "" && p.onSet(Number(e.currentTarget.value))} />
      ) : type() === "trigger" ? (
        <button class="fire" classList={{ flash: p.flash }} onClick={p.onFire}>
          Fire
        </button>
      ) : (
        <input type="text" value={String(p.value ?? "")} onChange={(e) => p.onSet(e.currentTarget.value)} />
      )}
    </div>
  );
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
