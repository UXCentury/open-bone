import { Skeleton } from "@openbone/runtime";
import { For, createMemo } from "solid-js";
import { activeSkinId, doc } from "../state.ts";
import { Section } from "./fields.tsx";

/**
 * Skeleton statistics (Spine's "Skeletons" panel): what the rig costs at runtime. Visible counts use the setup pose
 * with the current skin; draw calls estimate WebGL batches (a new batch whenever the texture or blend mode changes).
 */
export function StatsSection() {
  const stats = createMemo(() => {
    const d = doc();
    const sk = d.skeleton;
    let totalAtt = 0;
    for (const skin of sk.skins) for (const atts of Object.values(skin.attachments)) totalAtt += Object.keys(atts).length;
    const s = new Skeleton(d);
    const skin = sk.skins.find((x) => x.id === activeSkinId());
    if (skin) s.setSkin(skin.name);
    s.updateWorldTransform();
    let vertices = 0;
    let transforms = 0;
    let triangles = 0;
    let clipping = 0;
    let visible = 0;
    for (const slot of s.slots) {
      const att = s.getAttachment(slot);
      if (!att) continue;
      visible++;
      if (att.type === "clipping") clipping++;
      if (att.type === "mesh") {
        const n = att.vertices.length / 2;
        vertices += n;
        transforms += att.weights ? att.weights.reduce((t, w) => t + w.length, 0) : n;
        triangles += att.triangles.length / 3;
      } else if (att.type === "region" || att.type === "sequence") {
        vertices += 4;
        transforms += 4;
        triangles += 2;
      }
    }
    const items = s.drawList();
    let calls = 0;
    let last = "";
    for (const it of items) {
      const key = `${it.texture?.id ?? it.image?.id ?? "solid"}|${it.blend}|${it.clip ? "clip" : ""}`;
      if (key !== last) calls++;
      last = key;
    }
    const pixels = d.images.reduce((t, i) => t + i.width * i.height, 0);
    return [
      ["Bones", sk.bones.length],
      ["Slots", sk.slots.length],
      ["Constraints", sk.ik.length + sk.transform.length + sk.path.length + sk.physics.length + (sk.sliders?.length ?? 0)],
      ["  IK · transform · path", `${sk.ik.length} · ${sk.transform.length} · ${sk.path.length}`],
      ["  physics · sliders", `${sk.physics.length} · ${sk.sliders?.length ?? 0}`],
      ["Attachments", `${visible} visible / ${totalAtt}`],
      ["Vertices", vertices],
      ["Vertex transforms", transforms],
      ["Triangles", triangles],
      ["Clipping masks", clipping],
      ["Draw calls (est.)", calls],
      ["Images", `${d.images.length}${d.atlas ? ` in ${d.atlas.pages.length} atlas page${d.atlas.pages.length === 1 ? "" : "s"}` : ""}`],
      ["Image area", `${(pixels / 1e6).toFixed(2)} MP`],
      ["Animations · state machines", `${d.animations.length} · ${d.stateMachines.length}`],
    ] as [string, string | number][];
  });
  return (
    <Section title="Stats">
      <div class="stats">
        <For each={stats()}>
          {([k, v]) => (
            <div class="stat-row">
              <span class="muted">{k}</span>
              <span>{v}</span>
            </div>
          )}
        </For>
      </div>
    </Section>
  );
}
