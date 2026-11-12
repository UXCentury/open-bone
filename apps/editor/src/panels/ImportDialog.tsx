import { type ImportReport, type OpenBoneDocument, importConflicts, parseDocument } from "@openbone/core";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { isDesktop } from "../storage.ts";
import { apply, doc, toast } from "../state.ts";

/**
 * ☰ Menu → Import from project… (like Spine's "Import data"): open another .obone/.obonb, pick animations and skins
 * (or the whole skeleton) and copy them in as one undo step with the `importData` op.
 */

interface Source {
  doc: OpenBoneDocument;
  file: string;
  /** Images whose pixels could not be read (relative paths on the web): they import with their path as is. */
  unreadable: string[];
}
const [source, setSource] = createSignal<Source | null>(null);
export const importOpen = () => !!source();

const bytesToDataUrl = (bytes: Uint8Array, mime: string) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
const mimeOf = (path: string) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" })[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
const isRelative = (src: string) => !!src && !/^(data:|https?:|blob:)/.test(src);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`Could not load ${src.slice(0, 40)}`));
    img.src = src;
  });
}

/**
 * Make the source's images and sounds self-contained before importing them: files next to the source project are
 * read in (desktop), and images that only live in its texture atlas are cut out of their page.
 */
async function embedAssets(d: OpenBoneDocument, dir: string | null): Promise<string[]> {
  const unreadable: string[] = [];
  const read = async (src: string): Promise<string | null> => {
    if (!dir || !isDesktop()) return null;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      return await bytesToDataUrl(await readFile(`${dir}/${src}`), mimeOf(src));
    } catch {
      return null;
    }
  };
  for (const p of d.atlas?.pages ?? []) if (isRelative(p.src)) p.src = (await read(p.src)) ?? p.src;
  for (const img of d.images) {
    if (isRelative(img.src)) {
      const data = await read(img.src);
      if (data) img.src = data;
      else unreadable.push(img.name);
    }
    if (img.src) continue;
    const r = d.atlas?.regions.find((x) => x.image === img.id);
    const page = r && d.atlas!.pages.find((p) => p.id === r.page);
    if (!r || !page || isRelative(page.src)) {
      unreadable.push(img.name);
      continue;
    }
    try {
      const pageImg = await loadImage(page.src);
      const scale = d.atlas!.scale ?? 1;
      const c = document.createElement("canvas");
      c.width = Math.round(r.originalWidth * scale);
      c.height = Math.round(r.originalHeight * scale);
      const g = c.getContext("2d")!;
      g.translate(r.offsetX * scale, r.offsetY * scale);
      if (r.rotated) {
        // Stored turned 90° clockwise: turn it back.
        g.translate(0, r.height);
        g.rotate(-Math.PI / 2);
        g.drawImage(pageImg, r.x, r.y, r.height, r.width, 0, 0, r.height, r.width);
      } else g.drawImage(pageImg, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      img.src = c.toDataURL("image/png");
    } catch {
      unreadable.push(img.name);
    }
  }
  for (const a of d.audio?.assets ?? []) if (isRelative(a.src)) a.src = (await read(a.src)) ?? a.src;
  for (const f of d.fonts ?? []) if (isRelative(f.src)) f.src = (await read(f.src)) ?? f.src;
  return unreadable;
}

async function openSource(bytes: Uint8Array, file: string, dir: string | null) {
  try {
    const d = parseDocument(bytes);
    const unreadable = await embedAssets(d, dir);
    setSource({ doc: d, file, unreadable });
  } catch (e) {
    toast(`Could not open ${file}: ${(e as Error).message}`, "error");
  }
}

/** Ask for a project file to import from. */
export async function importFromProject() {
  if (isDesktop()) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({ multiple: false, filters: [{ name: "OpenBone", extensions: ["obone", "obonb", "json"] }] });
      if (typeof path !== "string") return;
      return void openSource(await readFile(path), path.split(/[\\/]/).pop()!, path.replace(/[\\/][^\\/]*$/, ""));
    } catch (e) {
      return toast((e as Error).message, "error");
    }
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".obone,.obonb,.json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) await openSource(new Uint8Array(await f.arrayBuffer()), f.name, null);
  };
  input.click();
}

