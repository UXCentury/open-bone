import { z } from "zod";
import { attachmentOwner, defaultSkin, descendantIds, get, getAttachment, newId, sortBones } from "../document.ts";
import { distToSegmentSq, gridMesh, shapeOutline, triangulate } from "../geometry.ts";
import { smoothKnots } from "../path.ts";
import { apply as applyM, invert, worldRotation } from "../math.ts";
import { setupWorld } from "../setup.ts";
import type { Attachment, BoneData, OpenBoneDocument, SkinData, VertexWeight } from "../types.ts";
import { defineOp, hex, optId, ref } from "./registry.ts";
import { checkSequenceProps } from "./sequence-props.ts";

const inherit = z.enum(["normal", "onlyTranslation", "noRotation", "noScale"]);
const blend = z.enum(["normal", "additive", "multiply", "screen"]);

const boneProps = {
  length: z.number().min(0).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  rotation: z.number().optional().describe("Degrees, counter-clockwise, relative to parent"),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  shearX: z.number().optional(),
  shearY: z.number().optional(),
  inherit: inherit.optional(),
  color: hex.optional(),
};

function uniqueName(existing: { name: string }[], base: string): string {
  if (!existing.some((e) => e.name === base)) return base;
  let i = 2;
  while (existing.some((e) => e.name === `${base}${i}`)) i++;
  return `${base}${i}`;
}

defineOp({
  name: "addBone",
  group: "rig",
  description:
    "Add a bone. Position/rotation are local to the parent (y-up, degrees CCW). Parent defaults to the root bone.",
  schema: z.object({ id: optId, name: z.string().optional(), parent: ref("Parent bone").nullable().optional(), ...boneProps }),
  apply(doc, a) {
    const bones = doc.skeleton.bones;
    const parent = a.parent === null ? null : a.parent ? get.bone(doc, a.parent).id : (bones[0]?.id ?? null);
    const id = (a.id ??= newId("bone"));
    const name = (a.name = uniqueName(bones, a.name ?? "bone"));
    const bone: BoneData = {
      id,
      name,
      parent,
      length: a.length ?? 50,
      x: a.x ?? 0,
      y: a.y ?? 0,
      rotation: a.rotation ?? 0,
      scaleX: a.scaleX ?? 1,
      scaleY: a.scaleY ?? 1,
      shearX: a.shearX ?? 0,
      shearY: a.shearY ?? 0,
      inherit: a.inherit ?? "normal",
      ...(a.color ? { color: a.color } : {}),
    };
    bones.push(bone);
    return { id, name };
  },
});

defineOp({
  name: "updateBone",
  group: "rig",
  description: "Change a bone's setup pose, name or parent.",
  schema: z.object({ bone: ref("Bone"), name: z.string().optional(), parent: ref("Parent bone").nullable().optional(), ...boneProps }),
  apply(doc, a) {
    const b = get.bone(doc, a.bone);
    const { bone: _, parent, name, ...rest } = a;
    if (name && name !== b.name) {
      if (doc.skeleton.bones.some((x) => x.name === name)) throw new Error(`Bone name "${name}" already used`);
      b.name = name;
    }
    if (parent !== undefined) {
      const pid = parent === null ? null : get.bone(doc, parent).id;
      if (pid && descendantIds(doc, b.id).has(pid)) throw new Error("Cannot parent a bone to its own descendant");
      b.parent = pid;
      sortBones(doc);
    }
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (b as unknown as Record<string, unknown>)[k] = v;
    return {};
  },
});

defineOp({
  name: "deleteBone",
  group: "rig",
  description: "Delete a bone with all its descendant bones, their slots and any constraints/timelines that reference them.",
  schema: z.object({ bone: ref("Bone") }),
  apply(doc, a) {
    const b = get.bone(doc, a.bone);
    if (b.parent === null && doc.skeleton.bones.filter((x) => x.parent === null).length === 1)
      throw new Error("Cannot delete the only root bone");
    const ids = descendantIds(doc, b.id);
    const slotIds = new Set(doc.skeleton.slots.filter((s) => ids.has(s.bone)).map((s) => s.id));
    const sk = doc.skeleton;
    sk.bones = sk.bones.filter((x) => !ids.has(x.id));
    sk.slots = sk.slots.filter((s) => !slotIds.has(s.id));
    for (const skin of sk.skins) for (const sid of slotIds) delete skin.attachments[sid];
    sk.ik = sk.ik.filter((c) => !c.bones.some((x) => ids.has(x)) && !ids.has(c.target));
    sk.transform = sk.transform.filter((c) => !c.bones.some((x) => ids.has(x)) && !ids.has(c.target));
    sk.path = sk.path.filter((c) => !c.bones.some((x) => ids.has(x)) && !slotIds.has(c.target));
    sk.physics = sk.physics.filter((c) => !ids.has(c.bone));
    dropConstraintTimelines(doc);
    for (const anim of doc.animations)
      anim.timelines = anim.timelines.filter(
        (t) => !(t.target === "bone" && ids.has(t.id)) && !((t.target === "slot" || t.target === "deform" || t.target === "sequence") && slotIds.has(t.id)),
      );
    for (const sm of doc.stateMachines) for (const l of sm.listeners) if (l.slot && slotIds.has(l.slot)) l.slot = null;
    return { deletedBones: ids.size, deletedSlots: slotIds.size };
  },
});

// ---------------- Slots ----------------

