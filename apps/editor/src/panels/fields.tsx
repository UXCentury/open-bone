import { type JSX, Show, createSignal } from "solid-js";

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
        max={100}
        step={5}
        class="alpha"
        title="Opacity (%)"
        aria-label={`${p.label} opacity (percent)`}
        value={Math.round(alpha() * 100)}
        onChange={(e) => {
          const a = Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)) / 100;
          p.onCommit(a >= 1 ? rgb() : rgb() + hex2(a));
        }}
      />
      <span class="unit">%</span>
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
  onKey?: () => void;
  keyed?: boolean;
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
      <Show when={p.onKey}>
        <button class="key-btn" classList={{ keyed: p.keyed }} title="Set key at current time (stepped)" onClick={(e) => (e.preventDefault(), p.onKey!())}>
          ◆
        </button>
      </Show>
    </label>
  );
}

// Collapsed sections, remembered per browser. Keyed by `id` or the title (text before " · ").
const COLLAPSE_KEY = "openbone.collapsed.v1";
const [collapsed, setCollapsed] = createSignal<Set<string>>(
  (() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  })(),
);
function toggleCollapsed(key: string) {
  const next = new Set(collapsed());
  next.has(key) ? next.delete(key) : next.add(key);
  setCollapsed(next);
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
  } catch {
    /* storage unavailable: still works for this session */
  }
}

/** Panel section with a header that collapses it (click the title; state is remembered). */
export function Section(p: { title: string; id?: string; children: JSX.Element; actions?: JSX.Element }) {
  const key = () => p.id ?? p.title.split(" · ")[0];
  const open = () => !collapsed().has(key());
  const bodyId = `sec-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <section class="section" classList={{ collapsed: !open() }}>
      <h3>
        <button class="section-toggle" aria-expanded={open()} aria-controls={bodyId} title={open() ? "Collapse" : "Expand"} onClick={() => toggleCollapsed(key())}>
          <span class="chevron" aria-hidden="true">
            ▾
          </span>
          <span>{p.title}</span>
        </button>
        <span class="actions">{p.actions}</span>
      </h3>
      <Show when={open()}>
        <div class="section-body" id={bodyId}>
          {p.children}
        </div>
      </Show>
    </section>
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
