import { type OpenBoneDocument, serialize } from "@openbone/core";
import { confirmDiscard } from "../destructive.ts";
import { bundleExample, exampleUrl, fetchExample } from "../examples.ts";
import { savedToast, saveTextFile } from "../storage.ts";
import { toast } from "../state.ts";
import { OpenBoneInstance } from "@openbone/runtime";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { setExamplesOpen } from "../editor-menus.ts";
import { openExample } from "../state.ts";
import { renderInstance } from "./Preview.tsx";

const EXAMPLES: { id: string; title: string; text: string; tags: string[] }[] = [
  { id: "knight", title: "Knight", text: "Side-view knight with sword and shield: walk on a scrolling castle road (click it), attack (click him), salute (click the helmet).", tags: ["IK legs", "Parallax", "Audio"] },
  { id: "walker", title: "Walker", text: "An adventurer walking through a forest with parallax scrolling and a proper jump: crouch, take-off, tuck, land.", tags: ["IK", "Blend", "Script"] },
  { id: "fox", title: "Pip the fox", text: "Click the head: a real recorded voice with mouth shapes keyed by lip sync.", tags: ["Lip sync", "Audio", "State machine"] },
  { id: "robot", title: "Robot", text: "A painted robot with a screen face, lip-synced to a robot voice.", tags: ["Lip sync", "Audio"] },
  { id: "tail", title: "Tail", text: "A creature whose painted tail bends along a path; click it to hop. A slow camera pan moves the meadow, the creature and the grass at different depths.", tags: ["Path", "Mesh", "Physics", "Parallax"] },
  { id: "rocket", title: "Rocket", text: "A rocket on its launch pad: click to launch. It flies out of frame as the space centre falls away, then lands back on the pad.", tags: ["Particles", "Parallax", "Audio"] },
  { id: "crash", title: "Crash game", text: "Stages, live text and input bindings: a betting game where the rocket climbs through layered clouds.", tags: ["Stages", "Bindings", "Text"] },
  { id: "button", title: "Interactive button", text: "Hover and press states driven by pointer listeners, with click sounds.", tags: ["State machine", "Audio"] },
  { id: "campfire", title: "Campfire", text: "Flames burning on painted logs, firelight flicker, a bending flame mesh and a crackle loop.", tags: ["Sequences", "Mesh"] },
];

/** Images of the gallery's documents, loaded from the examples source (kept apart from the editor's image cache). */
const images = new Map<string, HTMLImageElement>();
function exampleImage(src: string): HTMLImageElement | null {
  const url = exampleUrl(src);
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/** A live, looping thumbnail of an example: its state machine when it has one, else its first animation. */
function Thumb(p: { id: string }) {
  let canvas!: HTMLCanvasElement;
  const [failed, setFailed] = createSignal(false);
  onMount(() => {
    let doc: OpenBoneDocument | null = null;
    let inst: OpenBoneInstance | null = null;
    let raf = 0;
    let last = performance.now();
    let alive = true;
    fetchExample(p.id)
      .then((d) => {
        if (!alive) return;
        doc = d;
        inst = new OpenBoneInstance(doc);
        const sm = doc.stateMachines[0];
        const idle = doc.animations.find((a) => /idle/i.test(a.name)) ?? doc.animations[0];
        if (sm) inst.useStateMachine(sm.name);
        else if (idle) inst.animationState.setAnimation(0, idle.name, true, 0);
        inst.advance(0);
      })
      .catch(() => setFailed(true));
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!inst || !doc) return;
      inst.advance(dt);
      renderInstance(canvas, doc, (r, v) => r.render(inst!.skeleton, { view: v, clear: false, bones: false }), (a) => exampleImage(a.src));
    };
    raf = requestAnimationFrame(frame);
    onCleanup(() => {
      alive = false;
      cancelAnimationFrame(raf);
    });
  });
  return (
    <div class="example-thumb">
      <canvas ref={canvas} />
      <Show when={failed()}>
        <span class="muted small">Preview unavailable</span>
      </Show>
    </div>
  );
}

/** Examples gallery: pick a sample project to open. */
export function ExamplesDialog() {
  let box!: HTMLDivElement;
  const close = () => setExamplesOpen(false);
  const pick = async (id: string) => {
    if (!(await confirmDiscard(`Opening the “${id}” example`))) return;
    close();
    void openExample(id);
  };
  const [busy, setBusy] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal("");
  // Download: fetch the example and all its art and sound, store them inside one file, save it.
  const download = async (id: string, title: string) => {
    setBusy(id);
    setProgress("");
    try {
      const doc = await bundleExample(id, (done, total) => setProgress(`${done}/${total}`));
      const saved = await saveTextFile(`${id}.obone`, serialize(doc));
      if (saved) savedToast(`Downloaded ${title} (${saved}): open it with ☰ Menu → Open…`, saved);
    } catch (e) {
      toast(`Couldn't download ${title}: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };
  onMount(() => {
    box.querySelector<HTMLButtonElement>(".example-open-area")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} class="modal examples-dialog" role="dialog" aria-modal="true" aria-labelledby="examples-title">
        <header class="modal-head">
          <h2 id="examples-title">Examples</h2>
          <span class="muted small">Open a sample project. Your current project is replaced, so save it first.</span>
          <button class="icon-btn close" title="Close (Esc)" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        <div class="examples-grid">
          <For each={EXAMPLES}>
            {(ex) => (
              <div class="example-card" role="group" aria-label={ex.title}>
                <button class="example-open-area" onClick={() => pick(ex.id)} title={`Open ${ex.title}`}>
                  <Thumb id={ex.id} />
                  <div class="example-info">
                    <strong>{ex.title}</strong>
                    <span class="example-text">{ex.text}</span>
                    <span class="example-tags">
                      <For each={ex.tags}>{(t) => <span class="tag">{t}</span>}</For>
                    </span>
                  </div>
                </button>
                <div class="example-actions">
                  <button class="primary" onClick={() => pick(ex.id)} title="Load it into the editor (replaces the current project)">
                    Open
                  </button>
                  <button
                    disabled={busy() === ex.id}
                    title="Download it as one .obone file with every image and sound inside (opens anywhere, offline)"
                    onClick={() => void download(ex.id, ex.title)}
                  >
                    {busy() === ex.id ? `Downloading… ${progress()}` : "⬇ Download"}
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
