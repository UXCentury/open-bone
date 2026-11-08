import { type AudioAsset, type OpenBoneDocument, busGain } from "@openbone/core";
import type { AudioCommand } from "@openbone/runtime";

export interface WebAudioOptions {
  /** Base URL for relative audio paths. */
  baseUrl?: string;
  /** Map an asset to the URL to load (overrides baseUrl), e.g. for files read from disk. */
  resolveUrl?: (asset: AudioAsset) => string;
  /** Use an existing context instead of creating one on first use. */
  context?: AudioContext;
  /** Called for every command handled (and for dropped/failed ones), for debugging. */
  onLog?: (message: string, cmd?: AudioCommand) => void;
}

interface Voice {
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  stopped: boolean;
}

const isAbsolute = (src: string) => /^(data:|https?:|blob:|\/)/.test(src);

/**
 * Plays the runtime's AudioCommands with the Web Audio API: resolves and decodes assets (cached per URL),
 * routes each sound through its bus into the master, applies fades, and follows the document's mix
 * (call `syncMix()` after changing bus/master values). Browsers block audio until a user gesture, so the
 * context is resumed by the first pointer/key event (see `unlock`); one-shots requested before that are skipped.
 */
export class WebAudioBackend {
  ctx: AudioContext | null;
  private master: GainNode | null = null;
  private buses = new Map<string, GainNode>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private voices = new Map<string, Voice>();
  private hostMuted = false;
  private unbind: (() => void) | null = null;

  constructor(
    public doc: OpenBoneDocument,
    private opts: WebAudioOptions = {},
  ) {
    this.ctx = opts.context ?? null;
  }

  /** True once the browser lets the context play. */
  get unlocked() {
    return this.ctx?.state === "running";
  }

  get muted() {
    return this.hostMuted;
  }

  /** Mute everything (independent of the document's own mute). */
  setMuted(m: boolean) {
    this.hostMuted = m;
    this.syncMix();
  }

  setDocument(doc: OpenBoneDocument) {
    this.doc = doc;
    this.syncMix();
  }

  setBaseUrl(url: string) {
    this.opts.baseUrl = url;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  private masterNode(ctx: AudioContext): GainNode {
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.syncMix();
    }
    return this.master;
  }

  private busNode(ctx: AudioContext, busId: string | null): GainNode {
    const master = this.masterNode(ctx);
    if (!busId || !this.doc.audio?.buses.some((b) => b.id === busId)) return master;
    let g = this.buses.get(busId);
    if (!g) {
      g = ctx.createGain();
      g.connect(master);
      this.buses.set(busId, g);
      this.syncMix();
    }
    return g;
  }

  /** Apply the document's master/bus volumes and mutes (and the host mute) to the graph. */
  syncMix() {
    const ctx = this.ctx;
    if (!ctx) return;
    const a = this.doc.audio;
    const t = ctx.currentTime;
    if (this.master) this.master.gain.setTargetAtTime(this.hostMuted || a?.muted ? 0 : (a?.master ?? 1), t, 0.015);
    for (const [id, g] of this.buses) {
      const bus = a?.buses.find((b) => b.id === id);
      g.gain.setTargetAtTime(bus ? (bus.muted ? 0 : bus.volume) : 1, t, 0.015);
    }
  }

  /** Effective gain a sound on `busId` gets from the mix right now (master x bus, 0 when muted). */
  busGain(busId: string | null) {
    return this.hostMuted ? 0 : busGain(this.doc, busId);
  }

  url(asset: AudioAsset): string {
    if (this.opts.resolveUrl) return this.opts.resolveUrl(asset);
    return isAbsolute(asset.src) ? asset.src : (this.opts.baseUrl ?? "") + asset.src;
  }

