import { PARTICLE_PRESETS, type ParticlePreset, type ParticlesAttachment, defaultParticleSettings, particlePreset } from "@openbone/core";
import { createSignal } from "solid-js";
import { doc, toast } from "./state.ts";

/**
 * Your own particle presets: an emitter's settings saved under a name, kept by the editor (not in the project), so
 * they show up in every project's "+ Particles…" and "Apply preset…" next to the built-in ones. A preset that uses an
 * image as its particle remembers the image by name and uses the image of that name in the open project.
 */

type Settings = Omit<ParticlesAttachment, "type" | "name">;
interface Stored {
  settings: Partial<Settings>;
  /** Name of the particle image (look = "image"). */
  imageName?: string;
}

const KEY = "openbone.particlePresets";
const read = (): Record<string, Stored> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Stored>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const [presets, setPresets] = createSignal<Record<string, Stored>>(read());
const write = (next: Record<string, Stored>) => {
  setPresets(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    toast("Couldn't save the preset (browser storage is full or blocked)", "error");
  }
};

export const BUILT_IN = Object.keys(PARTICLE_PRESETS) as ParticlePreset[];
export const userPresetNames = () => Object.keys(presets()).sort((a, b) => a.localeCompare(b));

/** Save an emitter's settings as a preset. Where it sits (position, direction) stays with each emitter. */
export function savePreset(name: string, att: ParticlesAttachment) {
  const { type: _t, name: _n, x: _x, y: _y, rotation: _r, image, ...settings } = structuredClone(att);
  const imageName = image ? doc().images.find((i) => i.id === image)?.name : undefined;
  write({ ...presets(), [name]: { settings, ...(imageName ? { imageName } : {}) } });
  toast(`Saved particle preset “${name}”: it's in “+ Particles…” and “Apply preset…” in every project`, "info");
}

export function deletePreset(name: string) {
  const next = { ...presets() };
  delete next[name];
  write(next);
}

/** Settings for a preset (built-in name, or one of yours), ready for addParticles / updateParticles. */
export function presetSettings(name: string): Partial<Settings> | null {
  if ((BUILT_IN as string[]).includes(name)) return particlePreset(name as ParticlePreset);
  const p = presets()[name];
  if (!p) return null;
  const out: Partial<Settings> = { ...defaultParticleSettings(), ...structuredClone(p.settings) };
  if (out.look === "image") {
    const img = p.imageName ? doc().images.find((i) => i.name === p.imageName) : undefined;
    if (img) out.image = img.id;
    else {
      // The image isn't in this project: a round particle instead, so the emitter still shows.
      out.look = "circle";
      delete out.image;
      toast(`Preset “${name}” uses the image “${p.imageName ?? "?"}”, which this project doesn't have: using round particles`, "info");
    }
  }
  return out;
}