defineOp({
  name: "addSlot",
  group: "rig",
  description: "Add a slot (a draw-order layer attached to a bone that displays one attachment). Appended on top of the draw order unless index given.",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bone: ref("Bone"),
    color: hex.optional(),
    blend: blend.optional(),
    index: z.number().int().min(0).optional().describe("Draw order position (0 = back)"),
  }),
  apply(doc, a) {
    const bone = get.bone(doc, a.bone);
    const id = (a.id ??= newId("slot"));
    const name = (a.name = uniqueName(doc.skeleton.slots, a.name ?? bone.name));
    const slot = { id, name, bone: bone.id, color: a.color ?? "#ffffff", attachment: null, blend: a.blend ?? "normal" } as const;
    const slots = doc.skeleton.slots;
    if (a.index === undefined || a.index >= slots.length) slots.push({ ...slot });
    else slots.splice(a.index, 0, { ...slot });
    return { id, name };
  },
});

defineOp({
  name: "updateSlot",
  group: "rig",
  description: "Change a slot's name, bone, tint color, blend mode, visible attachment (null to hide) or draw-order index.",
  schema: z.object({
    slot: ref("Slot"),
    name: z.string().optional(),
    bone: ref("Bone").optional(),
    color: hex.optional(),
    blend: blend.optional(),
    attachment: z.string().nullable().optional(),
    index: z.number().int().min(0).optional(),
  }),
  apply(doc, a) {
    const s = get.slot(doc, a.slot);
    if (a.name) s.name = a.name;
    if (a.bone) s.bone = get.bone(doc, a.bone).id;
    if (a.color) s.color = a.color;
    if (a.blend) s.blend = a.blend;
    if (a.attachment !== undefined) s.attachment = a.attachment;
    if (a.index !== undefined) {
      const slots = doc.skeleton.slots;
      slots.splice(slots.indexOf(s), 1);
      slots.splice(Math.min(a.index, slots.length), 0, s);
    }
    return {};
  },
});

defineOp({
  name: "deleteSlot",
  group: "rig",
  description: "Delete a slot and its attachments.",
  schema: z.object({ slot: ref("Slot") }),
  apply(doc, a) {
    const s = get.slot(doc, a.slot);
    doc.skeleton.slots = doc.skeleton.slots.filter((x) => x !== s);
    for (const skin of doc.skeleton.skins) {
      delete skin.attachments[s.id];
      // Masks that ended at this slot now clip to the end of the draw order.
      for (const atts of Object.values(skin.attachments))
        for (const att of Object.values(atts)) if (att.type === "clipping" && att.end === s.id) att.end = null;
    }
    doc.skeleton.path = doc.skeleton.path.filter((c) => c.target !== s.id);
    dropConstraintTimelines(doc);
    for (const anim of doc.animations)
      anim.timelines = anim.timelines.filter((t) => !((t.target === "slot" || t.target === "deform" || t.target === "sequence") && t.id === s.id));
    return {};
  },
});

defineOp({
  name: "addSkin",
  group: "rig",
  description: "Add a skin (an alternative set of attachments, e.g. outfits).",
  schema: z.object({ id: optId, name: z.string() }),
  apply(doc, a) {
    assertSkinName(doc, a.name);
    const id = (a.id ??= newId("skin"));
    doc.skeleton.skins.push({ id, name: a.name, attachments: {} });
    return { id };
  },
});

function nonDefaultSkin(doc: OpenBoneDocument, ref: string, action: string): SkinData {
  const skin = get.skin(doc, ref);
  if (skin === defaultSkin(doc)) throw new Error(`The default skin cannot be ${action}`);
  return skin;
}

function assertSkinName(doc: OpenBoneDocument, name: string, except?: SkinData) {
  if (!name.trim()) throw new Error("Skin name cannot be empty");
  if (doc.skeleton.skins.some((s) => s !== except && s.name === name)) throw new Error(`A skin named "${name}" already exists`);
}

defineOp({
  name: "renameSkin",
  group: "rig",
  description: "Rename a skin. The default skin (the first one) keeps its name.",
  schema: z.object({ skin: ref("Skin"), name: z.string() }),
  apply(doc, a) {
    const skin = nonDefaultSkin(doc, a.skin, "renamed");
    assertSkinName(doc, a.name, skin);
    skin.name = a.name;
    return {};
  },
});

defineOp({
  name: "deleteSkin",
  group: "rig",
  description: "Delete a skin and all of its attachments. The default skin cannot be deleted.",
  schema: z.object({ skin: ref("Skin") }),
  apply(doc, a) {
    const skin = nonDefaultSkin(doc, a.skin, "deleted");
    doc.skeleton.skins = doc.skeleton.skins.filter((s) => s !== skin);
    return {};
  },
});

defineOp({
  name: "duplicateSkin",
  group: "rig",
  description: "Copy a skin (all its attachments) into a new skin, e.g. to start a new outfit from an existing one.",
  schema: z.object({ id: optId, skin: ref("Skin"), name: z.string() }),
  apply(doc, a) {
    const src = get.skin(doc, a.skin);
    assertSkinName(doc, a.name);
    const id = (a.id ??= newId("skin"));
    doc.skeleton.skins.push({ id, name: a.name, attachments: structuredClone(src.attachments) });
    return { id };
  },
});

defineOp({
  name: "copyAttachment",
  group: "attachment",
  description:
    "Copy an attachment from one skin to another (and optionally to another slot or name). Copying a default-skin attachment into an outfit skin under the same name makes the outfit override it.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    fromSkin: ref("Skin").optional().describe("Defaults to the default skin"),
    toSkin: ref("Skin"),
    toSlot: ref("Slot").optional().describe("Defaults to the same slot"),
    name: z.string().optional().describe("New attachment name (defaults to the same name)"),
  }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const from = a.fromSkin ? get.skin(doc, a.fromSkin) : defaultSkin(doc);
    const to = get.skin(doc, a.toSkin);
    const toSlot = a.toSlot ? get.slot(doc, a.toSlot) : slot;
    const att = from.attachments[slot.id]?.[a.attachment];
    if (!att) throw new Error(`Attachment "${a.attachment}" not found on slot "${slot.name}" in skin "${from.name}"`);
    const name = a.name ?? att.name;
    if (from === to && toSlot === slot && name === att.name) throw new Error("Source and destination are the same");
    (to.attachments[toSlot.id] ??= {})[name] = { ...structuredClone(att), name };
    return { slot: toSlot.id, name, skin: to.id };
  },
});

