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
  buffer?: AudioBuffer;
  /** The sound's own rate (the backend's speed multiplies it). */
  rate: number;
  loop: boolean;
  /** Context time and file position (seconds) when the current source started, for pause/resume and speed changes. */
  startedAt: number;
  offset: number;
  /** File position while paused; null when playing. */
  paused: number | null;
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
  /** Looping sounds requested before audio was unlocked, by voice id; they start when the context runs. */
  private pending = new Map<string, Extract<AudioCommand, { type: "play" }>>();
  private offline: OfflineAudioContext | null = null;

  constructor(
    public doc: OpenBoneDocument,
    private opts: WebAudioOptions = {},
  ) {
    this.ctx = opts.context ?? null;
    if (this.ctx) this.watch(this.ctx);
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

  /** Create (if needed) and resume the context now. Call it from a user gesture (a click) so the browser allows sound. */
  activate(): AudioContext | null {
    const ctx = this.context();
    if (ctx && ctx.state !== "running") void ctx.resume();
    return ctx;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.watch(this.ctx);
    return this.ctx;
  }

  /** Start the loops that were waiting for audio once the context runs (whoever resumed it). */
  private watch(ctx: AudioContext) {
    ctx.addEventListener?.("statechange", () => this.flushPending());
  }

  private flushPending() {
    if (this.ctx?.state !== "running" || !this.pending.size) return;
    const cmds = [...this.pending.values()];
    this.pending.clear();
    for (const cmd of cmds) this.play(cmd);
  }

  /**
   * Where sounds are decoded: the live context once it exists, else an OfflineAudioContext, which the browser allows
   * without a user gesture (decoded buffers play in any context).
   */
  private decoder(): BaseAudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.offline) {
      const Offline = globalThis.OfflineAudioContext ?? (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Offline) return this.context();
      this.offline = new Offline(2, 1, 48000);
    }
    return this.offline;
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

  /** Mutes set while playing by "mix" commands (mute buttons): bus id, "" = master. They win over the document. */
  private mixMutes = new Map<string, boolean>();

  private isMuted(busId: string | null): boolean {
    const key = busId ?? "";
    if (this.mixMutes.has(key)) return this.mixMutes.get(key)!;
    const a = this.doc.audio;
    return busId === null ? !!a?.muted : !!a?.buses.find((b) => b.id === busId)?.muted;
  }

  /** Apply the document's master/bus volumes and mutes (and the host mute, and mute buttons) to the graph. */
  syncMix() {
    const ctx = this.ctx;
    if (!ctx) return;
    const a = this.doc.audio;
    const t = ctx.currentTime;
    if (this.master) this.master.gain.setTargetAtTime(this.hostMuted || this.isMuted(null) ? 0 : (a?.master ?? 1), t, 0.015);
    for (const [id, g] of this.buses) {
      const bus = a?.buses.find((b) => b.id === id);
      g.gain.setTargetAtTime(bus ? (this.isMuted(id) ? 0 : bus.volume) : 1, t, 0.015);
    }
  }

  /** Effective gain a sound on `busId` gets from the mix right now (master x bus, 0 when muted). */
  busGain(busId: string | null) {
    if (this.hostMuted || this.isMuted(null) || (busId !== null && this.isMuted(busId))) return 0;
    return busGain(this.doc, busId);
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
      const ctx = this.decoder();
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
      case "mix": {
        this.mixMutes.set(cmd.bus ?? "", cmd.muted);
        // Make sure the bus node exists so the mute applies to sounds started later too.
        const ctx = this.ctx;
        if (ctx && cmd.bus) this.busNode(ctx, cmd.bus);
        this.syncMix();
        const name = cmd.bus === null ? "master" : (this.doc.audio?.buses.find((b) => b.id === cmd.bus)?.name ?? cmd.bus);
        this.opts.onLog?.(`${cmd.muted ? "mute" : "unmute"} ${name}`, cmd);
        return;
      }
    }
  };

  private play(cmd: Extract<AudioCommand, { type: "play" }>) {
    const asset = this.doc.audio?.assets.find((a) => a.id === cmd.asset);
    // Never create the context here: before a user gesture the browser refuses it ("The AudioContext was not allowed
    // to start"). It is created by unlock() / activate(), from a click or key press.
    const ctx = this.ctx;
    const name = this.doc.audio?.sounds.find((s) => s.id === cmd.sound)?.name ?? asset?.name ?? cmd.sound;
    if (!asset) {
      this.opts.onLog?.(`play ${name} skipped (asset missing)`, cmd);
      return;
    }
    if (!ctx || ctx.state !== "running") {
      // One-shots before the first gesture would all burst out at unlock time: drop them. Loops (music, ambience)
      // wait and start when audio unlocks.
      if (!cmd.loop) {
        this.opts.onLog?.(`play ${name} skipped (audio locked until a click or key press)`, cmd);
        return;
      }
      this.pending.set(cmd.id, cmd);
      this.opts.onLog?.(`play ${name} [${cmd.id}] loop waits for audio to unlock`, cmd);
      void this.load(asset);
      return;
    }
    const gain = ctx.createGain();
    gain.connect(this.busNode(ctx, cmd.bus));
    const voice: Voice = { gain, source: null, stopped: false, rate: cmd.rate, loop: cmd.loop, startedAt: 0, offset: 0, paused: this.pausedAll ? 0 : null };
    this.voices.set(cmd.id, voice);
    this.opts.onLog?.(`play ${name} [${cmd.id}]${cmd.loop ? " loop" : ""} vol ${round(cmd.volume)} × bus ${round(this.busGain(cmd.bus))} rate ${cmd.rate} (${cmd.source})`, cmd);
    void this.load(asset).then((buffer) => {
      if (!buffer || voice.stopped) {
        this.voices.delete(cmd.id);
        gain.disconnect();
        return;
      }
      voice.buffer = buffer;
      const t = ctx.currentTime;
      if (cmd.fadeIn > 0) {
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(cmd.volume, t + cmd.fadeIn);
      } else gain.gain.setValueAtTime(cmd.volume, t);
      // Started while everything is paused: it waits at the beginning for resumeAll().
      if (voice.paused === null) this.startSource(cmd.id, voice, 0);
    });
  }

  /** (Re)start a voice's buffer from `offset` seconds into the file, at the sound's rate × the backend's speed. */
  private startSource(id: string, voice: Voice, offset: number) {
    const ctx = this.ctx;
    if (!ctx || !voice.buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = voice.buffer;
    src.loop = voice.loop;
    src.playbackRate.value = voice.rate * this.speed;
    src.connect(voice.gain);
    src.onended = () => {
      if (voice.source !== src) return;
      if (this.voices.get(id) === voice) this.voices.delete(id);
      voice.gain.disconnect();
    };
    voice.source = src;
    voice.startedAt = ctx.currentTime;
    voice.offset = offset;
    voice.paused = null;
    src.start(ctx.currentTime, Math.max(0, offset));
  }

  /** Where a voice is in its file now (seconds). */
  private position(v: Voice): number {
    if (v.paused !== null) return v.paused;
    const ctx = this.ctx;
    if (!ctx || !v.buffer) return 0;
    const p = v.offset + (ctx.currentTime - v.startedAt) * v.rate * this.speed;
    return v.loop ? p % v.buffer.duration : p;
  }

  private speed = 1;
  private pausedAll = false;

  /**
   * Playback speed for everything this backend plays (sounds already playing change too), like a player's speed
   * control: 2 plays twice as fast and an octave higher.
   */
  setSpeed(speed: number) {
    const ctx = this.ctx;
    for (const v of this.voices.values()) {
      if (!v.source || !ctx) continue;
      // Keep the position continuous: restart the clock from here at the new rate.
      v.offset = this.position(v);
      v.startedAt = ctx.currentTime;
      v.source.playbackRate.value = v.rate * speed;
    }
    this.speed = Math.max(0.05, speed);
  }

  /** Pause every voice where it is (resumeAll continues them from there). */
  pauseAll() {
    this.pausedAll = true;
    for (const v of this.voices.values()) {
      if (!v.source) continue;
      v.paused = this.position(v);
      const src = v.source;
      v.source = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
  }

  /** Continue every paused voice from where it was paused. */
  resumeAll() {
    this.pausedAll = false;
    for (const [id, v] of [...this.voices]) {
      if (v.paused === null || v.source) continue;
      if (!v.buffer) {
        v.paused = null; // still loading: it starts when it arrives
        continue;
      }
      if (!v.loop && v.paused >= v.buffer.duration - 0.005) {
        this.voices.delete(id);
        v.gain.disconnect();
        continue;
      }
      this.startSource(id, v, v.paused);
    }
  }

  /**
   * A short grain of a sound at `offset` seconds into its file, for scrubbing a timeline: fades in and out over a few
   * milliseconds so dragging sounds like a tape head rather than clicks.
   */
  scrub(assetId: string, offset: number, o: { duration?: number; volume?: number; rate?: number; bus?: string | null } = {}) {
    const asset = this.doc.audio?.assets.find((a) => a.id === assetId);
    const ctx = this.context();
    if (!asset || !ctx || ctx.state !== "running") return;
    void this.load(asset).then((buffer) => {
      if (!buffer || offset < 0 || offset >= buffer.duration) return;
      const dur = Math.min(o.duration ?? 0.09, buffer.duration - offset);
      const g = ctx.createGain();
      g.connect(this.busNode(ctx, o.bus ?? null));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = (o.rate ?? 1) * this.speed;
      src.connect(g);
      const t = ctx.currentTime;
      const v = o.volume ?? 1;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.006);
      g.gain.setValueAtTime(v, t + Math.max(0.007, dur - 0.012));
      g.gain.linearRampToValueAtTime(0, t + dur);
      src.onended = () => g.disconnect();
      src.start(t, offset, dur + 0.01);
    });
  }

  private stop(id: string, fade: number, cmd?: AudioCommand) {
    if (this.pending.delete(id)) this.opts.onLog?.(`stop [${id}] (had not started)`, cmd);
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
    this.pending.clear();
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
