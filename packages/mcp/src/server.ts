import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadImage } from "@napi-rs/canvas";
import { registry, serialize, summarize, validate } from "@openbone/core";
import type { ScriptHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { z } from "zod";
import { GUIDE } from "./guide.ts";
import { packAtlas, pose, renderGif, renderPng } from "./render.ts";
import { ProjectSession } from "./session.ts";

export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

const stepSchema = z.object({
  advance: z.number().min(0).optional().describe("Seconds to advance after applying this step (default 1/30)"),
  setInputs: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  fire: z.array(z.string()).optional().describe("Trigger inputs to fire"),
  pointer: z
    .object({ type: z.enum(["down", "up", "move"]), x: z.number(), y: z.number() })
    .optional()
    .describe("Pointer event in ARTBOARD pixels (y-down, top-left origin)"),
});

export interface ServerOptions {
  session?: ProjectSession;
  scriptHost?: ScriptHost;
}

export function createServer(opts: ServerOptions = {}) {
  const session = opts.session ?? new ProjectSession();
  let host: ScriptHost | undefined = opts.scriptHost;
  const scriptHost = async () => (host ??= await createQuickJsHost({ timeoutMs: 50 }));

  const server = new McpServer(
    { name: "openbone", version: "0.1.0" },
    {
      instructions:
        "OpenBone: 2D skeletal animation + interactive state machines. Read the openbone://guide resource (or call get_guide) first. Start with new_project or open_project; edit with the add_*/update_*/set_keys tools; verify with render_frame and simulate_state_machine.",
    },
  );

  // ---------- Generated edit tools (one per core op) ----------
  for (const def of registry.values()) {
    server.registerTool(
      snake(def.name),
      { title: def.name, description: `[${def.group}] ${def.description}`, inputSchema: def.schema.shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = session.store.apply(def.name, args);
          await session.maybeAutosave();
          return text({ ok: true, ...(result && typeof result === "object" ? result : { result }) });
        } catch (e) {
          return fail(e);
        }
      },
    );
  }

  // ---------- Project tools ----------
  server.registerTool(
    "new_project",
    {
      description: "Start a new empty project (root bone only). With `path` (.obone), it is saved and autosaved after every edit.",
      inputSchema: {
        name: z.string(),
        path: z.string().optional(),
        width: z.number().positive().default(800),
        height: z.number().positive().default(600),
        originX: z.number().optional(),
        originY: z.number().optional(),
        background: z.string().nullable().optional(),
      },
    },
    async (a) => {
      try {
        session.newProject(a.name, a.path ?? null, {
          width: a.width,
          height: a.height,
          originX: a.originX ?? a.width / 2,
          originY: a.originY ?? a.height * 0.75,
          background: a.background ?? null,
        });
        if (session.filePath) await session.save();
        return text({ ok: true, path: session.filePath, rootBone: session.doc.skeleton.bones[0].id });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "open_project",
    { description: "Open an .obone file.", inputSchema: { path: z.string() } },
    async (a) => {
      try {
        await session.open(a.path);
        return text(summarize(session.doc));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "save_project",
    { description: "Save the project (optionally to a new path).", inputSchema: { path: z.string().optional() } },
    async (a) => {
      try {
        return text({ ok: true, path: await session.save(a.path) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool("get_guide", { description: "How to use OpenBone tools: coordinate system, workflow, examples." }, async () => text(GUIDE));

  server.registerTool("get_summary", { description: "Readable outline of the open project: bones, slots, animations, state machines." }, async () =>
    text(summarize(session.doc)),
  );

  server.registerTool(
    "get_document",
    {
      description: "Raw JSON of the open document or one section of it.",
      inputSchema: { section: z.enum(["all", "skeleton", "animations", "stateMachines", "scripts", "events", "images"]).default("all") },
    },
    async (a) => {
      const d = session.doc;
      if (a.section === "all") return text(serialize(d, false));
      if (a.section === "images") return text(d.images.map(({ src, ...rest }) => ({ ...rest, src: src.startsWith("data:") ? `${src.slice(0, 40)}…` : src })));
      return text(JSON.stringify(d[a.section]));
    },
  );

  server.registerTool("validate", { description: "Check the document for broken references and problems." }, async () => {
    const issues = validate(session.doc);
    return text(issues.length ? issues : "No issues found.");
  });

  server.registerTool("undo", { description: "Undo the last edit." }, async () => {
    const ok = session.store.undo();
    await session.maybeAutosave();
    return text({ ok });
  });
  server.registerTool("redo", { description: "Redo the last undone edit." }, async () => {
    const ok = session.store.redo();
    await session.maybeAutosave();
    return text({ ok });
  });

  server.registerTool(
    "import_image",
    {
      description:
        "Import a PNG/JPG/WebP from disk as an image asset (size detected). Stored as a path relative to the project file, or embedded when `embed` is true or the project is unsaved.",
      inputSchema: { path: z.string(), name: z.string().optional(), embed: z.boolean().default(false) },
    },
    async (a) => {
      try {
        const abs = path.resolve(a.path);
        const buf = await readFile(abs);
        const img = await loadImage(buf);
        const ext = path.extname(abs).slice(1).toLowerCase().replace("jpg", "jpeg");
        const src =
          a.embed || !session.filePath
            ? `data:image/${ext};base64,${buf.toString("base64")}`
            : path.relative(session.baseDir, abs).split(path.sep).join("/");
        const result = session.store.apply("addImage", {
          name: a.name ?? path.basename(abs, path.extname(abs)),
          src,
          width: img.width,
          height: img.height,
        });
        await session.maybeAutosave();
        return text({ ok: true, ...(result as object), width: img.width, height: img.height });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "import_audio",
    {
      description:
        "Import a WAV/MP3/OGG file from disk as an audio asset plus a sound of the same name (on the sfx bus unless `bus` is given). Stored as a path relative to the project file, or embedded when `embed` is true or the project is unsaved. Then play it with add_audio_key, set_event_sound, set_state_sound or a playSound listener action.",
      inputSchema: {
        path: z.string(),
        name: z.string().optional(),
        embed: z.boolean().default(false),
        bus: z.string().optional(),
        loop: z.boolean().default(false),
      },
    },
    async (a) => {
      try {
        const abs = path.resolve(a.path);
        const buf = await readFile(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime = ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : ext === "ogg" || ext === "oga" ? "audio/ogg" : `audio/${ext}`;
        const src = a.embed || !session.filePath ? `data:${mime};base64,${buf.toString("base64")}` : path.relative(session.baseDir, abs).split(path.sep).join("/");
        const duration = wavDuration(buf);
        const result = session.store.apply("addAudio", {
          name: a.name ?? path.basename(abs, path.extname(abs)),
          src,
          duration,
          loop: a.loop,
          ...(a.bus ? { bus: a.bus } : {}),
        });
        await session.maybeAutosave();
        return text({ ok: true, ...(result as object), duration });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "pack_atlas",
    {
      description:
        "Pack every image into texture atlas pages (embedded PNGs) and store them with set_atlas, so renderers draw packed images (and shapes) from one texture: fewer WebGL draw calls. Re-run after adding images. With stripImageSources the file carries only the pages.",
      inputSchema: {
        padding: z.number().int().min(0).max(32).default(2).describe("Empty pixels around each image"),
        maxSize: z.number().int().min(16).max(8192).default(2048).describe("Largest page width/height"),
        powerOfTwo: z.boolean().default(true),
        stripImageSources: z.boolean().default(false),
      },
    },
    async (a) => {
      try {
        if (!session.doc.images.length) throw new Error("No images to pack");
        const atlas = await packAtlas(session, session.doc, { padding: a.padding, maxWidth: a.maxSize, maxHeight: a.maxSize, powerOfTwo: a.powerOfTwo });
        session.store.apply("setAtlas", { atlas, stripImageSources: a.stripImageSources });
        await session.maybeAutosave();
        return text({ ok: true, pages: atlas.pages.map((p) => `${p.id} ${p.width}x${p.height}`), regions: atlas.regions.length });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- Preview / verification ----------
  server.registerTool(
    "render_frame",
    {
      description:
        "Render the artboard to a PNG you can look at. Setup pose by default; or an animation at `time`; or a state machine after `steps`. Bones are drawn as blue wedges, bounding boxes dashed orange, clipping masks dashed violet.",
      inputSchema: {
        animation: z.string().optional(),
        time: z.number().min(0).optional(),
        stateMachine: z.string().optional().describe("State machine name (empty string = first)"),
        steps: z.array(stepSchema).optional(),
        skin: z.string().optional().describe("Skin (outfit) name to show; default skin only when omitted"),
        scale: z.number().positive().max(4).default(1),
        showBones: z.boolean().default(true),
        showBoundingBoxes: z.boolean().default(true),
        wireframe: z.boolean().default(false),
      },
    },
    async (a) => {
      try {
        const needsScripts = a.stateMachine !== undefined || !!a.steps;
        const { png, log } = await renderPng(session, a, needsScripts ? await scriptHost() : undefined);
        return {
          content: [
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
            ...(log.length ? [{ type: "text" as const, text: log.join("\n") }] : []),
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "render_gif",
    {
      description: "Render an animated GIF of an animation or state machine run, saved to `out` (and returned as an image).",
      inputSchema: {
        animation: z.string().optional(),
        stateMachine: z.string().optional(),
        skin: z.string().optional().describe("Skin (outfit) name to show; default skin only when omitted"),
        steps: z.array(stepSchema).optional().describe("State machine inputs over time (each step's advance is its duration)"),
        duration: z.number().positive().max(20).default(2),
        fps: z.number().int().min(1).max(60).default(20),
        scale: z.number().positive().max(2).default(0.5),
        showBones: z.boolean().default(false),
        out: z.string().optional().describe("Output path (default next to the project)"),
      },
    },
    async (a) => {
      try {
        const gif = await renderGif(session, a, await scriptHost());
        const { writeFile } = await import("node:fs/promises");
        const out = path.resolve(session.baseDir, a.out ?? `${(a.animation ?? a.stateMachine ?? "preview").replace(/\W+/g, "_")}.gif`);
        await writeFile(out, gif);
        return {
          content: [
            { type: "text" as const, text: `Saved ${out} (${(gif.length / 1024).toFixed(0)} KB)` },
            { type: "image" as const, data: gif.toString("base64"), mimeType: "image/gif" },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "simulate_state_machine",
    {
      description:
        "Run a state machine headlessly through steps (set inputs, fire triggers, pointer events, advance time) and get a log of state changes, events, input changes, audio commands and script output. Use to test interactivity.",
      inputSchema: { stateMachine: z.string().optional(), steps: z.array(stepSchema).min(1) },
    },
    async (a) => {
      try {
        const { log } = pose(session.doc, { stateMachine: a.stateMachine ?? "", steps: a.steps }, await scriptHost());
        return text(log.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "inspect_pose",
    {
      description: "World positions/rotations of bones (skeleton space, y-up) for the setup pose or an animation at a time.",
      inputSchema: { animation: z.string().optional(), time: z.number().min(0).optional(), bones: z.array(z.string()).optional() },
    },
    async (a) => {
      try {
        const { inst } = pose(session.doc, { animation: a.animation, time: a.time });
        const list = inst.skeleton.bones.filter((b) => !a.bones || a.bones.includes(b.data.name) || a.bones.includes(b.data.id));
        const r = (n: number) => Math.round(n * 100) / 100;
        return text(
          list.map((b) => ({
            bone: b.data.name,
            worldX: r(b.world.x),
            worldY: r(b.world.y),
            worldRotation: r(b.worldRotation),
            local: { x: r(b.x), y: r(b.y), rotation: r(b.applied.rotation) },
          })),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- Resources & prompts ----------
  server.registerResource("guide", "openbone://guide", { mimeType: "text/markdown", description: "Agent authoring guide" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }],
  }));
  server.registerResource("document", "openbone://document", { mimeType: "application/json", description: "The open document" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: serialize(session.doc) }],
  }));
  server.registerResource("summary", "openbone://summary", { mimeType: "text/plain", description: "Outline of the open document" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: summarize(session.doc) }],
  }));

  server.registerPrompt(
    "rig_character",
    { description: "Rig and animate a character", argsSchema: { description: z.string(), path: z.string() } },
    (a) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Using the OpenBone tools, create a project at ${a.path} and build: ${a.description}.\nRead get_guide first. Build the bone hierarchy, add shapes or images, add IK for limbs, create idle and walk animations that loop cleanly, then a state machine with a 'speed' number input blending idle→walk. Check with render_frame after each major step.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "interactive_button",
    { description: "Build an interactive animated button", argsSchema: { label: z.string(), path: z.string() } },
    (a) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Using the OpenBone tools, create a project at ${a.path}: an animated "${a.label}" button with idle, hover and press states driven by pointer listeners on a bounding box, and a 'clicked' event reported on click. Verify with simulate_state_machine using pointer steps, then render_frame.`,
          },
        },
      ],
    }),
  );

  return { server, session };
}

/** Seconds of PCM audio in a WAV file (0 for other formats or unreadable headers). */
function wavDuration(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
  let byteRate = 0;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt " && p + 16 <= buf.length) byteRate = buf.readUInt32LE(p + 16);
    if (id === "data") return byteRate ? Math.round((Math.min(size, buf.length - p - 8) / byteRate) * 1000) / 1000 : 0;
    p += 8 + size + (size % 2);
  }
  return 0;
}