// ---------------- Attachments ----------------

export function putAttachment(doc: OpenBoneDocument, slotRef: string, skinRef: string | undefined, att: Attachment, activate: boolean) {
  const slot = get.slot(doc, slotRef);
  const skin: SkinData = skinRef ? get.skin(doc, skinRef) : defaultSkin(doc);
  (skin.attachments[slot.id] ??= {})[att.name] = att;
  if (activate) slot.attachment = att.name;
  return { slot: slot.id, name: att.name, skin: skin.id };
}

export const attTarget = {
  slot: ref("Slot"),
  name: z.string().optional().describe("Attachment name (defaults to the image/shape name)"),
  skin: ref("Skin").optional().describe("Defaults to the default skin"),
  activate: z.boolean().default(true).describe("Show this attachment in the slot's setup pose"),
};
const placement = {
  x: z.number().default(0),
  y: z.number().default(0),
  rotation: z.number().default(0),
};

defineOp({
  name: "addRegion",
  group: "attachment",
  description: "Attach an image (textured quad) to a slot. Offset/rotation are relative to the slot's bone.",
  schema: z.object({
    ...attTarget,
    image: ref("Image"),
    ...placement,
    scaleX: z.number().default(1),
    scaleY: z.number().default(1),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    color: hex.default("#ffffff"),
  }),
  apply(doc, a) {
    const img = get.image(doc, a.image);
    return putAttachment(
      doc,
      a.slot,
      a.skin,
      {
        type: "region",
        name: a.name ?? img.name,
        image: img.id,
        x: a.x,
        y: a.y,
        rotation: a.rotation,
        scaleX: a.scaleX,
        scaleY: a.scaleY,
        width: a.width ?? img.width,
        height: a.height ?? img.height,
        color: a.color,
      },
      a.activate,
    );
  },
});

defineOp({
  name: "addShape",
  group: "attachment",
  description: "Attach a vector shape (rect, ellipse or polygon) to a slot; no image needed. Great for quick prototypes and UI.",
  schema: z.object({
    ...attTarget,
    shape: z.enum(["rect", "ellipse", "polygon"]),
    ...placement,
    width: z.number().min(0).default(50),
    height: z.number().min(0).default(50),
    radius: z.number().min(0).default(0).describe("Rect corner radius"),
    points: z.array(z.number()).optional().describe("Polygon points flat [x0,y0,x1,y1,...] (polygon only)"),
    fill: hex.default("#cccccc"),
    stroke: hex.optional(),
    strokeWidth: z.number().min(0).optional(),
  }),
  apply(doc, a) {
    const { slot, skin, activate, name, ...rest } = a;
    return putAttachment(doc, slot, skin, { type: "shape", name: name ?? a.shape, ...rest }, activate);
  },
});

defineOp({
  name: "addMesh",
  group: "attachment",
  description:
    "Attach a deformable mesh. Either give a grid (cols x rows over the image, centred at x,y) or explicit vertices/uvs/triangles.",
  schema: z.object({
    ...attTarget,
    image: ref("Image"),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    cols: z.number().int().min(1).max(64).default(4),
    rows: z.number().int().min(1).max(64).default(4),
    vertices: z.array(z.number()).optional(),
    uvs: z.array(z.number()).optional(),
    triangles: z.array(z.number().int()).optional(),
    hull: z.number().int().optional(),
    color: hex.default("#ffffff"),
  }),
  apply(doc, a) {
    const img = get.image(doc, a.image);
    let mesh: { vertices: number[]; uvs: number[]; triangles: number[]; hull: number };
    if (a.vertices && a.uvs && a.triangles) {
      mesh = { vertices: a.vertices, uvs: a.uvs, triangles: a.triangles, hull: a.hull ?? a.vertices.length / 2 };
      if (a.uvs.length !== a.vertices.length) throw new Error("uvs and vertices must have the same length");
    } else {
      mesh = gridMesh(a.width ?? img.width, a.height ?? img.height, a.cols, a.rows, a.x, a.y);
    }
    return putAttachment(
      doc,
      a.slot,
      a.skin,
      { type: "mesh", name: a.name ?? img.name, image: img.id, ...mesh, color: a.color },
      a.activate,
    );
  },
});

