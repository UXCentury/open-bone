import { z } from "zod";
import { ensureAudio, findAudioAsset, findBus, findSound } from "../audio.ts";
import { RefError, get, newId } from "../document.ts";
import type { AudioAsset, AudioBus, AudioKey, OpenBoneDocument, SoundData } from "../types.ts";
import { defineOp, optId, ref } from "./registry.ts";

const names = (list: { name: string }[] | undefined) => (list ?? []).map((x) => x.name).join(", ") || "(none)";
function needSound(d: OpenBoneDocument, r: string): SoundData {
  const s = findSound(d, r);
  if (!s) throw new RefError(`Sound "${r}" not found. Available: ${names(d.audio?.sounds)}`);
  return s;
}
function needAsset(d: OpenBoneDocument, r: string): AudioAsset {
  const a = findAudioAsset(d, r);
  if (!a) throw new RefError(`Audio asset "${r}" not found. Available: ${names(d.audio?.assets)}`);
  return a;
}
function needBus(d: OpenBoneDocument, r: string): AudioBus {
  const b = findBus(d, r);
  if (!b) throw new RefError(`Bus "${r}" not found. Available: ${names(d.audio?.buses)}`);
  return b;
}
/** Bus ref → id; null → master; undefined → the "sfx" bus when there is one. */
function busId(d: OpenBoneDocument, r: string | null | undefined): string | null {
  if (r === null) return null;
  if (r === undefined) return d.audio?.buses.find((b) => b.name === "sfx")?.id ?? null;
  return needBus(d, r).id;
}

const volume = z.number().min(0).describe("Linear volume (1 = unchanged)");
const rate = z.number().min(0.05).max(8).describe("Playback rate / pitch (1 = original, 2 = octave up)");
const fade = z.number().min(0).describe("Seconds");

/** Remove every reference to a sound (event audio, animation keys, state hooks, listener actions). */
function dropSoundRefs(d: OpenBoneDocument, s: SoundData) {
  for (const e of d.events) if (e.audio === s.id || e.audio === s.name) delete e.audio;
  for (const a of d.animations) if (a.audio) a.audio = a.audio.filter((k) => k.sound !== s.id);
  for (const sm of d.stateMachines) {
    for (const l of sm.layers) for (const st of l.states) if (st.sounds) st.sounds = st.sounds.filter((x) => x.sound !== s.id);
    for (const li of sm.listeners) li.actions = li.actions.filter((x) => !((x.type === "playSound" || x.type === "stopSound") && x.sound === s.id));
  }
}

// ---------------- Assets ----------------

defineOp({
  name: "addAudio",
  group: "audio",
  description:
    "Add an audio file (WAV/MP3/OGG) as a data: URI or a path relative to the project. By default also creates a sound of the same name on the sfx bus, ready to play from event keys, audio keys, states or listeners.",
  schema: z.object({
    id: optId,
    name: z.string().min(1),
    src: z.string().min(1).describe("data: URI, relative path or URL"),
    duration: z.number().min(0).default(0).describe("Seconds (0 = unknown)"),
    sound: z.boolean().default(true).describe("Also create a sound using this asset"),
    soundId: optId,
    bus: ref("Bus").nullable().optional().describe("Bus for the created sound (default sfx; null = master)"),
    loop: z.boolean().default(false).describe("Created sound loops"),
  }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    if (audio.assets.some((x) => x.name === a.name)) throw new Error(`Audio "${a.name}" already exists`);
    const id = (a.id ??= newId("aud"));
    audio.assets.push({ id, name: a.name, src: a.src, duration: a.duration });
    let soundId: string | undefined;
    if (a.sound && !audio.sounds.some((s) => s.name === a.name)) {
      soundId = a.soundId ??= newId("snd");
      audio.sounds.push({ id: soundId, name: a.name, asset: id, bus: busId(doc, a.bus), volume: 1, rate: 1, loop: a.loop, fadeIn: 0, fadeOut: a.loop ? 0.2 : 0 });
    }
    return { id, ...(soundId ? { sound: soundId } : {}) };
  },
});

