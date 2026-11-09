import {
  type AnimationData,
  type EventData,
  type EventKey,
  type Key,
  type OpenBoneDocument,
  IK_STEP_PROPERTIES,
  animationDuration,
  evalCurve,
  lerp,
  lerpAngle,
  lerpColor,
  parseHex,
} from "@openbone/core";
import type { Skeleton } from "./skeleton.ts";

export interface FiredEvent {
  name: string;
  id: string;
  time: number;
  int: number;
  float: number;
  string: string;
  /** Sound (or audio asset) the event plays, and its volume multiplier. */
  audio?: string;
  volume?: number;
  animation: string;
}

/** Find surrounding keys and the eased fraction between them. */
function locate<T>(keys: Key<T>[], time: number): { a: Key<T>; b: Key<T> | null; t: number } {
  if (time <= keys[0].time) return { a: keys[0], b: null, t: 0 };
  const last = keys[keys.length - 1];
  if (time >= last.time) return { a: last, b: null, t: 0 };
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const f = (time - a.time) / (b.time - a.time || 1);
  return { a, b, t: evalCurve(a.curve, f) };
}

export function sampleNumber(keys: Key<number>[], time: number): number {
  const { a, b, t } = locate(keys, time);
  if (!b || a.curve === "stepped") return a.value;
  return lerp(a.value, b.value, t);
}

