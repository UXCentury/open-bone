import { type ColorStop, PARTICLE_PRESETS, type ParticlePreset, type ParticlesAttachment, type Range, type SkinData } from "@openbone/core";
import { For, Show } from "solid-js";
import { ensureAnimation } from "../edit.ts";
import { apply, currentAnimation, doc, mode, time } from "../state.ts";
import { ColorField, NumberField, Section, SelectField } from "./fields.tsx";

/** Slots that have a particles attachment in any skin (targets for emitter actions and state toggles). */
export function emitterSlots() {
  const d = doc();
  return d.skeleton.slots.filter((s) => d.skeleton.skins.some((k) => Object.values(k.attachments[s.id] ?? {}).some((a) => a.type === "particles")));
}

export const PRESET_NAMES = Object.keys(PARTICLE_PRESETS) as ParticlePreset[];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Key the slot's emitter on/off or rate at the current time (Animate mode). */
export function keyParticles(slotId: string, property: "emitting" | "rate", value: boolean | number) {
  const anim = ensureAnimation();
  if (anim)
    apply("setKeys", { animation: anim, target: "particles", id: slotId, property, keys: [{ time: round3(time()), value, curve: property === "emitting" ? "stepped" : "linear" }] });
}

function isKeyed(slotId: string, property: string) {
  const tl = currentAnimation()?.timelines.find((t) => t.target === "particles" && t.id === slotId && t.property === property);
  return !!tl?.keys.some((k) => Math.abs(k.time - time()) < 1e-4);
}

function Check(p: { label: string; checked: boolean; onChange: (v: boolean) => void; onKey?: () => void; keyed?: boolean; title?: string }) {
  return (
    <label class="field" title={p.title}>
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.currentTarget.checked)} />
      <Show when={p.onKey}>
        <button class="key-btn" classList={{ keyed: p.keyed }} title="Set key at current time" onClick={p.onKey}>
          ◆
        </button>
      </Show>
    </label>
  );
}

function RangeField(p: { label: string; value: Range; step?: number; onCommit: (v: Range) => void }) {
  return (
    <div class="range-field">
      <NumberField label={`${p.label} min`} step={p.step} value={p.value[0]} onCommit={(v) => p.onCommit([v, Math.max(v, p.value[1])])} />
      <NumberField label="max" step={p.step} value={p.value[1]} onCommit={(v) => p.onCommit([Math.min(v, p.value[0]), v])} />
    </div>
  );
}

/** Colour-over-life gradient: a preview strip plus editable stops. */
function GradientEditor(p: { stops: ColorStop[]; onCommit: (v: ColorStop[]) => void }) {
  const sorted = () => [...p.stops].sort((a, b) => a.t - b.t);
  const css = () => {
    const toCss = (c: string) => {
      const n = (i: number) => parseInt(c.slice(i, i + 2), 16);
      const a = c.length >= 9 ? n(7) / 255 : 1;
      return `rgba(${n(1)},${n(3)},${n(5)},${a})`;
    };
    return `linear-gradient(to right, ${sorted().map((s) => `${toCss(s.color)} ${s.t * 100}%`).join(", ")}), repeating-conic-gradient(#999 0 25%, #ddd 0 50%) 0 0 / 10px 10px`;
  };
  const set = (i: number, stop: Partial<ColorStop>) => p.onCommit(sorted().map((s, j) => (j === i ? { ...s, ...stop } : s)));
  return (
    <>
      <div class="gradient-strip" style={{ background: css() }} />
      <For each={sorted()}>
        {(s, i) => (
          <div class="range-field">
            <NumberField label="At" step={0.01} value={s.t} onCommit={(v) => set(i(), { t: Math.max(0, Math.min(1, v)) })} />
            <ColorField label="" value={s.color} onCommit={(v) => set(i(), { color: v })} />
            <button class="row-del" title="Remove stop" disabled={p.stops.length <= 1} onClick={() => p.onCommit(sorted().filter((_, j) => j !== i()))}>
              ×
            </button>
          </div>
        )}
      </For>
      <button
        onClick={() => {
          const s = sorted();
          // Insert halfway into the widest gap.
          let at = 0.5;
          let best = -1;
          for (let i = 1; i < s.length; i++) if (s[i].t - s[i - 1].t > best) [best, at] = [s[i].t - s[i - 1].t, (s[i].t + s[i - 1].t) / 2];
          p.onCommit([...s, { t: round3(at), color: s[0]?.color ?? "#ffffff" }]);
        }}
      >
        + Colour stop
      </button>
    </>
  );
}

