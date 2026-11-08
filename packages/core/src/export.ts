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
}

export interface ExportStats {
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
        for (const a of Object.values(atts)) if (a.type === "region" || a.type === "mesh") usedImages.add(a.image);
    d.images = d.images.filter((i) => usedImages.has(i.id));
    const usedEvents = new Set<Id>();
    for (const a of d.animations) for (const k of a.events) usedEvents.add(k.event);
    for (const sm of d.stateMachines) for (const li of sm.listeners) for (const a of li.actions) if (a.type === "reportEvent") usedEvents.add(a.event);
    d.events = d.events.filter((e) => usedEvents.has(e.id));
  }

  return {
    doc: d,
    warnings,
    stats: {
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
