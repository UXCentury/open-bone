import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";

/**
 * In-app replacements for window.confirm / prompt: styled modals with real buttons, keyboard support
 * (Enter confirms, Esc cancels, Tab stays inside) and inline validation. All calls return promises.
 */

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export type Field =
  | { key: string; label: string; type: "text"; value?: string; placeholder?: string; required?: boolean; validate?: (v: string) => string | null }
  /** `compact`: a drop-down instead of a row of buttons, for long lists (images, presets). */
  | { key: string; label: string; type: "choice"; value?: string; options: ChoiceOption[]; compact?: boolean };

interface FormRequest {
  title: string;
  message?: string;
  fields: Field[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (v: Record<string, string> | null) => void;
}

const [current, setCurrent] = createSignal<FormRequest | null>(null);
const queue: FormRequest[] = [];

function open(req: Omit<FormRequest, "resolve">): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const r = { ...req, resolve };
    if (current()) queue.push(r);
    else setCurrent(r);
  });
}

function finish(value: Record<string, string> | null) {
  const r = current();
  setCurrent(queue.shift() ?? null);
  r?.resolve(value);
}

/** A form with text and choice fields. Resolves to the values, or null when cancelled. */
export const askForm = (o: Omit<FormRequest, "resolve">) => open(o);

/** Yes/no question. `danger` styles the confirm button for destructive actions. */
export async function askConfirm(o: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return (await open({ ...o, fields: [] })) !== null;
}

/**
 * Confirm a destructive action, then run it. `what` names the thing ("bone “arm”"); `detail` says what else goes
 * with it. Resolves to whether it ran. Everything is undoable, and the dialog says so.
 */
export async function confirmDelete(what: string, detail: string | null, run: () => unknown, verb = "Delete"): Promise<boolean> {
  const ok = await askConfirm({
    title: `${verb} ${what}?`,
    message: `${detail ? `${detail} ` : ""}You can undo this (${undoKeys()}).`,
    confirmLabel: verb,
    danger: true,
  });
  if (ok) run();
  return ok;
}

/** "Ctrl+Z" / "⌘Z", without importing the shortcut registry into this module's load order. */
const undoKeys = () => (/mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? "") ? "⌘Z" : "Ctrl+Z");