defineOp({
  name: "addBoundingBox",
  group: "attachment",
  description: "Attach a bounding-box polygon (hit area for listeners/pointer events). Give vertices or a rect.",
  schema: z.object({
    ...attTarget,
    activate: z.boolean().default(false),
    vertices: z.array(z.number()).optional(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  }),
  apply(doc, a) {
    let v = a.vertices;
    if (!v) {
      const w = (a.width ?? 100) / 2;
      const h = (a.height ?? 100) / 2;
      v = [a.x - w, a.y - h, a.x + w, a.y - h, a.x + w, a.y + h, a.x - w, a.y + h];
    }
    return putAttachment(doc, a.slot, a.skin, { type: "boundingBox", name: a.name ?? "hitbox", vertices: v }, a.activate);
  },
});

defineOp({
  name: "addClipping",
  group: "attachment",
  description:
    "Add a clipping mask to a slot. It is not drawn; the slots after it in draw order, up to and including `end`, are clipped to its outline (e.g. keep a shine sweep inside a rounded button). Give a rect/ellipse (width, height, radius) or polygon points, or raw vertices.",
  schema: z.object({
    ...attTarget,
    shape: z.enum(["rect", "ellipse", "polygon"]).default("rect"),
    ...placement,
    width: z.number().positive().default(100),
    height: z.number().positive().default(100),
    radius: z.number().min(0).default(0).describe("Rect corner radius"),
    points: z.array(z.number()).optional().describe("Polygon points flat [x0,y0,...] (shape polygon)"),
    vertices: z.array(z.number()).optional().describe("Raw outline flat [x0,y0,...] in slot-bone space; overrides shape"),
    end: ref("Last clipped slot").nullable().default(null).describe("Last slot that is clipped; null = every slot drawn after this one"),
  }),
  apply(doc, a) {
    const vertices =
      a.vertices ??
      shapeOutline({ type: "shape", name: "", shape: a.shape, x: a.x, y: a.y, rotation: a.rotation, width: a.width, height: a.height, radius: a.radius, points: a.points, fill: "#000" }).map(
        (v) => Math.round(v * 1000) / 1000,
      );
    checkClipPolygon(vertices);
    const end = a.end === null ? null : get.slot(doc, a.end).id;
    return putAttachment(doc, a.slot, a.skin, { type: "clipping", name: a.name ?? "mask", vertices, end }, a.activate);
  },
});

function checkClipPolygon(v: unknown) {
  if (!Array.isArray(v) || v.length < 6 || v.length % 2 || v.some((x) => typeof x !== "number" || !Number.isFinite(x)))
    throw new Error("A clipping outline needs at least 3 points as a flat [x0,y0,x1,y1,...] array");
}

defineOp({
  name: "addPoint",
  group: "attachment",
  description: "Attach a point (a named locator, e.g. a gun muzzle) to a slot.",
  schema: z.object({ ...attTarget, activate: z.boolean().default(false), ...placement }),
  apply(doc, a) {
    return putAttachment(
      doc,
      a.slot,
      a.skin,
      { type: "point", name: a.name ?? "point", x: a.x, y: a.y, rotation: a.rotation },
      a.activate,
    );
  },
});

defineOp({
  name: "addPath",
  group: "attachment",
  description:
    "Attach a bezier path (used by path constraints) to a slot, in slot-bone space. Give `anchors` (flat [x0,y0,x1,y1,...]; handles are placed automatically for a smooth curve) or `vertices` (flat, 3 points per knot: [inX,inY, x,y, outX,outY, ...]). Bind it to control bones with autoWeights to bend it.",
  schema: z.object({
    ...attTarget,
    activate: z.boolean().default(true),
    anchors: z.array(z.number()).optional().describe("Points the curve passes through, flat [x0,y0,x1,y1,...]"),
    vertices: z.array(z.number()).optional().describe("Explicit knots, 6 numbers each: in handle, anchor, out handle"),
    closed: z.boolean().default(false),
    color: hex.default("#ff7a00"),
  }),
  apply(doc, a) {
    let v = a.vertices;
    if (!v) {
      if (!a.anchors || a.anchors.length < 4 || a.anchors.length % 2)
        throw new Error("Give at least two anchor points (flat [x0,y0,x1,y1,...]) or vertices");
      v = smoothKnots(a.anchors, a.closed);
      a.vertices = v;
    }
    if (v.length < 12 || v.length % 6) throw new Error("Path vertices need 6 numbers per knot and at least 2 knots");
    return putAttachment(doc, a.slot, a.skin, { type: "path", name: a.name ?? "path", vertices: v, closed: a.closed, color: a.color }, a.activate);
  },
});

defineOp({
  name: "updateAttachment",
  group: "attachment",
  description:
    "Change properties of an existing attachment (any field of its type, e.g. x, y, width, fill, vertices). Mesh vertices are slot-bone local; on a weighted mesh they are re-bound to the same bones at the new position. When the vertex count changes pass uvs too (triangles are recomputed if omitted).",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional(),
    props: z.record(z.string(), z.unknown()),
  }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const skin = a.skin ? get.skin(doc, a.skin) : undefined;
    const owner = attachmentOwner(doc, slot.id, a.attachment, skin?.id);
    const att = owner?.attachments[slot.id][a.attachment];
    if (!owner || !att) throw new Error(`Attachment "${a.attachment}" not found on slot "${slot.name}"`);
    const { type: _t, ...props } = a.props as Record<string, unknown>;
    if (typeof props.name === "string" && props.name !== att.name) {
      const map = owner.attachments[slot.id];
      if (map[props.name]) throw new Error(`Slot "${slot.name}" already has an attachment "${props.name}" in skin "${owner.name}"`);
      delete map[att.name];
      map[props.name] = att;
      if (slot.attachment === att.name) slot.attachment = props.name;
    }
    if (att.type === "mesh") return updateMesh(doc, slot.bone, att, props);
    if (att.type === "sequence") checkSequenceProps(doc, props);
    if (att.type === "clipping") {
      if ("vertices" in props) checkClipPolygon(props.vertices);
      if ("end" in props) props.end = props.end == null ? null : get.slot(doc, String(props.end)).id;
    }
    Object.assign(att, props);
    return {};
  },
});

/**
 * Apply props to a mesh and keep it consistent: new `vertices` on a weighted mesh re-bind each vertex to its
 * bones at the new setup-pose position (same influences; nearest old vertex when the count changes), a changed
 * vertex count re-triangulates when no `triangles` are given, and the result is validated.
 */
