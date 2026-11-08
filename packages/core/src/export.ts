import { cloneDocument } from "./document.ts";
import type { Id, OpenBoneDocument } from "./types.ts";

/** What to put in an exported file. Lists hold ids; omitted = everything of that kind. */
export interface ExportOptions {
  animations?: Id[];
  stateMachines?: Id[];
  scripts?: Id[];
  /** Extra skins to keep (the default skin is always kept). */
  skins?: Id[];
  /** Drop images and events that nothing in the export uses. Default true. */
  pruneUnused?: boolean;
  /** Keep editor-only data (bone colours, state machine node positions). Default true. */
  nonessential?: boolean;
  /** Remove keys that change nothing and timelines that only repeat the setup pose. Default false. */
  cleanUpAnimations?: boolean;
}

export interface ExportStats {
  /** Keys removed by animation clean-up (whole removed timelines count all their keys). */
  removedKeys: number;
  bones: number;
  slots: number;
  skins: number;
  images: number;
  events: number;
  animations: number;
  stateMachines: number;
  scripts: number;
}

export interface ExportResult {
  doc: OpenBoneDocument;
  /** References that had to be cut because their target was left out. */
  warnings: string[];
  stats: ExportStats;
}

/**
 * Build a document containing only the chosen parts. The rig (bones, slots, constraints, default skin) is
 * always kept. References to left-out animations/scripts are removed (with a warning) so the result stays valid.
 */