export function sampleArray(keys: Key<number[]>[], time: number): number[] {
  const { a, b, t } = locate(keys, time);
  if (!b || a.curve === "stepped") return a.value;
  const n = Math.max(a.value.length, b.value.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = lerp(a.value[i] ?? 0, b.value[i] ?? 0, t);
  return out;
}

export function sampleStep<T>(keys: Key<T>[], time: number): T {
  return locate(keys, time).a.value;
}

/** Local playback time for a total elapsed time. */
export function localTime(anim: AnimationData, total: number, loop: boolean): number {
  const d = animationDuration(anim);
  if (d <= 0) return 0;
  if (loop) return ((total % d) + d) % d;
  return Math.min(Math.max(total, 0), d);
}

/**
 * Pose the skeleton with an animation at local time `time`, blended over the current pose by `alpha`.
 * Values are absolute (not relative to setup), so un-keyed properties keep whatever is underneath.
 */
export function applyAnimation(sk: Skeleton, anim: AnimationData, time: number, alpha = 1) {
  if (alpha <= 0) return;
  // Sequences follow the dominant animation's time.
  if (alpha >= 0.5 || sk.animationTime === null) sk.animationTime = time;
  for (const tl of anim.timelines) {
    if (!tl.keys.length) continue;
    switch (tl.target) {
      case "bone": {
        const bone = sk.boneById_(tl.id);
        if (!bone) break;
        const v = sampleNumber(tl.keys, time);
        const prop = tl.property;
        // At full weight the keyed value is used as is; only a partial mix takes the shortest way round.
        bone[prop] = alpha >= 1 ? v : prop === "rotation" ? lerpAngle(bone[prop], v, alpha) : lerp(bone[prop], v, alpha);
        break;
      }
      case "slot": {
        const slot = sk.slotById_(tl.id);
        if (!slot) break;
        if (tl.property === "color") {
          const { a, b, t } = locate(tl.keys, time);
          const ca = parseHex(a.value);
          const v = !b || a.curve === "stepped" ? ca : lerpColor(ca, parseHex(b.value), t);
          slot.color = alpha >= 1 ? v : lerpColor(slot.color, v, alpha);
        } else if (tl.property === "dark") {
          const { a, b, t } = locate(tl.keys, time);
          const ca = parseHex(a.value);
          const v = !b || a.curve === "stepped" ? ca : lerpColor(ca, parseHex(b.value), t);
          slot.dark = alpha >= 1 ? v : lerpColor(slot.dark ?? [0, 0, 0, 1], v, alpha);
        } else if (alpha >= 0.5) {
          slot.attachmentName = sampleStep(tl.keys, time);
        }
        break;
      }
      case "ik":
      case "transform":
      case "path":
      case "physics": {
        const values = sk.constraintValues.get(tl.id);
        if (!values) break;
        const prop: string = tl.property;
        if (tl.target === "ik" && (IK_STEP_PROPERTIES as string[]).includes(prop)) {
          // Switches (bend direction, stretch, compress) change at keys, never blend.
          if (alpha >= 0.5) values[prop] = Number(sampleStep(tl.keys as Key<number | boolean>[], time));
        } else values[prop] = lerp(values[prop] ?? 0, sampleNumber(tl.keys, time), alpha);
        break;
      }
      case "particles": {
        const slot = sk.slotById_(tl.id);
        if (!slot) break;
        const cur = sk.particleValues.get(tl.id) ?? {};
        if (tl.property === "emitting") {
          if (alpha >= 0.5) cur.emitting = sampleStep(tl.keys, time);
        } else {
          const att = sk.getAttachment(slot);
          const base = cur.rate ?? (att?.type === "particles" ? att.rate : 0);
          cur.rate = lerp(base, sampleNumber(tl.keys, time), alpha);
        }
        sk.particleValues.set(tl.id, cur);
        break;
      }
      case "deform": {
        const slot = sk.slotById_(tl.id);
        if (!slot) break;
        const v = sampleArray(tl.keys, time);
        const cur = slot.deform.get(tl.attachment);
        slot.deform.set(tl.attachment, cur && alpha < 1 ? v.map((x, i) => lerp(cur[i] ?? 0, x, alpha)) : alpha < 1 ? v.map((x) => x * alpha) : v);
        break;
      }
      case "sequence": {
        const slot = sk.slotById_(tl.id);
        if (!slot) break;
        // Frames are discrete: like attachment keys, the stronger side of a mix wins.
        if (alpha >= 0.5) slot.sequenceFrames.set(tl.attachment, sampleNumber(tl.keys, time));
        break;
      }
      case "drawOrder": {
        if (alpha < 0.5) break;
        const order = sampleStep(tl.keys, time);
        // Like Spine: slots the key doesn't list keep their setup places; the listed ones fill the other places,
        // back to front in the key's order.
        const listed = order.map((id) => sk.slotById_(id)).filter(Boolean) as typeof sk.drawOrder;
        const placed = new Set(listed);
        const out: (typeof sk.drawOrder)[number][] = new Array(sk.slots.length);
        sk.slots.forEach((slot, i) => {
          if (!placed.has(slot)) out[i] = slot;
        });
        let next = 0;
        for (let i = 0; i < out.length && next < listed.length; i++) if (!out[i]) out[i] = listed[next++];
        sk.drawOrder = out.filter(Boolean);
        break;
      }
    }
  }
}

/** Event keys crossed when total time moves from `prev` (exclusive) to `next` (inclusive). */
export function eventsBetween(
  doc: OpenBoneDocument,
  anim: AnimationData,
  prev: number,
  next: number,
  loop: boolean,
): FiredEvent[] {
  if (!anim.events.length || next <= prev) return [];
  const d = animationDuration(anim);
  const out: FiredEvent[] = [];
  const push = (k: EventKey, ev: EventData, at: number) =>
    out.push({
      name: ev.name,
      id: ev.id,
      time: at,
      int: k.int ?? ev.int,
      float: k.float ?? ev.float,
      string: k.string ?? ev.string,
      ...(ev.audio ? { audio: ev.audio } : {}),
      ...(ev.volume !== undefined ? { volume: ev.volume } : {}),
      animation: anim.name,
    });
  for (const k of anim.events) {
    const ev = doc.events.find((e) => e.id === k.event);
    if (!ev) continue;
    if (!loop || d <= 0) {
      if (k.time > prev && k.time <= next) push(k, ev, k.time);
      continue;
    }
    const first = Math.floor(prev / d);
    const lastC = Math.floor(next / d);
    for (let c = first; c <= lastC; c++) {
      const at = c * d + k.time;
      if (at > prev && at <= next) push(k, ev, k.time);
    }
  }
  return out;
}

/**
 * Pose `sk` with `anim` (or the setup pose when null) at `time`, with particles brought to that time
 * deterministically (replayed from 0 when seeking backwards). Editor scrubbing and image/video export use this,
 * so a frame at time t always shows the same particles.
 */
export function seekAnimation(sk: Skeleton, anim: AnimationData | null, time: number) {
  const pose = (t: number) => {
    sk.setToSetupPose();
    if (anim) applyAnimation(sk, anim, t);
    sk.updateWorldTransform();
  };
  sk.seekParticles(time, pose);
  pose(time);
}