function updateMesh(doc: OpenBoneDocument, slotBone: string, att: MeshAtt, props: Record<string, unknown>) {
  const oldN = att.vertices.length / 2;
  const next = { ...att, ...props } as MeshAtt;
  const n = next.vertices.length / 2;
  const isNums = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (!isNums(next.vertices) || next.vertices.length % 2) throw new Error("vertices must be a flat [x0,y0,x1,y1,...] array of numbers");
  if (n < 3) throw new Error("A mesh needs at least 3 vertices");
  if ("vertices" in props && n !== oldN) {
    if (!("uvs" in props)) throw new Error(`The vertex count changed (${oldN} → ${n}): also pass uvs (one u,v pair per vertex)`);
    if (!("hull" in props)) next.hull = Math.min(att.hull, n);
    if (!("triangles" in props)) next.triangles = triangulate(next.vertices.slice(0, next.hull * 2), next.vertices.slice(next.hull * 2));
  }
  if (!isNums(next.uvs) || next.uvs.length !== next.vertices.length) throw new Error(`uvs must have one u,v pair per vertex (${n})`);
  if (!Number.isInteger(next.hull) || next.hull < 3 || next.hull > n) throw new Error(`hull must be an integer between 3 and ${n}`);
  if (!isNums(next.triangles) || next.triangles.length % 3 || next.triangles.some((i) => !Number.isInteger(i) || i < 0 || i >= n))
    throw new Error(`triangles must be index triples in 0..${n - 1}`);
  if ("vertices" in props && !("weights" in props) && att.weights) {
    // Re-bind the weighted mesh so the new vertex positions take effect.
    const world = setupWorld(doc);
    const slotM = world.get(slotBone)!;
    const oldWorld = Array.from({ length: oldN }, (_, v) => vertexSetupWorld(att, world, slotBone, v));
    next.weights = Array.from({ length: n }, (_, v) => {
      const [wx, wy] = applyM(slotM, next.vertices[v * 2], next.vertices[v * 2 + 1]);
      let from = v;
      if (n !== oldN) {
        let best = Infinity;
        oldWorld.forEach(([ox, oy], i) => {
          const d = (ox - wx) ** 2 + (oy - wy) ** 2;
          if (d < best) [best, from] = [d, i];
        });
      }
      return att.weights![from].map((inf) => {
        const [x, y] = applyM(invert(world.get(inf.bone)!), wx, wy);
        return { ...inf, x, y };
      });
    });
  }
  if (next.weights) {
    if (!Array.isArray(next.weights) || next.weights.length !== n) throw new Error(`weights must have one entry per vertex (${n})`);
    for (const list of next.weights)
      for (const inf of list) if (!doc.skeleton.bones.some((b) => b.id === inf.bone)) throw new Error(`weights reference unknown bone "${inf.bone}"`);
  }
  Object.assign(att, next);
  return { vertices: n, triangles: next.triangles.length / 3 };
}

defineOp({
  name: "deleteAttachment",
  group: "attachment",
  description: "Remove an attachment from a slot.",
  schema: z.object({ slot: ref("Slot"), attachment: z.string(), skin: ref("Skin").optional() }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const skin = a.skin ? get.skin(doc, a.skin) : defaultSkin(doc);
    const map = skin.attachments[slot.id];
    if (!map?.[a.attachment]) throw new Error(`Attachment "${a.attachment}" not found on slot "${slot.name}" in skin "${skin.name}"`);
    delete map[a.attachment];
    if (!Object.keys(map).length) delete skin.attachments[slot.id];
    // Keep the setup attachment if another skin still provides one under that name.
    const stillUsed = doc.skeleton.skins.some((k) => k.attachments[slot.id]?.[a.attachment]);
    if (slot.attachment === a.attachment && !stillUsed) slot.attachment = null;
    return {};
  },
});

defineOp({
  name: "autoWeights",
  group: "attachment",
  description:
    "Bind a mesh (or path) to bones automatically: each vertex is weighted to its nearest bones (by distance to the bone segment) in the setup pose.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional().describe("Skin holding the mesh (defaults to the default skin)"),
    bones: z.array(ref("Bone")).min(1).describe("Bones that may influence the mesh"),
    maxInfluences: z.number().int().min(1).max(4).default(2),
    falloff: z.number().positive().default(2).describe("Higher = sharper transitions"),
  }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const att = getAttachment(doc, slot.id, a.attachment, a.skin ? get.skin(doc, a.skin).id : undefined);
    if (!att || (att.type !== "mesh" && att.type !== "path")) throw new Error("autoWeights needs a mesh or path attachment");
    const world = setupWorld(doc);
    const slotM = world.get(slot.bone)!;
    const bones = a.bones.map((r) => get.bone(doc, r));
    const weights: VertexWeight[][] = [];
    for (let i = 0; i < att.vertices.length; i += 2) {
      const [wx, wy] = applyM(slotM, att.vertices[i], att.vertices[i + 1]);
      const scored = bones.map((b) => {
        const m = world.get(b.id)!;
        const [ex, ey] = applyM(m, Math.max(b.length, 1e-3), 0);
        const d = Math.sqrt(distToSegmentSq(wx, wy, m.x, m.y, ex, ey));
        return { b, m, score: 1 / Math.pow(d + 1, a.falloff) };
      });
      scored.sort((p, q) => q.score - p.score);
      const top = scored.slice(0, a.maxInfluences);
      const total = top.reduce((s, t) => s + t.score, 0);
      weights.push(
        top.map(({ b, m, score }) => {
          const [lx, ly] = applyM(invert(m), wx, wy);
          return { bone: b.id, x: lx, y: ly, weight: score / total };
        }),
      );
    }
    att.weights = weights;
    return { vertices: weights.length };
  },
});

type MeshAtt = Extract<Attachment, { type: "mesh" }>;
type World = ReturnType<typeof setupWorld>;

/** Setup-pose world position of mesh vertex `v`. */
/** Anything with flat vertices and optional per-vertex weights (meshes and paths). */
type Weighted = Pick<MeshAtt, "vertices" | "weights">;

function vertexSetupWorld(att: Weighted, world: World, slotBone: string, v: number): [number, number] {
  if (att.weights) {
    let wx = 0;
    let wy = 0;
    for (const inf of att.weights[v]) {
      const [x, y] = applyM(world.get(inf.bone)!, inf.x, inf.y);
      wx += x * inf.weight;
      wy += y * inf.weight;
    }
    return [wx, wy];
  }
  return applyM(world.get(slotBone)!, att.vertices[v * 2], att.vertices[v * 2 + 1]);
}

