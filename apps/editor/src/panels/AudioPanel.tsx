import { type AnimationData, type LayerData, type SoundData, type StateData, animationDuration } from "@openbone/core";
import { For, Show, createEffect, createSignal } from "solid-js";
import { audioMuted, audition, importAudio, setAudioMuted } from "../audio.ts";
import { askConfirm, askForm, askText, uniqueName } from "../dialogs.tsx";
import { decodedNow, drawWaveform } from "../waveform.ts";
import { apply, currentStateMachine, doc, selection, setSelection, time } from "../state.ts";
import { NumberField, Section, SelectField, TextField } from "./fields.tsx";

const sounds = () => doc().audio?.sounds ?? [];
const buses = () => doc().audio?.buses ?? [];
const assets = () => doc().audio?.assets ?? [];
const soundName = (id: string) => sounds().find((s) => s.id === id)?.name ?? id;
const busName = (id: string | null) => buses().find((b) => b.id === id)?.name ?? "master";
const fmt = (n: number) => `${Math.round(n * 100) / 100}`;

let fileInput: HTMLInputElement | undefined;
/** Open the file picker for WAV/MP3/OGG. */
export const pickAudio = () => fileInput?.click();

/** Speaker button that mutes all editor audio (preview, Run, auditions). */
export function MuteButton() {
  return (
    <button
      classList={{ active: audioMuted() }}
      title={audioMuted() ? "Editor audio is muted: click to unmute" : "Mute editor audio (preview and Run)"}
      onClick={() => setAudioMuted(!audioMuted())}
    >
      {audioMuted() ? "🔇" : "🔊"}
    </button>
  );
}

// ---------------- Hierarchy ----------------

/** Hierarchy section: sounds, buses (with mute) and files. */
export function AudioSection() {
  const sel = () => selection();
  return (
    <Section
      title="Audio"
      actions={
        <>
          <button title="Import WAV / MP3 / OGG files" onClick={pickAudio}>
            +
          </button>
          <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.ogg" multiple hidden onChange={(e) => e.currentTarget.files && void importAudio(e.currentTarget.files).then(() => (e.currentTarget.value = ""))} />
        </>
      }
    >
      <For each={sounds()} fallback={<div class="muted pad">Drop WAV/MP3/OGG files on the viewport or use +</div>}>
        {(s) => {
          // Rows read through doc() so in-place edits re-render.
          const live = () => (doc(), s);
          return (
            <div
              class="tree-row"
              classList={{ selected: sel()?.kind === "sound" && sel()!.id === s.id }}
              title="Sound: click to edit; ▶ plays it"
              onClick={() => setSelection({ kind: "sound", id: s.id })}
            >
              <span class="icon">♪</span> {live().name}
              <span class="muted"> {busName(live().bus)}{live().loop ? " · loop" : ""}</span>
              <span class="row-actions">
                <button class="row-btn" title="Play" onClick={(e) => { e.stopPropagation(); audition(s.id); }}>▶</button>
              </span>
            </div>
          );
        }}
      </For>
      <Show when={doc().audio}>
        <div
          class="tree-row"
          classList={{ selected: sel()?.kind === "bus" && sel()!.id === "master" }}
          onClick={() => setSelection({ kind: "bus", id: "master" })}
          title="Master volume and mute"
        >
          <span class="icon">🎚</span> master <span class="muted">{fmt(doc().audio!.master)}{doc().audio!.muted ? " · muted" : ""}</span>
        </div>
        <For each={buses()}>
          {(b) => {
            const live = () => (doc(), b);
            return (
              <div
                class="tree-row"
                classList={{ selected: sel()?.kind === "bus" && sel()!.id === b.id }}
                style={{ "padding-left": "20px" }}
                onClick={() => setSelection({ kind: "bus", id: b.id })}
                title="Bus: volume and mute apply to every sound routed to it"
              >
                <span class="icon">⫶</span> {live().name} <span class="muted">{fmt(live().volume)}</span>
                <span class="row-actions" style={{ visibility: "visible" }}>
                  <button class="row-btn" title={live().muted ? "Unmute bus" : "Mute bus"} onClick={(e) => { e.stopPropagation(); apply("updateBus", { bus: b.id, muted: !live().muted }); }}>
                    {live().muted ? "🔇" : "🔈"}
                  </button>
                </span>
              </div>
            );
          }}
        </For>
        <For each={assets()}>
          {(a) => (
            <div class="tree-row" classList={{ selected: sel()?.kind === "audio" && sel()!.id === a.id }} onClick={() => setSelection({ kind: "audio", id: a.id })} title="Audio file">
              <span class="icon">🎵</span> {(doc(), a).name} <span class="muted">{fmt(a.duration)}s</span>
            </div>
          )}
        </For>
      </Show>
    </Section>
  );
}

