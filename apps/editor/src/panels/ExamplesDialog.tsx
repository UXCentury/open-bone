import { type OpenBoneDocument, deserialize } from "@openbone/core";
import { OpenBoneInstance } from "@openbone/runtime";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { setExamplesOpen } from "../editor-menus.ts";
import { openExample } from "../state.ts";
import { renderInstance } from "./Preview.tsx";

const EXAMPLES: { id: string; title: string; text: string; tags: string[] }[] = [
  { id: "knight", title: "Knight", text: "Painted parts on a full skeleton, a cape mesh that bends, idle, wave and march.", tags: ["Meshes", "Painted art"] },
  { id: "fox", title: "Pip the fox", text: "Click the head: a real recorded voice with mouth shapes keyed by lip sync.", tags: ["Lip sync", "Audio", "State machine"] },
  { id: "robot", title: "Robot", text: "Lip sync from a synthesised voice, mouth shapes swapped per frame.", tags: ["Lip sync", "Audio"] },
  { id: "walker", title: "Walker", text: "A walk cycle with IK legs, a mesh body, blended animations and a script.", tags: ["IK", "Mesh", "Script"] },
  { id: "button", title: "Interactive button", text: "Hover and press states driven by pointer listeners, with click sounds.", tags: ["State machine", "Audio"] },
  { id: "crash", title: "Crash game", text: "Stages, live text and input bindings: a betting game from bet to cash out.", tags: ["Stages", "Bindings", "Text"] },
  { id: "campfire", title: "Campfire", text: "Flames and smoke from sprite sequences, looping at their own speeds.", tags: ["Sequences"] },
  { id: "tail", title: "Tail", text: "A tail that follows a path and swings with physics.", tags: ["Path", "Physics"] },
  { id: "rocket", title: "Rocket", text: "Exhaust and sparks from particle emitters.", tags: ["Particles"] },
];

/** Images of the gallery's documents, loaded from /examples/ (kept apart from the editor's own image cache). */
const images = new Map<string, HTMLImageElement>();
function exampleImage(src: string): HTMLImageElement | null {
  const url = /^(data:|https?:|blob:|\/)/.test(src) ? src : `/examples/${src}`;
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
    fetch(`/examples/${p.id}.obone`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (!alive) return;
        doc = deserialize(text);
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
  const pick = (id: string) => {
    close();
    void openExample(id);
  };
  onMount(() => {
    box.querySelector<HTMLButtonElement>(".example-card")?.focus();
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
              <button class="example-card" onClick={() => pick(ex.id)} title={`Open ${ex.title}`}>
                <Thumb id={ex.id} />
                <div class="example-info">
                  <strong>{ex.title}</strong>
                  <span class="example-text">{ex.text}</span>
                  <span class="example-tags">
                    <For each={ex.tags}>{(t) => <span class="tag">{t}</span>}</For>
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
