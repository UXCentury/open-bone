import { z } from "zod";
import { get } from "../document.ts";
import type { OpenBoneDocument, SequenceFrame } from "../types.ts";
import { ref } from "./registry.ts";

const rect = z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() });
export const frameSchema = z.union([
  ref("Image"),
  z.object({
    image: ref("Image"),
    rect: rect.optional().describe("Sprite sheet cell (image pixels, y-down); whole image when omitted"),
    trim: z
      .object({ x: z.number(), y: z.number(), sourceWidth: z.number().positive(), sourceHeight: z.number().positive() })
      .optional()
      .describe("Trimmed frame: where rect sits inside the untrimmed sourceWidth x sourceHeight frame"),
  }),
]);
export type FrameInput = z.infer<typeof frameSchema>;
export const sequenceMode = z
  .enum(["loop", "once", "pingPong", "holdLast"])
  .describe("loop wraps; once plays through then hides; pingPong goes forward then back; holdLast stops on the last frame");

/** Resolve image refs to ids and check sheet rects lie inside their image. */
export function resolveFrames(doc: OpenBoneDocument, frames: FrameInput[]): SequenceFrame[] {
  return frames.map((f, i) => {
    const o = typeof f === "string" ? { image: f } : f;
    const img = get.image(doc, o.image);
    const r = o.rect;
    if (r && (r.x + r.width > img.width + 1e-6 || r.y + r.height > img.height + 1e-6))
      throw new Error(`Frame ${i}: rect ${r.x},${r.y} ${r.width}x${r.height} is outside image "${img.name}" (${img.width}x${img.height})`);
    return { image: img.id, ...(r ? { rect: { ...r } } : {}), ...(o.trim ? { trim: { ...o.trim } } : {}) };
  });
}

/** Number input id from an id or name in any state machine. */
export function resolveSequenceInput(doc: OpenBoneDocument, input: string): string {
  for (const sm of doc.stateMachines) {
    const i = sm.inputs.find((x) => x.id === input) ?? sm.inputs.find((x) => x.name === input);
    if (i) {
      if (i.type !== "number") throw new Error(`Input "${i.name}" is a ${i.type}; a sequence needs a number input`);
      return i.id;
    }
  }
  throw new Error(`Number input "${input}" not found in any state machine`);
}

/** Validate and normalise updateAttachment props for a sequence (in place). */
export function checkSequenceProps(doc: OpenBoneDocument, props: Record<string, unknown>) {
  if ("frames" in props) props.frames = resolveFrames(doc, z.array(frameSchema).parse(props.frames));
  if ("mode" in props) sequenceMode.parse(props.mode);
  if ("fps" in props && !(typeof props.fps === "number" && props.fps > 0)) throw new Error("fps must be a positive number");
  if ("offset" in props && !(typeof props.offset === "number" && Number.isFinite(props.offset))) throw new Error("offset must be a number of frames");
  if ("input" in props) props.input = props.input == null || props.input === "" ? null : resolveSequenceInput(doc, String(props.input));
}
