import { type AnimationData, animationDuration } from "@openbone/core";
import { type FiredEvent, applyAnimation, eventsBetween, localTime } from "./animation.ts";
import { Emitter } from "./emitter.ts";
import type { Skeleton } from "./skeleton.ts";

export class TrackEntry {
  /** Total elapsed time on this entry (seconds, unwrapped). */
  time = 0;
  prevTime = -1e-6;
  speed = 1;
  alpha = 1;
  mixingFrom: TrackEntry | null = null;
  mixTime = 0;
  mixDuration = 0;
  completedLoops = 0;
  constructor(
    public animation: AnimationData,
    public loop: boolean,
  ) {}
  get duration() {
    return animationDuration(this.animation);
  }
  get localTime() {
    return localTime(this.animation, this.time, this.loop);
  }
  get isComplete() {
    return !this.loop && this.time >= this.duration;
  }
}

type Events = {
  event: [FiredEvent, number];
  start: [TrackEntry, number];
  complete: [TrackEntry, number];
};

/** Plays animations on numbered tracks with cross-fading. Higher tracks layer on top. */
export class AnimationState extends Emitter<Events> {
  tracks: (TrackEntry | null)[] = [];
  queue: { track: number; entry: TrackEntry; delay: number; mix: number }[] = [];
  defaultMix = 0.2;

  constructor(public skeleton: Skeleton) {
    super();
  }

  private resolve(anim: string | AnimationData): AnimationData {
    if (typeof anim !== "string") return anim;
    const a = this.skeleton.doc.animations.find((x) => x.id === anim || x.name === anim);
    if (!a) throw new Error(`Animation "${anim}" not found`);
    return a;
  }

  setAnimation(track: number, anim: string | AnimationData, loop = true, mix = this.defaultMix): TrackEntry {
    const entry = new TrackEntry(this.resolve(anim), loop);
    const cur = this.tracks[track];
    if (cur && mix > 0) {
      entry.mixingFrom = cur;
      cur.mixingFrom = null;
      entry.mixDuration = mix;
    }
    this.tracks[track] = entry;
    this.queue = this.queue.filter((q) => q.track !== track);
    this.emit("start", entry, track);
    return entry;
  }

  /** Queue an animation to start after the current one completes (non-looping) or after `delay` seconds. */
  addAnimation(track: number, anim: string | AnimationData, loop = true, delay = 0, mix = this.defaultMix): TrackEntry {
    const entry = new TrackEntry(this.resolve(anim), loop);
    if (!this.tracks[track]) {
      this.tracks[track] = entry;
      this.emit("start", entry, track);
    } else this.queue.push({ track, entry, delay, mix });
    return entry;
  }

  clearTrack(track: number) {
    this.tracks[track] = null;
  }

  update(dt: number) {
    this.tracks.forEach((e, track) => {
      if (!e) return;
      e.prevTime = e.time;
      e.time += dt * e.speed;
      if (e.mixingFrom) {
        e.mixingFrom.prevTime = e.mixingFrom.time;
        e.mixingFrom.time += dt * e.mixingFrom.speed;
        e.mixTime += dt;
        if (e.mixTime >= e.mixDuration) e.mixingFrom = null;
      }
      for (const ev of eventsBetween(this.skeleton.doc, e.animation, e.prevTime, e.time, e.loop)) this.emit("event", ev, track);
      const d = e.duration;
      if (d > 0) {
        const loops = Math.floor(e.time / d);
        if (e.loop ? loops > e.completedLoops : e.prevTime < d && e.time >= d) {
          e.completedLoops = loops;
          this.emit("complete", e, track);
        }
      }
      const q = this.queue.find((x) => x.track === track);
      if (q && (q.delay > 0 ? e.time >= q.delay : e.isComplete || (e.loop && d > 0 && e.time >= d))) {
        this.queue.splice(this.queue.indexOf(q), 1);
        q.entry.mixingFrom = e;
        q.entry.mixDuration = q.mix;
        this.tracks[track] = q.entry;
        this.emit("start", q.entry, track);
      }
    });
  }

  apply(sk: Skeleton = this.skeleton) {
    for (const e of this.tracks) {
      if (!e) continue;
      if (e.mixingFrom) {
        applyAnimation(sk, e.mixingFrom.animation, e.mixingFrom.localTime, e.alpha);
        applyAnimation(sk, e.animation, e.localTime, e.alpha * Math.min(1, e.mixTime / (e.mixDuration || 1)));
      } else applyAnimation(sk, e.animation, e.localTime, e.alpha);
    }
  }
}
