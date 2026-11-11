import type { FiredEvent } from "@openbone/runtime";
import { Player } from "./player.ts";

/**
 * <openbone-player src="hero.obone" state-machine="ui" animation="idle" skin="red" fit="contain" renderer="webgl">
 * Events: "openbone-event" (detail = FiredEvent), "openbone-state" (detail = state change), "openbone-load".
 * Methods: setInput(name, value), fire(name), setText(slot, text), setSkin(name), play(), pause(),
 * setMuted(muted), setBusMuted(bus, muted | "toggle"), toggleBus(bus), isBusMuted(bus), buses, player (the underlying Player).
 * Audio plays after the first click/key press; `muted` attribute starts muted, `audio="off"` disables it.
 * Changing the `skin` attribute switches the outfit without reloading.
 */
export class OpenBonePlayerElement extends HTMLElement {
  /** `skin` switches skins in place; any other of these reloads the player with the new settings. */
  static observedAttributes = ["src", "skin", "animation", "state-machine", "fit", "renderer", "autoplay", "background", "scripts", "audio", "muted"];
  player: Player | null = null;
  /**
   * An AudioContext to play through instead of creating one, set before `src`. Create and resume it in a click
   * handler (a play button) and the player starts with sound even when it loads after that click.
   */
  audioContext: AudioContext | null = null;
  private canvas: HTMLCanvasElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:inline-block;width:400px;height:300px;position:relative}canvas{width:100%;height:100%;display:block;touch-action:none}</style>`;
    this.canvas = document.createElement("canvas");
    root.appendChild(this.canvas);
  }

  connectedCallback() {
    // An upgraded element may already have loaded from attributeChangedCallback.
    if (!this.player) this.init();
  }
  disconnectedCallback() {
    this.player?.dispose();
    this.player = null;
  }
  attributeChangedCallback(n: string, old: string | null, val: string | null) {
    if (old === val || !this.isConnected) return;
    if (n === "skin") this.player?.setSkin(val);
    // Includes `src` set for the first time after the element was added to the page. Upgrading an element reports each
    // attribute it already has; those match what the player was built with, so they don't reload it.
    else if (this.settings() !== this.loadedWith) this.init();
  }

  /** The attributes the current player was built with (everything observed except `skin`). */
  private loadedWith: string | undefined;
  private settings() {
    return JSON.stringify(OpenBonePlayerElement.observedAttributes.filter((a) => a !== "skin").map((a) => this.getAttribute(a)));
  }

  private init() {
    const src = this.getAttribute("src");
    this.player?.dispose();
    this.player = null;
    this.loadedWith = this.settings();
    if (!src) return;
    this.player = new Player({
      canvas: this.canvas,
      src,
      stateMachine: this.getAttribute("state-machine") ?? undefined,
      animation: this.getAttribute("animation") ?? undefined,
      skin: this.getAttribute("skin") ?? undefined,
      fit: (this.getAttribute("fit") as "contain") ?? "contain",
      renderer: (this.getAttribute("renderer") as "webgl") ?? "webgl",
      autoplay: this.getAttribute("autoplay") !== "false",
      background: this.background(),
      scripts: this.getAttribute("scripts") === "none" ? "none" : "quickjs",
      audio: this.getAttribute("audio") === "off" ? false : this.hasAttribute("muted") ? "muted" : true,
      ...(this.audioContext ? { audioContext: this.audioContext } : {}),
      onEvent: (e: FiredEvent) => this.dispatchEvent(new CustomEvent("openbone-event", { detail: e, bubbles: true, composed: true })),
      onStateChange: (e) => this.dispatchEvent(new CustomEvent("openbone-state", { detail: e, bubbles: true, composed: true })),
      onLoad: () => this.dispatchEvent(new CustomEvent("openbone-load", { bubbles: true, composed: true })),
    });
    this.player.ready.catch((e) => console.error(e));
  }

  /** `background` attribute: a colour, "transparent"/"none" for no background, absent for the file's own. */
  private background(): string | null | undefined {
    if (!this.hasAttribute("background")) return undefined;
    const v = this.getAttribute("background")?.trim() ?? "";
    return v === "" || v === "transparent" || v === "none" ? null : v;
  }

  setInput(name: string, value: boolean | number | string) {
    this.player?.setInput(name, value);
  }
  setText(slot: string, text: string | null) {
    this.player?.setText(slot, text);
  }
  fire(name: string) {
    this.player?.fire(name);
  }
  setSkin(name: string | null) {
    if (name) this.setAttribute("skin", name);
    else this.removeAttribute("skin");
  }
  play() {
    this.player?.play();
  }
  /** Mute or unmute everything. */
  setMuted(muted: boolean) {
    this.player?.setMuted(muted);
  }
  /** Mute, unmute or toggle a sound bus by name ("music", "sfx"…); null or "master" = the master. */
  setBusMuted(bus: string | null, muted: boolean | "toggle" = true) {
    return this.player?.setBusMuted(bus, muted) ?? null;
  }
  toggleBus(bus: string | null) {
    return this.player?.toggleBus(bus) ?? null;
  }
  isBusMuted(bus: string | null) {
    return this.player?.isBusMuted(bus) ?? null;
  }
  get buses() {
    return this.player?.buses ?? [];
  }
  pause() {
    this.player?.pause();
  }
}

export function definePlayerElement(tag = "openbone-player") {
  if (!customElements.get(tag)) customElements.define(tag, OpenBonePlayerElement);
}