  /** Fetch and decode an asset (cached by URL). */
  load(asset: AudioAsset): Promise<AudioBuffer | null> {
    const url = this.url(asset);
    let p = this.buffers.get(url);
    if (!p) {
      const ctx = this.context();
      if (!ctx) return Promise.resolve(null);
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => ctx.decodeAudioData(buf))
        .catch((e) => {
          this.opts.onLog?.(`could not load audio "${asset.name}": ${(e as Error).message}`);
          this.buffers.delete(url);
          return null;
        });
      this.buffers.set(url, p);
    }
    return p;
  }

  /** Start decoding every asset in the document. */
  preload() {
    return Promise.all((this.doc.audio?.assets ?? []).map((a) => this.load(a)));
  }

  /** Resume the context on the first user gesture on `target` (default: window). Safe to call more than once. */
  unlock(target: EventTarget = globalThis as unknown as EventTarget) {
    if (this.unbind || !target?.addEventListener) return;
    const evs = ["pointerdown", "keydown", "touchend"];
    const go = () => {
      const ctx = this.context();
      if (!ctx) return;
      void ctx.resume().then(() => {
        if (ctx.state === "running") {
          this.opts.onLog?.("audio unlocked");
          this.unbind?.();
        }
      });
    };
    for (const e of evs) target.addEventListener(e, go, { capture: true });
    this.unbind = () => {
      for (const e of evs) target.removeEventListener(e, go, { capture: true });
      this.unbind = () => {};
    };
  }

  /** Handle one runtime command. Pass this to `instance.on("audio", ...)`. */
  handle = (cmd: AudioCommand) => {
    switch (cmd.type) {
      case "play":
        return this.play(cmd);
      case "stop":
        return this.stop(cmd.id, cmd.fade, cmd);
      case "fade": {
        const v = this.voices.get(cmd.id);
        if (!v || !this.ctx) return;
        const t = this.ctx.currentTime;
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(cmd.volume, t + Math.max(0.005, cmd.duration));
        this.opts.onLog?.(`fade ${cmd.id} → ${cmd.volume} over ${cmd.duration}s`, cmd);
        return;
      }
    }
  };

  private play(cmd: Extract<AudioCommand, { type: "play" }>) {
    const asset = this.doc.audio?.assets.find((a) => a.id === cmd.asset);
    const ctx = this.context();
    const name = this.doc.audio?.sounds.find((s) => s.id === cmd.sound)?.name ?? asset?.name ?? cmd.sound;
    if (!asset || !ctx) {
      this.opts.onLog?.(`play ${name} skipped (${asset ? "no Web Audio" : "asset missing"})`, cmd);
      return;
    }
    // One-shots before the first gesture would all burst out at unlock time: drop them. Loops start late.
    if (ctx.state !== "running" && !cmd.loop) {
      this.opts.onLog?.(`play ${name} skipped (audio locked until a click or key press)`, cmd);
      return;
    }
    const gain = ctx.createGain();
    gain.connect(this.busNode(ctx, cmd.bus));
    const voice: Voice = { gain, source: null, stopped: false };
    this.voices.set(cmd.id, voice);
    this.opts.onLog?.(`play ${name} [${cmd.id}]${cmd.loop ? " loop" : ""} vol ${round(cmd.volume)} × bus ${round(this.busGain(cmd.bus))} rate ${cmd.rate} (${cmd.source})`, cmd);
    void this.load(asset).then((buffer) => {
      if (!buffer || voice.stopped) {
        this.voices.delete(cmd.id);
        gain.disconnect();
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = cmd.loop;
      src.playbackRate.value = cmd.rate;
      src.connect(gain);
      const t = ctx.currentTime;
      if (cmd.fadeIn > 0) {
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(cmd.volume, t + cmd.fadeIn);
      } else gain.gain.setValueAtTime(cmd.volume, t);
      src.onended = () => {
        if (this.voices.get(cmd.id) === voice) this.voices.delete(cmd.id);
        gain.disconnect();
      };
      voice.source = src;
      src.start(t);
    });
  }

  private stop(id: string, fade: number, cmd?: AudioCommand) {
    const v = this.voices.get(id);
    if (!v) return;
    v.stopped = true;
    this.voices.delete(id);
    this.opts.onLog?.(`stop [${id}]${fade > 0 ? ` fade ${fade}s` : ""}`, cmd);
    const ctx = this.ctx;
    if (!ctx || !v.source) {
      v.gain.disconnect();
      return;
    }
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    if (fade > 0) v.gain.gain.linearRampToValueAtTime(0, t + fade);
    try {
      v.source.stop(t + Math.max(0, fade));
    } catch {
      /* already stopped */
    }
  }

  /** Stop every voice (optionally fading). */
  stopAll(fade = 0) {
    for (const id of [...this.voices.keys()]) this.stop(id, fade);
  }

  /** Number of voices currently playing or loading. */
  get activeVoices() {
    return this.voices.size;
  }

  dispose() {
    this.stopAll();
    this.unbind?.();
    if (!this.opts.context) void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.buses.clear();
    this.buffers.clear();
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
