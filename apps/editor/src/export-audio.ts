import { type AnimationData, type OpenBoneDocument, busGain } from "@openbone/core";
import { type PcmAudio, floatToPcm } from "@openbone/export";
import { animationAudioSchedule } from "@openbone/runtime";
import { resolveAudioUrl } from "./audio.ts";

/** Sound for video exports: the animation's audio keys and event sounds, mixed offline like the editor plays them. */

export interface AudioMix {
  sampleRate: number;
  /** Planar float channels (left, right). */
  channels: Float32Array[];
  pcm: PcmAudio;
}

export const MIX_RATE = 48000;

/** Decoded files, by resolved URL (decoding a long voice track takes a moment). */
const decoded = new Map<string, Promise<AudioBuffer>>();

function decode(ctx: BaseAudioContext, url: string, name: string): Promise<AudioBuffer> {
  let p = decoded.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b))
      .catch((e: unknown) => {
        decoded.delete(url);
        throw new Error(`Could not read sound "${name}" for the video (${e instanceof Error ? e.message : String(e)}). Untick "Include sound" to export without it.`);
      });
    decoded.set(url, p);
  }
  return p;
}

/**
 * Mix what `anim` plays over `duration` seconds into stereo. Returns null when the animation plays no sound.
 * Gains follow the document's mix: master x bus x sound x key/event volume, with fades and loops.
 */
export async function mixAnimationAudio(doc: OpenBoneDocument, anim: AnimationData, duration: number, sampleRate = MIX_RATE): Promise<AudioMix | null> {
  const schedule = animationAudioSchedule(doc, anim, duration);
  const plays = schedule.filter((e) => e.command.type === "play");
  if (!plays.length || duration <= 0) return null;
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const assets = new Map((doc.audio?.assets ?? []).map((a) => [a.id, a]));
  const buffers = new Map<string, AudioBuffer>();
  await Promise.all(
    [...new Set(plays.map((e) => (e.command.type === "play" ? e.command.asset : "")))].map(async (id) => {
      const asset = assets.get(id);
      if (asset) buffers.set(id, await decode(ctx, resolveAudioUrl(asset), asset.name));
    }),
  );
  const voices = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; bus: number }>();
  for (const { time: t, command: c } of schedule) {
    if (c.type === "play") {
      const buffer = buffers.get(c.asset);
      if (!buffer) continue;
      const bus = busGain(doc, c.bus);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = c.rate || 1;
      src.loop = c.loop;
      const gain = ctx.createGain();
      if (c.fadeIn > 0) {
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(c.volume * bus, t + c.fadeIn);
      } else gain.gain.setValueAtTime(c.volume * bus, t);
      src.connect(gain).connect(ctx.destination);
      src.start(t);
      voices.set(c.id, { src, gain, bus });
    } else if (c.type === "stop") {
      const v = voices.get(c.id);
      if (!v) continue;
      if (c.fade > 0) {
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(0, t + c.fade);
      }
      v.src.stop(t + Math.max(0, c.fade));
    } else if (c.type === "fade") {
      // ("mix" commands come from mute buttons, never from animation tracks.)
      const v = voices.get(c.id);
      v?.gain.gain.linearRampToValueAtTime(c.volume * v.bus, t + Math.max(0.005, c.duration));
    }
  }
  const out = await ctx.startRendering();
  const channels = [out.getChannelData(0), out.getChannelData(out.numberOfChannels > 1 ? 1 : 0)];
  return { sampleRate, channels, pcm: floatToPcm(channels, sampleRate) };
}