defineOp({
  name: "updateAudio",
  group: "audio",
  description: "Rename an audio asset or replace its source / duration.",
  schema: z.object({ asset: ref("Audio asset"), name: z.string().min(1).optional(), src: z.string().min(1).optional(), duration: z.number().min(0).optional() }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const old = needAsset(doc, a.asset);
    if (a.name && a.name !== old.name && audio.assets.some((x) => x.name === a.name)) throw new Error(`Audio "${a.name}" already exists`);
    // Assets are shared between undo snapshots: replace, never mutate.
    const next: AudioAsset = { ...old, ...(a.name ? { name: a.name } : {}), ...(a.src ? { src: a.src } : {}), ...(a.duration !== undefined ? { duration: a.duration } : {}) };
    audio.assets = audio.assets.map((x) => (x === old ? next : x));
    return {};
  },
});

defineOp({
  name: "deleteAudio",
  group: "audio",
  description: "Delete an audio asset, the sounds that use it and everything that plays them.",
  schema: z.object({ asset: ref("Audio asset") }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const asset = needAsset(doc, a.asset);
    audio.assets = audio.assets.filter((x) => x !== asset);
    for (const s of audio.sounds.filter((x) => x.asset === asset.id)) dropSoundRefs(doc, s);
    audio.sounds = audio.sounds.filter((x) => x.asset !== asset.id);
    for (const e of doc.events) if (e.audio === asset.id || e.audio === asset.name) delete e.audio;
    return {};
  },
});

// ---------------- Sounds ----------------

const soundProps = {
  bus: ref("Bus").nullable().optional().describe("Bus id/name (default sfx); null plays straight into the master"),
  volume: volume.optional(),
  rate: rate.optional(),
  loop: z.boolean().optional(),
  fadeIn: fade.optional().describe("Fade-in seconds when started"),
  fadeOut: fade.optional().describe("Fade-out seconds when stopped (also when its state/animation ends)"),
};

defineOp({
  name: "addSound",
  group: "audio",
  description: "Create a sound from an audio asset with its own bus, volume, rate (pitch), loop and fade in/out.",
  schema: z.object({ id: optId, name: z.string().min(1), asset: ref("Audio asset"), ...soundProps }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    if (audio.sounds.some((s) => s.name === a.name)) throw new Error(`Sound "${a.name}" already exists`);
    const asset = needAsset(doc, a.asset);
    const id = (a.id ??= newId("snd"));
    audio.sounds.push({
      id,
      name: a.name,
      asset: asset.id,
      bus: busId(doc, a.bus),
      volume: a.volume ?? 1,
      rate: a.rate ?? 1,
      loop: a.loop ?? false,
      fadeIn: a.fadeIn ?? 0,
      fadeOut: a.fadeOut ?? 0,
    });
    return { id };
  },
});

defineOp({
  name: "updateSound",
  group: "audio",
  description: "Change a sound's name, asset, bus, volume, rate, loop or fades.",
  schema: z.object({ sound: ref("Sound"), name: z.string().min(1).optional(), asset: ref("Audio asset").optional(), ...soundProps }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const s = needSound(doc, a.sound);
    if (a.name && a.name !== s.name) {
      if (audio.sounds.some((x) => x.name === a.name)) throw new Error(`Sound "${a.name}" already exists`);
      for (const e of doc.events) if (e.audio === s.name) e.audio = s.id;
      s.name = a.name;
    }
    if (a.asset) s.asset = needAsset(doc, a.asset).id;
    if (a.bus !== undefined) s.bus = busId(doc, a.bus);
    if (a.volume !== undefined) s.volume = a.volume;
    if (a.rate !== undefined) s.rate = a.rate;
    if (a.loop !== undefined) s.loop = a.loop;
    if (a.fadeIn !== undefined) s.fadeIn = a.fadeIn;
    if (a.fadeOut !== undefined) s.fadeOut = a.fadeOut;
    return {};
  },
});

