/**
 * Client side of <LivePlayer>: loads the web player script once, starts each player when it scrolls into view,
 * pauses it off screen, and wires the input controls and the sound button.
 */

interface PlayerElement extends HTMLElement {
  setInput(name: string, value: boolean | number | string): void;
  fire(name: string): void;
  play(): void;
  pause(): void;
  player: { setMuted(m: boolean): void; ready: Promise<void> } | null;
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

function start(fig: HTMLElement) {
  // data-started="" is the flag (an empty string is falsy, so test for presence): wire each player once.
  if (fig.dataset.started !== undefined) return;
  fig.dataset.started = "";
  const el = fig.querySelector("openbone-player") as PlayerElement;
  el.addEventListener("openbone-load", () => {
    fig.dataset.ready = "";
  });
  void loadPlayerScript().then(() => el.setAttribute("src", fig.dataset.src ?? ""));

  fig.querySelectorAll<HTMLButtonElement>("[data-fire]").forEach((b) => b.addEventListener("click", () => el.fire(b.dataset.fire ?? "")));
  fig.querySelectorAll<HTMLButtonElement>("[data-bool]").forEach((b) =>
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      el.setInput(b.dataset.bool ?? "", on);
    }),
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
    // This click is the user gesture the browser needs: the player's AudioContext is created and resumed by it.
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
          start(fig);
          if (fig.dataset.ready !== undefined) el?.play();
        } else if (fig.dataset.ready !== undefined) el?.pause();
      }
    },
    { rootMargin: "200px 0px" },
  );
  for (const fig of figs) {
    fig.dataset.mounted = "";
    if (fig.dataset.eager !== undefined) start(fig);
    observer.observe(fig);
  }
}
