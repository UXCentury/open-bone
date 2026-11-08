import { z } from "zod";
import { attachmentOwner, defaultSkin, get } from "../document.ts";
import { PARTICLE_PRESETS, type ParticlePreset, defaultParticleSettings, particlePreset } from "../particles.ts";
import type { ParticlesAttachment, SkinData } from "../types.ts";
import { defineOp, hex, ref } from "./registry.ts";

const range = (what: string, min = -Infinity) =>
  z
    .tuple([z.number().min(min), z.number().min(min)])
    .refine(([a, b]) => a <= b, { message: "min must be <= max" })
    .describe(`${what} as [min, max]; each particle picks a random value in between`);

/** Every editable emitter field. Used (partial) by addParticles and updateParticles. */
const settings = z.object({
  emitting: z.boolean().describe("Emitting on/off in the setup pose (keyable: timeline target 'particles', property 'emitting')"),
  rate: z.number().min(0).max(10000).describe("Particles per second (keyable: property 'rate')"),
  bursts: z
    .array(z.object({ time: z.number().min(0), count: z.number().int().min(1).max(10000) }))
    .describe("One-off spawns: count particles at time seconds into each emitter cycle"),
  maxParticles: z.number().int().min(1).max(10000).describe("Live particle cap; extra spawns are dropped"),
  duration: z.number().positive().describe("Emitter cycle length in seconds"),
  loop: z.boolean().describe("Repeat the cycle (bursts replay each cycle); false stops emitting after duration"),
  prewarm: z.boolean().describe("Start as if one cycle had already run (smoke and exhaust look settled at time 0)"),
  shape: z.enum(["point", "circle", "box", "cone"]).describe("Where particles spawn: point, circle (emits outwards), box, cone (mouth of radius)"),
  x: z.number(),
  y: z.number(),
  rotation: z.number().describe("Emission direction in degrees in slot-bone space (90 = bone +y)"),
  angle: z.number().min(0).max(360).describe("Spread in degrees around the direction"),
  radius: z.number().min(0).describe("Circle radius / cone mouth half-width"),
  width: z.number().min(0).describe("Box width"),
  height: z.number().min(0).describe("Box height"),
  space: z.enum(["world", "local"]).describe("world: particles stay put when the bone moves (trails); local: they move with the bone"),
  lifetime: range("Seconds a particle lives", 0.001),
  speed: range("Start speed in units/s"),
  gravity: z.number().describe("Downward acceleration in units/s² (negative rises)"),
  drag: z.number().min(0).describe("Velocity decay per second"),
  startSize: range("Size at birth", 0),
  endSize: range("Size at death", 0),
  startRotation: range("Rotation at birth in degrees"),
  endRotation: range("Rotation at death in degrees (interpolated over the life)"),
  angularVelocity: range("Extra spin in degrees per second"),
  colors: z
    .array(z.object({ t: z.number().min(0).max(1), color: hex }))
    .min(1)
    .describe("Colour over life: stops with t 0..1 and #rrggbbaa colours (alpha fades)"),
  blend: z.enum(["normal", "additive", "multiply", "screen"]),
  look: z.enum(["circle", "square", "spark", "image"]).describe("circle = soft dot, square, spark = streak along velocity, image = textured quad"),
  image: ref("Image").optional().describe("Image for look 'image' (packed atlas images work too)"),
  stretch: z.number().min(0).describe("Spark streak length in seconds of velocity"),
  seed: z.number().int().describe("Random seed: the same seed and time give the same particles"),
});

const presetNames = Object.keys(PARTICLE_PRESETS) as [ParticlePreset, ...ParticlePreset[]];

function resolveImage(doc: Parameters<typeof get.image>[0], props: { image?: string; look?: string }) {
  if (props.image !== undefined) props.image = get.image(doc, props.image).id;
}