/** Test hook: open the dialog on a document directly. */
export const openImportDialogWith = (d: OpenBoneDocument, file = "project.obone") => setSource({ doc: d, file, unreadable: [] });

export function ImportDialog() {
  const src = () => source()!;
  const info = createMemo(() => importConflicts(doc(), src().doc));
  const [anims, setAnims] = createSignal<string[]>([]);
  const [skins, setSkins] = createSignal<string[]>([]);
  const [skeleton, setSkeleton] = createSignal(false);
  const [onConflict, setOnConflict] = createSignal<"rename" | "replace" | "skip">("rename");
  const [report, setReport] = createSignal<ImportReport | null>(null);
  const toggle = (list: () => string[], set: (v: string[]) => void, id: string) => set(list().includes(id) ? list().filter((x) => x !== id) : [...list(), id]);
  const close = () => setSource(null);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));

  // Images this project already has (same name) are reused, so only the others matter.
  const unreadable = () => src().unreadable.filter((n) => !doc().images.some((i) => i.name === n));
  const conflicts = () => info().animations.filter((a) => a.conflict && anims().includes(a.id)).length + info().skins.filter((s) => s.conflict && skins().includes(s.id)).length;
  const nothing = () => !skeleton() && !anims().length && !skins().length;
  const run = () => {
    const r = apply("importData", { document: src().doc, animations: anims(), skins: skeleton() ? [] : skins(), skeleton: skeleton(), onConflict: onConflict() }) as ImportReport | undefined;
    if (!r) return;
    setReport(r);
    const parts = [
      r.animations.length && `${r.animations.length} animation${r.animations.length === 1 ? "" : "s"}`,
      r.skins.length && `${r.skins.length} skin${r.skins.length === 1 ? "" : "s"}`,
      r.bones && `${r.bones} bones`,
    ].filter(Boolean);
    toast(`Imported ${parts.join(", ") || "nothing"} from ${src().file}${r.skipped.length ? ` · ${r.skipped.length} note${r.skipped.length === 1 ? "" : "s"}` : ""}`);
  };

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div class="modal-head">
          <h2 id="import-title">Import from “{src().file}”</h2>
          <span class="muted small">{src().doc.name}</span>
        </div>
        <Show
          when={!report()}
          fallback={
            <div class="import-body">
              <h3>Imported</h3>
              <ul class="import-report">
                <For each={report()!.animations}>{(a) => <li>▶ {a.from}{a.name !== a.from ? ` → ${a.name}` : ""}{a.replaced ? " (replaced)" : ""}</li>}</For>
                <For each={report()!.skins}>{(k) => <li>● {k.from}{k.name !== k.from ? ` → ${k.name}` : ""} · {k.attachments} attachments</li>}</For>
                <Show when={report()!.bones}>
                  <li>🦴 {report()!.bones} bones, {report()!.slots} slots, {report()!.constraints} constraints</li>
                </Show>
                <Show when={report()!.images.length + report()!.sounds.length + report()!.events.length}>
                  <li class="muted">
                    Also added: {[...report()!.images.map((x) => `🖼 ${x}`), ...report()!.sounds.map((x) => `♪ ${x}`), ...report()!.events.map((x) => `⚡ ${x}`)].join(", ")}
                  </li>
                </Show>
              </ul>
              <Show when={report()!.skipped.length}>
                <h3>Notes</h3>
                <ul class="import-report warn">
                  <For each={report()!.skipped}>{(s) => <li>{s}</li>}</For>
                </ul>
              </Show>
              <p class="muted small">One undo step takes it all back.</p>
            </div>
          }
        >
          <div class="import-body">
            <label class="check import-skeleton" title="Bring in every bone, slot, constraint and attachment under a new root bone">
              <input type="checkbox" checked={skeleton()} onChange={(e) => setSkeleton(e.currentTarget.checked)} /> Whole skeleton
              <span class="muted small"> · {src().doc.skeleton.bones.length} bones, {src().doc.skeleton.slots.length} slots, all skins, under a new root bone “{src().doc.name || "imported"}”</span>
            </label>
            <div class="import-cols">
              <section>
                <h3>
                  Animations
                  <button class="small-btn" onClick={() => setAnims(anims().length === info().animations.length ? [] : info().animations.map((a) => a.id))}>
                    {anims().length === info().animations.length && anims().length ? "None" : "All"}
                  </button>
                </h3>
                <For each={info().animations} fallback={<div class="muted small">No animations</div>}>
                  {(a) => (
                    <label class="check import-item">
                      <input type="checkbox" checked={anims().includes(a.id)} onChange={() => toggle(anims, setAnims, a.id)} />
                      <span>{a.folder ? <span class="muted">{a.folder}/</span> : null}{a.name}</span>
                      <Show when={a.conflict}>
                        <span class="skin-badge conflict" title="An animation with this name already exists here">exists</span>
                      </Show>
                    </label>
                  )}
                </For>
              </section>
              <section classList={{ disabled: skeleton() }}>
                <h3>Skins</h3>
                <For each={info().skins}>
                  {(k) => (
                    <label class="check import-item" title={k.isDefault ? "Merges into this project's default skin" : undefined}>
                      <input type="checkbox" disabled={skeleton()} checked={skeleton() || skins().includes(k.id)} onChange={() => toggle(skins, setSkins, k.id)} />
                      <span>{k.folder ? <span class="muted">{k.folder}/</span> : null}{k.name}</span>
                      <Show when={k.isDefault}>
                        <span class="skin-badge">merges</span>
                      </Show>
                      <Show when={k.conflict}>
                        <span class="skin-badge conflict" title="A skin with this name already exists here">exists</span>
                      </Show>
                    </label>
                  )}
                </For>
              </section>
            </div>
            <Show when={!skeleton() && (info().missingBones.length || info().missingSlots.length)}>
              <div class="hint warn">
                Matched by name: {info().missingBones.length ? `${info().missingBones.length} bone${info().missingBones.length === 1 ? "" : "s"} (${info().missingBones.slice(0, 4).join(", ")}${info().missingBones.length > 4 ? "…" : ""})` : ""}
                {info().missingBones.length && info().missingSlots.length ? " and " : ""}
                {info().missingSlots.length ? `${info().missingSlots.length} slot${info().missingSlots.length === 1 ? "" : "s"} (${info().missingSlots.slice(0, 4).join(", ")}${info().missingSlots.length > 4 ? "…" : ""})` : ""} aren't in this project, so their keys and attachments are skipped. Tick “Whole skeleton” to bring them in.
              </div>
            </Show>
            <Show when={unreadable().length}>
              <div class="hint warn">
                {unreadable().length} image{unreadable().length === 1 ? "" : "s"} could not be read ({unreadable().slice(0, 3).join(", ")}): they keep their file path, so copy those files next to this project.
              </div>
            </Show>
            <div class="field">
              <span>Same name</span>
              <div class="segmented group">
                <button classList={{ active: onConflict() === "rename" }} onClick={() => setOnConflict("rename")} title="Import with a new name (walk2)">Rename</button>
                <button classList={{ active: onConflict() === "replace" }} onClick={() => setOnConflict("replace")} title="Replace the existing one (animations keep their id, so state machines still play them)">Replace</button>
                <button classList={{ active: onConflict() === "skip" }} onClick={() => setOnConflict("skip")} title="Keep the existing one and don't import">Skip</button>
              </div>
              <Show when={conflicts()}>
                <span class="muted small">{conflicts()} name{conflicts() === 1 ? "" : "s"} already used</span>
              </Show>
            </div>
          </div>
        </Show>
        <div class="modal-foot">
          <span class="muted small">Bones, slots, constraints and events are matched by name; images and sounds come along.</span>
          <span style={{ flex: 1 }} />
          <Show when={!report()} fallback={<button class="primary" onClick={close}>Done</button>}>
            <button onClick={close}>Cancel</button>
            <button class="primary" disabled={nothing()} onClick={run}>
              Import
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
