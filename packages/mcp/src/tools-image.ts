import { readFile, writeFile } from "node:fs/promises";
import { decodeImage } from "./image-load.ts";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCanvas } from "@napi-rs/canvas";
import { z } from "zod";
import { type Box, type Pixels, alphaBounds, crop, differenceMatte, featherEdges, flip, keepLargest, keyColor } from "./image-ops.ts";
import type { ProjectSession } from "./session.ts";

/**
 * process_image: prepare art for rigging without leaving the MCP — key out a flat background (generated art usually
 * comes on plain grey), cut a layer out by comparing a picture with a cleaned copy of it, trim to the visible pixels,
 * crop, resize, flip, feather edges for seamless tiling — then save the PNG and import it (or replace an image in place).
 */

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("keyColor"),
    color: z.string().optional().describe("Background colour #rrggbb (default: the median of the border)"),
    sampleFrom: z.enum(["all", "top"]).default("all").describe("Border to sample the default colour from; 'top' when the art touches the other edges"),
    tolerance: z.number().min(0).max(441).default(18),
    softness: z.number().min(1).max(441).default(34).describe("Colour distance over which pixels fade in; large values (200+) turn brightness into transparency, e.g. mist or glow keyed off black"),
    keepBrighterThan: z.number().min(0).max(255).optional().describe("Keep pixels at least this bright opaque (white details on a light background)"),
    despill: z.boolean().optional().describe("Remove the key colour's cast from edges (default: on for strongly coloured keys like #00ff00)"),
  }),
  z.object({
    op: z.literal("differenceMatte"),
    other: z.string().describe("The same picture with the object removed (path, or a project image name/id); resized to match when its size differs"),
    threshold: z.number().min(0).max(1).default(0.06),
    softness: z.number().min(0.001).max(1).default(0.09),
    region: boxSchema.optional().describe("Only cut out inside this box (input pixels)"),
    fadeRows: z.object({ from: z.number(), to: z.number() }).optional().describe("Fade the cut-out to nothing from row `from` to row `to` (where the object meets repainted ground)"),
    keepLargest: z.boolean().default(true),
  }),
  z.object({ op: z.literal("trim"), threshold: z.number().int().min(0).max(254).default(8), padding: z.number().int().min(0).default(0) }),
  z.object({ op: z.literal("crop"), ...boxSchema.shape }),
  z.object({
    op: z.literal("resize"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    scale: z.number().positive().optional(),
  }),
  z.object({ op: z.literal("flip"), horizontal: z.boolean().default(true), vertical: z.boolean().default(false) }),
  z.object({
    op: z.literal("featherEdges"),
    left: z.number().min(0).optional(),
    right: z.number().min(0).optional(),
    top: z.number().min(0).optional(),
    bottom: z.number().min(0).optional(),
  }),
  z.object({ op: z.literal("keepLargest"), threshold: z.number().int().min(0).max(254).default(12) }),
]);