/** Plural helper for confirmation messages: "3 slots", "1 slot". */
export const count = (n: number, word: string, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

/** Ask for one line of text (trimmed, required by default). Resolves to null when cancelled. */
export async function askText(o: {
  title: string;
  label?: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  const r = await open({
    title: o.title,
    message: o.message,
    confirmLabel: o.confirmLabel ?? "OK",
    fields: [{ key: "v", type: "text", label: o.label ?? "Name", value: o.value, placeholder: o.placeholder, required: true, validate: o.validate }],
  });
  return r ? r.v : null;
}

/** Validator: reject names already used by another item (case-insensitive), allowing the item's own name. */
export const uniqueName =
  (existing: string[], self?: string) =>
  (v: string): string | null =>
    existing.some((n) => n.toLowerCase() === v.toLowerCase() && n !== self) ? `"${v}" is already used` : null;

/** Renders the active dialog. Mount once at the app root. */
export function DialogHost() {
  return (
    <Show when={current()} keyed>
      {(req) => <Dialog req={req} />}
    </Show>
  );
}

function Dialog(p: { req: FormRequest }) {
  const initial: Record<string, string> = {};
  for (const f of p.req.fields) initial[f.key] = f.value ?? (f.type === "choice" ? (f.options[0]?.value ?? "") : "");
  const [values, setValues] = createSignal(initial);
  const [touched, setTouched] = createSignal(false);
  let box!: HTMLDivElement;
  const previousFocus = document.activeElement as HTMLElement | null;

  const errorFor = (f: Field): string | null => {
    if (f.type !== "text") return null;
    const v = (values()[f.key] ?? "").trim();
    if (f.required !== false && !v) return `${f.label} is required`;
    return f.validate?.(v) ?? null;
  };
  const errors = () => p.req.fields.map(errorFor);
  const valid = () => errors().every((e) => !e);

  const submit = () => {
    setTouched(true);
    if (!valid()) {
      box.querySelector<HTMLInputElement>("input[aria-invalid='true']")?.focus();
      return;
    }
    const out: Record<string, string> = {};
    for (const f of p.req.fields) out[f.key] = f.type === "text" ? (values()[f.key] ?? "").trim() : values()[f.key];
    finish(out);
  };
  const cancel = () => finish(null);

  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && !e.isComposing && !(e.target instanceof HTMLButtonElement && !e.target.classList.contains("dialog-choice"))) {
      // Enter submits from text fields and choices; Cancel/OK buttons keep their own Enter behaviour.
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const items = [...box.querySelectorAll<HTMLElement>("input, button, select, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  onMount(() => {
    window.addEventListener("keydown", key, true);
    const input = box.querySelector<HTMLInputElement>("input[type='text']");
    if (input) {
      input.focus();
      input.select();
    } else box.querySelector<HTMLButtonElement>(p.req.danger ? ".dialog-cancel" : ".dialog-confirm")?.focus();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", key, true);
    previousFocus?.focus?.();
  });

  const set = (k: string, v: string) => setValues({ ...values(), [k]: v });
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div class="modal-backdrop dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={box}
        class="modal dialog"
        classList={{ danger: !!p.req.danger }}
        role={p.req.danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={p.req.message ? `${id}-msg` : undefined}
      >
        <div class="dialog-body">
          <Show when={p.req.danger}>
            <div class="dialog-icon" aria-hidden="true">
              !
            </div>
          </Show>
          <div class="dialog-main">
            <h2 id={`${id}-title`}>{p.req.title}</h2>
            <Show when={p.req.message}>
              <p id={`${id}-msg`} class="dialog-msg">
                {p.req.message}
              </p>
            </Show>
            <For each={p.req.fields}>
              {(f, i) => (
                <Switch>
                  <Match when={f.type === "text" && f}>
                    {(tf) => (
                      <label class="dialog-field">
                        <span>{tf().label}</span>
                        <input
                          type="text"
                          value={values()[tf().key] ?? ""}
                          placeholder={tf().placeholder}
                          aria-invalid={touched() && !!errors()[i()]}
                          spellcheck={false}
                          autocomplete="off"
                          onInput={(e) => set(tf().key, e.currentTarget.value)}
                        />
                        <Show when={touched() && errors()[i()]}>
                          <span class="dialog-error" role="alert">
                            {errors()[i()]}
                          </span>
                        </Show>
                      </label>
                    )}
                  </Match>
                  <Match when={f.type === "choice" && f.compact && f}>
                    {(cf) => (
                      <label class="dialog-field">
                        <span>{cf().label}</span>
                        <select class="dialog-select" value={values()[cf().key]} onChange={(e) => set(cf().key, e.currentTarget.value)}>
                          <For each={cf().options}>{(o) => <option value={o.value} selected={values()[cf().key] === o.value}>{o.label}</option>}</For>
                        </select>
                      </label>
                    )}
                  </Match>
                  <Match when={f.type === "choice" && f}>
                    {(cf) => (
                      <div class="dialog-field" role="radiogroup" aria-label={cf().label}>
                        <span>{cf().label}</span>
                        <div class="dialog-choices">
                          <For each={cf().options}>
                            {(o) => (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={values()[cf().key] === o.value}
                                class="dialog-choice"
                                classList={{ active: values()[cf().key] === o.value }}
                                onClick={() => set(cf().key, o.value)}
                              >
                                <b>{o.label}</b>
                                <Show when={o.description}>
                                  <small>{o.description}</small>
                                </Show>
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </div>
        <footer class="modal-foot">
          <span class="spacer" />
          <button class="dialog-cancel" onClick={cancel}>
            {p.req.cancelLabel ?? "Cancel"}
          </button>
          <button class="dialog-confirm" classList={{ primary: !p.req.danger, "danger-btn": !!p.req.danger }} onClick={submit}>
            {p.req.confirmLabel ?? "OK"}
          </button>
        </footer>
      </div>
    </div>
  );
}
