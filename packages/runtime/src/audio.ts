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
  | { type: "fade"; id: string; /** Target volume (sound x play volume scale). */ volume: number; duration: number }
  /** Mute or unmute a bus (null = the master) on top of the document's mix, e.g. from a mute button. */
  | { type: "mix"; bus: Id | null; muted: boolean };

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

  /** Mutes set while playing (bus id, "" = master), starting from the document's mix. */
  private mutes = new Map<string, boolean>();

  /** Whether a bus (null = the master) is muted right now. */
  isMuted(bus: Id | null): boolean {
    const key = bus ?? "";
    if (this.mutes.has(key)) return this.mutes.get(key)!;
    const a = this.doc.audio;
    return bus === null ? !!a?.muted : !!a?.buses.find((b) => b.id === bus)?.muted;
  }

  /** Mute, unmute or toggle a bus (null = the master); emits a "mix" command. Returns the new state. */
  setMute(bus: Id | null, muted: boolean | "toggle"): boolean {
    const next = muted === "toggle" ? !this.isMuted(bus) : muted;
    this.mutes.set(bus ?? "", next);
    this.out({ type: "mix", bus, muted: next });
    return next;
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

/** An audio command and the animation time it happens at. */
export interface TimedAudioCommand {
  time: number;
  command: AudioCommand;
}

/**
 * What an animation plays when it runs once from 0 to `duration` (an export's length): its audio keys and the sounds
 * of its events, each with the time it starts. Looping sounds stop at `duration`. Times are exact key times.
 */
export function animationAudioSchedule(doc: OpenBoneDocument, anim: AnimationData, duration: number): TimedAudioCommand[] {
  const out: TimedAudioCommand[] = [];
  let at = 0;
  const dir = new AudioDirector(doc, (command) => out.push({ time: at, command }));
  const starts: { time: number; play: () => void }[] = [];
  for (const { key, index } of audioKeysBetween(anim, -1e-9, duration, false))
    starts.push({
      time: Math.max(0, key.time),
      play: () => dir.play(key.sound, { volume: key.volume, rate: key.rate, loop: key.loop, owner: "export", tag: `${anim.id}#${index}`, source: `key:${anim.name}` }),
    });
  for (const k of anim.events) {
    if (k.time < 0 || k.time > duration) continue;
    const ev = doc.events.find((e) => e.id === k.event);
    const sound = ev?.audio;
    if (ev && sound) starts.push({ time: k.time, play: () => dir.play(sound, { volume: ev.volume, owner: "export", source: `event:${ev.name}` }) });
  }
  starts.sort((a, b) => a.time - b.time);
  for (const s of starts) {
    dir.update(s.time - at);
    at = s.time;
    s.play();
  }
  dir.update(Math.max(0, duration - at));
  at = duration;
  dir.stopOwner("export", 0, false);
  return out;
}
