/**
 * Client side of <LivePlayer>: loads the web player script once, loads each player (first frame, paused) when it
 * scrolls into view, and starts it from the big play button. That click is the user gesture browsers require for
 * sound, so the player starts with its audio on. Started players pause off screen and resume when back; the input
 * controls and the speaker button work once it runs (pressing a control also starts it).
 */

interface PlayerElement extends HTMLElement {
  setInput(name: string, value: boolean | number | string): void;
  fire(name: string): void;
  play(): void;
  pause(): void;
  player: { setMuted(m: boolean): void; audio: { activate(): AudioContext | null } | null } | null;
}

let loading: Promise<void> | null = null;

function loadPlayerScript(): Promise<void> {
  if (customElements.get("openbone-player")) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/player/openbone-player.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the OpenBone player"));
    document.head.append(s);
  });
  return loading;
}

const has = (el: HTMLElement, flag: string) => el.dataset[flag] !== undefined;

/** Start playing with sound. Must run inside a click: it creates and resumes the audio context first. */
async function run(fig: HTMLElement) {
  const el = fig.querySelector("openbone-player") as PlayerElement;
  if (has(fig, "playing")) return;
  fig.dataset.playing = "";
  const ctx = el.player?.audio?.activate();
  if (ctx && ctx.state !== "running") await ctx.resume().catch(() => {});
  el.player?.setMuted(false);
  el.play();
}

/** Load the player (first frame, paused) and wire its buttons. Once per player. */
function load(fig: HTMLElement) {
  if (has(fig, "started")) return;
  fig.dataset.started = "";
  const el = fig.querySelector("openbone-player") as PlayerElement;
  el.addEventListener("openbone-load", () => {
    fig.dataset.ready = "";
  });
  void loadPlayerScript().then(() => el.setAttribute("src", fig.dataset.src ?? ""));

  fig.querySelector<HTMLButtonElement>(".ob-live-play")?.addEventListener("click", () => void run(fig));

  // Controls also start a player that is not running yet, then act.
  const withRun = (fn: () => void) => async () => {
    if (!has(fig, "playing")) await run(fig);
    fn();
  };
  fig.querySelectorAll<HTMLButtonElement>("[data-fire]").forEach((b) => b.addEventListener("click", withRun(() => el.fire(b.dataset.fire ?? ""))));
  fig.querySelectorAll<HTMLButtonElement>("[data-bool]").forEach((b) =>
    b.addEventListener(
      "click",
      withRun(() => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        el.setInput(b.dataset.bool ?? "", on);
      }),
    ),
  );
  fig.querySelectorAll<HTMLInputElement>("[data-number]").forEach((r) =>
    r.addEventListener("input", () => {
      el.setInput(r.dataset.number ?? "", Number(r.value));
      const out = r.parentElement?.querySelector("output");
      if (out) out.textContent = Number(r.value).toFixed(2);
    }),
  );
  const sound = fig.querySelector<HTMLButtonElement>(".ob-live-sound");
  sound?.addEventListener("click", () => {
    const on = sound.getAttribute("aria-pressed") !== "true";
    sound.setAttribute("aria-pressed", String(on));
    sound.setAttribute("aria-label", on ? "Mute" : "Turn sound on");
    el.player?.audio?.activate();
    el.player?.setMuted(!on);
  });
}

let observer: IntersectionObserver | null = null;

export function mountLivePlayers() {
  const figs = [...document.querySelectorAll<HTMLElement>("figure.ob-live:not([data-mounted])")];
  if (!figs.length) return;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const fig = e.target as HTMLElement;
        const el = fig.querySelector("openbone-player") as PlayerElement | null;
        if (e.isIntersecting) {
          load(fig);
          if (has(fig, "playing") && has(fig, "ready")) el?.play();
        } else if (has(fig, "playing") && has(fig, "ready")) el?.pause();
      }
    },
    { rootMargin: "200px 0px" },
  );
  for (const fig of figs) {
    fig.dataset.mounted = "";
    if (has(fig, "eager")) load(fig);
    observer.observe(fig);
  }
}