/** Inspector for a particles attachment: grouped sections, presets, keyable emitting/rate in Animate mode. */
export function ParticlesEditor(p: { slotId: string; att: ParticlesAttachment; owner: SkinData }) {
  // Read through doc() and props so fields follow undo and selection changes (attachments are edited in place).
  const a = () => (doc(), p.att);
  const set = (props: Record<string, unknown>) => apply("updateParticles", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, ...props });
  const animate = () => mode() === "animate";
  const opts = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));
  return (
    <>
      <SelectField
        label="Preset"
        value=""
        options={[{ value: "", label: "Apply preset…" }, ...PRESET_NAMES.map((n) => ({ value: n, label: n }))]}
        onCommit={(v) => v && set({ preset: v })}
      />
      <Section title="Emission" id="particles.emission">
        <Check
          label="Emitting"
          checked={a().emitting}
          onChange={(v) => (animate() ? keyParticles(p.slotId, "emitting", v) : set({ emitting: v }))}
          onKey={animate() ? () => keyParticles(p.slotId, "emitting", a().emitting) : undefined}
          keyed={animate() && isKeyed(p.slotId, "emitting")}
          title={animate() ? "Keys the emitter on/off at the current time" : "Setup value"}
        />
        <NumberField
          label="Rate /s"
          value={a().rate}
          onCommit={(v) => (animate() ? keyParticles(p.slotId, "rate", Math.max(0, v)) : set({ rate: Math.max(0, v) }))}
          onKey={animate() ? () => keyParticles(p.slotId, "rate", a().rate) : undefined}
          keyed={animate() && isKeyed(p.slotId, "rate")}
        />
        <NumberField label="Max" value={a().maxParticles} onCommit={(v) => set({ maxParticles: Math.max(1, Math.round(v)) })} />
        <NumberField label="Duration" step={0.05} value={a().duration} onCommit={(v) => set({ duration: Math.max(0.01, v) })} />
        <Check label="Loop" checked={a().loop} onChange={(v) => set({ loop: v })} />
        <Check label="Prewarm" checked={a().prewarm} onChange={(v) => set({ prewarm: v })} title="Start as if one cycle had already run" />
        <div class="hint">Bursts (seconds into each cycle)</div>
        <For each={a().bursts}>
          {(b, i) => (
            <div class="range-field">
              <NumberField label="At" step={0.05} value={b.time} onCommit={(v) => set({ bursts: a().bursts.map((x, j) => (j === i() ? { ...x, time: Math.max(0, v) } : x)) })} />
              <NumberField label="Count" value={b.count} onCommit={(v) => set({ bursts: a().bursts.map((x, j) => (j === i() ? { ...x, count: Math.max(1, Math.round(v)) } : x)) })} />
              <button class="row-del" title="Remove burst" onClick={() => set({ bursts: a().bursts.filter((_, j) => j !== i()) })}>
                ×
              </button>
            </div>
          )}
        </For>
        <button onClick={() => set({ bursts: [...a().bursts, { time: 0, count: 20 }] })}>+ Burst</button>
      </Section>
      <Section title="Shape" id="particles.shape">
        <SelectField label="Shape" value={a().shape} options={opts(["point", "circle", "box", "cone"])} onCommit={(v) => set({ shape: v })} />
        <NumberField label="X" value={a().x} onCommit={(v) => set({ x: v })} />
        <NumberField label="Y" value={a().y} onCommit={(v) => set({ y: v })} />
        <NumberField label="Direction" value={a().rotation} onCommit={(v) => set({ rotation: v })} />
        <Show when={a().shape !== "circle"}>
          <NumberField label="Spread" value={a().angle} onCommit={(v) => set({ angle: Math.max(0, Math.min(360, v)) })} />
        </Show>
        <Show when={a().shape === "circle" || a().shape === "cone"}>
          <NumberField label="Radius" value={a().radius} onCommit={(v) => set({ radius: Math.max(0, v) })} />
        </Show>
        <Show when={a().shape === "box"}>
          <NumberField label="Width" value={a().width} onCommit={(v) => set({ width: Math.max(0, v) })} />
          <NumberField label="Height" value={a().height} onCommit={(v) => set({ height: Math.max(0, v) })} />
        </Show>
        <SelectField label="Space" value={a().space} options={opts(["world", "local"])} onCommit={(v) => set({ space: v })} />
      </Section>
      <Section title="Particles" id="particles.particles">
        <RangeField label="Life" step={0.05} value={a().lifetime} onCommit={(v) => set({ lifetime: [Math.max(0.001, v[0]), Math.max(0.001, v[1])] })} />
        <RangeField label="Speed" value={a().speed} onCommit={(v) => set({ speed: v })} />
        <NumberField label="Gravity" value={a().gravity} onCommit={(v) => set({ gravity: v })} />
        <NumberField label="Drag" step={0.05} value={a().drag} onCommit={(v) => set({ drag: Math.max(0, v) })} />
        <RangeField label="Size start" value={a().startSize} onCommit={(v) => set({ startSize: [Math.max(0, v[0]), Math.max(0, v[1])] })} />
        <RangeField label="Size end" value={a().endSize} onCommit={(v) => set({ endSize: [Math.max(0, v[0]), Math.max(0, v[1])] })} />
        <RangeField label="Rot start" value={a().startRotation} onCommit={(v) => set({ startRotation: v })} />
        <RangeField label="Rot end" value={a().endRotation} onCommit={(v) => set({ endRotation: v })} />
        <RangeField label="Spin °/s" value={a().angularVelocity} onCommit={(v) => set({ angularVelocity: v })} />
      </Section>
      <Section title="Colour over life" id="particles.colors">
        <GradientEditor stops={a().colors} onCommit={(v) => set({ colors: v })} />
        <SelectField label="Blend" value={a().blend} options={opts(["normal", "additive", "multiply", "screen"])} onCommit={(v) => set({ blend: v })} />
      </Section>
      <Section title="Look" id="particles.look">
        <SelectField
          label="Look"
          value={a().look}
          options={opts(doc().images.length ? ["circle", "square", "spark", "image"] : ["circle", "square", "spark"])}
          onCommit={(v) => set(v === "image" ? { look: v, image: a().image ?? doc().images[0].id } : { look: v })}
        />
        <Show when={a().look === "image"}>
          <SelectField label="Image" value={a().image ?? ""} options={doc().images.map((i) => ({ value: i.id, label: i.name }))} onCommit={(v) => set({ image: v })} />
        </Show>
        <Show when={a().look === "spark"}>
          <NumberField label="Stretch" step={0.01} value={a().stretch} onCommit={(v) => set({ stretch: Math.max(0, v) })} />
        </Show>
      </Section>
      <Section title="Determinism" id="particles.seed">
        <div class="range-field">
          <NumberField label="Seed" value={a().seed} onCommit={(v) => set({ seed: Math.round(v) })} />
          <button title="Pick another random seed" onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}>
            🎲
          </button>
        </div>
        <div class="hint">Same seed and time → same particles in the viewport, exports and players.</div>
      </Section>
    </>
  );
}
