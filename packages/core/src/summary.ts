import { animationDuration, defaultSkin } from "./document.ts";
import type { OpenBoneDocument } from "./types.ts";

/** Compact, human/LLM-readable outline of a document. */
export function summarize(d: OpenBoneDocument): string {
  const lines: string[] = [];
  const name = (id: string | null) => d.skeleton.bones.find((b) => b.id === id)?.name ?? id;
  lines.push(`# ${d.name} — artboard ${d.width}x${d.height}, origin (${d.originX},${d.originY}), ${d.fps}fps`);
  lines.push(`## Bones (${d.skeleton.bones.length}) — name [id] parent: x,y rot len`);
  const depth = (id: string | null): number => {
    const b = d.skeleton.bones.find((x) => x.id === id);
    return b?.parent ? 1 + depth(b.parent) : 0;
  };
  for (const b of d.skeleton.bones)
    lines.push(
      `${"  ".repeat(depth(b.id))}- ${b.name} [${b.id}] ${b.parent ? `<${name(b.parent)}>` : "(root)"}: ${r(b.x)},${r(b.y)} rot ${r(b.rotation)} len ${r(b.length)}${b.scaleX !== 1 || b.scaleY !== 1 ? ` scale ${r(b.scaleX)},${r(b.scaleY)}` : ""}`,
    );
  lines.push(`## Slots (${d.skeleton.slots.length}, back→front)`);
  const skin = defaultSkin(d);
  for (const s of d.skeleton.slots) {
    const atts = Object.values(skin.attachments[s.id] ?? {}).map((a) => `${a.name}:${a.type}${(a.type === "mesh" || a.type === "path" || a.type === "boundingBox") && a.weights ? "(weighted)" : ""}`);
    lines.push(`- ${s.name} [${s.id}] on ${name(s.bone)} shows ${s.attachment ?? "nothing"}; attachments: ${atts.join(", ") || "none"}`);
  }
  if (d.images.length) lines.push(`## Images: ${d.images.map((i) => `${i.name} [${i.id}] ${i.width}x${i.height}`).join("; ")}`);
  if (d.skeleton.skins.length > 1) lines.push(`## Skins: ${d.skeleton.skins.map((s) => s.name).join(", ")}`);
  for (const c of d.skeleton.ik) lines.push(`- IK ${c.name} [${c.id}]: ${c.bones.map(name).join("→")} → ${name(c.target)} mix ${c.mix}${c.softness ? ` softness ${c.softness}` : ""}${c.stretch ? " stretch" : ""}${c.compress ? " compress" : ""}`);
  for (const c of d.skeleton.transform)
    lines.push(
      `- Transform ${c.name} [${c.id}]: ${c.bones.map(name).join(",")} ← ${name(c.target)}${c.local ? " local" : ""}${c.relative ? " relative" : ""}`,
    );
  const slotName = (id: string) => d.skeleton.slots.find((s) => s.id === id)?.name ?? id;
  for (const c of d.skeleton.path ?? [])
    lines.push(
      `- Path ${c.name} [${c.id}]: ${c.bones.map(name).join("→")} along slot ${slotName(c.target)} (${c.positionMode} ${c.position}, ${c.spacingMode} ${c.spacing}, ${c.rotateMode})`,
    );
  for (const c of d.skeleton.physics ?? [])
    lines.push(`- Physics ${c.name} [${c.id}]: ${name(c.bone)} strength ${c.strength} damping ${c.damping} inertia ${c.inertia} gravity ${c.gravity} wind ${c.wind}`);
  if (d.events.length) lines.push(`## Events: ${d.events.map((e) => e.name).join(", ")}`);
  lines.push(`## Animations (${d.animations.length})`);
  for (const a of d.animations)
    lines.push(`- ${a.name} [${a.id}] ${r(animationDuration(a))}s, ${a.timelines.length} timelines, ${a.events.length} event keys${a.audio?.length ? `, ${a.audio.length} audio keys` : ""}`);
  for (const sm of d.stateMachines) {
    lines.push(`## State machine ${sm.name} [${sm.id}]`);
    lines.push(`  inputs: ${sm.inputs.map((i) => `${i.name}:${i.type}=${JSON.stringify(i.default)}`).join(", ") || "none"}`);
    for (const l of sm.layers) {
      const sn = (id: string) => (id === "@any" ? "@any" : (l.states.find((s) => s.id === id)?.name ?? id));
      lines.push(`  layer ${l.name} (entry: ${l.entry ? sn(l.entry) : "none"})`);
      for (const s of l.states) {
        const anim = d.animations.find((a) => a.id === s.animation)?.name;
        const next = s.onComplete ? ` → ${sn(s.onComplete)} on complete` : "";
        lines.push(`    state ${s.name} [${s.id}] ${s.type}${anim ? ` ${anim}` : ""}${s.loop ? " loop" : ""}${next}`);
      }
      for (const t of l.transitions) {
        const cond = t.conditions
          .map((c) => `${sm.inputs.find((i) => i.id === c.input)?.name} ${c.op} ${JSON.stringify(c.value)}`)
          .join(" && ");
        lines.push(`    ${sn(t.from)} → ${sn(t.to)} [${t.id}] ${cond || "(always)"} fade ${t.duration}s${t.exitTime != null ? ` exit@${t.exitTime}` : ""}`);
      }
    }
    for (const b of sm.bindings ?? [])
      lines.push(`  binding [${b.id}] ${sm.inputs.find((i) => i.id === b.input)?.name} ${b.inMin}..${b.inMax} → ${b.target} ${b.object}.${b.property} ${b.outMin}..${b.outMax}`);
    for (const li of sm.listeners)
      lines.push(`  listener ${li.name}: ${li.event} on ${d.skeleton.slots.find((s) => s.id === li.slot)?.name ?? "artboard"} → ${li.actions.map((a) => a.type).join(", ")}`);
  }
  if (d.audio && (d.audio.assets.length || d.audio.sounds.length)) {
    const bus = (id: string | null) => d.audio!.buses.find((b) => b.id === id)?.name ?? "master";
    lines.push(`## Audio — master ${d.audio.master}${d.audio.muted ? " (muted)" : ""}; buses: ${d.audio.buses.map((b) => `${b.name} ${b.volume}${b.muted ? " muted" : ""}`).join(", ")}`);
    lines.push(`  assets: ${d.audio.assets.map((a) => `${a.name} [${a.id}] ${r(a.duration)}s`).join("; ") || "none"}`);
    for (const s of d.audio.sounds)
      lines.push(`  sound ${s.name} [${s.id}] → ${bus(s.bus)} vol ${s.volume} rate ${s.rate}${s.loop ? " loop" : ""}${s.fadeIn ? ` fadeIn ${s.fadeIn}` : ""}${s.fadeOut ? ` fadeOut ${s.fadeOut}` : ""}`);
  }
  if (d.scripts.length) lines.push(`## Scripts: ${d.scripts.map((s) => `${s.name} [${s.id}]`).join(", ")}`);
  return lines.join("\n");
}

const r = (n: number) => Math.round(n * 100) / 100;
