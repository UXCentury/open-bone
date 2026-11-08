import type { AudioAsset, AudioBus, AudioData, Id, OpenBoneDocument, SoundData } from "./types.ts";

/** Buses a document gets when its first audio is added. Fixed ids keep op replays deterministic. */
export const DEFAULT_BUSES: AudioBus[] = [
  { id: "bus_sfx", name: "sfx", volume: 1, muted: false },
  { id: "bus_music", name: "music", volume: 1, muted: false },
  { id: "bus_ui", name: "ui", volume: 1, muted: false },
];

export const emptyAudio = (): AudioData => ({ master: 1, muted: false, assets: [], buses: DEFAULT_BUSES.map((b) => ({ ...b })), sounds: [] });

/** The document's audio section, created (with the default buses) when missing. */
export function ensureAudio(d: OpenBoneDocument): AudioData {
  d.audio ??= emptyAudio();
  return d.audio;
}

const byRef = <T extends { id: Id; name: string }>(list: T[] | undefined, ref: string): T | undefined =>
  list?.find((x) => x.id === ref) ?? list?.find((x) => x.name === ref);

export const findSound = (d: OpenBoneDocument, ref: string): SoundData | undefined => byRef(d.audio?.sounds, ref);
export const findAudioAsset = (d: OpenBoneDocument, ref: string): AudioAsset | undefined => byRef(d.audio?.assets, ref);
export const findBus = (d: OpenBoneDocument, ref: string): AudioBus | undefined => byRef(d.audio?.buses, ref);

/**
 * What to play for a reference: a sound by id/name, or else an audio asset by id/name played with default
 * settings on the sfx bus (so `EventData.audio` may point straight at a file). null when nothing matches.
 */
export function resolveSound(d: OpenBoneDocument, ref: string): SoundData | null {
  const s = findSound(d, ref);
  if (s) return s;
  const a = findAudioAsset(d, ref);
  if (!a) return null;
  const bus = d.audio?.buses.find((b) => b.name === "sfx")?.id ?? null;
  return { id: a.id, name: a.name, asset: a.id, bus, volume: 1, rate: 1, loop: false, fadeIn: 0, fadeOut: 0 };
}

/** Master x bus gain (0 when either is muted). A missing bus counts as 1. */
export function busGain(d: OpenBoneDocument, busId: Id | null): number {
  const a = d.audio;
  if (!a) return 1;
  if (a.muted) return 0;
  const bus = busId ? a.buses.find((b) => b.id === busId) : undefined;
  if (bus?.muted) return 0;
  return a.master * (bus ? bus.volume : 1);
}

/** Final linear gain of one playing sound: master x bus x sound x per-play volume. */
export function soundGain(d: OpenBoneDocument, sound: SoundData, volume = 1): number {
  return busGain(d, sound.bus) * sound.volume * volume;
}

/** Ids of the sounds something in the document plays (event audio, animation keys, state hooks, listeners). */
export function usedSounds(d: OpenBoneDocument): Set<Id> {
  const out = new Set<Id>();
  const add = (ref: string | undefined) => {
    if (!ref) return;
    const s = resolveSound(d, ref);
    if (s) out.add(s.id);
  };
  for (const e of d.events) add(e.audio);
  for (const a of d.animations) for (const k of a.audio ?? []) add(k.sound);
  for (const sm of d.stateMachines) {
    for (const l of sm.layers) for (const st of l.states) for (const x of st.sounds ?? []) add(x.sound);
    for (const li of sm.listeners) for (const x of li.actions) if (x.type === "playSound" || x.type === "stopSound") add(x.sound);
  }
  return out;
}
