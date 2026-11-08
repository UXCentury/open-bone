import { MOUTH_SHAPES, type MouthShape, guessMouthMapping, lipSync, slotAttachments } from "@openbone/core";
import { pickAudio } from "./panels/AudioPanel.tsx";
import { askConfirm, askForm } from "./dialogs.tsx";
import { activeSkin, setAnimationId, setMode, store, time, toast, transaction } from "./state.ts";
import { decodeAudio } from "./waveform.ts";

const SHAPE_LABELS: Record<MouthShape, string> = {
  rest: "Rest (silence)",
  closed: "Closed (M, B, P)",
  small: "Small (S, T, F, quiet)",
  open: "Open (most vowels)",
  wide: "Wide (loud A, E)",
  round: "Round (O, U, W)",
};

/**
 * Lip sync: analyse a sound and key a mouth slot's attachments to it (stepped), starting at the current time in
 * the current animation; the sound is added to the animation's audio track too. One undo step.
 */
export async function lipSyncDialog(animationId: string | null) {
  const doc = store.doc;
  const sounds = doc.audio?.sounds ?? [];
  if (!sounds.length) {
    if (await askConfirm({ title: "No sounds yet", message: "Import a voice recording (WAV, MP3 or OGG) first, then run lip sync on it.", confirmLabel: "Import…" })) pickAudio();
    return;
  }
  const mouthSlots = doc.skeleton.slots.filter((s) => slotAttachments(doc, s.id, activeSkin()?.id).length >= 2);
  if (!mouthSlots.length) {
    toast("Lip sync needs a mouth slot with two or more attachments (one image per mouth shape)", "error");
    return;
  }
  const guessSlot = mouthSlots.find((s) => /mouth|lip/i.test(s.name)) ?? mouthSlots[0];
  const first = await askForm({
    title: "Lip sync",
    message: "Keys the mouth slot's images to the speech in a sound: rest, closed (M/B/P), small, open, wide and round shapes.",
    confirmLabel: "Next",
    fields: [
      { key: "sound", label: "Sound", type: "choice", value: sounds[0].id, options: sounds.map((s) => ({ value: s.id, label: s.name })) },
      { key: "slot", label: "Mouth slot", type: "choice", value: guessSlot.id, options: mouthSlots.map((s) => ({ value: s.id, label: s.name })) },
      { key: "start", label: "Start at (s)", type: "text", value: String(Math.round(time() * 1000) / 1000), validate: (v) => (Number(v) >= 0 ? null : "A time ≥ 0") },
    ],
  });
  if (!first) return;
  const names = slotAttachments(doc, first.slot, activeSkin()?.id).map((a) => a.name);
  const guess = guessMouthMapping(names);
  const options = names.map((n) => ({ value: n, label: n }));
  const map = await askForm({
    title: "Mouth shapes",
    message: "Which image plays each shape? Guessed from the names; several shapes may share one image.",
    confirmLabel: "Lip sync",
    fields: MOUTH_SHAPES.map((shape) => ({ key: shape, label: SHAPE_LABELS[shape], type: "choice" as const, value: guess[shape] ?? names[0], options })),
  });
  if (!map) return;

  const sound = sounds.find((s) => s.id === first.sound)!;
  const asset = doc.audio?.assets.find((a) => a.id === sound.asset);
  if (!asset) return toast("That sound has no audio file", "error");
  const decoded = await decodeAudio(asset);
  if (!decoded) return toast(`Could not decode "${asset.name}"`, "error");
  const rate = sound.rate ?? 1;
  const keys = lipSync(decoded.samples, decoded.sampleRate, { fps: doc.fps });
  const start = Number(first.start);
  const end = start + decoded.duration / rate;

  transaction("lip sync", () => {
    let anim = animationId && store.doc.animations.find((a) => a.id === animationId)?.id;
    if (!anim) anim = (store.apply("createAnimation", { name: `lipsync ${sound.name}` }) as { id: string }).id;
    // Replace earlier attachment keys of this slot inside the sound's span.
    const a = store.doc.animations.find((x) => x.id === anim)!;
    const tl = a.timelines.find((t) => t.target === "slot" && t.id === first.slot && t.property === "attachment");
    for (const k of [...((tl?.keys as { time: number }[]) ?? [])])
      if (k.time >= start - 1e-6 && k.time <= end + 1e-6) store.apply("deleteKey", { animation: anim, target: "slot", id: first.slot, property: "attachment", time: k.time });
    const fps = store.doc.fps;
    const snap = (t: number) => Math.round(t * fps) / fps;
    store.apply("setKeys", {
      animation: anim,
      target: "slot",
      id: first.slot,
      property: "attachment",
      keys: keys.map((k) => ({ time: snap(start + k.time / rate), value: map[k.shape], curve: "stepped" })),
    });
    store.apply("addAudioKey", { animation: anim, sound: sound.id, time: start });
    if (a.duration > 0 && end > a.duration) store.apply("updateAnimation", { animation: anim, duration: snap(end) });
    setAnimationId(anim);
  });
  setMode("animate");
  toast(`Lip sync: ${keys.length} mouth keys over ${(end - start).toFixed(2)}s`, "info");
}
