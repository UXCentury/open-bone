import { type ExportOptions, type ExportResult, exportDocument, serialize, validate } from "@openbone/core";
import { Player } from "@openbone/player";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { imageAsDataUrl, resolveImageUrl } from "../images.ts";
import { saveTextFile } from "../storage.ts";
import { doc, fileName, setExportOpen, toast } from "../state.ts";

type Named = { id: string; name: string };

/** A checklist of named items with All / None shortcuts. */
function Picker(p: { title: string; items: Named[]; selected: Set<string>; onChange: (s: Set<string>) => void; hint?: string }) {
  const toggle = (id: string, on: boolean) => {
    const s = new Set(p.selected);
    on ? s.add(id) : s.delete(id);
    p.onChange(s);
  };
  return (
    <fieldset class="export-group">
      <legend>
        {p.title} <span class="muted">{p.selected.size}/{p.items.length}</span>
        <span class="spacer" />
        <button class="link" onClick={() => p.onChange(new Set(p.items.map((i) => i.id)))} disabled={p.selected.size === p.items.length}>
          All
        </button>
        <button class="link" onClick={() => p.onChange(new Set())} disabled={!p.selected.size}>
          None
        </button>
      </legend>
      <Show when={p.items.length} fallback={<div class="muted">None in this project.</div>}>
        <div class="export-list">
          <For each={p.items}>
            {(it) => (
              <label class="check">
                <input type="checkbox" checked={p.selected.has(it.id)} onChange={(e) => toggle(it.id, e.currentTarget.checked)} /> {it.name}
              </label>
            )}
          </For>
        </div>
      </Show>
      <Show when={p.hint}>
        <div class="muted small">{p.hint}</div>
      </Show>
    </fieldset>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

/**
 * Export: choose what goes into the file (animations, state machines, scripts, skins), preview exactly that
 * result live (interactive), then save it as a .obone file. The open project is not changed.
 */
export function ExportDialog() {
  const source = doc();
  const all = (list: Named[]) => new Set(list.map((x) => x.id));
  const [anims, setAnims] = createSignal(all(source.animations));
  const [sms, setSms] = createSignal(all(source.stateMachines));
  const [scripts, setScripts] = createSignal(all(source.scripts));
  const extraSkins = source.skeleton.skins.slice(1);
  const [skins, setSkins] = createSignal(all(extraSkins));
  const [prune, setPrune] = createSignal(true);
  const needsEmbed = source.images.some((i) => !i.src.startsWith("data:"));
  const [embed, setEmbed] = createSignal(needsEmbed);
  const [compact, setCompact] = createSignal(false);
  const [name, setName] = createSignal(fileName().replace(/\.obone$/i, "") + "-export");
  const [busy, setBusy] = createSignal(false);

  const options = (): ExportOptions => ({
    animations: [...anims()],
    stateMachines: [...sms()],
    scripts: [...scripts()],
    skins: [...skins()],
    pruneUnused: prune(),
  });
  const result = createMemo<ExportResult>(() => exportDocument(source, options()));
  const issues = createMemo(() => validate(result().doc).filter((i) => i.level === "error"));
  // File size before embedding images that are still external files.
  const size = createMemo(() => (compact() ? JSON.stringify(result().doc) : serialize(result().doc)).length);

  const presets = {
    everything: () => {
      setAnims(all(source.animations));
      setSms(all(source.stateMachines));
      setScripts(all(source.scripts));
      setSkins(all(extraSkins));
    },
    animations: () => {
      setAnims(all(source.animations));
      setSms(new Set<string>());
      setScripts(new Set<string>());
    },
    rig: () => {
      setAnims(new Set<string>());
      setSms(new Set<string>());
      setScripts(new Set<string>());
    },
  };

  // ---------- preview ----------
  type Target = { kind: "sm" | "anim"; name: string } | null;
  const targets = createMemo(() => [
    ...result().doc.stateMachines.map((s) => ({ kind: "sm" as const, name: s.name, label: `State machine · ${s.name}` })),
    ...result().doc.animations.map((a) => ({ kind: "anim" as const, name: a.name, label: `Animation · ${a.name}` })),
  ]);
  const [target, setTarget] = createSignal<Target>(null);
  const currentTarget = (): Target => {
    const t = target();
    const list = targets();
    return t && list.some((x) => x.kind === t.kind && x.name === t.name) ? t : (list[0] ?? null);
  };
  const [stage, setStage] = createSignal(0);
  const [status, setStatus] = createSignal("");
  let host!: HTMLDivElement;
  let player: Player | null = null;
  let timer = 0;

  const disposePlayer = () => {
    if (!player) return;
    const canvas = host.querySelector("canvas");
    player.dispose();
    player = null;
    (canvas?.getContext("webgl2") as WebGL2RenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas?.remove();
  };

  const rebuild = () => {
    disposePlayer();
    const d = structuredClone(result().doc);
    // Preview loads images from where the editor has them; the exported file keeps its own srcs.
    for (const img of d.images) img.src = resolveImageUrl(img);
    const t = currentTarget();
    // A fresh canvas per preview, so pointer listeners from earlier previews can't leak in.
    const canvas = document.createElement("canvas");
    canvas.className = "export-canvas";
    host.append(canvas);
    setStatus(t?.kind === "sm" ? "Interactive: hover and click the preview" : t ? "Looping animation" : "Setup pose (nothing animated is exported)");
    player = new Player({
      canvas,
      src: d,
      ...(t?.kind === "sm" ? { stateMachine: t.name } : t ? { animation: t.name } : {}),
      fit: "contain",
      onStateChange: (e) => setStatus(`State: ${e.to}`),
    });
    player.ready.catch((e) => setStatus(`Preview failed: ${(e as Error).message}`));
  };

  onMount(() => {
    rebuild();
    createEffect(
      on([result, currentTarget, stage], () => {
        clearTimeout(timer);
        timer = window.setTimeout(rebuild, 150);
      }, { defer: true }),
    );
  });
  onCleanup(() => {
    clearTimeout(timer);
    disposePlayer();
  });

  // ---------- export ----------
  const doExport = async () => {
    if (issues().length) return toast("Fix the problems listed before exporting", "error");
    setBusy(true);
    try {
      const d = structuredClone(result().doc);
      if (embed()) for (const img of d.images) img.src = await imageAsDataUrl(img);
      const text = compact() ? JSON.stringify(d) : serialize(d);
      const saved = await saveTextFile(`${name().trim() || "export"}.obone`, text);
      if (saved) {
        toast(`Exported ${saved} (${fmtBytes(text.length)})`);
        setExportOpen(false);
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const close = () => !busy() && setExportOpen(false);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));

  const s = () => result().stats;
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header class="modal-head">
          <h2 id="export-title">Export</h2>
          <span class="muted">Choose what goes into the file and check it in the preview. Your open project is not changed.</span>
          <span class="spacer" />
          <button class="icon-btn" title="Close (Esc)" onClick={close}>
            ✕
          </button>
        </header>
        <div class="export-body">
          <div class="export-options">
            <div class="btn-row">
              <span class="muted">Quick pick:</span>
              <button onClick={presets.everything}>Everything</button>
              <button onClick={presets.animations} title="Rig and animations, no state machines or scripts">
                Animations only
              </button>
              <button onClick={presets.rig} title="Rig and setup pose only">
                Rig only
              </button>
            </div>
            <div class="hint">The rig (bones, slots, attachments, constraints) is always included.</div>
            <Picker title="Animations" items={source.animations} selected={anims()} onChange={setAnims} />
            <Picker title="State machines" items={source.stateMachines} selected={sms()} onChange={setSms} />
            <Show when={source.scripts.length}>
              <Picker title="Scripts" items={source.scripts} selected={scripts()} onChange={setScripts} />
            </Show>
            <Show when={extraSkins.length}>
              <Picker title="Extra skins" items={extraSkins} selected={skins()} onChange={setSkins} hint="The default skin is always included." />
            </Show>
            <fieldset class="export-group">
              <legend>File</legend>
              <label class="field">
                <span>Name</span>
                <input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                <span class="muted">.obone</span>
              </label>
              <label class="check">
                <input type="checkbox" checked={embed()} onChange={(e) => setEmbed(e.currentTarget.checked)} /> Embed images in the file
                <span class="muted small">{needsEmbed ? "(recommended: one self-contained file)" : "(already embedded)"}</span>
              </label>
              <label class="check">
                <input type="checkbox" checked={prune()} onChange={(e) => setPrune(e.currentTarget.checked)} /> Leave out unused images and events
              </label>
              <label class="check">
                <input type="checkbox" checked={compact()} onChange={(e) => setCompact(e.currentTarget.checked)} /> Compact JSON (smaller, not human-readable)
              </label>
            </fieldset>
          </div>
          <div class="export-preview">
            <div class="field">
              <span>Preview</span>
              <select
                value={currentTarget() ? `${currentTarget()!.kind}:${currentTarget()!.name}` : ""}
                onChange={(e) => {
                  const [kind, ...rest] = e.currentTarget.value.split(":");
                  setTarget(kind ? { kind: kind as "sm" | "anim", name: rest.join(":") } : null);
                }}
              >
                <Show when={!targets().length}>
                  <option value="">Setup pose</option>
                </Show>
                <For each={targets()}>
                  {(t) => (
                    <option value={`${t.kind}:${t.name}`} selected={currentTarget()?.kind === t.kind && currentTarget()?.name === t.name}>
                      {t.label}
                    </option>
                  )}
                </For>
              </select>
              <button title="Restart the preview" onClick={() => setStage((n) => n + 1)}>
                ↺
              </button>
            </div>
            <div class="export-stage" ref={host} />
            <div class="muted small">{status()}</div>
            <div class="export-summary">
              <span>{plural(s().bones, "bone")}</span>
              <span>{plural(s().slots, "slot")}</span>
              <span>{plural(s().animations, "animation")}</span>
              <span>{plural(s().stateMachines, "state machine")}</span>
              <span>{plural(s().scripts, "script")}</span>
              <span>{plural(s().images, "image")}</span>
              <span>{plural(s().events, "event")}</span>
              <span>
                ≈ {fmtBytes(size())}
                {embed() && needsEmbed && result().doc.images.length ? " + embedded images" : ""}
              </span>
            </div>
            <Show when={issues().length}>
              <div class="export-issues error">
                <For each={issues()}>{(i) => <div>⛔ {i.path}: {i.message}</div>}</For>
              </div>
            </Show>
            <Show when={result().warnings.length}>
              <details class="export-issues" open={result().warnings.length <= 3}>
                <summary>
                  ⚠ {result().warnings.length} reference{result().warnings.length === 1 ? "" : "s"} to left-out items will be removed
                </summary>
                <For each={result().warnings}>{(w) => <div>{w}</div>}</For>
              </details>
            </Show>
          </div>
        </div>
        <footer class="modal-foot">
          <span class="spacer" />
          <button onClick={close} disabled={busy()}>
            Cancel
          </button>
          <button class="primary" onClick={doExport} disabled={busy() || issues().length > 0}>
            {busy() ? "Exporting…" : "Export .obone"}
          </button>
        </footer>
      </div>
    </div>
  );
}
