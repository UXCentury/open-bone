import { For, Show, createEffect, createSignal } from "solid-js";
import { apply, currentStateMachine, doc } from "../state.ts";
import { askConfirm, askText, uniqueName } from "../dialogs.tsx";

const TEMPLATE = `// Runs inside a sandbox (QuickJS). Global API: ob
// ob.input(name) · ob.setInput(name, v) · ob.fire(name) · ob.emit(event, {int, float, string})
// ob.bone(name) → {x, y, rotation, worldX, worldY, ...} · ob.setBone(name, {rotation, x, ...})
// ob.slot(name, {color, attachment}) · ob.pointer() → {x, y, down} · ob.time() · ob.log(...)

function onStart() {}

function onUpdate(dt) {
  // e.g. make a bone follow the pointer:
  // const p = ob.pointer(); ob.setBone("head", { rotation: p.x * 0.1 });
}

function onEvent(e) {
  // ob.log("event", e.name);
}

// Called by listener actions of type "run script"
function onAction() {}
`;

export function ScriptsPanel() {
  const [selId, setSelId] = createSignal<string | null>(null);
  const script = () => doc().scripts.find((s) => s.id === selId()) ?? doc().scripts[0] ?? null;
  const [draft, setDraft] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  createEffect(() => {
    const s = script();
    setDraft(s?.code ?? "");
    setDirty(false);
  });
  const attached = () => {
    const sm = currentStateMachine();
    const s = script();
    return !!sm && !!s && sm.scripts.includes(s.id);
  };
  const save = () => {
    const s = script();
    if (s) apply("updateScript", { script: s.id, code: draft() });
    setDirty(false);
  };
  return (
    <div class="scripts-panel">
      <div class="script-list">
        <div class="col-title">
          Scripts
          <button
            onClick={async () => {
              const name = await askText({
                title: "New script",
                value: `script${doc().scripts.length + 1}`,
                confirmLabel: "Create",
                validate: uniqueName(doc().scripts.map((x) => x.name)),
              });
              if (!name) return;
              const r = apply("addScript", { name, code: TEMPLATE }) as { id: string } | undefined;
              if (r) setSelId(r.id);
            }}
          >
            +
          </button>
        </div>
        <For each={doc().scripts} fallback={<div class="muted pad">Scripts add logic: follow the pointer, counters, procedural motion…</div>}>
          {(s) => (
            <div class="tree-row" classList={{ selected: script()?.id === s.id }} onClick={() => setSelId(s.id)}>
              <span class="icon">ƒ</span> {s.name}
              <button class="row-del" onClick={(e) => { e.stopPropagation(); void askConfirm({ title: `Delete script "${s.name}"?`, message: "States and listeners that run it stop running it. You can undo this.", confirmLabel: "Delete", danger: true }).then((ok) => ok && apply("deleteScript", { script: s.id })); }}>
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={script()} fallback={<div class="empty">Create a script with +</div>}>
        <div class="script-editor">
          <div class="sm-bar">
            <b>{script()!.name}.js</b>
            <Show when={currentStateMachine()}>
              <label class="check">
                <input
                  type="checkbox"
                  checked={attached()}
                  onChange={() => apply("attachScript", { stateMachine: currentStateMachine()!.id, script: script()!.id })}
                  disabled={attached()}
                />{" "}
                Runs in “{currentStateMachine()!.name}”
              </label>
            </Show>
            <span class="spacer" />
            <button class={dirty() ? "primary" : ""} disabled={!dirty()} onClick={save}>
              Save (Ctrl+S)
            </button>
          </div>
          <textarea
            spellcheck={false}
            value={draft()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                save();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const t = e.currentTarget;
                const s = t.selectionStart;
                t.setRangeText("  ", s, t.selectionEnd, "end");
                setDraft(t.value);
                setDirty(true);
              }
            }}
          />
        </div>
      </Show>
    </div>
  );
}
