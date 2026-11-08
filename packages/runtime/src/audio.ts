import { type AnimationData, type AudioKey, type Id, type OpenBoneDocument, type SoundData, animationDuration, resolveSound } from "@openbone/core";

/**
 * Audio commands the runtime emits (on the "audio" event of AnimationState, StateMachineInstance and
 * OpenBoneInstance). The runtime never touches an audio API: a backend (e.g. the Web Audio one in
 * @openbone/player) turns these into sound, applying the document's buses and master volume.
 */
export type AudioCommand =
  | {
      type: "play";
      /** Unique id of this playing instance; later stop/fade commands refer to it. */
      id: string;
      sound: Id;
      asset: Id;
      /** Bus id, or null for straight into the master. The backend applies bus and master gain. */
      bus: Id | null;
      /** Sound volume x per-play volume (bus and master not included). */
      volume: number;
      rate: number;
      loop: boolean;
      /** Seconds to ramp from silence to `volume`. */
      fadeIn: number;
      /** What started it, e.g. "event:click", "key:walk", "state:Idle", "listener:press". */
      source: string;
    }
  | { type: "stop"; id: string; /** Seconds to fade out before stopping (0 = cut). */ fade: number }
  | { type: "fade"; id: string; /** Target volume (sound x play volume scale). */ volume: number; duration: number };

export interface PlayOptions {
  volume?: number;
  rate?: number;
  loop?: boolean;
  /** Lifetime owner (a track entry or state instance). Looping sounds stop when their owner ends. */
  owner?: string;
  /** Dedup tag: a looping sound is not restarted while one with the same owner and tag is playing. */
  tag?: string;
  source?: string;
}

export interface PlayingSound {
  id: string;
  sound: SoundData;
  owner: string | null;
  tag: string | null;
  loop: boolean;
  volume: number;
  startedAt: number;
  /** Director time at which a one-shot is assumed finished (Infinity for loops). */
  endsAt: number;
}

let counter = 0;
const nextId = () => `play_${(++counter).toString(36)}`;

/** One-shots whose length is unknown are forgotten after this long. */
const UNKNOWN_LENGTH = 10;

/**
 * Keeps track of what is playing and turns play/stop requests into AudioCommands with ids.
 * Pure bookkeeping: deterministic and testable without any audio API.
 */
export class AudioDirector {
  readonly playing = new Map<string, PlayingSound>();
  time = 0;

  constructor(
    public doc: OpenBoneDocument,
    private out: (c: AudioCommand) => void,
  ) {}

  update(dt: number) {
    this.time += dt;
    for (const [id, p] of this.playing) if (p.endsAt <= this.time) this.playing.delete(id);
  }

  /** Start a sound (id or name; an audio asset ref plays it with defaults). Returns the instance id, or null. */
  play(ref: string, o: PlayOptions = {}): string | null {
    const sound = resolveSound(this.doc, ref);
    if (!sound) return null;
    const loop = o.loop ?? sound.loop;
    const owner = o.owner ?? null;
    const tag = o.tag ?? null;
    if (loop && tag !== null)
      for (const p of this.playing.values()) if (p.loop && p.owner === owner && p.tag === tag) return p.id;
    const rate = o.rate ?? sound.rate;
    const volume = sound.volume * (o.volume ?? 1);
    const len = this.doc.audio?.assets.find((a) => a.id === sound.asset)?.duration ?? 0;
    const id = nextId();
    this.playing.set(id, {
      id,
      sound,
      owner,
      tag,
      loop,
      volume,
      startedAt: this.time,
      endsAt: loop ? Number.POSITIVE_INFINITY : this.time + (len > 0 ? len / rate : UNKNOWN_LENGTH),
    });
    this.out({ type: "play", id, sound: sound.id, asset: sound.asset, bus: sound.bus, volume, rate, loop, fadeIn: sound.fadeIn, source: o.source ?? "" });
    return id;
  }

  /** Stop one instance (fade defaults to its sound's fadeOut). */
  stop(id: string, fade?: number) {
    const p = this.playing.get(id);
    if (!p) return;
    this.playing.delete(id);
    this.out({ type: "stop", id, fade: fade ?? p.sound.fadeOut });
  }

  /** Stop every playing instance of a sound. */
  stopSound(ref: string, fade?: number) {
    const s = resolveSound(this.doc, ref);
    if (!s) return;
    for (const p of [...this.playing.values()]) if (p.sound.id === s.id) this.stop(p.id, fade);
  }

  /** Stop what an owner started: its looping sounds (or everything with `all`). Fade is at least the sound's fadeOut. */
  stopOwner(owner: string, fade = 0, all = false) {
    for (const p of [...this.playing.values()])
      if (p.owner === owner && (all || p.loop)) this.stop(p.id, Math.max(fade, p.sound.fadeOut));
  }

  /** Ramp an instance to a new volume over `duration` seconds. */
  fade(id: string, volume: number, duration: number) {
    const p = this.playing.get(id);
    if (!p) return;
    p.volume = volume;
    this.out({ type: "fade", id, volume, duration });
  }

  stopAll(fade = 0) {
    for (const id of [...this.playing.keys()]) this.stop(id, fade);
  }
}

/**
 * Audio keys crossed when total time moves from `prev` (exclusive) to `next` (inclusive), with their index
 * (for dedup tags). Same rules as eventsBetween: looping animations cross each key once per cycle.
 */
export function audioKeysBetween(anim: AnimationData, prev: number, next: number, loop: boolean): { key: AudioKey; index: number }[] {
  const keys = anim.audio;
  if (!keys?.length || next <= prev) return [];
  const d = animationDuration(anim);
  const out: { key: AudioKey; index: number }[] = [];
  keys.forEach((key, index) => {
    if (!loop || d <= 0) {
      if (key.time > prev && key.time <= next) out.push({ key, index });
      return;
    }
    for (let c = Math.floor(prev / d); c <= Math.floor(next / d); c++) {
      const at = c * d + key.time;
      if (at > prev && at <= next) out.push({ key, index });
    }
  });
  return out;
}

/** Start the audio keys an animation crossed between two times, owned by `owner`. */
export function playAudioKeys(dir: AudioDirector, anim: AnimationData, prev: number, next: number, loop: boolean, owner: string) {
  for (const { key, index } of audioKeysBetween(anim, prev, next, loop))
    dir.play(key.sound, { volume: key.volume, rate: key.rate, loop: key.loop, owner, tag: `${anim.id}#${index}`, source: `key:${anim.name}` });
}
