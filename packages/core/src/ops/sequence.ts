import { z } from "zod";
import { get } from "../document.ts";
import { gridSheetFrames, sequenceFrameSize } from "../sequence.ts";
import type { SequenceAttachment, SequenceFrame } from "../types.ts";
import { defineOp, hex, ref } from "./registry.ts";
import { attTarget, putAttachment } from "./rig.ts";
import { type FrameInput, frameSchema, resolveFrames, resolveSequenceInput, sequenceMode } from "./sequence-props.ts";

const grid = z
  .object({
    image: ref("Sprite sheet image"),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    frameWidth: z.number().positive().optional(),
    frameHeight: z.number().positive().optional(),
    padding: z.number().min(0).default(0).describe("Pixels between cells"),
    margin: z.number().min(0).default(0).describe("Pixels around the grid"),
    count: z.number().int().positive().optional().describe("Use only the first N cells (row by row)"),
  })
  .describe("Cut a sprite sheet image into a grid of frames (give cols/rows or the frame size)");

function framesFrom(doc: Parameters<typeof get.image>[0], a: { frames?: FrameInput[]; grid?: z.infer<typeof grid> }): SequenceFrame[] {
  if (a.grid) {
    const img = get.image(doc, a.grid.image);
    const cells = gridSheetFrames({ ...a.grid, imageWidth: img.width, imageHeight: img.height });
    return cells.map((c) => ({ image: img.id, rect: c.rect }));
  }
  return resolveFrames(doc, a.frames ?? []);
}

defineOp({
  name: "addSequence",
  group: "attachment",
  description:
    "Attach a frame-by-frame sequence (image sequence or sprite sheet) to a slot. Frames are image refs in order, sheet cells {image, rect:{x,y,width,height}}, or a `grid` over one sheet image. The frame shown is floor(time x fps) + offset, mapped by mode; bind `input` (a number input) to drive the frame from a state machine, or key it with setKeys target 'sequence'.",
  schema: z.object({
    ...attTarget,
    frames: z.array(frameSchema).optional().describe("Frames in order: image ids/names, or {image, rect, trim}"),
    grid: grid.optional(),
    x: z.number().default(0),
    y: z.number().default(0),
    rotation: z.number().default(0),
    scaleX: z.number().default(1),
    scaleY: z.number().default(1),
    skewX: z.number().default(0).describe("Skew in degrees (slants the vertical edges)"),
    skewY: z.number().default(0).describe("Skew in degrees (slants the horizontal edges)"),
    width: z.number().positive().optional().describe("Frame width (default: the first frame's size)"),
    height: z.number().positive().optional(),
    color: hex.default("#ffffff"),
    fps: z.number().positive().default(24),
    mode: sequenceMode.default("loop"),
    offset: z.number().int().default(0).describe("Frames added to the frame counter"),
    input: z.string().nullable().optional().describe("Number input (id or name) whose value is the frame counter"),
  }),
  apply(doc, a) {
    if (!a.frames?.length && !a.grid) throw new Error("Give frames or a grid");
    const frames = framesFrom(doc, a);
    if (!frames.length) throw new Error("The sequence has no frames");
    const first = get.image(doc, frames[0].image);
    const size = sequenceFrameSize(frames[0], first);
    const att: SequenceAttachment = {
      type: "sequence",
      name: a.name ?? first.name.replace(/[\s._-]*\d+$/, "") ?? "sequence",
      frames,
      x: a.x,
      y: a.y,
      rotation: a.rotation,
      scaleX: a.scaleX,
      scaleY: a.scaleY,
      ...(a.skewX ? { skewX: a.skewX } : {}),
      ...(a.skewY ? { skewY: a.skewY } : {}),
      width: a.width ?? size.width,
      height: a.height ?? size.height,
      color: a.color,
      fps: a.fps,
      mode: a.mode,
      offset: a.offset,
      ...(a.input ? { input: resolveSequenceInput(doc, a.input) } : {}),
    };
    if (!att.name) att.name = "sequence";
    const out = putAttachment(doc, a.slot, a.skin, att, a.activate);
    return { ...out, frames: frames.length };
  },
});

defineOp({
  name: "setSequenceFrames",
  group: "attachment",
  description:
    "Replace or reorder the frames of a sequence attachment (frames in the new order, or a `grid` over a sheet image). `resize` sets the attachment size to the first frame's size.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional().describe("Defaults to the skin that holds the attachment (active skin, then default)"),
    frames: z.array(frameSchema).optional(),
    grid: grid.optional(),
    resize: z.boolean().default(false),
  }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const skins = a.skin ? [get.skin(doc, a.skin)] : doc.skeleton.skins;
    const att = skins.map((k) => k.attachments[slot.id]?.[a.attachment]).find(Boolean);
    if (!att || att.type !== "sequence") throw new Error(`Sequence attachment "${a.attachment}" not found on slot "${slot.name}"`);
    if (!a.frames?.length && !a.grid) throw new Error("Give frames or a grid");
    const frames = framesFrom(doc, a);
    att.frames = frames;
    if (a.resize && frames.length) Object.assign(att, sequenceFrameSize(frames[0], get.image(doc, frames[0].image)));
    return { frames: frames.length };
  },
});