defineOp({
  name: "deleteSound",
  group: "audio",
  description: "Delete a sound and every key, state hook, listener action and event reference that plays it (the asset stays).",
  schema: z.object({ sound: ref("Sound") }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const s = needSound(doc, a.sound);
    dropSoundRefs(doc, s);
    audio.sounds = audio.sounds.filter((x) => x !== s);
    return {};
  },
});

// ---------------- Mixer ----------------

defineOp({
  name: "addBus",
  group: "audio",
  description: "Add a mixer bus (documents start with sfx, music and ui). Sounds route into one bus; bus volume and mute apply to all of them.",
  schema: z.object({ id: optId, name: z.string().min(1), volume: volume.default(1), muted: z.boolean().default(false) }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    if (audio.buses.some((b) => b.name === a.name)) throw new Error(`Bus "${a.name}" already exists`);
    const id = (a.id ??= newId("bus"));
    audio.buses.push({ id, name: a.name, volume: a.volume, muted: a.muted });
    return { id };
  },
});

defineOp({
  name: "updateBus",
  group: "audio",
  description: "Rename a bus or change its volume / mute.",
  schema: z.object({ bus: ref("Bus"), name: z.string().min(1).optional(), volume: volume.optional(), muted: z.boolean().optional() }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const b = needBus(doc, a.bus);
    if (a.name && a.name !== b.name && audio.buses.some((x) => x.name === a.name)) throw new Error(`Bus "${a.name}" already exists`);
    if (a.name) b.name = a.name;
    if (a.volume !== undefined) b.volume = a.volume;
    if (a.muted !== undefined) b.muted = a.muted;
    return {};
  },
});

defineOp({
  name: "deleteBus",
  group: "audio",
  description: "Delete a bus. Its sounds play straight into the master.",
  schema: z.object({ bus: ref("Bus") }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    const b = needBus(doc, a.bus);
    audio.buses = audio.buses.filter((x) => x !== b);
    for (const s of audio.sounds) if (s.bus === b.id) s.bus = null;
    // Inputs that muted it mute nothing now.
    for (const sm of doc.stateMachines) for (const i of sm.inputs) if (i.mutes === b.id) delete i.mutes;
    return {};
  },
});

defineOp({
  name: "setAudioMix",
  group: "audio",
  description: "Set the master volume and/or mute every sound in the document.",
  schema: z.object({ master: volume.optional(), muted: z.boolean().optional() }),
  apply(doc, a) {
    const audio = ensureAudio(doc);
    if (a.master !== undefined) audio.master = a.master;
    if (a.muted !== undefined) audio.muted = a.muted;
    return {};
  },
});

// ---------------- Triggers ----------------

const keyOverrides = {
  volume: volume.optional().describe("Multiplies the sound's volume"),
  rate: rate.optional().describe("Overrides the sound's rate"),
  loop: z.boolean().optional().describe("Overrides the sound's loop; looping keys stop when the animation ends or is replaced"),
};

const sameKey = (k: AudioKey, sound: string, time: number) => k.sound === sound && Math.abs(k.time - time) < 1e-6;

defineOp({
  name: "addAudioKey",
  group: "audio",
  description: "Start a sound at a time on an animation's audio track (replaces a key of the same sound at that time).",
  schema: z.object({ animation: ref("Animation"), sound: ref("Sound"), time: z.number().min(0), ...keyOverrides }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const s = needSound(doc, a.sound);
    const key: AudioKey = { time: a.time, sound: s.id };
    if (a.volume !== undefined) key.volume = a.volume;
    if (a.rate !== undefined) key.rate = a.rate;
    if (a.loop !== undefined) key.loop = a.loop;
    anim.audio = (anim.audio ?? []).filter((k) => !sameKey(k, s.id, a.time));
    anim.audio.push(key);
    anim.audio.sort((p, q) => p.time - q.time);
    return {};
  },
});