defineOp({
  name: "addParticles",
  group: "attachment",
  description:
    "Attach a particle emitter to a slot (rocket exhaust, sparks, confetti, smoke, coins). It emits from the slot bone's world transform. Start from a `preset` (fire, smoke, sparks, confetti, exhaust, coins) and override any setting. Key `emitting`/`rate` with setKeys (target 'particles', id = slot); state machines switch it with setStateEmitter or setEmitter/emitParticles listener actions.",
  schema: settings.partial().extend({
    slot: ref("Slot"),
    name: z.string().optional().describe("Attachment name (defaults to the preset name or 'particles')"),
    skin: ref("Skin").optional().describe("Defaults to the default skin"),
    activate: z.boolean().default(true).describe("Show this emitter in the slot's setup pose"),
    preset: z.enum(presetNames).optional(),
  }),
  apply(doc, a) {
    const { slot: slotRef, name, skin: skinRef, activate, preset, ...props } = a;
    const slot = get.slot(doc, slotRef);
    const skin: SkinData = skinRef ? get.skin(doc, skinRef) : defaultSkin(doc);
    resolveImage(doc, props);
    if (props.look === "image" && !props.image) throw new Error("look 'image' needs an image");
    const base = preset ? particlePreset(preset) : defaultParticleSettings();
    const map = (skin.attachments[slot.id] ??= {});
    let attName = name ?? preset ?? "particles";
    if (!name) for (let i = 2; map[attName]; i++) attName = `${preset ?? "particles"}${i}`;
    const att: ParticlesAttachment = { type: "particles", name: attName, ...base, ...structuredClone(props) };
    map[attName] = att;
    if (activate) slot.attachment = attName;
    return { slot: slot.id, name: attName, skin: skin.id };
  },
});

defineOp({
  name: "updateParticles",
  group: "attachment",
  description:
    "Change settings of a particle emitter (validated). Pass only the fields to change; `preset` first resets every field to that preset.",
  schema: settings.partial().extend({
    slot: ref("Slot"),
    attachment: z.string().describe("Particles attachment name"),
    skin: ref("Skin").optional(),
    preset: z.enum(presetNames).optional(),
  }),
  apply(doc, a) {
    const { slot: slotRef, attachment, skin: skinRef, preset, ...props } = a;
    const slot = get.slot(doc, slotRef);
    const owner = attachmentOwner(doc, slot.id, attachment, skinRef ? get.skin(doc, skinRef).id : undefined);
    const att = owner?.attachments[slot.id][attachment];
    if (!att || att.type !== "particles") throw new Error(`Slot "${slot.name}" has no particles attachment "${attachment}"`);
    resolveImage(doc, props);
    if (preset) {
      const keep = { seed: att.seed, image: att.image };
      for (const k of Object.keys(att)) if (k !== "type" && k !== "name") delete (att as unknown as Record<string, unknown>)[k];
      Object.assign(att, particlePreset(preset), keep.image ? { image: keep.image } : {}, { seed: keep.seed });
    }
    Object.assign(att, structuredClone(props));
    if (att.look === "image" && !att.image) throw new Error("look 'image' needs an image");
    return {};
  },
});

defineOp({
  name: "setStateEmitter",
  group: "interactivity",
  description:
    "Make a state switch a slot's particle emitter on or off when the state is entered (emitting null removes the switch). Turning it on restarts the emitter cycle, so bursts replay.",
  schema: z.object({
    stateMachine: ref("State machine"),
    layer: ref("Layer").optional(),
    state: ref("State"),
    slot: ref("Slot with a particles attachment"),
    emitting: z.boolean().nullable(),
  }),
  apply(doc, a) {
    const sm = get.stateMachine(doc, a.stateMachine);
    const layer = get.layer(sm, a.layer);
    const st = get.state(layer, a.state);
    const slot = get.slot(doc, a.slot);
    const list = (st.emitters ?? []).filter((e) => e.slot !== slot.id);
    if (a.emitting !== null) list.push({ slot: slot.id, emitting: a.emitting });
    if (list.length) st.emitters = list;
    else delete st.emitters;
    return {};
  },
});
