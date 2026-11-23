import type { Id, OpenBoneDocument, TransformChannel } from "./types.ts";
import { type Issue, issueFix, validate } from "./validate.ts";

/**
 * Everything the editor's Problems panel lists: `validate()` (errors and warnings that matter for loading and
 * exporting) plus advisory hints that never block an export: unused images, empty skins and animations, settings
 * that have no effect. Hints are level "warning" with `hint: true`.
 */
export function findProblems(d: OpenBoneDocument): (Issue & { hint?: boolean })[] {
  return [...validate(d), ...hints(d).map((h) => ({ ...h, hint: true }))];
}

export function hints(d: OpenBoneDocument): Issue[] {
  const out: Issue[] = [];
  const hint = (path: string, message: string, x: Pick<Issue, "ref" | "fix"> = {}) => out.push({ level: "warning", path, message, ...x });
  const sk = d.skeleton;

  // Images no attachment shows (the same rule as the export's "leave out unused images").
  const used = new Set<Id>();
  for (const skin of sk.skins)
    for (const atts of Object.values(skin.attachments))
      for (const a of Object.values(atts)) {
        if ((a.type === "region" || a.type === "mesh" || a.type === "particles") && a.image) used.add(a.image);
        else if (a.type === "sequence") for (const f of a.frames) used.add(f.image);
      }
  for (const img of d.images)
    if (!used.has(img.id))
      hint(`image ${img.name}`, "is not used by any attachment", { ref: { kind: "image", id: img.id }, fix: issueFix(`Delete image "${img.name}"`, "deleteImage", { image: img.id }) });

  sk.skins.forEach((skin, i) => {
    if (i === 0 || skin.name === "default") return;
    if (!Object.values(skin.attachments).some((x) => Object.keys(x).length) && !skin.bones?.length && !skin.constraints?.length)
      hint(`skin ${skin.name}`, "is empty", { fix: issueFix(`Delete skin "${skin.name}"`, "deleteSkin", { skin: skin.id }) });
  });

  for (const a of d.animations)
    if (!a.timelines.some((t) => t.keys.length) && !a.events.length && !a.audio?.length)
      hint(`animation ${a.name}`, "has no keys", { ref: { kind: "animation", id: a.id } });

  for (const c of sk.ik)
    if (c.volume && c.uniform)
      hint(`constraint ${c.name}`, "Volume has no effect while Uniform is on", { ref: { kind: "ik", id: c.id }, fix: issueFix("Turn Volume off", "updateIkConstraint", { constraint: c.id, volume: false }) });
  for (const c of sk.physics)
    if (c.volume && !(c.scaleX > 0))
      hint(`physics constraint ${c.name}`, "Volume has no effect while Stretch is 0", { ref: { kind: "physics", id: c.id }, fix: issueFix("Turn Volume off", "updatePhysicsConstraint", { constraint: c.id, volume: false }) });

  // A mapping that writes a property whose mix is 0 (and no animation keys that mix) does nothing.
  const mixOf: Record<TransformChannel, "mixRotate" | "mixTranslate" | "mixScale" | "mixShear"> = {
    rotation: "mixRotate",
    x: "mixTranslate",
    y: "mixTranslate",
    scaleX: "mixScale",
    scaleY: "mixScale",
    shearY: "mixShear",
  };
  for (const c of sk.transform) {
    if (!c.map?.length) continue;
    const keyed = new Set(d.animations.flatMap((a) => a.timelines.filter((t) => t.target === "transform" && t.id === c.id).map((t) => t.property)));
    const dead = [...new Set(c.map.map((m) => m.to))].filter((to) => !(c[mixOf[to]] > 0) && !keyed.has(mixOf[to]));
    if (dead.length)
      hint(`constraint ${c.name}`, `mapping writes ${dead.join(", ")} but ${[...new Set(dead.map((t) => mixOf[t]))].join(", ")} is 0`, {
        ref: { kind: "transform", id: c.id },
        fix: issueFix("Set those mixes to 1", "updateTransformConstraint", { constraint: c.id, ...Object.fromEntries(dead.map((t) => [mixOf[t], 1])) }),
      });
  }
  return out;
}
