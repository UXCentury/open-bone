import { type JSX, Show } from "solid-js";

/** Numeric input with drag-to-scrub label. Commits on change / Enter / drag end. */
export function NumberField(p: {
  label: string;
  value: number;
  step?: number;
  onCommit: (v: number) => void;
  onKey?: () => void;
  keyed?: boolean;
}) {
  let startX = 0;
  let startV = 0;
  let input!: HTMLInputElement;
  const down = (e: PointerEvent) => {
    startX = e.clientX;
    startV = p.value;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const v = round(startV + (m.clientX - startX) * (p.step ?? 1) * (m.shiftKey ? 0.1 : 1));
      input.value = String(v);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const v = Number(input.value);
      if (v !== p.value) p.onCommit(v);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <label class="field">
      <span class="scrub" onPointerDown={down} title="Drag to change">
        {p.label}
      </span>
      <input
        ref={input}
        type="number"
        step={p.step ?? 1}
        value={round(p.value)}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) p.onCommit(v);
        }}
      />
      <Show when={p.onKey}>
        <button class="key-btn" classList={{ keyed: p.keyed }} title="Set key at current time" onClick={p.onKey}>
          ◆
        </button>
      </Show>
    </label>
  );
}

export function TextField(p: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  return (
    <label class="field">
      <span>{p.label}</span>
      <input type="text" value={p.value} placeholder={p.placeholder} onChange={(e) => p.onCommit(e.currentTarget.value)} />
    </label>
  );
}

export function ColorField(p: { label: string; value: string; onCommit: (v: string) => void; onKey?: () => void; keyed?: boolean }) {
  const rgb = () => p.value.slice(0, 7);
  const alpha = () => (p.value.length >= 9 ? parseInt(p.value.slice(7, 9), 16) / 255 : 1);
  const hex2 = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return (
    <label class="field">
      <span>{p.label}</span>
      <input type="color" value={rgb()} onChange={(e) => p.onCommit(alpha() < 1 ? e.currentTarget.value + hex2(alpha()) : e.currentTarget.value)} />
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        class="alpha"
        title="Alpha"
        value={round(alpha())}
        onChange={(e) => {
          const a = Math.max(0, Math.min(1, Number(e.currentTarget.value)));
          p.onCommit(a >= 1 ? rgb() : rgb() + hex2(a));
        }}
      />
      <Show when={p.onKey}>
        <button class="key-btn" classList={{ keyed: p.keyed }} title="Set key at current time" onClick={p.onKey}>
          ◆
        </button>
      </Show>
    </label>
  );
}

export function SelectField<T extends string>(p: {
  label: string;
  value: T | "";
  options: { value: T | ""; label: string }[];
  onCommit: (v: T) => void;
}) {
  return (
    <label class="field">
      <span>{p.label}</span>
      <select value={p.value} onChange={(e) => p.onCommit(e.currentTarget.value as T)}>
        {p.options.map((o) => (
          <option value={o.value} selected={o.value === p.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Section(p: { title: string; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="section">
      <h3>
        <span>{p.title}</span>
        <span class="actions">{p.actions}</span>
      </h3>
      <div class="section-body">{p.children}</div>
    </section>
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