defineOp({
  name: "updateAudioKey",
  group: "audio",
  description: "Move an audio key or change its volume / rate / loop overrides (null clears an override).",
  schema: z.object({
    animation: ref("Animation"),
    sound: ref("Sound"),
    time: z.number(),
    newTime: z.number().min(0).optional(),
    volume: volume.nullable().optional(),
    rate: rate.nullable().optional(),
    loop: z.boolean().nullable().optional(),
  }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const s = needSound(doc, a.sound);
    const k = anim.audio?.find((x) => sameKey(x, s.id, a.time));
    if (!k || !anim.audio) throw new Error("Audio key not found");
    for (const f of ["volume", "rate", "loop"] as const) {
      const v = a[f];
      if (v === null) delete k[f];
      else if (v !== undefined) (k as unknown as Record<string, unknown>)[f] = v;
    }
    if (a.newTime !== undefined) {
      anim.audio = anim.audio.filter((x) => x === k || !sameKey(x, s.id, a.newTime!));
      k.time = a.newTime;
      anim.audio.sort((p, q) => p.time - q.time);
    }
    return {};
  },
});

defineOp({
  name: "deleteAudioKey",
  group: "audio",
  description: "Remove an audio key from an animation.",
  schema: z.object({ animation: ref("Animation"), sound: ref("Sound"), time: z.number() }),
  apply(doc, a) {
    const anim = get.animation(doc, a.animation);
    const s = needSound(doc, a.sound);
    const before = anim.audio?.length ?? 0;
    anim.audio = (anim.audio ?? []).filter((k) => !sameKey(k, s.id, a.time));
    if (anim.audio.length === before) throw new Error("Audio key not found");
    if (!anim.audio.length) delete anim.audio;
    return {};
  },
});

defineOp({
  name: "setEventSound",
  group: "audio",
  description: "Play a sound whenever an event fires (from animation keys, listeners or scripts). sound null removes it.",
  schema: z.object({ event: ref("Event"), sound: ref("Sound").nullable(), volume: volume.optional() }),
  apply(doc, a) {
    const ev = get.event(doc, a.event);
    if (a.sound === null) {
      delete ev.audio;
      delete ev.volume;
      return {};
    }
    ev.audio = needSound(doc, a.sound).id;
    if (a.volume !== undefined) {
      if (a.volume === 1) delete ev.volume;
      else ev.volume = a.volume;
    }
    return {};
  },
});

defineOp({
  name: "setStateSound",
  group: "audio",
  description:
    "Play or stop a sound when a state is entered or exited (replaces the same sound's hook for that moment). A looping sound played on enter stops (with its fade-out) when the state exits.",
  schema: z.object({
    stateMachine: ref("State machine"),
    layer: ref("Layer").optional().describe("Defaults to the first layer"),
    state: ref("State"),
    sound: ref("Sound"),
    on: z.enum(["enter", "exit"]).default("enter"),
    action: z.enum(["play", "stop"]).default("play"),
    volume: volume.optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const st = get.state(get.layer(sm, a.layer), a.state);
    const s = needSound(doc, a.sound);
    const list = (st.sounds ?? []).filter((x) => !(x.sound === s.id && x.on === a.on));
    list.push({ sound: s.id, on: a.on, action: a.action, ...(a.volume !== undefined ? { volume: a.volume } : {}) });
    st.sounds = list;
    return {};
  },
});

defineOp({
  name: "deleteStateSound",
  group: "audio",
  description: "Remove a state's sound hook (for one moment, or both when `on` is omitted).",
  schema: z.object({
    stateMachine: ref("State machine"),
    layer: ref("Layer").optional(),
    state: ref("State"),
    sound: ref("Sound"),
    on: z.enum(["enter", "exit"]).optional(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const st = get.state(get.layer(sm, a.layer), a.state);
    const s = needSound(doc, a.sound);
    st.sounds = (st.sounds ?? []).filter((x) => !(x.sound === s.id && (!a.on || x.on === a.on)));
    if (!st.sounds.length) delete st.sounds;
    return {};
  },
});