/**
 * Replace the influences of the given vertices. Positions are computed from the setup pose so the mesh
 * does not move; an unweighted mesh is first bound 100% to its slot bone. Weights are normalised.
 */
function writeWeights(
  doc: OpenBoneDocument,
  slotRef: string,
  attachment: string,
  edits: { vertex: number; influences: { bone: string; weight: number }[] }[],
  op: string,
  skinRef?: string,
) {
  const slot = get.slot(doc, slotRef);
  const att = getAttachment(doc, slot.id, attachment, skinRef ? get.skin(doc, skinRef).id : undefined);
  if (!att || (att.type !== "mesh" && att.type !== "path")) throw new Error(`${op} needs a mesh or path attachment`);
  const n = att.vertices.length / 2;
  const world = setupWorld(doc);
  const resolved = edits.map((e) => {
    if (e.vertex >= n) throw new Error(`Vertex ${e.vertex} out of range (mesh has ${n})`);
    const infl = e.influences.filter((i) => i.weight > 0);
    const total = infl.reduce((s, i) => s + i.weight, 0);
    if (total <= 0) throw new Error(`Vertex ${e.vertex} needs at least one influence with weight > 0`);
    // Merge duplicate bones.
    const byBone = new Map<string, number>();
    for (const i of infl) {
      const id = get.bone(doc, i.bone).id;
      byBone.set(id, (byBone.get(id) ?? 0) + i.weight / total);
    }
    const [wx, wy] = vertexSetupWorld(att, world, slot.bone, e.vertex);
    return {
      vertex: e.vertex,
      infl: [...byBone].map(([bone, weight]): VertexWeight => {
        const [x, y] = applyM(invert(world.get(bone)!), wx, wy);
        return { bone, x, y, weight };
      }),
    };
  });
  if (!att.weights) {
    // Initialise all vertices bound 100% to the slot bone (local == slot-bone space).
    att.weights = [];
    for (let i = 0; i < n; i++) att.weights.push([{ bone: slot.bone, x: att.vertices[i * 2], y: att.vertices[i * 2 + 1], weight: 1 }]);
  }
  for (const r of resolved) att.weights[r.vertex] = r.infl;
  return { vertices: resolved.length };
}

const influences = z.array(z.object({ bone: ref("Bone"), weight: z.number().min(0) })).min(1);

defineOp({
  name: "setWeights",
  group: "attachment",
  description: "Set explicit weights for one mesh or path vertex (positions computed from the setup pose). Weights are normalised.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional().describe("Skin holding the mesh (defaults to the default skin)"),
    vertex: z.number().int().min(0),
    influences,
  }),
  apply(doc, a) {
    writeWeights(doc, a.slot, a.attachment, [{ vertex: a.vertex, influences: a.influences }], "setWeights", a.skin);
    return {};
  },
});

defineOp({
  name: "setMeshWeights",
  group: "attachment",
  description:
    "Set bone weights for many mesh vertices at once (e.g. a weight-painting stroke). Each entry replaces that vertex's influences; vertices not listed keep theirs. Weights are normalised per vertex and the mesh keeps its setup-pose shape.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional().describe("Skin holding the mesh (defaults to the default skin)"),
    vertices: z.array(z.object({ vertex: z.number().int().min(0), influences })).min(1),
  }),
  apply(doc, a) {
    return writeWeights(doc, a.slot, a.attachment, a.vertices, "setMeshWeights", a.skin);
  },
});

// ---------------- Constraints ----------------

/** Remove animation timelines whose constraint no longer exists. */
function dropConstraintTimelines(doc: OpenBoneDocument) {
  const sk = doc.skeleton;
  const live = {
    ik: new Set(sk.ik.map((c) => c.id)),
    transform: new Set(sk.transform.map((c) => c.id)),
    path: new Set(sk.path.map((c) => c.id)),
    physics: new Set(sk.physics.map((c) => c.id)),
  };
  for (const anim of doc.animations)
    anim.timelines = anim.timelines.filter((t) => !(t.target in live) || live[t.target as keyof typeof live].has(t.id));
}

function constraintName(doc: OpenBoneDocument, base: string): string {
  const sk = doc.skeleton;
  return uniqueName([...sk.ik, ...sk.transform, ...sk.path, ...sk.physics], base);
}

/** Copy defined values from `a` onto `target` for the listed keys. */
function assignDefined<T extends object>(target: T, a: Record<string, unknown>, keys: (keyof T & string)[]) {
  for (const k of keys) if (a[k] !== undefined) (target as Record<string, unknown>)[k] = a[k];
}

const mix01 = z.number().min(0).max(1);

const ikProps = {
  mix: mix01.optional(),
  bendPositive: z.boolean().optional(),
  softness: z.number().min(0).optional().describe("2-bone only: distance before full extension where the chain eases into straight (0 = off)"),
  stretch: z.boolean().optional().describe("Scale bones up along their length when the target is out of reach"),
  compress: z.boolean().optional().describe("1-bone only: scale the bone down when the target is closer than its length"),
};

defineOp({
  name: "addIkConstraint",
  group: "constraint",
  description:
    "Add an IK constraint: 1 bone aims at the target, or 2 bones (parent then child, e.g. thigh+shin) bend to reach it. Optional softness, stretch and compress.",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1).max(2),
    target: ref("Target bone"),
    ...ikProps,
  }),
  apply(doc, a) {
    const bones = a.bones.map((r) => get.bone(doc, r));
    if (bones.length === 2 && bones[1].parent !== bones[0].id)
      throw new Error("For 2-bone IK the second bone must be a direct child of the first");
    const target = get.bone(doc, a.target);
    if (bones.some((b) => descendantIds(doc, b.id).has(target.id)))
      throw new Error("IK target must not be a descendant of a constrained bone");
    const id = (a.id ??= newId("ik"));
    const name = (a.name ??= constraintName(doc, `${bones[bones.length - 1].name}-ik`));
    doc.skeleton.ik.push({
      id,
      name,
      bones: bones.map((b) => b.id),
      target: target.id,
      mix: a.mix ?? 1,
      bendPositive: a.bendPositive ?? true,
      softness: a.softness ?? 0,
      stretch: a.stretch ?? false,
      compress: a.compress ?? false,
    });
    return { id, name };
  },
});

