import { z } from "zod";
import { attachmentOwner, defaultSkin, descendantIds, get, getAttachment, newId, sortBones } from "../document.ts";
import { distToSegmentSq, gridMesh } from "../geometry.ts";
import { apply as applyM, invert, worldRotation } from "../math.ts";
import { setupWorld } from "../setup.ts";
import type { Attachment, BoneData, OpenBoneDocument, SkinData, VertexWeight } from "../types.ts";
import { defineOp, hex, optId, ref } from "./registry.ts";

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
    for (const anim of doc.animations)
      anim.timelines = anim.timelines.filter(
        (t) => !(t.target === "bone" && ids.has(t.id)) && !((t.target === "slot" || t.target === "deform") && slotIds.has(t.id)),
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
    for (const skin of doc.skeleton.skins) delete skin.attachments[s.id];
    for (const anim of doc.animations)
      anim.timelines = anim.timelines.filter((t) => !((t.target === "slot" || t.target === "deform") && t.id === s.id));
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

function putAttachment(doc: OpenBoneDocument, slotRef: string, skinRef: string | undefined, att: Attachment, activate: boolean) {
  const slot = get.slot(doc, slotRef);
  const skin: SkinData = skinRef ? get.skin(doc, skinRef) : defaultSkin(doc);
  (skin.attachments[slot.id] ??= {})[att.name] = att;
  if (activate) slot.attachment = att.name;
  return { slot: slot.id, name: att.name, skin: skin.id };
}

const attTarget = {
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
  name: "updateAttachment",
  group: "attachment",
  description: "Change properties of an existing attachment (any field of its type, e.g. x, y, width, fill, vertices).",
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
    Object.assign(att, props);
    return {};
  },
});

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
    "Bind a mesh to bones automatically: each vertex is weighted to its nearest bones (by distance to the bone segment) in the setup pose.",
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
    if (!att || att.type !== "mesh") throw new Error("autoWeights needs a mesh attachment");
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

defineOp({
  name: "setWeights",
  group: "attachment",
  description: "Set explicit weights for one mesh vertex (positions computed from the setup pose). Weights are normalised.",
  schema: z.object({
    slot: ref("Slot"),
    attachment: z.string(),
    skin: ref("Skin").optional().describe("Skin holding the mesh (defaults to the default skin)"),
    vertex: z.number().int().min(0),
    influences: z.array(z.object({ bone: ref("Bone"), weight: z.number().min(0) })).min(1),
  }),
  apply(doc, a) {
    const slot = get.slot(doc, a.slot);
    const att = getAttachment(doc, slot.id, a.attachment, a.skin ? get.skin(doc, a.skin).id : undefined);
    if (!att || att.type !== "mesh") throw new Error("setWeights needs a mesh attachment");
    const n = att.vertices.length / 2;
    if (a.vertex >= n) throw new Error(`Vertex ${a.vertex} out of range (mesh has ${n})`);
    const world = setupWorld(doc);
    // Current world position of the vertex in setup pose.
    let wx: number;
    let wy: number;
    if (att.weights) {
      wx = 0;
      wy = 0;
      for (const inf of att.weights[a.vertex]) {
        const [x, y] = applyM(world.get(inf.bone)!, inf.x, inf.y);
        wx += x * inf.weight;
        wy += y * inf.weight;
      }
    } else {
      [wx, wy] = applyM(world.get(slot.bone)!, att.vertices[a.vertex * 2], att.vertices[a.vertex * 2 + 1]);
    }
    const total = a.influences.reduce((s, i) => s + i.weight, 0) || 1;
    const infl = a.influences.map((i) => {
      const b = get.bone(doc, i.bone);
      const [x, y] = applyM(invert(world.get(b.id)!), wx, wy);
      return { bone: b.id, x, y, weight: i.weight / total };
    });
    if (!att.weights) {
      // Initialise all vertices bound 100% to the slot bone.
      const m = world.get(slot.bone)!;
      const inv = invert(m);
      att.weights = [];
      for (let i = 0; i < n; i++) {
        const [vx, vy] = applyM(m, att.vertices[i * 2], att.vertices[i * 2 + 1]);
        const [x, y] = applyM(inv, vx, vy);
        att.weights.push([{ bone: slot.bone, x, y, weight: 1 }]);
      }
    }
    att.weights[a.vertex] = infl;
    return {};
  },
});

