import type { FiredEvent } from "@openbone/runtime";
import { Player } from "./player.ts";

/**
 * <openbone-player src="hero.obone" state-machine="ui" animation="idle" skin="red" fit="contain" renderer="webgl">
 * Events: "openbone-event" (detail = FiredEvent), "openbone-state" (detail = state change), "openbone-load".
 * Methods: setInput(name, value), fire(name), setSkin(name), play(), pause(), player (the underlying Player).
 * Changing the `skin` attribute switches the outfit without reloading.
 */
export class OpenBonePlayerElement extends HTMLElement {
  static observedAttributes = ["src", "skin"];
  player: Player | null = null;
  private canvas: HTMLCanvasElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:inline-block;width:400px;height:300px;position:relative}canvas{width:100%;height:100%;display:block;touch-action:none}</style>`;
    this.canvas = document.createElement("canvas");
    root.appendChild(this.canvas);
  }

  connectedCallback() {
    this.init();
  }
  disconnectedCallback() {
    this.player?.dispose();
    this.player = null;
  }
  attributeChangedCallback(n: string, old: string | null, val: string | null) {
    if (old === val || !this.isConnected) return;
    if (n === "skin") this.player?.setSkin(val);
    else if (old !== null) this.init();
  }

  private init() {
    const src = this.getAttribute("src");
    if (!src) return;
    this.player?.dispose();
    this.player = new Player({
      canvas: this.canvas,
      src,
      stateMachine: this.getAttribute("state-machine") ?? undefined,
      animation: this.getAttribute("animation") ?? undefined,
      skin: this.getAttribute("skin") ?? undefined,
      fit: (this.getAttribute("fit") as "contain") ?? "contain",
      renderer: (this.getAttribute("renderer") as "webgl") ?? "webgl",
      autoplay: this.getAttribute("autoplay") !== "false",
      background: this.hasAttribute("background") ? this.getAttribute("background") : undefined,
      scripts: this.getAttribute("scripts") === "none" ? "none" : "quickjs",
      onEvent: (e: FiredEvent) => this.dispatchEvent(new CustomEvent("openbone-event", { detail: e, bubbles: true, composed: true })),
      onStateChange: (e) => this.dispatchEvent(new CustomEvent("openbone-state", { detail: e, bubbles: true, composed: true })),
      onLoad: () => this.dispatchEvent(new CustomEvent("openbone-load", { bubbles: true, composed: true })),
    });
    this.player.ready.catch((e) => console.error(e));
  }

  setInput(name: string, value: boolean | number) {
    this.player?.setInput(name, value);
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
  pause() {
    this.player?.pause();
  }
}

export function definePlayerElement(tag = "openbone-player") {
  if (!customElements.get(tag)) customElements.define(tag, OpenBonePlayerElement);
}