// ---------------- Inspector ----------------

function Check(p: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label class="field" title={p.title}>
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function SoundInspector(p: { id: string }) {
  const s = () => (doc(), sounds().find((x) => x.id === p.id));
  const set = (props: Record<string, unknown>) => apply("updateSound", { sound: p.id, ...props });
  const events = () => doc().events.filter((e) => e.audio === p.id || e.audio === s()?.name);
  const [bindEvent, setBindEvent] = createSignal("");
  return (
    <Show when={s()}>
      <Section title="Sound">
        <TextField label="Name" value={s()!.name} onCommit={(v) => v && set({ name: v })} />
        <SelectField label="File" value={s()!.asset} options={assets().map((a) => ({ value: a.id, label: a.name }))} onCommit={(v) => set({ asset: v })} />
        <SelectField
          label="Bus"
          value={s()!.bus ?? ""}
          options={[{ value: "", label: "(master)" }, ...buses().map((b) => ({ value: b.id, label: b.name }))]}
          onCommit={(v) => set({ bus: v || null })}
        />
        <NumberField label="Volume" step={0.05} value={s()!.volume} onCommit={(v) => set({ volume: Math.max(0, v) })} />
        <NumberField label="Rate" step={0.05} value={s()!.rate} onCommit={(v) => set({ rate: Math.min(8, Math.max(0.05, v)) })} />
        <Check label="Loop" checked={s()!.loop} onChange={(v) => set({ loop: v })} title="Looping sounds stop when the state or animation that started them ends" />
        <NumberField label="Fade in" step={0.05} value={s()!.fadeIn} onCommit={(v) => set({ fadeIn: Math.max(0, v) })} />
        <NumberField label="Fade out" step={0.05} value={s()!.fadeOut} onCommit={(v) => set({ fadeOut: Math.max(0, v) })} />
        <div class="btn-row">
          <button onClick={() => audition(p.id)}>▶ Play</button>
          <button
            class="danger"
            onClick={() =>
              void askConfirm({ title: `Delete sound “${s()!.name}”?`, message: "Audio keys, state hooks, listener actions and event links that play it are removed too. The file stays. You can undo this.", confirmLabel: "Delete", danger: true }).then(
                (ok) => ok && apply("deleteSound", { sound: p.id }) !== undefined && setSelection(null),
              )
            }
          >
            Delete
          </button>
        </div>
      </Section>
      <Section title="Play on events">
        <For each={events()} fallback={<div class="hint pad">Link an event so every time it fires (animation key, listener, script) this sound plays.</div>}>
          {(e) => (
            <div class="input-row">
              <span class="grow">⚡ {e.name}</span>
              <button class="row-del" style={{ visibility: "visible" }} title="Unlink" onClick={() => apply("setEventSound", { event: e.id, sound: null })}>
                ×
              </button>
            </div>
          )}
        </For>
        <div class="field">
          <select value={bindEvent()} onChange={(e) => setBindEvent(e.currentTarget.value)}>
            <option value="">event…</option>
            <For each={doc().events.filter((e) => !events().includes(e))}>{(e) => <option value={e.id}>{e.name}{e.audio ? " (has a sound)" : ""}</option>}</For>
          </select>
          <button disabled={!bindEvent()} onClick={() => { apply("setEventSound", { event: bindEvent(), sound: p.id }); setBindEvent(""); }}>
            Link
          </button>
        </div>
      </Section>
    </Show>
  );
}

export function BusInspector(p: { id: string }) {
  const mix = () => doc().audio;
  const b = () => (doc(), buses().find((x) => x.id === p.id));
  const addBus = async () => {
    const name = await askText({ title: "New bus", message: "A mixer channel, e.g. voice or ambience.", value: "bus", confirmLabel: "Add", validate: uniqueName(buses().map((x) => x.name)) });
    if (!name) return;
    const r = apply("addBus", { name }) as { id: string } | undefined;
    if (r) setSelection({ kind: "bus", id: r.id });
  };
  return (
    <Show when={mix()}>
      <Show
        when={p.id !== "master" && b()}
        fallback={
          <Section title="Master">
            <NumberField label="Volume" step={0.05} value={mix()!.master} onCommit={(v) => apply("setAudioMix", { master: Math.max(0, v) })} />
            <Check label="Muted" checked={mix()!.muted} onChange={(v) => apply("setAudioMix", { muted: v })} title="Saved in the document: players start silent" />
            <div class="hint">Final gain = master × bus × sound × key volume. The 🔊 button in the toolbar mutes only the editor.</div>
            <button onClick={addBus}>+ Bus</button>
          </Section>
        }
      >
        <Section title="Bus">
          <TextField label="Name" value={b()!.name} onCommit={(v) => v && apply("updateBus", { bus: p.id, name: v })} />
          <NumberField label="Volume" step={0.05} value={b()!.volume} onCommit={(v) => apply("updateBus", { bus: p.id, volume: Math.max(0, v) })} />
          <Check label="Muted" checked={b()!.muted} onChange={(v) => apply("updateBus", { bus: p.id, muted: v })} />
          <div class="hint">Sounds: {sounds().filter((s) => s.bus === p.id).map((s) => s.name).join(", ") || "none"}</div>
          <div class="btn-row">
            <button onClick={addBus}>+ Bus</button>
            <button class="danger" onClick={() => apply("deleteBus", { bus: p.id }) !== undefined && setSelection({ kind: "bus", id: "master" })}>
              Delete
            </button>
          </div>
        </Section>
      </Show>
    </Show>
  );
}

export function AudioAssetInspector(p: { id: string }) {
  const a = () => (doc(), assets().find((x) => x.id === p.id));
  const used = () => sounds().filter((s) => s.asset === p.id);
  return (
    <Show when={a()}>
      <Section title="Audio file">
        <TextField label="Name" value={a()!.name} onCommit={(v) => v && apply("updateAudio", { asset: p.id, name: v })} />
        <div class="hint">
          {fmt(a()!.duration)}s · {a()!.src.startsWith("data:") ? "embedded" : a()!.src}
        </div>
        <div class="hint">Used by: {used().map((s) => s.name).join(", ") || "no sound"}</div>
        <div class="btn-row">
          <button
            onClick={async () => {
              const name = await askText({ title: "New sound from this file", value: `${a()!.name}${used().length + 1}`, confirmLabel: "Create", validate: uniqueName(sounds().map((s) => s.name)) });
              const r = name ? (apply("addSound", { name, asset: p.id }) as { id: string } | undefined) : undefined;
              if (r) setSelection({ kind: "sound", id: r.id });
            }}
          >
            + Sound
          </button>
          <button
            class="danger"
            onClick={() =>
              void askConfirm({ title: `Delete “${a()!.name}”?`, message: "Sounds that use this file, and everything that plays them, are removed too. You can undo this.", confirmLabel: "Delete", danger: true }).then(
                (ok) => ok && apply("deleteAudio", { asset: p.id }) !== undefined && setSelection(null),
              )
            }
          >
            Delete
          </button>
        </div>
      </Section>
    </Show>
  );
}

// ---------------- Timeline ----------------

const soundOptions = () => sounds().map((s) => ({ value: s.id, label: `${s.name}${s.loop ? " (loop)" : ""}` }));

/** Ask for a sound and add an audio key at time `at`. */
export async function addSoundKey(anim: AnimationData, at: number) {
  if (!sounds().length) {
    if (await askConfirm({ title: "No sounds yet", message: "Import a WAV, MP3 or OGG file first.", confirmLabel: "Import…" })) pickAudio();
    return;
  }
  const r = await askForm({
    title: "Add sound key",
    message: `Starts at ${at}s. Looping sounds stop when the animation ends or another one replaces it.`,
    confirmLabel: "Add",
    fields: [
      { key: "sound", label: "Sound", type: "choice", value: sounds()[0].id, options: soundOptions() },
      { key: "volume", label: "Volume", type: "text", value: "1", validate: (v) => (Number(v) >= 0 ? null : "A number ≥ 0") },
    ],
  });
  if (r) apply("addAudioKey", { animation: anim.id, sound: r.sound, time: at, ...(Number(r.volume) !== 1 ? { volume: Number(r.volume) } : {}) });
}

/** "♪ audio" track row: drag keys to move them, double-click to edit, × deletes the selected key. */
export function AudioTrack(p: { anim: AnimationData; pps: number; width: number; labelWidth: number; snap: (t: number) => number; onScrub: (e: PointerEvent) => void }) {
  const [selKey, setSelKey] = createSignal<{ sound: string; time: number } | null>(null);
  const keys = () => (doc(), p.anim.audio ?? []);
  const isSel = (k: { sound: string; time: number }) => {
    const s = selKey();
    return !!s && s.sound === k.sound && Math.abs(s.time - k.time) < 1e-6;
  };
  const drag = (e: PointerEvent, k: { sound: string; time: number }) => {
    e.stopPropagation();
    setSelKey({ sound: k.sound, time: k.time });
    const startX = e.clientX;
    let to = k.time;
    const move = (m: PointerEvent) => {
      to = p.snap(k.time + (m.clientX - startX) / p.pps);
      (e.target as HTMLElement).style.left = `${to * p.pps}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (Math.abs(to - k.time) > 1e-6) {
        apply("updateAudioKey", { animation: p.anim.id, sound: k.sound, time: k.time, newTime: to });
        setSelKey({ sound: k.sound, time: to });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const edit = async (k: { sound: string; time: number; volume?: number; rate?: number; loop?: boolean }) => {
    const r = await askForm({
      title: `Sound key “${soundName(k.sound)}” at ${k.time}s`,
      confirmLabel: "Save",
      fields: [
        { key: "volume", label: "Volume", type: "text", value: String(k.volume ?? 1), validate: (v) => (Number(v) >= 0 ? null : "A number ≥ 0") },
        { key: "rate", label: "Rate (empty = sound's)", type: "text", value: k.rate !== undefined ? String(k.rate) : "", required: false, validate: (v) => (!v || (Number(v) >= 0.05 && Number(v) <= 8) ? null : "0.05 to 8") },
        {
          key: "loop",
          label: "Loop",
          type: "choice",
          value: k.loop === undefined ? "" : String(k.loop),
          options: [
            { value: "", label: "Sound's setting" },
            { value: "true", label: "Loop" },
            { value: "false", label: "Play once" },
          ],
        },
      ],
    });
    if (!r) return;
    apply("updateAudioKey", {
      animation: p.anim.id,
      sound: k.sound,
      time: k.time,
      volume: Number(r.volume) === 1 ? null : Number(r.volume),
      rate: r.rate ? Number(r.rate) : null,
      loop: r.loop === "" ? null : r.loop === "true",
    });
  };
  const del = () => {
    const k = selKey();
    if (k) apply("deleteAudioKey", { animation: p.anim.id, sound: k.sound, time: k.time });
    setSelKey(null);
  };
  return (
    <div class="track-row audio-row" style={{ width: `${p.width}px` }} onKeyDown={(e) => (e.key === "Delete" || e.key === "Backspace") && selKey() && (e.stopPropagation(), del())}>
      <div class="row-label" title="Sounds started by this animation">
        ♪ audio
        <Show when={selKey()}>
          <button class="row-del" style={{ visibility: "visible" }} title="Delete the selected sound key" onClick={del}>
            ×
          </button>
        </Show>
      </div>
      <div class="track" onPointerDown={p.onScrub}>
        <For each={keys()}>
          {(k) => {
            const s = () => sounds().find((x) => x.id === k.sound);
            const loop = () => k.loop ?? s()?.loop ?? false;
            const asset = () => assets().find((x) => x.id === s()?.asset);
            const rate = () => k.rate ?? s()?.rate ?? 1;
            const len = () => {
              const a = asset();
              return a?.duration ? a.duration / rate() : 0;
            };
            // Waveform under the key: the sound's length, or up to the animation's end for a loop.
            const seconds = () => (loop() ? Math.max(len(), animationDuration(p.anim) - k.time) : len());
            let canvas: HTMLCanvasElement | undefined;
            createEffect(() => {
              const d = decodedNow(asset());
              const sec = seconds();
              if (canvas && d && sec > 0) drawWaveform(canvas, d, { pps: p.pps, rate: rate(), seconds: sec, color: isSel(k) ? "#ffe08a" : "#6fe3b4" });
            });
            return (
              <div
                class="event-key audio-key"
                classList={{ selected: isSel(k), loop: loop() }}
                style={{ left: `${k.time * p.pps}px`, "min-width": `${Math.max(12, (loop() ? 0 : len()) * p.pps)}px` }}
                title={`${s()?.name ?? k.sound} at ${k.time}s${k.volume !== undefined ? ` · vol ${k.volume}` : ""}${loop() ? " · loop" : ""} (double-click to edit)`}
                onPointerDown={(e) => drag(e, k)}
                onDblClick={() => void edit(k)}
              >
                <canvas class="wave" ref={canvas} />
                <span class="audio-name">
                  ♪ {s()?.name ?? "?"}
                  {loop() ? " ⟳" : ""}
                </span>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// ---------------- State machine ----------------

/** Sounds played or stopped when a state is entered / exited. */
export function StateSounds(p: { state: StateData; layer: LayerData }) {
  const sm = () => currentStateMachine()!;
  const args = () => ({ stateMachine: sm().id, layer: p.layer.id, state: p.state.id });
  const list = () => (doc(), p.state.sounds ?? []);
  const add = async () => {
    if (!sounds().length) {
      if (await askConfirm({ title: "No sounds yet", message: "Import a WAV, MP3 or OGG file first.", confirmLabel: "Import…" })) pickAudio();
      return;
    }
    const r = await askForm({
      title: `Sound for state “${p.state.name}”`,
      message: "A looping sound played on enter keeps playing while the state is active and fades out when it exits.",
      confirmLabel: "Add",
      fields: [
        { key: "sound", label: "Sound", type: "choice", value: sounds()[0].id, options: soundOptions() },
        { key: "on", label: "When", type: "choice", value: "enter", options: [{ value: "enter", label: "On enter" }, { value: "exit", label: "On exit" }] },
        { key: "action", label: "Do", type: "choice", value: "play", options: [{ value: "play", label: "Play" }, { value: "stop", label: "Stop (with its fade-out)" }] },
      ],
    });
    if (r) apply("setStateSound", { ...args(), sound: r.sound, on: r.on, action: r.action });
  };
  return (
    <>
      <div class="col-title">Sounds</div>
      <For each={list()} fallback={<div class="muted pad">No sounds</div>}>
        {(x) => (
          <div class="input-row">
            <span class="grow" title={x.action === "play" && sounds().find((s) => s.id === x.sound)?.loop && x.on === "enter" ? "Loops while the state is active" : undefined}>
              {x.on === "enter" ? "↘ enter" : "↗ exit"}: {x.action} ♪ {soundName(x.sound)}
              {x.action === "play" && x.on === "enter" && sounds().find((s) => s.id === x.sound)?.loop ? " ⟳" : ""}
            </span>
            <button class="row-del" style={{ visibility: "visible" }} title="Remove" onClick={() => apply("deleteStateSound", { ...args(), sound: x.sound, on: x.on })}>
              ×
            </button>
          </div>
        )}
      </For>
      <button onClick={() => void add()}>+ Sound</button>
    </>
  );
}

export type { SoundData };
