import { defaultSkin } from "./document.ts";
import type { Id, MeshAttachment, OpenBoneDocument, SkinData } from "./types.ts";

/** Linked meshes: meshes that share another mesh's geometry and weights (see MeshAttachment.linked). */

/** The parent mesh of a linked mesh found at (skin, slot), or null when it is gone. */
export function linkedParent(doc: OpenBoneDocument, skin: SkinData, slotId: Id, mesh: MeshAttachment): MeshAttachment | null {
  const l = mesh.linked;
  if (!l) return null;
  const slot = l.slot ?? slotId;
  const skins = l.skin ? doc.skeleton.skins.filter((k) => k.id === l.skin) : [skin, defaultSkin(doc), ...doc.skeleton.skins];
  for (const k of skins) {
    const p = k.attachments[slot]?.[l.mesh];
    if (p && p !== mesh && p.type === "mesh" && !p.linked) return p;
  }
  return null;
}

const GEOMETRY = ["vertices", "uvs", "triangles", "hull", "weights"] as const;

/**
 * Copy each linked mesh's parent geometry into it (after every op, so renderers, exports and other runtimes read a
 * complete mesh). A linked mesh whose parent was deleted keeps its last geometry and becomes a normal mesh.
 * Returns how many linked meshes changed.
 */
export function syncLinkedMeshes(doc: OpenBoneDocument): number {
  let changed = 0;
  for (const skin of doc.skeleton.skins)
    for (const [slotId, atts] of Object.entries(skin.attachments))
      for (const att of Object.values(atts)) {
        if (att.type !== "mesh" || !att.linked) continue;
        const parent = linkedParent(doc, skin, slotId, att);
        if (!parent) {
          delete att.linked;
          changed++;
          continue;
        }
        for (const k of GEOMETRY) {
          const v = parent[k];
          if (JSON.stringify(v) === JSON.stringify(att[k])) continue;
          if (v === undefined) delete att[k];
          else (att as unknown as Record<string, unknown>)[k] = structuredClone(v);
          changed++;
        }
      }
  return changed;
}

/** True when the document has any linked mesh (cheap check before syncing). */
export function hasLinkedMeshes(doc: OpenBoneDocument): boolean {
  for (const skin of doc.skeleton.skins) for (const atts of Object.values(skin.attachments)) for (const a of Object.values(atts)) if (a.type === "mesh" && a.linked) return true;
  return false;
}