defineOp({
  name: "updateIkConstraint",
  group: "constraint",
  description: "Change an IK constraint's mix, bend direction, softness, stretch/compress, target or name.",
  schema: z.object({ constraint: ref("IK constraint"), name: z.string().optional(), target: ref("Bone").optional(), ...ikProps }),
  apply(doc, a) {
    const ik = get.ik(doc, a.constraint);
    if (a.name) ik.name = a.name;
    if (a.target) {
      const t = get.bone(doc, a.target);
      if (ik.bones.some((b) => descendantIds(doc, b).has(t.id))) throw new Error("IK target must not be a descendant of a constrained bone");
      ik.target = t.id;
    }
    assignDefined(ik, a, ["mix", "bendPositive", "softness", "stretch", "compress"]);
    return {};
  },
});

const transformProps = {
  mixRotate: mix01.optional(),
  mixTranslate: mix01.optional(),
  mixScale: mix01.optional(),
  mixShear: mix01.optional().describe("Blend of the shear between the bone's axes"),
  offsetRotation: z.number().optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  offsetScaleX: z.number().optional().describe("Added to the copied scale"),
  offsetScaleY: z.number().optional(),
  offsetShear: z.number().optional(),
  local: z.boolean().optional().describe("Copy local (parent-space) values instead of world transforms"),
  relative: z.boolean().optional().describe("Add the target's change from its setup pose instead of copying its absolute value"),
};
const TRANSFORM_KEYS = Object.keys(transformProps) as (keyof typeof transformProps)[];

defineOp({
  name: "addTransformConstraint",
  group: "constraint",
  description:
    "Make bones copy (mix toward) the rotation/translation/scale/shear of a target bone, plus offsets. World or local space; absolute or relative (adds the target's change from its setup pose).",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1),
    target: ref("Target bone"),
    ...transformProps,
  }),
  apply(doc, a) {
    const bones = a.bones.map((r) => get.bone(doc, r).id);
    const target = get.bone(doc, a.target).id;
    if (bones.includes(target)) throw new Error("A transform constraint's target cannot be one of its bones");
    const id = (a.id ??= newId("tc"));
    const name = (a.name ??= constraintName(doc, "transform"));
    doc.skeleton.transform.push({
      id,
      name,
      bones,
      target,
      mixRotate: a.mixRotate ?? 1,
      mixTranslate: a.mixTranslate ?? 1,
      mixScale: a.mixScale ?? 0,
      mixShear: a.mixShear ?? 0,
      offsetRotation: a.offsetRotation ?? 0,
      offsetX: a.offsetX ?? 0,
      offsetY: a.offsetY ?? 0,
      offsetScaleX: a.offsetScaleX ?? 0,
      offsetScaleY: a.offsetScaleY ?? 0,
      offsetShear: a.offsetShear ?? 0,
      local: a.local ?? false,
      relative: a.relative ?? false,
    });
    return { id, name };
  },
});

defineOp({
  name: "updateTransformConstraint",
  group: "constraint",
  description: "Change a transform constraint's mixes, offsets, space (local), relative mode, bones, target or name.",
  schema: z.object({
    constraint: ref("Transform constraint"),
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1).optional(),
    target: ref("Bone").optional(),
    ...transformProps,
  }),
  apply(doc, a) {
    const c = get.transform(doc, a.constraint);
    if (a.name) c.name = a.name;
    if (a.bones) c.bones = a.bones.map((r) => get.bone(doc, r).id);
    if (a.target) c.target = get.bone(doc, a.target).id;
    if (c.bones.includes(c.target)) throw new Error("A transform constraint's target cannot be one of its bones");
    assignDefined(c, a, TRANSFORM_KEYS);
    return {};
  },
});

const pathProps = {
  positionMode: z.enum(["fixed", "percent"]).optional().describe("fixed: position is a distance; percent: 0..1 of the path length"),
  spacingMode: z
    .enum(["length", "fixed", "percent", "proportional"])
    .optional()
    .describe("length: bone length + spacing; fixed: spacing; percent: spacing x path length; proportional: spacing x path length shared by bone length"),
  rotateMode: z
    .enum(["tangent", "chain", "chainScale"])
    .optional()
    .describe("tangent: follow the curve direction; chain: point at the next bone's spot; chainScale: chain and stretch to reach it"),
  offsetRotation: z.number().optional(),
  position: z.number().optional().describe("Where the first bone sits along the path"),
  spacing: z.number().optional(),
  mixRotate: mix01.optional(),
  mixX: mix01.optional(),
  mixY: mix01.optional(),
};
const PATH_KEYS = Object.keys(pathProps) as (keyof typeof pathProps)[];

/** Resolve and order path-constraint bones; they must form a parent-before-child list. */
function pathBones(doc: OpenBoneDocument, refs: string[]): string[] {
  const ids = refs.map((r) => get.bone(doc, r).id);
  const order = new Map(doc.skeleton.bones.map((b, i) => [b.id, i]));
  if (new Set(ids).size !== ids.length) throw new Error("A bone appears twice in the path constraint");
  return ids.sort((p, q) => order.get(p)! - order.get(q)!);
}

