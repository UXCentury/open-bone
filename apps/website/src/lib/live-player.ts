/**
 * Client side of <LivePlayer>. Until someone presses play, a player is only its poster image: nothing else loads.
 *
 * The play click creates and resumes an AudioContext right there (the user gesture browsers require for sound, which
 * Safari does not extend to later async work), hands it to the player, then loads the player script and the document.
 * The player starts with sound as soon as its first frame is drawn. Pressing an input control or the fullscreen button
 * also starts it. Started players pause off screen and resume when back.
 */

interface PlayerElement extends HTMLElement {
  setInput(name: string, value: boolean | number | string): void;
  fire(name: string): void;
  play(): void;
  pause(): void;
  audioContext: AudioContext | null;
  player: { setMuted(m: boolean): void } | null;
}

let script: Promise<void> | null = null;

/** The player script's URL, versioned by the build (data-player); the plain path as a fallback. */
function loadPlayerScript(src = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/player/openbone-player.js`): Promise<void> {
  if (customElements.get("openbone-player")) return Promise.resolve();
  script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the OpenBone player"));
    document.head.append(s);
  }).catch((e) => {
    script = null;
    throw e;
  });
  return script;
}

const has = (el: HTMLElement, flag: string) => el.dataset[flag] !== undefined;
const playerOf = (fig: HTMLElement) => fig.querySelector("openbone-player") as PlayerElement;

/** One AudioContext for the page, created and resumed inside the first play click. */
let audio: AudioContext | null = null;
function unlockAudio(): AudioContext | null {
  if (!audio) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor();
  }
  if (audio.state !== "running") void audio.resume().catch(() => {});
  return audio;
}

const started = new WeakMap<HTMLElement, Promise<void>>();

/** Load and start a player with sound. Call it from a click. Resolves once the player is running. */
function run(fig: HTMLElement): Promise<void> {
  const already = started.get(fig);
  if (already) return already;
  fig.dataset.playing = "";
  const el = playerOf(fig);
  // Created and resumed synchronously, while the click still counts. Handed to the element only once the script has
  // defined <openbone-player>: upgrading the element would reset a property set before that.
  const ctx = has(fig, "audio") ? unlockAudio() : null;
  const ready = new Promise<void>((resolve) => {
    el.addEventListener(
      "openbone-load",
      () => {
        fig.dataset.ready = "";
        resolve();
      },
      { once: true },
    );
  });
  const p = loadPlayerScript(fig.dataset.player || undefined)
    .then(() => customElements.whenDefined("openbone-player"))
    .then(() => {
      el.audioContext = ctx;
      el.setAttribute("src", fig.dataset.src ?? "");
    })
    .then(() => ready)
    .catch((e) => {
      console.error(e);
      delete fig.dataset.playing;
      started.delete(fig);
    });
  started.set(fig, p);
  return p;
}

const fullscreenElement = () => document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ?? null;

function toggleFullscreen(fig: HTMLElement) {
  if (fullscreenElement() === fig) {
    void (document.exitFullscreen?.() ?? (document as unknown as { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.());
    return;
  }
  const req = fig.requestFullscreen?.bind(fig) ?? (fig as unknown as { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen?.bind(fig);
  void req?.();
}

function wire(fig: HTMLElement) {
  const el = playerOf(fig);
  fig.querySelector<HTMLButtonElement>(".ob-live-play")?.addEventListener("click", () => void run(fig));

  // Controls start a player that is not running yet, then act once it has loaded.
  const thenAct = (fn: () => void) => () => void run(fig).then(fn);
  fig.querySelectorAll<HTMLButtonElement>("[data-fire]").forEach((b) => b.addEventListener("click", thenAct(() => el.fire(b.dataset.fire ?? ""))));
  fig.querySelectorAll<HTMLButtonElement>("[data-bool]").forEach((b) =>
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      void run(fig).then(() => el.setInput(b.dataset.bool ?? "", on));
    }),
  );
  fig.querySelectorAll<HTMLInputElement>("[data-number]").forEach((r) =>
    r.addEventListener("input", () => {
      const out = r.parentElement?.querySelector("output");
      if (out) out.textContent = Number(r.value).toFixed(2);
      void run(fig).then(() => el.setInput(r.dataset.number ?? "", Number(r.value)));
    }),
  );

  const sound = fig.querySelector<HTMLButtonElement>(".ob-live-sound");
  sound?.addEventListener("click", () => {
    const on = sound.getAttribute("aria-pressed") !== "true";
    sound.setAttribute("aria-pressed", String(on));
    sound.setAttribute("aria-label", on ? "Mute" : "Turn sound on");
    sound.title = on ? "Mute" : "Turn sound on";
    if (on) unlockAudio();
    el.player?.setMuted(!on);
  });

  const fs = fig.querySelector<HTMLButtonElement>(".ob-live-fs");
  const canFullscreen = document.fullscreenEnabled || (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled;
  if (fs && canFullscreen) {
    fs.hidden = false;
    fs.addEventListener("click", () => {
      void run(fig);
      toggleFullscreen(fig);
    });
  }
}

function syncFullscreenButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".ob-live-fs")) {
    const on = fullscreenElement() === b.closest("figure");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    b.title = on ? "Exit full screen" : "Full screen";
  }
}

let observer: IntersectionObserver | null = null;

export function mountLivePlayers() {
  const figs = [...document.querySelectorAll<HTMLElement>("figure.ob-live:not([data-mounted])")];
  if (!figs.length) return;
  // Only started players are touched: pause off screen, resume when back.
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const fig = e.target as HTMLElement;
        if (!has(fig, "ready")) continue;
        if (e.isIntersecting) playerOf(fig).play();
        else if (fullscreenElement() !== fig) playerOf(fig).pause();
      }
    },
    { rootMargin: "200px 0px" },
  );
  for (const fig of figs) {
    fig.dataset.mounted = "";
    wire(fig);
    observer.observe(fig);
  }
  document.addEventListener("fullscreenchange", syncFullscreenButtons);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButtons);
}