// ---------------- Constraints ----------------

defineOp({
  name: "addIkConstraint",
  group: "constraint",
  description:
    "Add an IK constraint: 1 bone aims at the target, or 2 bones (parent then child, e.g. thigh+shin) bend to reach it.",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1).max(2),
    target: ref("Target bone"),
    mix: z.number().min(0).max(1).default(1),
    bendPositive: z.boolean().default(true),
  }),
  apply(doc, a) {
    const bones = a.bones.map((r) => get.bone(doc, r));
    if (bones.length === 2 && bones[1].parent !== bones[0].id)
      throw new Error("For 2-bone IK the second bone must be a direct child of the first");
    const target = get.bone(doc, a.target);
    if (bones.some((b) => descendantIds(doc, b.id).has(target.id)))
      throw new Error("IK target must not be a descendant of a constrained bone");
    const id = (a.id ??= newId("ik"));
    const name = (a.name ??= `${bones[bones.length - 1].name}-ik`);
    doc.skeleton.ik.push({ id, name, bones: bones.map((b) => b.id), target: target.id, mix: a.mix, bendPositive: a.bendPositive });
    return { id, name };
  },
});

defineOp({
  name: "updateIkConstraint",
  group: "constraint",
  description: "Change an IK constraint's mix, bend direction, target or name.",
  schema: z.object({
    constraint: ref("IK constraint"),
    name: z.string().optional(),
    target: ref("Bone").optional(),
    mix: z.number().min(0).max(1).optional(),
    bendPositive: z.boolean().optional(),
  }),
  apply(doc, a) {
    const ik = doc.skeleton.ik.find((c) => c.id === a.constraint || c.name === a.constraint);
    if (!ik) throw new Error(`IK constraint "${a.constraint}" not found`);
    if (a.name) ik.name = a.name;
    if (a.target) ik.target = get.bone(doc, a.target).id;
    if (a.mix !== undefined) ik.mix = a.mix;
    if (a.bendPositive !== undefined) ik.bendPositive = a.bendPositive;
    return {};
  },
});

defineOp({
  name: "addTransformConstraint",
  group: "constraint",
  description: "Make bones copy (mix toward) the world rotation/translation/scale of a target bone, plus offsets.",
  schema: z.object({
    id: optId,
    name: z.string().optional(),
    bones: z.array(ref("Bone")).min(1),
    target: ref("Target bone"),
    mixRotate: z.number().min(0).max(1).default(1),
    mixTranslate: z.number().min(0).max(1).default(1),
    mixScale: z.number().min(0).max(1).default(0),
    offsetRotation: z.number().default(0),
    offsetX: z.number().default(0),
    offsetY: z.number().default(0),
  }),
  apply(doc, a) {
    const bones = a.bones.map((r) => get.bone(doc, r).id);
    const target = get.bone(doc, a.target).id;
    const id = (a.id ??= newId("tc"));
    const name = (a.name ??= "transform");
    const { id: _i, name: _n, bones: _b, target: _t, ...mix } = a;
    doc.skeleton.transform.push({ id, name, bones, target, ...mix });
    return { id, name };
  },
});

defineOp({
  name: "deleteConstraint",
  group: "constraint",
  description: "Delete an IK or transform constraint.",
  schema: z.object({ constraint: ref("Constraint") }),
  apply(doc, a) {
    const sk = doc.skeleton;
    const match = (c: { id: string; name: string }) => c.id === a.constraint || c.name === a.constraint;
    const before = sk.ik.length + sk.transform.length;
    sk.ik = sk.ik.filter((c) => !match(c));
    sk.transform = sk.transform.filter((c) => !match(c));
    if (sk.ik.length + sk.transform.length === before) throw new Error(`Constraint "${a.constraint}" not found`);
    return {};
  },
});

/** Helper used by editor tools: world rotation of a bone in setup pose. */
export function setupWorldRotation(doc: OpenBoneDocument, boneId: string): number {
  return worldRotation(setupWorld(doc).get(boneId)!);
}