export function registerImageTools(server: McpServer, session: ProjectSession) {
  const resolveInput = async (ref: string): Promise<Buffer> => {
    const img = session.doc.images.find((i) => i.id === ref || i.name === ref);
    if (img) {
      if (!img.src) throw new Error(`Image "${ref}" has no file of its own (packed in an atlas)`);
      const src = await session.readImageSrc(img.src);
      return typeof src === "string" ? Buffer.from(src.replace(/^data:[^,]*,/, ""), "base64") : src;
    }
    return readFile(path.resolve(session.baseDir, ref));
  };
  const decode = async (buf: Buffer, w?: number, h?: number): Promise<Pixels> => {
    const el = await decodeImage(buf);
    const width = w ?? el.width;
    const height = h ?? el.height;
    const c = createCanvas(width, height);
    const g = c.getContext("2d");
    g.drawImage(el, 0, 0, width, height);
    return { data: new Uint8ClampedArray(g.getImageData(0, 0, width, height).data), width, height };
  };
  const toCanvas = (p: Pixels) => {
    const c = createCanvas(p.width, p.height);
    const g = c.getContext("2d");
    const im = g.createImageData(p.width, p.height);
    im.data.set(p.data);
    g.putImageData(im, 0, 0);
    return c;
  };

  server.registerTool(
    "process_image",
    {
      description:
        "Prepare art for rigging: run `ops` in order on an image (a file path or a project image name/id), save the result as a PNG at `out` and optionally import it (`importAs`: a new image of that name) or replace a project image in place (`replace`: regions using it keep their pixel density). Ops: keyColor (remove a flat background colour everywhere, soft edges, no colour fringe; colour defaults to the border median, sampleFrom:'top' for strips like grass that touch the bottom), differenceMatte (cut out what differs from `other`, the same picture with the object painted out — e.g. a tree, to animate it on its own layer; fadeRows fades it where it meets the ground), trim (crop to the visible pixels), crop, resize, flip, featherEdges (fade the sides so tiled copies overlap without seams), keepLargest (drop stray specks). Returns the size and `box`: where the result sits in the input picture (input pixels) — use it to place the layer exactly where it was in the full picture.",
      inputSchema: {
        input: z.string().describe("Image file path (relative to the project folder or absolute) or a project image name/id"),
        out: z.string().describe("Output PNG path (relative to the project folder or absolute)"),
        ops: z.array(opSchema).min(1),
        importAs: z.string().optional().describe("Import the result as a new image with this name"),
        replace: z.string().optional().describe("Replace this project image (name or id) with the result, keeping its id"),
      },
    },
    async (a) => {
      try {
        let p = await decode(await resolveInput(a.input));
        const inW = p.width;
        const inH = p.height;
        // The result's place in the input picture (scale tracks resizes).
        let box: Box = { x: 0, y: 0, width: inW, height: inH };
        let sx = 1;
        let sy = 1;
        const notes: string[] = [];
        for (const o of a.ops) {
          switch (o.op) {
            case "keyColor": {
              const { color } = keyColor(p, o);
              notes.push(`keyed out #${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
              break;
            }
            case "differenceMatte": {
              const raw = await resolveInput(o.other);
              differenceMatte(p, await decode(raw, p.width, p.height), o);
              break;
            }
            case "trim": {
              const b = alphaBounds(p, o.threshold, o.padding);
              if (!b) throw new Error("trim: nothing visible is left in the image");
              p = crop(p, b);
              box = { x: box.x + b.x / sx, y: box.y + b.y / sy, width: b.width / sx, height: b.height / sy };
              break;
            }
            case "crop": {
              p = crop(p, o);
              box = { x: box.x + o.x / sx, y: box.y + o.y / sy, width: p.width / sx, height: p.height / sy };
              break;
            }
            case "resize": {
              const w = o.width ?? (o.scale ? Math.round(p.width * o.scale) : o.height ? Math.round((p.width * o.height) / p.height) : p.width);
              const h = o.height ?? (o.scale ? Math.round(p.height * o.scale) : Math.round((p.height * w) / p.width));
              const c = createCanvas(w, h);
              c.getContext("2d").drawImage(toCanvas(p), 0, 0, w, h);
              sx *= w / p.width;
              sy *= h / p.height;
              p = { data: new Uint8ClampedArray(c.getContext("2d").getImageData(0, 0, w, h).data), width: w, height: h };
              break;
            }
            case "flip":
              p = flip(p, o.horizontal, o.vertical);
              break;
            case "featherEdges":
              featherEdges(p, o);
              break;
            case "keepLargest":
              keepLargest(p, o.threshold);
              break;
          }
        }
        const out = path.resolve(session.baseDir, a.out);
        const png = toCanvas(p).toBuffer("image/png");
        await writeFile(out, png);
        const result: Record<string, unknown> = {
          ok: true,
          out,
          width: p.width,
          height: p.height,
          box: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
          ...(notes.length ? { notes } : {}),
        };
        if (a.importAs || a.replace) {
          const src = session.filePath ? path.relative(session.baseDir, out).split(path.sep).join("/") : `data:image/png;base64,${png.toString("base64")}`;
          if (a.replace) {
            const img = session.doc.images.find((i) => i.id === a.replace || i.name === a.replace);
            if (!img) throw new Error(`Image "${a.replace}" not found`);
            result.replaced = img.id;
            Object.assign(result, session.store.apply("updateImage", { image: img.id, src, width: p.width, height: p.height }) as object);
          } else result.image = (session.store.apply("addImage", { name: a.importAs!, src, width: p.width, height: p.height }) as { id: string }).id;
          await session.maybeAutosave();
        }
        return text(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}

const round = (v: number) => Math.round(v * 100) / 100;
