import info from "virtual:openbone-about";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { setAboutOpen } from "../editor-menus.ts";
import { isDesktop } from "../storage.ts";

const REPO = "https://github.com/UXCentury/open-bone";
const UXCENTURY = "https://uxcentury.com";

const GROUPS: { kind: "app" | "desktop" | "tool"; title: string }[] = [
  { kind: "app", title: "In the editor, player and runtimes" },
  { kind: "desktop", title: "Desktop app" },
  { kind: "tool", title: "Build and test tools" },
];

/** Version line for bug reports: "OpenBone 0.1.0 (abc1234, 2026-11-09, desktop)". */
export const versionText = () =>
  `OpenBone ${info.version} (${[info.commit && `${info.commit}${info.dirty ? "+changes" : ""}`, info.buildDate, isDesktop() ? "desktop" : "web"].filter(Boolean).join(", ")})`;

/** Open a link in the system browser (desktop) or a new tab (web). */
async function openLink(e: MouseEvent, url: string) {
  if (!isDesktop()) return; // the <a target="_blank"> does it
  e.preventDefault();
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

function Link(p: { href: string; children: unknown }) {
  return (
    <a href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => void openLink(e, p.href)}>
      {p.children as string}
    </a>
  );
}

/** ☰ Menu → About OpenBone: version, who makes it, and the open-source tools it is built with. */
export function AboutDialog() {
  const close = () => setAboutOpen(false);
  const [copied, setCopied] = createSignal(false);
  let box!: HTMLDivElement;
  const previousFocus = document.activeElement as HTMLElement | null;
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  onMount(() => {
    window.addEventListener("keydown", key, true);
    box.querySelector<HTMLButtonElement>(".primary")?.focus();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", key, true);
    previousFocus?.focus?.();
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(versionText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} class="modal about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="about-body">
          <header class="about-head">
            <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width="72" height="72" />
            <div>
              <h2 id="about-title">OpenBone</h2>
              <div class="muted">Open-source 2D skeletal animation with state machines, scripting and an MCP server.</div>
              <div class="about-version">
                <span class="selectable">
                  Version <b>{info.version}</b>
                  <Show when={info.commit}>
                    {" "}· build <code>{info.commit}{info.dirty ? "+changes" : ""}</code>
                  </Show>
                  {" "}· {info.buildDate} · {isDesktop() ? "desktop app" : "web"}
                </span>
                <button class="small-btn" onClick={() => void copy()} title="Copy the version, for bug reports">
                  {copied() ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </header>

          <section class="about-made">
            Made by <Link href={UXCENTURY}>UXCentury</Link>. Free and open source under the <Link href={`${REPO}/blob/main/LICENSE`}>MIT License</Link>.
            <div class="about-links">
              <Link href={REPO}>Source on GitHub</Link>
              <Link href={`${REPO}/blob/main/CHANGELOG.md`}>Changelog</Link>
              <Link href={`${REPO}/issues`}>Report a problem</Link>
            </div>
          </section>

          <section class="about-credits">
            <h3>Credits</h3>
            <p class="muted small">
              OpenBone is built on these open-source projects. Thank you to everyone who makes and maintains them.
            </p>
            <For each={GROUPS}>
              {(g) => (
                <Show when={info.credits.some((c) => c.kind === g.kind)}>
                  <h4>{g.title}</h4>
                  <ul class="credit-list">
                    <For each={info.credits.filter((c) => c.kind === g.kind)}>
                      {(c) => (
                        <li title={c.description}>
                          <Link href={c.url}>{c.name}</Link>
                          <span class="muted small"> {c.version}</span>
                          <span class="credit-license">{c.license}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </For>
            <p class="muted small">
              The logo and the example projects' art and voices were made with <Link href="https://elevenlabs.io">ElevenLabs</Link>.
            </p>
          </section>
        </div>
        <footer class="modal-foot">
          <span class="spacer" />
          <button class="primary" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
