/**
 * The example projects as the site shows them: read from examples/*.obone at build time (size, background, state
 * machine inputs), plus a line of copy and which inputs get a control.
 */
import fs from "node:fs";
import path from "node:path";

const EXAMPLES = path.resolve(process.cwd(), "../../examples");

export interface ExampleInput {
  name: string;
  type: "bool" | "number" | "trigger" | "string";
  value?: unknown;
  min?: number;
  max?: number;
}

export interface Example {
  id: string;
  title: string;
  blurb: string;
  tags: string[];
  /** Tell the visitor what to click on the artwork itself. */
  hint?: string;
  width: number;
  height: number;
  background: string | null;
  stateMachine: string | null;
  animations: string[];
  inputs: ExampleInput[];
}

interface Copy {
  title: string;
  blurb: string;
  tags: string[];
  hint?: string;
  /** Inputs that get no control (driven by the file's own listeners or scripts). */
  hide?: string[];
  ranges?: Record<string, [number, number]>;
}

const COPY: Record<string, Copy> = {
  windswept: {
    title: "Windswept",
    blurb: "Physics hair and skirt, a wind-blown tree and grass, fog, petals and gulls, two Japanese lines lip-synced with subtitles, music and ambience.",
    tags: ["Physics", "Lip sync", "Particles", "Audio"],
    hint: "Click the buttons on the left of the artwork",
    hide: ["hoverTalk", "hoverGull", "hoverGust"],
  },
  walker: {
    title: "Walker",
    blurb: "IK legs, a scarf mesh, an idle/walk blend eased by a script, a jump and a forest scrolling in parallax.",
    tags: ["IK", "Blend", "Script"],
    hint: "Click the path to walk, click him to jump",
    hide: ["speed"],
  },
  knight: {
    title: "Knight",
    blurb: "Walks along a scrolling castle road, attacks with a swing and a clang, salutes with a spoken greeting.",
    tags: ["IK legs", "Parallax", "Audio"],
    hint: "Click the road to walk, him to attack, the helmet to salute",
  },
  fox: { title: "Pip the fox", blurb: "A real recorded voice with mouth shapes keyed by lip sync.", tags: ["Lip sync", "Audio"], hint: "Click the head" },
  robot: { title: "Robot", blurb: "A painted robot whose screen face is lip-synced to a robot voice.", tags: ["Lip sync", "Audio"], hint: "Click the robot" },
  tail: {
    title: "Tail",
    blurb: "A painted tail mesh bending along a path, spring antennae, and a camera pan on a second state-machine layer.",
    tags: ["Path", "Mesh", "Physics"],
    hint: "Click the creature",
  },
  rocket: { title: "Rocket", blurb: "Particles, ignition and engine sounds, and a landing back on the pad.", tags: ["Particles", "Audio"], hint: "Click the rocket to launch" },
  crash: {
    title: "Crash game",
    blurb: "A staged flow (idle → fly-out → flying → crash or cash-out), a live multiplier text and input bindings driving the parallax.",
    tags: ["Stages", "Bindings", "Text"],
    hint: "Press START, then drag the multiplier",
    hide: ["status"],
    ranges: { multiplier: [1, 25] },
  },
  button: { title: "Button", blurb: "A state machine with a clipping mask, hover and click sounds.", tags: ["Listeners", "Clipping"], hint: "Hover and click it", hide: ["hover"] },
  campfire: { title: "Campfire", blurb: "Sprite-sequence flames, flickering firelight, a bending flame mesh and a crackle loop.", tags: ["Sequences", "Mesh", "Audio"] },
};

/** Gallery order. */
export const EXAMPLE_IDS = ["windswept", "knight", "walker", "crash", "rocket", "tail", "fox", "robot", "button", "campfire"];

interface Doc {
  width: number;
  height: number;
  background?: string | null;
  animations?: { name: string }[];
  stateMachines?: { name: string; inputs?: { name: string; type: ExampleInput["type"]; value?: unknown; default?: unknown }[] }[];
}

const cache = new Map<string, Example>();

export function getExample(id: string): Example {
  const hit = cache.get(id);
  if (hit) return hit;
  const doc = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${id}.obone`), "utf8")) as Doc;
  const copy = COPY[id] ?? { title: id, blurb: "", tags: [] };
  const sm = doc.stateMachines?.[0];
  const inputs = (sm?.inputs ?? [])
    .filter((i) => !copy.hide?.includes(i.name))
    .map((i): ExampleInput => {
      const r = copy.ranges?.[i.name];
      return { name: i.name, type: i.type, value: i.value ?? i.default, ...(r ? { min: r[0], max: r[1] } : {}) };
    });
  const ex: Example = {
    id,
    title: copy.title,
    blurb: copy.blurb,
    tags: copy.tags,
    hint: copy.hint,
    width: doc.width,
    height: doc.height,
    background: doc.background ?? null,
    stateMachine: sm?.name ?? null,
    animations: (doc.animations ?? []).map((a) => a.name),
    inputs,
  };
  cache.set(id, ex);
  return ex;
}

export const allExamples = () => EXAMPLE_IDS.map(getExample);

/** A site URL under the deploy base. */
export function url(p: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/${p.replace(/^\//, "")}`;
}