defineOp({
  name: "addPathConstraint",
  group: "constraint",
  description:
    "Place and rotate a chain of bones along a slot's path attachment (add one with addPath). Bones are ordered parent first. Good for tails, tentacles, ropes and things moving along a track.",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1),
    target: ref("Slot showing a path attachment"),
    ...pathProps,
  }),
  apply(doc, a) {
    const bones = pathBones(doc, a.bones);
    const slot = get.slot(doc, a.target);
    if (bones.some((b) => descendantIds(doc, b).has(slot.bone)) )
      throw new Error("The path's slot bone must not be one of the constrained bones or their descendants");
    const id = (a.id ??= newId("path"));
    const name = (a.name ??= constraintName(doc, `${slot.name}-path`));
    doc.skeleton.path.push({
      id,
      name,
      bones,
      target: slot.id,
      positionMode: a.positionMode ?? "percent",
      spacingMode: a.spacingMode ?? "length",
      rotateMode: a.rotateMode ?? "tangent",
      offsetRotation: a.offsetRotation ?? 0,
      position: a.position ?? 0,
      spacing: a.spacing ?? 0,
      mixRotate: a.mixRotate ?? 1,
      mixX: a.mixX ?? 1,
      mixY: a.mixY ?? 1,
    });
    return { id, name };
  },
});

defineOp({
  name: "updatePathConstraint",
  group: "constraint",
  description: "Change a path constraint's modes, position, spacing, mixes, bones, target slot or name.",
  schema: z.object({
    constraint: ref("Path constraint"),
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1).optional(),
    target: ref("Slot").optional(),
    ...pathProps,
  }),
  apply(doc, a) {
    const c = get.path(doc, a.constraint);
    if (a.name) c.name = a.name;
    if (a.bones) c.bones = pathBones(doc, a.bones);
    if (a.target) c.target = get.slot(doc, a.target).id;
    const slot = get.slot(doc, c.target);
    if (c.bones.some((b) => descendantIds(doc, b).has(slot.bone)))
      throw new Error("The path's slot bone must not be one of the constrained bones or their descendants");
    assignDefined(c, a, PATH_KEYS);
    return {};
  },
});

const physicsProps = {
  x: mix01.optional().describe("How much the simulation moves the bone origin horizontally"),
  y: mix01.optional().describe("How much the simulation moves the bone origin vertically"),
  rotate: mix01.optional().describe("How much the simulation rotates the bone"),
  scaleX: mix01.optional().describe("How much the simulation stretches the bone"),
  inertia: mix01.optional().describe("How much of the bone's own movement is resisted (1 = full lag)"),
  strength: z.number().min(0).optional().describe("Spring stiffness back to the animated pose"),
  damping: z.number().min(0).optional().describe("Velocity decay per second"),
  mass: z.number().positive().optional(),
  gravity: z.number().optional().describe("Downward acceleration (units/s²)"),
  wind: z.number().optional().describe("Sideways +x acceleration (units/s²)"),
  mix: mix01.optional(),
  fps: z.number().min(1).max(480).optional().describe("Simulation steps per second (fixed timestep)"),
};
const PHYSICS_KEYS = Object.keys(physicsProps) as (keyof typeof physicsProps)[];

defineOp({
  name: "addPhysicsConstraint",
  group: "constraint",
  description:
    "Add spring-based secondary motion (hair, cloth, antennae, tails) to a bone. Add one per bone of a chain, parent first. Deterministic for a fixed timestep.",
  schema: z.object({ id: optId, name: z.string().optional(), bone: ref("Bone"), ...physicsProps }),
  apply(doc, a) {
    const bone = get.bone(doc, a.bone);
    const id = (a.id ??= newId("phys"));
    const name = (a.name ??= constraintName(doc, `${bone.name}-physics`));
    doc.skeleton.physics.push({
      id,
      name,
      bone: bone.id,
      x: a.x ?? 0,
      y: a.y ?? 0,
      rotate: a.rotate ?? 1,
      scaleX: a.scaleX ?? 0,
      inertia: a.inertia ?? 0.8,
      strength: a.strength ?? 120,
      damping: a.damping ?? 6,
      mass: a.mass ?? 1,
      gravity: a.gravity ?? 0,
      wind: a.wind ?? 0,
      mix: a.mix ?? 1,
      fps: a.fps ?? 60,
    });
    return { id, name };
  },
});

defineOp({
  name: "updatePhysicsConstraint",
  group: "constraint",
  description: "Change a physics constraint's channels, spring settings, gravity, wind, mix, bone or name.",
  schema: z.object({ constraint: ref("Physics constraint"), name: z.string().optional(), bone: ref("Bone").optional(), ...physicsProps }),
  apply(doc, a) {
    const c = get.physics(doc, a.constraint);
    if (a.name) c.name = a.name;
    if (a.bone) c.bone = get.bone(doc, a.bone).id;
    assignDefined(c, a, PHYSICS_KEYS);
    return {};
  },
});

defineOp({
  name: "deleteConstraint",
  group: "constraint",
  description: "Delete an IK, transform, path or physics constraint (and its animation timelines).",
  schema: z.object({ constraint: ref("Constraint") }),
  apply(doc, a) {
    const sk = doc.skeleton;
    const match = (c: { id: string; name: string }) => c.id === a.constraint || c.name === a.constraint;
    const count = () => sk.ik.length + sk.transform.length + sk.path.length + sk.physics.length;
    const before = count();
    sk.ik = sk.ik.filter((c) => !match(c));
    sk.transform = sk.transform.filter((c) => !match(c));
    sk.path = sk.path.filter((c) => !match(c));
    sk.physics = sk.physics.filter((c) => !match(c));
    if (count() === before) throw new Error(`Constraint "${a.constraint}" not found`);
    dropConstraintTimelines(doc);
    return {};
  },
});

/** Helper used by editor tools: world rotation of a bone in setup pose. */
export function setupWorldRotation(doc: OpenBoneDocument, boneId: string): number {
  return worldRotation(setupWorld(doc).get(boneId)!);
}