export function exportDocument(source: OpenBoneDocument, opts: ExportOptions = {}): ExportResult {
  const d = cloneDocument(source);
  const warnings: string[] = [];
  const keep = <T extends { id: Id }>(list: T[], ids?: Id[]) => (ids ? list.filter((x) => ids.includes(x.id)) : list);
  const name = (list: { id: Id; name: string }[], id: Id) => list.find((x) => x.id === id)?.name ?? id;

  const [defaultSkin, ...extraSkins] = d.skeleton.skins;
  d.skeleton.skins = defaultSkin ? [defaultSkin, ...keep(extraSkins, opts.skins)] : [];
  d.animations = keep(d.animations, opts.animations);
  d.stateMachines = keep(d.stateMachines, opts.stateMachines);
  d.scripts = keep(d.scripts, opts.scripts);

  const animIds = new Set(d.animations.map((a) => a.id));
  const scriptIds = new Set(d.scripts.map((s) => s.id));
  const srcAnim = (id: Id) => name(source.animations, id);
  const srcScript = (id: Id) => name(source.scripts, id);

  for (const sm of d.stateMachines) {
    const dropScripts = (ids: Id[] | undefined, where: string) =>
      ids?.filter((id) => {
        if (scriptIds.has(id)) return true;
        warnings.push(`${where} ran script "${srcScript(id)}", which is not exported`);
        return false;
      });
    sm.scripts = dropScripts(sm.scripts, `State machine "${sm.name}"`) ?? [];
    for (const layer of sm.layers)
      for (const st of layer.states) {
        const where = `State "${st.name}" in "${sm.name}"`;
        if (st.animation && !animIds.has(st.animation)) {
          warnings.push(`${where} played animation "${srcAnim(st.animation)}", which is not exported`);
          delete st.animation;
        }
        if (st.blend) {
          st.blend = st.blend.filter((b) => {
            if (animIds.has(b.animation)) return true;
            warnings.push(`${where} blended animation "${srcAnim(b.animation)}", which is not exported`);
            return false;
          });
        }
        if (st.scripts) st.scripts = dropScripts(st.scripts, where);
      }
    for (const li of sm.listeners)
      li.actions = li.actions.filter((a) => {
        if (a.type !== "runScript" || scriptIds.has(a.script)) return true;
        warnings.push(`Listener "${li.name}" in "${sm.name}" ran script "${srcScript(a.script)}", which is not exported`);
        return false;
      });
  }

  if (opts.pruneUnused !== false) {
    const usedImages = new Set<Id>();
    for (const skin of d.skeleton.skins)
      for (const atts of Object.values(skin.attachments))
        for (const a of Object.values(atts)) {
          if (a.type === "region" || a.type === "mesh") usedImages.add(a.image);
          else if (a.type === "sequence") for (const f of a.frames) usedImages.add(f.image);
        }
    d.images = d.images.filter((i) => usedImages.has(i.id));
    if (d.atlas) {
      // Keep only pages that still hold a used image (the white block alone is not worth a page).
      // The atlas object is shared with the source document, so build a new one.
      const regions = d.atlas.regions.filter((r) => usedImages.has(r.image));
      const pages = new Set(regions.map((r) => r.page));
      const { white, ...rest } = d.atlas;
      d.atlas = { ...rest, regions, pages: d.atlas.pages.filter((p) => pages.has(p.id)), ...(white && pages.has(white.page) ? { white } : {}) };
      if (!d.atlas.pages.length) delete d.atlas;
    }
    const usedEvents = new Set<Id>();
    for (const a of d.animations) for (const k of a.events) usedEvents.add(k.event);
    for (const sm of d.stateMachines) for (const li of sm.listeners) for (const a of li.actions) if (a.type === "reportEvent") usedEvents.add(a.event);
    d.events = d.events.filter((e) => usedEvents.has(e.id));
  }

  const removedKeys = opts.cleanUpAnimations ? cleanUpAnimations(d) : 0;
  if (opts.nonessential === false) {
    for (const b of d.skeleton.bones) delete b.color;
    for (const sm of d.stateMachines) for (const l of sm.layers) for (const st of l.states) st.x = st.y = 0;
  }

  return {
    doc: d,
    warnings,
    stats: {
      removedKeys,
      bones: d.skeleton.bones.length,
      slots: d.skeleton.slots.length,
      skins: d.skeleton.skins.length,
      images: d.images.length,
      events: d.events.length,
      animations: d.animations.length,
      stateMachines: d.stateMachines.length,
      scripts: d.scripts.length,
    },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Drop keys whose neighbours hold the same value (the segment is constant either way, whatever the curves),
 * then timelines whose every key equals the setup pose. Mutates `d`; returns how many keys were removed.
 */
export function cleanUpAnimations(d: OpenBoneDocument): number {
  let removed = 0;
  const bones = new Map(d.skeleton.bones.map((b) => [b.id, b]));
  const slots = new Map(d.skeleton.slots.map((s) => [s.id, s]));
  const ik = new Map(d.skeleton.ik.map((c) => [c.id, c]));
  const setupValue = (tl: OpenBoneDocument["animations"][number]["timelines"][number]): { known: boolean; value?: unknown } => {
    switch (tl.target) {
      case "bone": {
        const b = bones.get(tl.id);
        return b ? { known: true, value: b[tl.property] } : { known: false };
      }
      case "slot": {
        const s = slots.get(tl.id);
        if (!s) return { known: false };
        return { known: true, value: tl.property === "color" ? s.color : s.attachment };
      }
      case "ik": {
        const c = ik.get(tl.id);
        return c ? { known: true, value: c.mix } : { known: false };
      }
      case "drawOrder":
        return { known: true, value: d.skeleton.slots.map((s) => s.id) };
      default:
        return { known: false };
    }
  };
  for (const anim of d.animations) {
    anim.timelines = anim.timelines.filter((tl) => {
      const keys = tl.keys as { time: number; value: unknown }[];
      const kept = keys.filter((k, i) => !(i > 0 && i < keys.length - 1 && same(keys[i - 1].value, k.value) && same(keys[i + 1].value, k.value)));
      removed += keys.length - kept.length;
      (tl as { keys: unknown[] }).keys = kept;
      const allSame = kept.every((k) => same(k.value, kept[0].value));
      let atSetup = false;
      if (allSame && kept.length) {
        if (tl.target === "deform") atSetup = (kept[0].value as number[]).every((v) => v === 0);
        else {
          const s = setupValue(tl);
          atSetup = s.known && same(s.value, kept[0].value);
        }
      }
      if (atSetup) removed += kept.length;
      return !atSetup;
    });
  }
  return removed;
}
